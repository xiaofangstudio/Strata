/**
 * 自动调整内核（自动色调 / 自动对比度 / 自动颜色）。
 *
 * 三者都是「先量一量这张图实际用到哪一段色阶，再把那一段拉满」，
 * 区别只在量几张直方图、以及拉之前要不要先校色：
 *
 *   自动对比度 —— 三通道合起来量一张，同一组 lo/hi 拉三个通道。整体拉满
 *                 明暗，但各通道的相对关系不动，所以色相不会跑。
 *   自动色调   —— 每个通道各量各的，各自拉满。偏色的图会被顺手拉回来
 *                 （每个通道都铺满 0–255，灰就真的是灰了）。
 *   自动颜色   —— 先做一次克制的灰世界白平衡把偏色摁下去，再走一遍
 *                 自动对比度。PS 同名功能的思路一致。
 *
 * 直方图只统计**不透明像素**：一张贴在图上的小图，四周大片透明，
 * 若把透明像素算进去（RGB 全是 0），量出来的暗端永远是 0，
 * 自动调整就什么也不会做。这是很多实现看起来「不灵」的根因。
 *
 * 与 `liquify.ts` 一样，本文件只认「RGBA 字节 + 宽高」，不碰画布与 DOM。
 */
import { createRaster, type Raster } from "./raster";

/** 每通道 256 格的计数。 */
export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  /** 参与统计的像素数（不透明像素） */
  count: number;
}

/** PS「自动」系列的默认裁剪量：两端各丢弃 0.1% 的像素。 */
export const AUTO_CLIP = 0.001;

/** 统计一张图的直方图（只算不透明像素）。 */
export function histogram(src: Raster, minAlpha = 8): Histogram {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const { data } = src;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < minAlpha) continue;
    r[data[i]] += 1;
    g[data[i + 1]] += 1;
    b[data[i + 2]] += 1;
    count += 1;
  }
  return { r, g, b, count };
}

/**
 * 由直方图求「有效色阶区间」：两端各裁掉 `clip` 比例的像素。
 *
 * 裁掉极端值而不是直接取最小 / 最大，是为了让一撮高光噪点或一颗死黑像素
 * 不会把整段色阶压扁 —— 直方图两侧各有一个尖峰时，取 min/max 等于没做。
 */
export function clipRange(
  hist: Uint32Array,
  count: number,
  clip = AUTO_CLIP,
): [number, number] {
  if (count <= 0) return [0, 255];
  const cut = count * Math.max(0, Math.min(0.2, clip));
  let acc = 0;
  let lo = 0;
  for (let v = 0; v < 256; v += 1) {
    acc += hist[v];
    if (acc > cut) {
      lo = v;
      break;
    }
  }
  acc = 0;
  let hi = 255;
  for (let v = 255; v >= 0; v -= 1) {
    acc += hist[v];
    if (acc > cut) {
      hi = v;
      break;
    }
  }
  if (hi <= lo) return [0, 255];
  return [lo, hi];
}

/** 由 [lo, hi] 生成 256 格查找表，把该区间铺满 0–255。 */
export function stretchLut(lo: number, hi: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  if (hi <= lo) {
    for (let v = 0; v < 256; v += 1) lut[v] = v;
    return lut;
  }
  const k = 255 / (hi - lo);
  for (let v = 0; v < 256; v += 1) lut[v] = (v - lo) * k;
  return lut;
}

/** 按三张 LUT 就地改写像素（alpha 不动）。 */
export function applyLut(
  src: Raster,
  rl: Uint8ClampedArray,
  gl: Uint8ClampedArray,
  bl: Uint8ClampedArray,
): void {
  const { data } = src;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    data[i] = rl[data[i]];
    data[i + 1] = gl[data[i + 1]];
    data[i + 2] = bl[data[i + 2]];
  }
}

/** 一次自动调整的结果说明（界面用来告诉用户「刚才动了什么」）。 */
export interface AutoReport {
  /** 是否真的改动了像素 */
  changed: boolean;
  /** R / G / B 各自的原始有效区间 */
  ranges: [[number, number], [number, number], [number, number]];
  /** 自动颜色额外报告的白平衡增益（其余为 null） */
  gains: [number, number, number] | null;
}

/** 自动对比度：三通道共用一组区间。 */
export function autoContrast(src: Raster, clip = AUTO_CLIP): AutoReport {
  const hist = histogram(src);
  if (hist.count === 0) {
    return { changed: false, ranges: [[0, 255], [0, 255], [0, 255]], gains: null };
  }
  const sum = new Uint32Array(256);
  for (let v = 0; v < 256; v += 1) sum[v] = hist.r[v] + hist.g[v] + hist.b[v];
  const [lo, hi] = clipRange(sum, hist.count * 3, clip);
  if (lo === 0 && hi === 255) {
    return { changed: false, ranges: [[lo, hi], [lo, hi], [lo, hi]], gains: null };
  }
  const lut = stretchLut(lo, hi);
  applyLut(src, lut, lut, lut);
  return { changed: true, ranges: [[lo, hi], [lo, hi], [lo, hi]], gains: null };
}

/** 自动色调：每个通道各拉各的（顺带中和偏色）。 */
export function autoTone(src: Raster, clip = AUTO_CLIP): AutoReport {
  const hist = histogram(src);
  if (hist.count === 0) {
    return { changed: false, ranges: [[0, 255], [0, 255], [0, 255]], gains: null };
  }
  const rr = clipRange(hist.r, hist.count, clip);
  const gr = clipRange(hist.g, hist.count, clip);
  const br = clipRange(hist.b, hist.count, clip);
  const changed =
    rr[0] !== 0 || rr[1] !== 255 || gr[0] !== 0 || gr[1] !== 255 || br[0] !== 0 || br[1] !== 255;
  if (!changed) return { changed: false, ranges: [rr, gr, br], gains: null };
  applyLut(src, stretchLut(rr[0], rr[1]), stretchLut(gr[0], gr[1]), stretchLut(br[0], br[1]));
  return { changed: true, ranges: [rr, gr, br], gains: null };
}

/** 灰世界增益的收敛范围：再偏也不许把通道乘成两倍或砍掉一半。 */
const GAIN_MIN = 0.82;
const GAIN_MAX = 1.22;

/**
 * 自动颜色：克制的灰世界白平衡 + 自动对比度。
 *
 * 增益夹在一个窄区间里是刻意的。纯灰世界假设「整张图的平均色应该是灰」，
 * 这对偏色的产品照成立，对一张晚霞或一片森林则会直接毁掉现场感 ——
 * 把暖色景物硬拉成中性灰，看起来像曝光错了。夹住增益等于说：
 * 「只修疑似偏色的那点量，剩下交给自动对比度」。
 */
export function autoColor(src: Raster, clip = AUTO_CLIP): AutoReport {
  const hist = histogram(src);
  if (hist.count === 0) {
    return { changed: false, ranges: [[0, 255], [0, 255], [0, 255]], gains: null };
  }
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let v = 0; v < 256; v += 1) {
    sr += v * hist.r[v];
    sg += v * hist.g[v];
    sb += v * hist.b[v];
  }
  const ar = sr / hist.count;
  const ag = sg / hist.count;
  const ab = sb / hist.count;
  const mean = (ar + ag + ab) / 3;
  const clampGain = (g: number) =>
    g < GAIN_MIN ? GAIN_MIN : g > GAIN_MAX ? GAIN_MAX : g;
  const gain = [
    mean > 0 && ar > 0 ? clampGain(mean / ar) : 1,
    mean > 0 && ag > 0 ? clampGain(mean / ag) : 1,
    mean > 0 && ab > 0 ? clampGain(mean / ab) : 1,
  ] as [number, number, number];

  const balanced = Math.abs(gain[0] - 1) > 0.005 ||
    Math.abs(gain[1] - 1) > 0.005 ||
    Math.abs(gain[2] - 1) > 0.005;
  if (balanced) {
    const { data } = src;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      data[i] = data[i] * gain[0];
      data[i + 1] = data[i + 1] * gain[1];
      data[i + 2] = data[i + 2] * gain[2];
    }
  }
  const rep = autoContrast(src, clip);
  return {
    changed: balanced || rep.changed,
    ranges: rep.ranges,
    gains: balanced ? gain : null,
  };
}

/** 复制一份再跑（非破坏版；界面预览用）。 */
export function autoOn(src: Raster, kind: "contrast" | "tone" | "color"): {
  raster: Raster;
  report: AutoReport;
} {
  const copy = createRaster(src.width, src.height);
  copy.data.set(src.data);
  const report =
    kind === "contrast" ? autoContrast(copy) : kind === "tone" ? autoTone(copy) : autoColor(copy);
  return { raster: copy, report };
}
