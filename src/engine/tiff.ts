/**
 * TIFF 解码器（自研）。
 *
 * 立项规划书 §7.5 要求开始页面能导入「PNG / JPEG / WebP / TIFF 等」格式。
 * 浏览器与 WebView2 都解不开 TIFF，所以这里从零写一个够用的基线解码器，
 * 覆盖真实世界里绝大多数 TIFF 的常见组合：
 *
 *  - 压缩：不压缩(1)、LZW(5)、Deflate(8 / 32946)、PackBits(32773)
 *  - 光度：灰度(0 白为零 / 1 黑为零)、RGB(2)、调色板(3)、透明蒙版(4)
 *  - 位深：1 / 2 / 4 / 8 / 16（16 位取高位字节）
 *  - 采样：灰度、Gray+Alpha、RGB、RGBA，附加样本按不透明处理
 *  - 预测器：横向差分(2)，LZW 与 Deflate 常与之搭配
 *
 * 明确不支持（会抛出中文提示，不做静默降级）：
 *  - BigTIFF（版本号 43）
 *  - JPEG 压缩(7)、CCITT 传真压缩、分离平面(PlanarConfiguration = 2)
 *
 * 约定：本文件不引入任何第三方库，也不依赖 WASM。
 */

/** 解码结果：交织好的 RGBA 像素。 */
export interface TiffImage {
  width: number;
  height: number;
  /** 长度 = width * height * 4，可直接喂给 ImageData */
  rgba: Uint8ClampedArray;
}

/** TIFF 6.0 的字段类型编号，只列会遇到的。 */
const enum FieldType {
  Byte = 1,
  Ascii = 2,
  Short = 3,
  Long = 4,
  Rational = 5,
  SByte = 6,
  Undefined = 7,
  SShort = 8,
  SLong = 9,
}

/** 单个 IFD 条目。 */
interface Entry {
  type: number;
  count: number;
  /** 指向文件内的原始值区（4 字节内联时指向条目自身） */
  valueOffset: number;
}

function fail(msg: string): never {
  throw new Error(`TIFF ${msg}`);
}

/** 字节序读取器。TIFF 允许 II（小端）与 MM（大端）两种。 */
class Cursor {
  readonly view: DataView;
  readonly little: boolean;

  constructor(bytes: Uint8Array, little: boolean) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.little = little;
  }

  u16(off: number): number {
    return this.view.getUint16(off, this.little);
  }

  u32(off: number): number {
    return this.view.getUint32(off, this.little);
  }

  get byteLength(): number {
    return this.view.byteLength;
  }
}

/** 一个条目的值宽度（字节）。 */
function typeSize(type: number): number {
  switch (type) {
    case FieldType.Byte:
    case FieldType.Ascii:
    case FieldType.SByte:
    case FieldType.Undefined:
      return 1;
    case FieldType.Short:
    case FieldType.SShort:
      return 2;
    case FieldType.Long:
    case FieldType.SLong:
    case FieldType.Rational:
      return 4;
    default:
      return 0;
  }
}

/** 把条目里的数值全部读出来。只处理整数类型，其余原样跳过。 */
function readNumbers(cur: Cursor, e: Entry): number[] {
  const size = typeSize(e.type);
  if (size === 0) return [];

  const total = size * e.count;
  const base = total <= 4 ? e.valueOffset : cur.u32(e.valueOffset);
  const out: number[] = new Array(e.count);

  for (let i = 0; i < e.count; i++) {
    const p = base + i * size;
    switch (e.type) {
      case FieldType.Byte:
      case FieldType.Undefined:
        out[i] = cur.view.getUint8(p);
        break;
      case FieldType.SByte:
        out[i] = cur.view.getInt8(p);
        break;
      case FieldType.Short:
        out[i] = cur.u16(p);
        break;
      case FieldType.SShort:
        out[i] = cur.view.getInt16(p, cur.little);
        break;
      case FieldType.Long:
        out[i] = cur.u32(p);
        break;
      case FieldType.SLong:
        out[i] = cur.view.getInt32(p, cur.little);
        break;
      case FieldType.Rational:
        out[i] = cur.u32(p);
        break;
      default:
        out[i] = 0;
    }
  }
  return out;
}

/**
 * 条目里的「内联值」在文件中的位置。
 *
 * TIFF 规定：值总字节数 ≤ 4 时，值直接存在条目的 value 字段里，
 * 位置就是条目偏移 + 8。否则 value 字段是一个偏移量。
 * 上面 readNumbers 已按规则取 base，这里补一个语义化入口。
 */
function valueSlot(entryOffset: number): number {
  return entryOffset + 8;
}

/** 解析第一个 IFD，返回 tag → 条目。 */
function readIfd(cur: Cursor, offset: number): Map<number, Entry> {
  if (offset + 2 > cur.byteLength) fail("文件已截断，读不到目录");

  const count = cur.u16(offset);
  const map = new Map<number, Entry>();

  for (let i = 0; i < count; i++) {
    const p = offset + 2 + i * 12;
    if (p + 12 > cur.byteLength) fail("文件已截断，目录不完整");
    const tag = cur.u16(p);
    map.set(tag, {
      type: cur.u16(p + 2),
      count: cur.u32(p + 4),
      valueOffset: valueSlot(p),
    });
  }
  return map;
}

/**
 * LZW 解压。
 *
 * 码宽从 9 位起步，每满一档涨 1 位，最大 12 位。
 * TIFF 用的是 Aldus 原版行为：码宽在 511 / 1023 / 2047 处**提前一位**增长
 * （early = true）。个别非标准编码器按 512 / 1024 / 2048 走，
 * 调用方在结果长度不足时会用 early = false 重试一次。
 */
function lzwDecode(src: Uint8Array, expected: number, early: boolean): Uint8Array {
  const CLEAR = 256;
  const EOI = 257;

  const out = new Uint8Array(Math.max(expected, 1) + 4096);
  let outLen = 0;

  // 字典用「前缀码 + 尾字节」表示一整串，省内存也够快
  const prefix = new Int32Array(4096).fill(-1);
  const suffix = new Uint8Array(4096);
  let tableLen = 258;

  const resetTable = () => {
    for (let i = 0; i < 256; i++) {
      prefix[i] = -1;
      suffix[i] = i;
    }
    tableLen = 258;
  };
  resetTable();

  let bitPos = 0;
  const bitLen = src.length * 8;
  let codeWidth = 9;
  let prev = -1;
  const tmp = new Uint8Array(4096);

  /** 按 MSB 优先读一个码，越界返回 -1。 */
  const readCode = (width: number): number => {
    if (bitPos + width > bitLen) return -1;
    let code = 0;
    for (let i = 0; i < width; i++) {
      const bp = bitPos + i;
      code = (code << 1) | ((src[bp >> 3] >> (7 - (bp & 7))) & 1);
    }
    bitPos += width;
    return code;
  };

  /** 展开一个码并写入 out，返回该串的首字节；损坏时返回 -1。 */
  const emit = (code: number): number => {
    let n = 0;
    let c = code;
    while (c >= 0 && n < 4096) {
      tmp[n++] = suffix[c];
      c = prefix[c];
    }
    if (c >= 0 || n === 0 || outLen + n > out.length) return -1;
    const firstByte = tmp[n - 1];
    for (let i = n - 1; i >= 0; i--) out[outLen++] = tmp[i];
    return firstByte;
  };

  for (;;) {
    const code = readCode(codeWidth);
    if (code < 0 || code === EOI) break;

    if (code === CLEAR) {
      resetTable();
      codeWidth = 9;
      prev = -1;
      continue;
    }

    if (prev < 0) {
      if (code > 255 || emit(code) < 0) return out.subarray(0, outLen);
      prev = code;
      continue;
    }

    let firstByte: number;
    if (code < tableLen) {
      firstByte = emit(code);
      if (firstByte < 0) return out.subarray(0, outLen);
    } else if (code === tableLen) {
      // KwKwK：要输出的串 = 上一条目 + 上一条目的首字节
      firstByte = emit(prev);
      if (firstByte < 0 || outLen >= out.length) {
        return out.subarray(0, outLen);
      }
      out[outLen++] = firstByte;
    } else {
      return out.subarray(0, outLen);
    }

    if (tableLen < 4096) {
      prefix[tableLen] = prev;
      suffix[tableLen] = firstByte;
      tableLen += 1;
      const limit = early ? (1 << codeWidth) - 1 : 1 << codeWidth;
      if (tableLen === limit && codeWidth < 12) codeWidth += 1;
    }
    prev = code;
  }

  return out.subarray(0, outLen);
}

/** PackBits 解压（TIFF 32773）。可整段解，逐行编码的流拼起来结果一致。 */
function packBitsDecode(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(Math.max(expected, src.length * 2, 1));
  let o = 0;
  let i = 0;

  while (i < src.length) {
    const n = (src[i] << 24) >> 24; // 当作有符号字节
    i += 1;
    if (n >= 0) {
      const run = n + 1;
      for (let k = 0; k < run && i < src.length; k++) {
        if (o >= out.length) return out.subarray(0, o);
        out[o++] = src[i++];
      }
    } else if (n !== -128) {
      const run = 1 - n;
      if (i >= src.length) break;
      const v = src[i++];
      for (let k = 0; k < run; k++) {
        if (o >= out.length) return out.subarray(0, o);
        out[o++] = v;
      }
    }
    // n === -128 是空操作，直接跳过
  }
  return out.subarray(0, o);
}

/** Deflate / ZIP 解压。优先按 zlib 包壳解，失败再按裸流解。 */
async function inflate(src: Uint8Array): Promise<Uint8Array> {
  const tryFormat = async (format: "deflate" | "deflate-raw") => {
    const ds = new DecompressionStream(format);
    const buf = new Uint8Array(src.byteLength);
    buf.set(src);
    const stream = new Blob([buf]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };

  try {
    return await tryFormat("deflate");
  } catch {
    try {
      return await tryFormat("deflate-raw");
    } catch {
      fail("Deflate 数据损坏");
    }
  }
}

/** 按字节序读一个 16 位样本。 */
function readU16(data: Uint8Array, off: number, little: boolean): number {
  return little
    ? data[off] | (data[off + 1] << 8)
    : (data[off] << 8) | data[off + 1];
}

/** 按字节序写一个 16 位样本。 */
function writeU16(
  data: Uint8Array,
  off: number,
  v: number,
  little: boolean,
): void {
  if (little) {
    data[off] = v & 0xff;
    data[off + 1] = (v >> 8) & 0xff;
  } else {
    data[off] = (v >> 8) & 0xff;
    data[off + 1] = v & 0xff;
  }
}

/**
 * 横向差分还原（Predictor = 2）。
 *
 * 差分是在**样本**粒度上做的，不是字节粒度：8 位按字节加、16 位按 16 位加。
 * 早先的实现一律按字节处理，8 位恰好正确，16 位则会把两个字节当成两个样本，
 * 结果整幅花掉。1/2/4 位基本不与预测器同现，遇到时直接跳过——
 * 宁可保持原样，也好过按错误的宽度做一次破坏性的还原。
 */
function undoPredictor(
  data: Uint8Array,
  width: number,
  samples: number,
  rowBytes: number,
  rows: number,
  bits: number,
  little: boolean,
): void {
  const bytesPerSample = bits / 8;
  if (!Number.isInteger(bytesPerSample)) return;
  if (bytesPerSample < 1 || bytesPerSample > 2) return;

  const rowSamples = width * samples;

  for (let y = 0; y < rows; y++) {
    const row = y * rowBytes;
    if (bytesPerSample === 1) {
      for (let i = samples; i < rowSamples; i++) {
        data[row + i] = (data[row + i] + data[row + i - samples]) & 0xff;
      }
    } else {
      for (let i = samples; i < rowSamples; i++) {
        const p = row + i * 2;
        const q = row + (i - samples) * 2;
        const v = (readU16(data, p, little) + readU16(data, q, little)) & 0xffff;
        writeU16(data, p, v, little);
      }
    }
  }
}

/** 一次解码所需的全部元信息。 */
interface Layout {
  width: number;
  height: number;
  bits: number;
  samples: number;
  photometric: number;
  compression: number;
  predictor: number;
  rowsPerStrip: number;
  stripOffsets: number[];
  stripCounts: number[];
  colorMap: number[] | null;
  little: boolean;
}

function pick(layout: Layout, index: number, fallback: number): number {
  return index < layout.stripOffsets.length ? layout.stripOffsets[index] : fallback;
}

/** 主入口：把 TIFF 字节解成 RGBA。 */
export async function decodeTiff(bytes: Uint8Array): Promise<TiffImage> {
  if (bytes.byteLength < 8) fail("文件太小，不是有效的 TIFF");

  const b0 = bytes[0];
  const b1 = bytes[1];
  let little: boolean;
  if (b0 === 0x49 && b1 === 0x49) little = true;
  else if (b0 === 0x4d && b1 === 0x4d) little = false;
  else fail("文件头不是 II 或 MM");

  const cur = new Cursor(bytes, little);
  const version = cur.u16(2);
  if (version === 43) fail("BigTIFF 暂不支持，请另存为普通 TIFF");
  if (version !== 42) fail("版本号不是 42，不是标准 TIFF");

  const firstIfd = cur.u32(4);
  if (firstIfd < 8 || firstIfd >= cur.byteLength) fail("目录偏移非法");

  const ifd = readIfd(cur, firstIfd);
  const num = (tag: number, dflt: number): number => {
    const e = ifd.get(tag);
    if (!e) return dflt;
    const v = readNumbers(cur, e);
    return v.length > 0 ? v[0] : dflt;
  };
  const nums = (tag: number): number[] => {
    const e = ifd.get(tag);
    return e ? readNumbers(cur, e) : [];
  };

  const width = num(256, 0);
  const height = num(257, 0);
  if (width <= 0 || height <= 0) fail("宽高缺失或非法");

  const bitsList = nums(258);
  const bits = bitsList.length > 0 ? bitsList[0] : 1;
  const samples = num(277, 1);
  const photometric = num(262, 1);
  const compression = num(259, 1);
  const predictor = num(317, 1);
  const planar = num(284, 1);

  if (planar === 2) fail("分离平面（Planar）的 TIFF 暂不支持");
  if (compression === 7) fail("JPEG 压缩的 TIFF 暂不支持");
  if (compression === 2 || compression === 3 || compression === 4) {
    fail("CCITT 传真压缩的 TIFF 暂不支持");
  }
  if (![1, 5, 8, 32773, 32946].includes(compression)) {
    fail(`压缩方式 ${compression} 暂不支持`);
  }

  const rowsPerStrip = num(278, height);
  const stripOffsets = nums(273);
  const stripCounts = nums(279);
  if (stripOffsets.length === 0) fail("缺少图像数据偏移");

  const colorMapRaw = nums(320);
  const colorMap = colorMapRaw.length > 0 ? colorMapRaw : null;

  const layout: Layout = {
    width,
    height,
    bits,
    samples,
    photometric,
    compression,
    predictor,
    rowsPerStrip: rowsPerStrip > 0 ? rowsPerStrip : height,
    stripOffsets,
    stripCounts,
    colorMap,
    little,
  };

  const rowBytes = Math.ceil((width * samples * bits) / 8);
  const rowsPerBuffer = Math.max(layout.rowsPerStrip, 1);

  // 逐条带解压，拼成一张完整的「原始像素」缓冲
  const raw = new Uint8Array(rowBytes * height);
  let written = 0;

  const stripTotal = Math.ceil(height / rowsPerBuffer);
  for (let s = 0; s < stripTotal; s++) {
    const rowsHere = Math.min(rowsPerBuffer, height - s * rowsPerBuffer);
    const expect = rowBytes * rowsHere;

    const off = pick(layout, s, -1);
    const len = layout.stripCounts.length > s ? layout.stripCounts[s] : 0;
    if (off < 0 || off + len > bytes.byteLength) fail("图像数据偏移越界");

    const chunk = bytes.subarray(off, off + len);
    let out: Uint8Array;

    if (compression === 1) {
      out = chunk;
    } else if (compression === 5) {
      out = lzwDecode(chunk, expect, true);
      if (out.length < expect) {
        const retry = lzwDecode(chunk, expect, false);
        if (retry.length > out.length) out = retry;
      }
    } else if (compression === 8 || compression === 32946) {
      out = await inflate(chunk);
    } else {
      out = packBitsDecode(chunk, expect);
    }

    if (predictor === 2) {
      undoPredictor(out, width, samples, rowBytes, rowsHere, bits, little);
    }

    const take = Math.min(out.length, expect);
    raw.set(out.subarray(0, take), written);
    written += take;
  }

  return { width, height, rgba: toRgba(layout, raw, rowBytes) };
}

/** 把原始像素按光度/位深摊平成 RGBA。 */
function toRgba(
  l: Layout,
  raw: Uint8Array,
  rowBytes: number,
): Uint8ClampedArray {
  const { width, height, bits, samples, photometric, colorMap, little } = l;
  const out = new Uint8ClampedArray(width * height * 4);

  const isPalette = photometric === 3 && colorMap !== null;
  const paletteMax = isPalette ? (1 << bits) - 1 : 0;
  const sampleMax = (1 << bits) - 1;
  const invertGray = photometric === 0;

  // 调色板：ColorMap 是 3 段各 2^bits 个 16 位值（R / G / B）
  // 段首偏移分别落在 0、n、2n（n = 2^bits），不是 0、2n、3n。
  let pg = 0;
  let pb = 0;
  if (isPalette) {
    const n = paletteMax + 1;
    pg = n;
    pb = n * 2;
  }

  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;

    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;

      if (bits === 8) {
        const base = row + x * samples;
        if (isPalette) {
          const idx = raw[base];
          r = colorMap![idx] >> 8;
          g = colorMap![pg + idx] >> 8;
          b = colorMap![pb + idx] >> 8;
        } else if (samples >= 3) {
          r = raw[base];
          g = raw[base + 1];
          b = raw[base + 2];
          if (samples >= 4) a = raw[base + 3];
        } else {
          const v = raw[base];
          r = g = b = invertGray ? 255 - v : v;
          if (samples === 2) a = raw[base + 1];
        }
      } else if (bits === 16) {
        const base = row + x * samples * 2;
        // 取每个样本的高字节映射到 8 位；字节序决定高字节在前还是在后
        const hi = (i: number) =>
          little ? raw[base + i * 2 + 1] : raw[base + i * 2];
        if (samples >= 3) {
          r = hi(0);
          g = hi(1);
          b = hi(2);
          if (samples >= 4) a = hi(3);
        } else {
          const v = hi(0);
          r = g = b = invertGray ? 255 - v : v;
        }
      } else {
        // 1 / 2 / 4 位：按位取，位序 MSB 在前
        const perByte = 8 / bits;
        const idxInRow = Math.floor(x / perByte);
        const slot = 8 - bits - (x % perByte) * bits;
        const v = (raw[row + idxInRow] >> slot) & sampleMax;

        if (isPalette) {
          r = colorMap![v] >> 8;
          g = colorMap![pg + v] >> 8;
          b = colorMap![pb + v] >> 8;
        } else {
          // 灰度：把 v 拉到 0~255
          const gv = Math.round((v * 255) / sampleMax);
          r = g = b = invertGray ? 255 - gv : gv;
        }
      }

      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }

  return out;
}
