/**
 * Select Sky：经典（非学习）天空分割。
 *
 * Ported from ArtCraft PhotoCraft (crates/algo/src/segment/sky.rs), MIT / Apache-2.0。
 * 颜色先验（蓝天/阴天/晚霞）× 梯度平滑度 → 似然图；顶部种子区域生长；
 * GMM 补上枝叶间隙里与天空同色的像素；最后用灰度引导滤波在全分辨率柔化边缘。
 * 纯函数，不碰 DOM。
 */
import { boxMean, guidedFilterGray } from "./guidedFilter";
import { Gmm, subsample } from "./gmm";

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** 单个颜色的天空先验（0..1）。 */
export function colourPrior(r: number, g: number, b: number): number {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const y = luma(rr, gg, bb);
  const mx = Math.max(rr, gg, bb);
  const mn = Math.min(rr, gg, bb);
  const sat = mx > 1e-4 ? (mx - mn) / mx : 0;
  const blue = smooth(0.02, 0.12, bb - rr) * smooth(-0.12, 0, bb - gg) * smooth(0.18, 0.4, y);
  const white = smooth(0.5, 0.75, y) * (1 - smooth(0.12, 0.3, sat));
  const warm = 0.6 * smooth(0.55, 0.8, y) * smooth(0, 0.1, rr - bb) * (1 - smooth(0.05, 0.25, gg - bb - 0.2));
  return Math.max(blue, white, warm);
}

/** 天空似然：颜色先验 ×（1 − 局部纹理）。 */
export function skyLikelihood(d: Uint8ClampedArray, w: number, h: number): Float32Array {
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const p = i * 4;
    lum[i] = luma(d[p] / 255, d[p + 1] / 255, d[p + 2] / 255);
  }
  const at = (x: number, y: number) => lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const grad = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)
        - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)
        - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      grad[y * w + x] = Math.hypot(gx, gy) / 8;
    }
  }
  const tex = boxMean(grad, w, h, 2);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i += 1) {
    const p = i * 4;
    out[i] = colourPrior(d[p], d[p + 1], d[p + 2]) * (1 - smooth(0.015, 0.07, tex[i]));
  }
  return out;
}

function downsample(d: Uint8ClampedArray, w: number, h: number, step: number): {
  data: Uint8ClampedArray; w: number; h: number;
} {
  const sw = Math.ceil(w / step);
  const sh = Math.ceil(h / step);
  const out = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) {
      const from = (Math.min(h - 1, y * step) * w + Math.min(w - 1, x * step)) * 4;
      out.set(d.subarray(from, from + 4), (y * sw + x) * 4);
    }
  }
  return { data: out, w: sw, h: sh };
}

/** 顶部被遮挡时，从上半部分找更大的高置信连通块当种子。 */
function obstructedSeeds(
  d: Uint8ClampedArray,
  like: Float32Array,
  w: number,
  h: number,
  t: number,
  maxStep: number,
): number[] {
  const seen = new Uint8Array(w * h);
  let best: number[] = [];
  const half = Math.ceil(h / 2);
  for (let y = 0; y < half; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (seen[i] || like[i] <= t) continue;
      const comp: number[] = [];
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const p = stack.pop() as number;
        comp.push(p);
        const px = p % w;
        const py = (p / w) | 0;
        for (const q of [px > 0 ? p - 1 : -1, px + 1 < w ? p + 1 : -1, py > 0 ? p - w : -1, py + 1 < h ? p + w : -1]) {
          if (q < 0 || seen[q] || like[q] <= t) continue;
          const a = p * 4;
          const b = q * 4;
          const dist = Math.hypot(d[a] - d[b], d[a + 1] - d[b + 1], d[a + 2] - d[b + 2]);
          if (dist >= maxStep) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
      if (comp.length > best.length) best = comp;
    }
  }
  return best.length >= 16 ? best : [];
}

/** 工作分辨率下的二值天空掩膜；没有可信天空时返回 null。 */
export function skyMaskLow(d: Uint8ClampedArray, w: number, h: number, threshold = 50): Uint8Array | null {
  if (w < 2 || h < 2) return null;
  const like = skyLikelihood(d, w, h);
  const t = 0.12 + 0.6 * (Math.min(100, Math.max(0, threshold)) / 100);
  const top = Math.max(1, Math.floor(h / 40));
  const mask = new Uint8Array(w * h);
  let stack: number[] = [];
  for (let i = 0; i < top * w; i += 1) {
    if (like[i] > t) {
      mask[i] = 1;
      stack.push(i);
    }
  }
  const maxStep = 0.12 * 255;
  if (stack.length * 20 < top * w) {
    mask.fill(0);
    stack = obstructedSeeds(d, like, w, h, t + 0.1, maxStep);
    if (!stack.length) return null;
    for (const i of stack) mask[i] = 1;
  }
  while (stack.length) {
    const i = stack.pop() as number;
    const x = i % w;
    const y = (i / w) | 0;
    for (const j of [x > 0 ? i - 1 : -1, x + 1 < w ? i + 1 : -1, y > 0 ? i - w : -1, y + 1 < h ? i + w : -1]) {
      if (j < 0 || mask[j] || like[j] <= t) continue;
      const a = i * 4;
      const b = j * 4;
      const dist = Math.hypot(d[a] - d[b], d[a + 1] - d[b + 1], d[a + 2] - d[b + 2]);
      if (dist >= maxStep) continue;
      mask[j] = 1;
      stack.push(j);
    }
  }

  // 枝叶间隙里的天空：与已生长天空颜色模型吻合的高似然像素。
  const samples: [number, number, number][] = [];
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    const p = i * 4;
    samples.push([d[p] / 255, d[p + 1] / 255, d[p + 2] / 255]);
  }
  if (samples.length >= 16) {
    const g = Gmm.fit(subsample(samples, 4000), 3);
    if (g) {
      const costs = subsample(samples, 2000).map((p) => g.logLikelihood(p));
      costs.sort((a, b) => b - a); // logLikelihood 越大越像；取 5% 分位作门槛
      const cut = costs[Math.min(costs.length - 1, Math.floor(costs.length * 0.05))];
      for (let i = 0; i < mask.length; i += 1) {
        if (mask[i] || like[i] <= t + 0.1) continue;
        const p = i * 4;
        if (g.logLikelihood([d[p] / 255, d[p + 1] / 255, d[p + 2] / 255]) >= cut) mask[i] = 1;
      }
    }
  }
  // 小洞填充（4 邻域包围）。
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      if (!mask[i] && mask[i - 1] && mask[i + 1] && mask[i - w] && mask[i + w]) mask[i] = 1;
    }
  }
  return mask;
}

/** 全分辨率天空命中表（引导滤波柔化边缘），null 表示没找到天空。 */
export function skyRobustHit(d: Uint8ClampedArray, w: number, h: number, threshold = 50, softness = 50): Uint8Array | null {
  if (w < 2 || h < 2) return null;
  const step = Math.max(1, Math.ceil(Math.sqrt((w * h) / 160000)));
  const low = downsample(d, w, h, step);
  const lowMask = skyMaskLow(low.data, low.w, low.h, threshold);
  if (!lowMask) return null;
  let count = 0;
  for (const v of lowMask) count += v;
  if (count < 4) return null;

  const full = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(low.h - 1, Math.floor(y / step));
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(low.w - 1, Math.floor(x / step));
      full[y * w + x] = lowMask[sy * low.w + sx];
    }
  }
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const p = i * 4;
    lum[i] = luma(d[p], d[p + 1], d[p + 2]);
  }
  const radius = Math.max(1, Math.round((softness / 100) * 8));
  const guideP = Float32Array.from(full);
  const soft = guidedFilterGray(lum, guideP, w, h, radius, 0.04);
  const hit = new Uint8Array(w * h);
  for (let i = 0; i < hit.length; i += 1) hit[i] = soft[i] >= 0.5 ? 1 : 0;
  return hit;
}
