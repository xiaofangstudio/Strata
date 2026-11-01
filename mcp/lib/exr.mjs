/**
 * OpenEXR 读取器（纯 JS，Node 侧用）。
 *
 * 应用里解 EXR 走的是 Rust 的 `exr` crate；MCP 是独立的 Node 进程，拿不到那段代码，
 * 所以这里实现一份「够用就好」的读取器：
 *
 *   · 支持 **NONE / RLE / ZIPS（1 行一块）/ ZIP（16 行一块）** 四种压缩
 *     （OpenEXR 默认就是 ZIP，覆盖面最大）；
 *   · 通道支持 HALF / FLOAT / UINT，能拼出 R/G/B/A，也能处理只有 Y 的灰度文件；
 *   · **PIZ / PXR24 / B44 / DWAA / DWAB 明确报错**（解压算法复杂，宁可说清楚也不糊弄）；
 *   · 多部件（multipart）能列出全部部件并逐部件解码；瓦片（tiled）与深数据（deep）报错。
 *
 * 输出统一是 8 位 sRGB RGBA —— EXR 存的是线性光，落地到 PNG/GIF 时必须做一次
 * sRGB 编码，否则暗部会塌成一团。
 */
import { inflateSync } from "node:zlib";

const MAGIC = 0x01312f76;

export const COMPRESSION_NAMES = [
  "NONE",
  "RLE",
  "ZIPS",
  "ZIP",
  "PIZ",
  "PXR24",
  "B44",
  "B44A",
  "DWAA",
  "DWAB",
];

/** 每种压缩一个块里包含多少扫描线。 */
const LINES_PER_CHUNK = [1, 1, 1, 16, 32, 16, 32, 32, 32, 256];

/** 我们能解的压缩方式。 */
const SUPPORTED = new Set([0, 1, 2, 3]);

/* ------------------------------------------------------------ 基础读取 */

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const i32 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
const f32 = (b, o) => new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, true);
const u64 = (b, o) => Number(new DataView(b.buffer, b.byteOffset + o, 8).getBigUint64(0, true));

function cstr(b, o) {
  let e = o;
  while (e < b.length && b[e] !== 0) e += 1;
  return { text: Buffer.from(b.buffer, b.byteOffset + o, e - o).toString("utf8"), next: e + 1 };
}

/* ---------------------------------------------------------------- 半精度 */

const HALF = (() => {
  const t = new Float32Array(65536);
  for (let i = 0; i < 65536; i += 1) {
    const s = (i & 0x8000) >> 15;
    const e = (i & 0x7c00) >> 10;
    const f = i & 0x03ff;
    if (e === 0) t[i] = (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
    else if (e === 0x1f) t[i] = f ? Number.NaN : (s ? -1 : 1) * Infinity;
    else t[i] = (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  return t;
})();

const halfAt = (b, o) => HALF[b[o] | (b[o + 1] << 8)];

/* ---------------------------------------------------------------- 头解析 */

function parseAttrs(b, start) {
  let p = start;
  const attrs = {};
  for (;;) {
    const name = cstr(b, p);
    p = name.next;
    if (!name.text) break;
    const type = cstr(b, p);
    p = type.next;
    const size = i32(b, p);
    p += 4;
    attrs[name.text] = { type: type.text, offset: p, size };
    p += size;
  }
  return { attrs, end: p };
}

function readChannels(b, attrs) {
  const a = attrs.channels;
  if (!a) throw new Error("EXR 缺少 channels 属性");
  const out = [];
  let p = a.offset;
  const end = a.offset + a.size;
  while (p < end && b[p] !== 0) {
    const nm = cstr(b, p);
    p = nm.next;
    const type = i32(b, p);
    p += 4;
    p += 4; // pLinear(1) + 保留(3)
    const xSampling = i32(b, p);
    p += 4;
    const ySampling = i32(b, p);
    p += 4;
    out.push({ name: nm.text, type, xSampling, ySampling });
  }
  // OpenEXR 规定通道按名字字典序存放，直接排一遍更稳
  out.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  return out;
}

/** 解析整个文件的所有头（单部件 / 多部件都走这里）。 */
function parseFile(bytes) {
  if (bytes.length < 8 || u32(bytes, 0) !== MAGIC) {
    throw new Error("不是 OpenEXR 文件（魔数不对）");
  }
  const version = u32(bytes, 4);
  if (version & 0x200) throw new Error("暂不支持瓦片（tiled）EXR，请用扫描线格式");
  if (version & 0x800) throw new Error("暂不支持深数据（deep）EXR");
  const multipart = (version & 0x1000) !== 0;

  const parts = [];
  let p = 8;
  for (;;) {
    const h = parseAttrs(bytes, p);
    const chans = readChannels(bytes, h.attrs);
    const dw = h.attrs.dataWindow;
    if (!dw) throw new Error("EXR 缺少 dataWindow 属性");
    const xMin = i32(bytes, dw.offset);
    const yMin = i32(bytes, dw.offset + 4);
    const xMax = i32(bytes, dw.offset + 8);
    const yMax = i32(bytes, dw.offset + 12);
    const comp = u8Of(bytes, h.attrs);
    const nameAttr = h.attrs.name;
    parts.push({
      index: parts.length,
      name: nameAttr
        ? Buffer.from(bytes.buffer, bytes.byteOffset + nameAttr.offset, nameAttr.size)
            .toString("utf8")
            .replace(/\0+$/, "")
        : `part${parts.length}`,
      xMin,
      yMin,
      width: xMax - xMin + 1,
      height: yMax - yMin + 1,
      compression: comp,
      channels: chans,
      headerEnd: h.end,
    });
    p = h.end;
    if (!multipart) break;
    if (bytes[p] === 0) {
      p += 1;
      break;
    }
  }
  const tableStart = p;
  // 每个部件的偏移表依次排列
  let t = tableStart;
  for (const part of parts) {
    part.tableAt = t;
    part.chunkCount = Math.ceil(part.height / LINES_PER_CHUNK[part.compression]);
    t += part.chunkCount * 8;
  }
  return { parts, multipart };
}

function u8Of(bytes, attrs) {
  const a = attrs.compression;
  if (!a) throw new Error("EXR 缺少 compression 属性");
  return bytes[a.offset];
}

/* ---------------------------------------------------------------- 解压 */

/** EXR 的 RLE：每段先读一个有符号 int8 计数，负数=字面量，正数=重复。 */
function rleDecode(src, expected) {
  const out = new Uint8Array(expected);
  let si = 0;
  let oi = 0;
  while (si < src.length && oi < expected) {
    const n = (src[si] << 24) >> 24;
    si += 1;
    if (n < 0) {
      const count = -n;
      out.set(src.subarray(si, si + count), oi);
      si += count;
      oi += count;
    } else {
      const v = src[si];
      si += 1;
      out.fill(v, oi, oi + n);
      oi += n;
    }
  }
  return out;
}

/* ------------------------------------------------------------ 对外 API */

/** 列出文件里的全部部件（不解像素，纯看头）。 */
export function exrInfo(bytes) {
  const { parts, multipart } = parseFile(bytes);
  return {
    multipart,
    count: parts.length,
    parts: parts.map((p) => ({
      index: p.index,
      name: p.name,
      width: p.width,
      height: p.height,
      compression: COMPRESSION_NAMES[p.compression] ?? String(p.compression),
      supported: SUPPORTED.has(p.compression),
      channels: p.channels.map((c) => ({
        name: c.name,
        type: c.type === 0 ? "UINT" : c.type === 1 ? "HALF" : "FLOAT",
        sampling: `${c.xSampling}x${c.ySampling}`,
      })),
    })),
  };
}

/** 解码一个部件为 8 位 sRGB RGBA。 */
export function exrDecode(bytes, index = 0) {
  const { parts, multipart } = parseFile(bytes);
  const part = parts[index];
  if (!part) throw new Error(`没有第 ${index} 个部件（共 ${parts.length} 个）`);
  if (!SUPPORTED.has(part.compression)) {
    throw new Error(
      `这个 EXR 用的是 ${COMPRESSION_NAMES[part.compression]} 压缩，MCP 侧暂不支持` +
        `（支持 NONE / RLE / ZIPS / ZIP）。可以用应用里的「文件 > 打开 EXR 部件」读它。`,
    );
  }

  const { width, height, xMin, yMin, channels, compression } = part;
  const linesPer = LINES_PER_CHUNK[compression];
  const w = width;

  const bytesPerSample = (type) => (type === 1 ? 2 : 4);
  const chanBytes = channels.reduce((s, c) => s + bytesPerSample(c.type) * w, 0);
  const rawChunk = chanBytes * linesPer;

  const planes = new Map();
  for (const c of channels) planes.set(c.name, new Float32Array(w * height));

  for (let ci = 0; ci < part.chunkCount; ci += 1) {
    let q = u64(bytes, part.tableAt + ci * 8);
    if (multipart) q += 4; // 多部件的块头多一个部件号
    const chunkY = i32(bytes, q);
    q += 4;
    const dataSize = i32(bytes, q);
    q += 4;
    const payload = bytes.subarray(q, q + dataSize);

    let raw;
    if (compression === 0) raw = payload;
    else if (compression === 1) raw = rleDecode(payload, rawChunk);
    else raw = inflateSync(payload);

    let o = 0;
    for (const c of channels) {
      const plane = planes.get(c.name);
      const bps = bytesPerSample(c.type);
      for (let li = 0; li < linesPer; li += 1) {
        const y = chunkY + li - yMin;
        if (y < 0 || y >= height) {
          o += w * bps;
          continue;
        }
        const row = y * w;
        for (let x = 0; x < w; x += 1) {
          let v;
          if (c.type === 1) v = halfAt(raw, o);
          else if (c.type === 0) v = u32(raw, o) / 4294967295;
          else v = f32(raw, o);
          o += bps;
          plane[row + x] = v;
        }
      }
    }
  }

  const pick = (...names) => {
    for (const n of names) if (planes.has(n)) return planes.get(n);
    return null;
  };
  const R = pick("R", "r");
  const G = pick("G", "g");
  const B = pick("B", "b");
  const A = pick("A", "a");
  const Y = pick("Y", "y");

  const srgb = (v) => {
    if (!Number.isFinite(v)) return 0;
    const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
    return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  };

  const out = new Uint8ClampedArray(w * height * 4);
  for (let i = 0; i < w * height; i += 1) {
    let r;
    let g;
    let b;
    if (R && G && B) {
      r = R[i];
      g = G[i];
      b = B[i];
    } else if (Y) {
      r = Y[i];
      g = Y[i];
      b = Y[i];
    } else {
      const first = [...planes.values()][0];
      r = g = b = first ? first[i] : 0;
    }
    out[i * 4] = Math.round(srgb(r) * 255);
    out[i * 4 + 1] = Math.round(srgb(g) * 255);
    out[i * 4 + 2] = Math.round(srgb(b) * 255);
    out[i * 4 + 3] = A ? Math.round(Math.min(1, Math.max(0, A[i])) * 255) : 255;
  }
  return { width: w, height, data: out, part: part.name, compression: COMPRESSION_NAMES[compression] };
}
