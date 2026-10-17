/**
 * 纯 Node 的 PNG 编解码（零外部依赖，只借用内置 zlib）。
 *
 * 为什么需要它：.strata 里每个像素层与蒙版都是一段 base64 PNG，而
 * export_png 又把合成结果写回 PNG。浏览器里这两件事本来交给
 * canvas.toDataURL / drawImage，Node 里没有 canvas，因此在这里补齐。
 *
 * 解码支持：颜色类型 0/2/3/4/6，位深 1/2/4/8/16，非隔行扫描。
 * 编码固定输出 8 位 RGBA（颜色类型 6），与 canvas.toDataURL("image/png")
 * 的产物一致，便于与既有实现互认。
 *
 * 所有失败都抛可读中文错误（由上层统一兜底）。
 */
import zlib from "node:zlib";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* ---------------------------------------------------------------- CRC32 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------------------------------------------------------- 解码 */

/** 每个像素的通道数（按颜色类型）。 */
function channelsOf(colorType) {
  switch (colorType) {
    case 0:
      return 1; // 灰度
    case 2:
      return 3; // RGB
    case 3:
      return 1; // 调色板索引
    case 4:
      return 2; // 灰度 + alpha
    case 6:
      return 4; // RGBA
    default:
      return 0;
  }
}

function readU32(buf, off) {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

/** 逐字节反滤波，就地展开成一整幅扫描线缓冲（每像素按 byteDepth 存）。 */
function unfilter(raw, width, height, channels, byteDepth) {
  const bpp = channels * byteDepth; // 每个像素占的字节数
  const stride = width * bpp; // 每条扫描线的字节数
  const out = Buffer.allocUnsafe(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[pos + x];
      const a = x >= bpp ? out[rowStart + x - bpp] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      const c = x >= bpp && y > 0 ? out[prevStart + x - bpp] : 0;
      let v;
      switch (filter) {
        case 0:
          v = rawByte;
          break;
        case 1:
          v = rawByte + a;
          break;
        case 2:
          v = rawByte + b;
          break;
        case 3:
          v = rawByte + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`PNG 使用了未知的滤波类型：${filter}`);
      }
      out[rowStart + x] = v & 0xff;
    }
    pos += stride;
  }
  return out;
}

/**
 * 解码 PNG 为 RGBA。
 * @param {Buffer|Uint8Array} input PNG 字节
 * @returns {{width:number, height:number, data:Uint8Array}} data 为 RGBA，长度 w*h*4
 */
export function decodePng(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error("不是合法的 PNG（文件头校验失败）");
  }

  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idat = [];

  while (off + 8 <= buf.length) {
    const len = readU32(buf, off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) {
      throw new Error("PNG 数据被截断");
    }
    if (type === "IHDR") {
      width = readU32(buf, dataStart);
      height = readU32(buf, dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      interlace = buf[dataStart + 12];
    } else if (type === "PLTE") {
      palette = buf.subarray(dataStart, dataEnd);
    } else if (type === "tRNS") {
      trns = buf.subarray(dataStart, dataEnd);
    } else if (type === "IDAT") {
      idat.push(buf.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    off = dataEnd + 4; // 跳过 CRC
  }

  if (width <= 0 || height <= 0) throw new Error("PNG 缺少合法的 IHDR");
  if (interlace !== 0) throw new Error("暂不支持隔行扫描（Adam7）的 PNG");
  const channels = channelsOf(colorType);
  if (channels === 0) throw new Error(`PNG 使用了不支持的颜色类型：${colorType}`);
  if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new Error(`PNG 使用了不支持的位深：${bitDepth}`);
  if (colorType === 3 && !palette) throw new Error("调色板 PNG 缺少 PLTE");

  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const byteDepth = bitDepth >= 8 ? bitDepth / 8 : 1;
  const unfiltered = unfilter(inflated, width, height, channels, byteDepth);

  const out = new Uint8Array(width * height * 4);
  const rowBytes = width * channels * byteDepth;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dst = (y * width + x) * 4;
      if (colorType === 3) {
        const idx = sampleIndex(unfiltered, y * rowBytes, x, bitDepth);
        const pr = palette[idx * 3] ?? 0;
        const pg = palette[idx * 3 + 1] ?? 0;
        const pb = palette[idx * 3 + 2] ?? 0;
        let pa = 255;
        if (trns && idx < trns.length) pa = trns[idx];
        out[dst] = pr;
        out[dst + 1] = pg;
        out[dst + 2] = pb;
        out[dst + 3] = pa;
        continue;
      }
      const src = y * rowBytes + x * channels * byteDepth;
      if (bitDepth === 16) {
        const r = unfiltered[src];
        const g = channels >= 3 ? unfiltered[src + 2] : r;
        const b = channels >= 3 ? unfiltered[src + 4] : r;
        let a = 255;
        if (colorType === 4) a = unfiltered[src + 2];
        else if (colorType === 6) a = unfiltered[src + 6];
        out[dst] = r;
        out[dst + 1] = g;
        out[dst + 2] = b;
        out[dst + 3] = a;
      } else if (bitDepth === 8) {
        const r = unfiltered[src];
        const g = channels >= 3 ? unfiltered[src + 1] : r;
        const b = channels >= 3 ? unfiltered[src + 2] : r;
        let a = 255;
        if (colorType === 4) a = unfiltered[src + 1];
        else if (colorType === 6) a = unfiltered[src + 3];
        out[dst] = r;
        out[dst + 1] = g;
        out[dst + 2] = b;
        out[dst + 3] = a;
      } else {
        // 位深 1/2/4 的灰度：把采样值放大到 0–255
        const v = sampleIndex(unfiltered, y * rowBytes, x, bitDepth);
        const max = (1 << bitDepth) - 1;
        const g = Math.round((v / max) * 255);
        out[dst] = g;
        out[dst + 1] = g;
        out[dst + 2] = g;
        out[dst + 3] = 255;
      }
    }
  }

  return { width, height, data: out };
}

/** 从打包位深的扫描线里取出第 x 个采样值（位深 < 8 时用）。 */
function sampleIndex(row, rowStart, x, bitDepth) {
  if (bitDepth === 8) return row[rowStart + x];
  const perByte = 8 / bitDepth;
  const byte = row[rowStart + Math.floor(x / perByte)];
  const shift = 8 - bitDepth * ((x % perByte) + 1);
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

/** 解码 base64 PNG。 */
export function decodePngBase64(b64) {
  return decodePng(Buffer.from(b64, "base64"));
}

/* ---------------------------------------------------------------- 编码 */

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * 把 RGBA 像素编码成 PNG 字节（8 位 RGBA）。
 * 用「每行挑选最小绝对滤波值」的自适应滤波，压缩率接近浏览器产物。
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("PNG 尺寸非法");
  }
  if (rgba.length < width * height * 4) {
    throw new Error("PNG 像素数据长度不足");
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型 RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const filtered = Buffer.allocUnsafe(stride * height + height);
  const bpp = 4;
  const cand = [Buffer.allocUnsafe(stride), Buffer.allocUnsafe(stride), Buffer.allocUnsafe(stride), Buffer.allocUnsafe(stride), Buffer.allocUnsafe(stride)];
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f += 1) {
      const outRow = cand[f];
      let score = 0;
      for (let x = 0; x < stride; x += 1) {
        const cur = rgba[rowStart + x];
        const a = x >= bpp ? rgba[rowStart + x - bpp] : 0;
        const b = y > 0 ? rgba[prevStart + x] : 0;
        const c = x >= bpp && y > 0 ? rgba[prevStart + x - bpp] : 0;
        let v;
        if (f === 0) v = cur;
        else if (f === 1) v = cur - a;
        else if (f === 2) v = cur - b;
        else if (f === 3) v = cur - ((a + b) >> 1);
        else {
          const pp = a + b - c;
          const pa = Math.abs(pp - a);
          const pb = Math.abs(pp - b);
          const pc = Math.abs(pp - c);
          v = cur - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        v &= 0xff;
        outRow[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    filtered[p] = best;
    p += 1;
    cand[best].copy(filtered, p);
    p += stride;
  }

  const idat = zlib.deflateSync(filtered, { level: 6 });
  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 编码成 base64（不带 data: 前缀）。 */
export function encodePngBase64(width, height, rgba) {
  return encodePng(width, height, rgba).toString("base64");
}

/** 生成一张全透明（或指定底色）的 RGBA 画布。 */
export function solidRgba(width, height, rgbaColor) {
  const out = new Uint8Array(width * height * 4);
  if (rgbaColor) {
    for (let i = 0; i < out.length; i += 4) {
      out[i] = rgbaColor[0];
      out[i + 1] = rgbaColor[1];
      out[i + 2] = rgbaColor[2];
      out[i + 3] = rgbaColor[3];
    }
  }
  return out;
}

export { PNG_SIG };
