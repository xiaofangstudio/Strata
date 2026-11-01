/**
 * GIF89a 编码器（纯 TS，零依赖）。
 *
 * 「文件 > 导出 > 渲染视频」的落点：Strata 的视频图层是帧序列模型，
 * 把每一帧合成后交给这里，就能导出真正能动的 GIF —— 不用引 ffmpeg
 * 那种几百 MB 的原生依赖，也符合「体积红线 ≤ 100MB」。
 *
 * 结构：文件头 + 逻辑屏描述 + NETSCAPE 循环扩展 + 每帧
 * （图像控制扩展 + 局部色表 + LZW 图像数据）+ 结束符。
 * 量化复用 core/colorMode 的中位切分（每帧局部 256 色），最近邻映射带缓存。
 */
import { medianCutPalette } from "../core/colorMode";
import type { RgbaBuffer } from "./filters/kernels";

/** 一帧的输入：RGBA 像素 + 尺寸 + 停留时长（秒）。 */
export interface GifFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** 该帧停留多少秒；GIF 内部按 1/100 秒取整，不足 0.02s 按 0.02s 记 */
  delay: number;
}

type Rgb = readonly [number, number, number];

/* ------------------------------------------------------------------ LZW */

/**
 * GIF 变体 LZW 压缩。
 *
 * 与普通 GIF-TIFF LZW 的差别：码长从 minCodeSize+1 起、有清除码/结束码、
 * 码长最大 12 位（到 4096 就发清除码重置字典）、按位打包时低位在前。
 */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): number[] {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  const dict = new Map<number, number>(); // key = (prefix << 8) | k

  const bytes: number[] = [];
  let bitBuf = 0;
  let bitCnt = 0;
  const emit = (code: number) => {
    bitBuf |= code << bitCnt;
    bitCnt += codeSize;
    while (bitCnt >= 8) {
      bytes.push(bitBuf & 0xff);
      bitBuf >>= 8;
      bitCnt -= 8;
    }
  };

  if (indices.length === 0) {
    emit(clearCode);
    emit(eoiCode);
    if (bitCnt > 0) bytes.push(bitBuf & 0xff);
    return bytes;
  }

  emit(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix);
    dict.set(key, nextCode);
    // 码长增长时机（经 PIL 实测裁决的标准行为）：刚分配出去的码顶满
    // 2^codeSize 时立刻加长，然后才轮到下一个号。判早了或判晚了，
    // 解码器都会在边界处错一位，整条流就废了。
    if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
    nextCode += 1;
    if (nextCode === 4096) {
      emit(clearCode);
      dict.clear();
      nextCode = eoiCode + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoiCode);
  if (bitCnt > 0) bytes.push(bitBuf & 0xff);
  return bytes;
}

/** 把字节流按 GIF 的子块格式打包：每 ≤255 字节前面放一个长度字节，最后补 0。 */
function toSubBlocks(bytes: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

/* -------------------------------------------------------------- 量化 */

/** 最近邻查表缓存：RGB 各取高 5 位做键，命中前先建索引。 */
class NearestPalette {
  private cache = new Map<number, number>();

  constructor(private readonly palette: Rgb[]) {}

  indexOf(r: number, g: number, b: number): number {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    let best = 0;
    let bestD = Infinity;
    const pal = this.palette;
    for (let i = 0; i < pal.length; i += 1) {
      const dr = r - pal[i][0];
      const dg = g - pal[i][1];
      const db = b - pal[i][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.cache.set(key, best);
    return best;
  }
}

/** 给一帧建 256 色局部色表，并返回每个像素的调色板下标。 */
export function quantizeFrame(frame: GifFrame): { indices: Uint8Array; palette: Rgb[] } {
  const buf: RgbaBuffer = {
    data: frame.data instanceof Uint8ClampedArray ? frame.data : new Uint8ClampedArray(frame.data),
    width: frame.width,
    height: frame.height,
  };
  const palette = medianCutPalette(buf, 256);
  const nearest = new NearestPalette(palette);
  const n = frame.width * frame.height;
  const indices = new Uint8Array(n);
  const d = buf.data;
  for (let p = 0; p < n; p += 1) {
    const i = p * 4;
    indices[p] = d[i + 3] < 8 ? 0 : nearest.indexOf(d[i], d[i + 1], d[i + 2]);
  }
  // GIF 色表固定 2 的幂大小；这里统一补到 256（packed 直接写 7）
  while (palette.length < 256) palette.push([0, 0, 0] as Rgb);
  return { indices, palette };
}

/* -------------------------------------------------------------- 组装 */

const U16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];

/**
 * 把若干帧编成一个 GIF 文件。
 *
 * @param frames 全部帧（尺寸必须一致；透明像素按第 0 号色处理）
 * @param loop 循环次数，0 = 无限循环
 */
export function encodeGif(frames: GifFrame[], loop = 0): Uint8Array {
  if (frames.length === 0) throw new Error("没有可导出的帧");
  const w = frames[0].width;
  const h = frames[0].height;
  for (const f of frames) {
    if (f.width !== w || f.height !== h) {
      throw new Error("各帧尺寸不一致，无法合成 GIF");
    }
  }

  const out: number[] = [];
  // 头 + 逻辑屏：无全局色表（bit7=0），背景色 0
  out.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // "GIF89a"
  out.push(...U16(w), ...U16(h), 0x70, 0x00, 0x00);

  // NETSCAPE2.0 循环扩展
  out.push(0x21, 0xff, 0x0b);
  for (const c of "NETSCAPE2.0") out.push(c.charCodeAt(0));
  out.push(0x03, 0x01, ...U16(loop), 0x00);

  for (const frame of frames) {
    const { indices, palette } = quantizeFrame(frame);
    // 图像控制扩展：不处理透明（bit 低 3 位 = 001 不处置），延时按 1/100 秒
    const delay = Math.max(2, Math.round(frame.delay * 100));
    out.push(0x21, 0xf9, 0x04, 0x04, ...U16(delay), 0x00, 0x00);
    // 图像描述符：带局部色表（bit7=0x80），表大小 256 → packed = 0x87
    out.push(0x2c, ...U16(0), ...U16(0), ...U16(w), ...U16(h), 0x87);
    for (const c of palette) out.push(c[0] & 0xff, c[1] & 0xff, c[2] & 0xff);
    out.push(8); // LZW 最小码长
    out.push(...toSubBlocks(lzwEncode(indices, 8)));
  }

  out.push(0x3b); // 结束符
  return new Uint8Array(out);
}

/** 便捷：从一份 RgbaBuffer 序列直接编码（时长统一）。 */
export function encodeGifFromBuffers(
  bufs: RgbaBuffer[],
  fps: number,
  loop = 0,
): Uint8Array {
  return encodeGif(
    bufs.map((b) => ({ data: b.data, width: b.width, height: b.height, delay: 1 / fps })),
    loop,
  );
}

/** 供测试/调试用：把一张纯色图编码后解出关键头部信息。 */
export function gifHeaderInfo(bytes: Uint8Array): { w: number; h: number; frames: number } {
  const dv = (i: number) => bytes[i] | (bytes[i + 1] << 8);
  let p = 13; // 头(6) + 逻辑屏(7)
  let frames = 0;
  while (p < bytes.length) {
    const b = bytes[p];
    if (b === 0x3b) break;
    if (b === 0x21) {
      p += 2;
      while (bytes[p] !== 0) p += bytes[p] + 1;
      p += 1;
      continue;
    }
    if (b === 0x2c) {
      frames += 1;
      p += 9; // 描述符
      const packed = bytes[p - 1];
      if (packed & 0x80) p += 3 * (2 << (packed & 7));
      p += 1; // LZW 最小码长
      while (bytes[p] !== 0) p += bytes[p] + 1;
      p += 1;
      continue;
    }
    p += 1;
  }
  return { w: dv(6), h: dv(8), frames };
}
