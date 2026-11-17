/**
 * 拉普拉斯金字塔多频段融合 / 焦堆栈融合。
 *
 * Ported from ArtCraft PhotoCraft (crates/algo/src/pyramid.rs), MIT / Apache-2.0。
 * Burt & Adelson：图像拆成带通层 + 低通残差，权重图做高斯金字塔，
 * 每层分别混合后 collapse。焦堆栈权重取亮度拉普拉斯能量，先做 halo 扩散，
 * 这样清晰区域的边界不会在融合结果里留下暗边/亮边光晕。
 *
 * 纯函数：只吃 Float32Array / RgbaBuffer，不碰 DOM。
 */
import { boxMean } from "./guidedFilter";
import type { RgbaBuffer } from "../filters/kernels";

export interface Plane {
  data: Float32Array;
  width: number;
  height: number;
}

/** 5-tap 二项核，reduce/expand 共用。 */
const KERNEL = [1, 4, 6, 4, 1] as const;
const KSUM = 16;

/** 短边小于等于 8 时停止；上限 8 层防止超大图爆内存。 */
export function autoLevels(w: number, h: number, minSide = 8): number {
  let levels = 1;
  let side = Math.min(w, h);
  while (side > minSide && levels < 8) {
    side = Math.ceil(side / 2);
    levels += 1;
  }
  return levels;
}

function binom(i: number): number {
  return i >= -2 && i <= 2 ? KERNEL[i + 2] / KSUM : 0;
}

/**
 * 1D expand：插零后用 2× 二项核卷积。
 * 偶数位置只取 reduce 核的偶抽头，奇数位置只取奇抽头；漏掉这一步会把高频
 * 幅度压掉，焦堆栈融合出来就是一片糊。
 */
function expand1D(src: Float32Array, len: number, x: number): number {
  const at = (i: number) => src[Math.min(len - 1, Math.max(0, i))];
  if (x % 2 === 0) {
    const i = x / 2;
    return 2 * (binom(-2) * at(i + 1) + binom(0) * at(i) + binom(2) * at(i - 1));
  }
  const i = (x - 1) / 2;
  return 2 * (binom(-1) * at(i + 1) + binom(1) * at(i));
}

/** 5-tap 低通 + 2× 降采样；尺寸向上取整，边界夹取。 */
export function reducePlane(src: Plane): Plane {
  const w = Math.ceil(src.width / 2);
  const h = Math.ceil(src.height / 2);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const cy = y * 2;
    for (let x = 0; x < w; x += 1) {
      const cx = x * 2;
      let sum = 0;
      for (let k = -2; k <= 2; k += 1) {
        const sy = Math.min(src.height - 1, Math.max(0, cy + k));
        const wy = binom(k);
        if (wy === 0) continue;
        for (let j = -2; j <= 2; j += 1) {
          const sx = Math.min(src.width - 1, Math.max(0, cx + j));
          sum += src.data[sy * src.width + sx] * wy * binom(j);
        }
      }
      out[y * w + x] = sum;
    }
  }
  return { data: out, width: w, height: h };
}

/** 插零 + 同核低通 + 4× 增益，涨到指定尺寸。 */
export function expandPlane(src: Plane, width: number, height: number): Plane {
  const out = new Float32Array(width * height);
  // 先按列、再按行做 1D expand，等价于二维「插零 + 2× 二项核」。
  const rows = new Float32Array(height * src.width);
  const col = new Float32Array(src.height);
  for (let x = 0; x < src.width; x += 1) {
    for (let y = 0; y < src.height; y += 1) col[y] = src.data[y * src.width + x];
    for (let y = 0; y < height; y += 1) rows[y * src.width + x] = expand1D(col, src.height, y);
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      out[y * width + x] = expand1D(
        rows.subarray(y * src.width, y * src.width + src.width), src.width, x,
      );
    }
  }
  return { data: out, width, height };
}

/** 高斯金字塔，G[0] 为原尺寸。 */
export function gaussianPyramid(src: Plane, levels: number): Plane[] {
  const out: Plane[] = [src];
  for (let i = 1; i < levels && out[i - 1].width > 1 && out[i - 1].height > 1; i += 1) {
    out.push(reducePlane(out[i - 1]));
  }
  return out;
}

/** 拉普拉斯金字塔：L[l] = G[l] - expand(G[l+1])，最顶层保留低通残差。 */
export function laplacianPyramid(src: Plane, levels: number): Plane[] {
  const g = gaussianPyramid(src, levels);
  const out: Plane[] = [];
  for (let i = 0; i < g.length - 1; i += 1) {
    const e = expandPlane(g[i + 1], g[i].width, g[i].height);
    const data = new Float32Array(g[i].data.length);
    for (let p = 0; p < data.length; p += 1) data[p] = g[i].data[p] - e.data[p];
    out.push({ data, width: g[i].width, height: g[i].height });
  }
  out.push(g[g.length - 1]);
  return out;
}

/** 由拉普拉斯金字塔精确重建（未混合时逐像素回到原图）。 */
export function collapsePyramid(lap: Plane[]): Plane {
  let acc = lap[lap.length - 1];
  for (let i = lap.length - 2; i >= 0; i -= 1) {
    const e = expandPlane(acc, lap[i].width, lap[i].height);
    for (let p = 0; p < e.data.length; p += 1) e.data[p] += lap[i].data[p];
    acc = e;
  }
  return acc;
}

/** 亮度平面。 */
export function lumaPlane(img: RgbaBuffer): Plane {
  const data = new Float32Array(img.width * img.height);
  for (let p = 0; p < data.length; p += 1) {
    const i = p * 4;
    data[p] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  }
  return { data, width: img.width, height: img.height };
}

function channelPlane(img: RgbaBuffer, ch: number): Plane {
  const data = new Float32Array(img.width * img.height);
  for (let p = 0; p < data.length; p += 1) data[p] = img.data[p * 4 + ch];
  return { data, width: img.width, height: img.height };
}

/** 焦点能量：3×3 拉普拉斯绝对值 + halo 盒式扩散，再按 power 拉大清晰/模糊差距。 */
export function focusWeights(imgs: RgbaBuffer[], halo = 2, power = 1.4): Float32Array[] {
  const w = imgs[0].width;
  const h = imgs[0].height;
  const radius = Math.max(0, Math.round(halo));
  return imgs.map((img) => {
    const lum = lumaPlane(img).data;
    const raw = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const p = y * w + x;
        const lap = 4 * lum[p] - lum[p - 1] - lum[p + 1] - lum[p - w] - lum[p + w];
        raw[p] = Math.abs(lap);
      }
    }
    const spread = radius > 0 ? boxMean(raw, w, h, radius) : raw;
    const out = new Float32Array(w * h);
    for (let p = 0; p < out.length; p += 1) {
      const a = img.data[p * 4 + 3] / 255;
      out[p] = Math.pow(spread[p] + 1e-6, power) * a;
    }
    return out;
  });
}

/** 逐像素归一化权重：Σ_i w_i[p] = 1。 */
function normalizeWeights(weights: Float32Array[]): Float32Array[] {
  const n = weights[0].length;
  const out = weights.map(() => new Float32Array(n));
  for (let p = 0; p < n; p += 1) {
    let sum = 0;
    for (const w of weights) sum += w[p];
    if (sum <= 1e-12) {
      for (const o of out) o[p] = 1 / weights.length;
    } else {
      for (let i = 0; i < weights.length; i += 1) out[i][p] = weights[i][p] / sum;
    }
  }
  return out;
}

function blendOne(
  planes: Plane[],
  weightLaps: Plane[][],
  levels: number,
): Plane {
  const laps = planes.map((p) => laplacianPyramid(p, levels));
  const blended: Plane[] = [];
  for (let l = 0; l < laps[0].length; l += 1) {
    const size = laps[0][l];
    const acc = new Float32Array(size.data.length);
    const den = new Float32Array(size.data.length);
    for (let i = 0; i < laps.length; i += 1) {
      const wp = weightLaps[i][l].data;
      const lp = laps[i][l].data;
      for (let p = 0; p < acc.length; p += 1) {
        const wgt = Math.max(0, wp[p]);
        acc[p] += lp[p] * wgt;
        den[p] += wgt;
      }
    }
    for (let p = 0; p < acc.length; p += 1) acc[p] = den[p] > 1e-10 ? acc[p] / den[p] : 0;
    blended.push({ data: acc, width: size.width, height: size.height });
  }
  return collapsePyramid(blended);
}

export interface PyramidBlendOptions {
  levels?: number;
  halo?: number;
  power?: number;
}

/**
 * 多张 JPEG/像素缓冲的焦堆栈融合。要求所有输入尺寸相同。
 * 相同图混合结果逐像素等于原图；不同焦面按局部清晰度选频带。
 */
export function fuseStackPyramid(imgs: RgbaBuffer[], opts: PyramidBlendOptions = {}): RgbaBuffer {
  if (imgs.length === 0) throw new Error("fuseStackPyramid: empty input");
  const w = imgs[0].width;
  const h = imgs[0].height;
  if (imgs.some((b) => b.width !== w || b.height !== h)) {
    throw new Error("fuseStackPyramid: size mismatch");
  }
  if (imgs.length === 1) return imgs[0];
  const levels = Math.max(1, opts.levels ?? autoLevels(w, h));
  const weights = normalizeWeights(focusWeights(imgs, opts.halo ?? 2, opts.power ?? 1.4));
  // 权重走高斯金字塔：每层仍是归一化权重图，不能直接拆成带通残差。
  const weightLaps = weights.map((m) => gaussianPyramid({ data: m, width: w, height: h }, levels));

  const out: RgbaBuffer = {
    data: new Uint8ClampedArray(w * h * 4),
    width: w,
    height: h,
  };
  for (let ch = 0; ch < 4; ch += 1) {
    const merged = blendOne(imgs.map((b) => channelPlane(b, ch)), weightLaps, levels);
    for (let p = 0; p < w * h; p += 1) out.data[p * 4 + ch] = merged.data[p];
  }
  return out;
}

/**
 * 两张图的无缝多频段混合（自动混合旧入口）：mask 为 0~1 的软权重，1 取 second。
 */
export function blendTwoPyramid(
  first: RgbaBuffer,
  second: RgbaBuffer,
  mask: Float32Array,
  opts: PyramidBlendOptions = {},
): RgbaBuffer {
  const w = first.width;
  const h = first.height;
  if (second.width !== w || second.height !== h || mask.length !== w * h) {
    throw new Error("blendTwoPyramid: size mismatch");
  }
  const levels = Math.max(1, opts.levels ?? autoLevels(w, h));
  const weights = [new Float32Array(w * h), new Float32Array(w * h)];
  for (let p = 0; p < w * h; p += 1) {
    const a = Math.min(1, Math.max(0, mask[p]));
    weights[0][p] = 1 - a;
    weights[1][p] = a;
  }
  // 权重走高斯金字塔：每层仍是归一化权重图，不能直接拆成带通残差。
  const weightLaps = weights.map((m) => gaussianPyramid({ data: m, width: w, height: h }, levels));
  const out: RgbaBuffer = {
    data: new Uint8ClampedArray(w * h * 4),
    width: w,
    height: h,
  };
  for (let ch = 0; ch < 4; ch += 1) {
    const merged = blendOne([channelPlane(first, ch), channelPlane(second, ch)], weightLaps, levels);
    for (let p = 0; p < w * h; p += 1) out.data[p * 4 + ch] = merged.data[p];
  }
  return out;
}
