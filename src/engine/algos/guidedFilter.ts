/**
 * Guided Image Filtering 降噪内核。
 *
 * Ported from ArtCraft PhotoCraft (crates/algo/src/denoise.rs + matting.rs),
 * MIT / Apache-2.0. 算法：He, Sun & Tang, "Guided Image Filtering", ECCV 2010。
 *
 * 与 kernels.ts 里旧的 median 混合不同，这里按原实现的 YCbCr + 局部线性模型：
 * 亮度自导引保边平滑，色度由清理后的亮度导引，可选 JPEG 8×8 去块与 USM 细节。
 * 本文件只处理 {data,width,height} 纯字节缓冲，不碰 DOM / Canvas。
 */
import type { RgbaBuffer } from "../filters/kernels";

export interface DenoiseSpec {
  /** PhotoCraft 单位 0..10。 */
  strength: number;
  /** Preserve Details，0..100。越大越保留细节（eps 越小）。 */
  preserve: number;
  /** Reduce Color Noise，0..100。 */
  color: number;
  /** Sharpen Details，0..100。 */
  sharpen: number;
  /** Remove JPEG Artifact。 */
  jpeg: boolean;
}

export const DEFAULT_DENOISE_SPEC: DenoiseSpec = {
  strength: 5,
  preserve: 35,
  color: 30,
  sharpen: 0,
  jpeg: false,
};

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** 边界夹取的平方窗口均值，O(w*h)，与半径无关。 */
export function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const n = w * h;
  if (n === 0) return new Float32Array(0);
  if (r <= 0) return src.slice();

  const tmp = new Float32Array(n);
  const out = new Float32Array(n);
  const pre = new Float64Array(w + 1);
  for (let y = 0; y < h; y += 1) {
    const base = y * w;
    for (let x = 0; x < w; x += 1) pre[x + 1] = pre[x] + src[base + x];
    for (let x = 0; x < w; x += 1) {
      const lo = Math.max(0, x - r);
      const hi = Math.min(w, x + r + 1);
      tmp[base + x] = (pre[hi] - pre[lo]) / (hi - lo);
    }
  }

  const col = new Float64Array((h + 1) * w);
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    const next = (y + 1) * w;
    for (let x = 0; x < w; x += 1) col[next + x] = col[row + x] + tmp[row + x];
  }
  for (let y = 0; y < h; y += 1) {
    const lo = Math.max(0, y - r);
    const hi = Math.min(h, y + r + 1);
    const span = hi - lo;
    for (let x = 0; x < w; x += 1) {
      out[y * w + x] = (col[hi * w + x] - col[lo * w + x]) / span;
    }
  }
  return out;
}

/** 可分离高斯（边界夹取），用于 Sharpen Details 的 USM blur 项与选区羽化。 */
export function gaussianBlurPlane(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.1 || w === 0 || h === 0) return src.slice();
  const r = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(r * 2 + 1);
  let sum = 0;
  for (let i = -r; i <= r; i += 1) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] /= sum;

  const tmp = new Float32Array(src.length);
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) {
      let acc = 0;
      for (let k = -r; k <= r; k += 1) {
        const sx = clamp(x + k, 0, w - 1);
        acc += src[row + sx] * kernel[k + r];
      }
      tmp[row + x] = acc;
    }
  }
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let acc = 0;
      for (let k = -r; k <= r; k += 1) {
        const sy = clamp(y + k, 0, h - 1);
        acc += tmp[sy * w + x] * kernel[k + r];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

/** 灰度导引图的 guided filter：output = mean_a * guide + mean_b。 */
export function guidedFilterGray(
  guide: Float32Array,
  p: Float32Array,
  w: number,
  h: number,
  r: number,
  eps: number,
): Float32Array {
  const n = w * h;
  if (n === 0) return new Float32Array(0);
  const mg = boxMean(guide, w, h, r);
  const mp = boxMean(p, w, h, r);
  const gp = new Float32Array(n);
  const g2 = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    gp[i] = guide[i] * p[i];
    g2[i] = guide[i] * guide[i];
  }
  const mgp = boxMean(gp, w, h, r);
  const mg2 = boxMean(g2, w, h, r);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const cov = mgp[i] - mg[i] * mp[i];
    const variance = Math.max(0, mg2[i] - mg[i] * mg[i]);
    a[i] = cov / (variance + eps);
    b[i] = mp[i] - a[i] * mg[i];
  }
  const ma = boxMean(a, w, h, r);
  const mb = boxMean(b, w, h, r);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = ma[i] * guide[i] + mb[i];
  return out;
}

/**
 * 彩色导引图的 guided filter（He et al. Eq. 19–21）。
 * guide 是 n*3 交错 RGB（0..1），p 是 w*h 单通道。
 */
export function guidedFilterColor(
  guide: Float32Array,
  p: Float32Array,
  w: number,
  h: number,
  r: number,
  eps: number,
): Float32Array {
  const n = w * h;
  if (n === 0) return new Float32Array(0);
  const chans: Float32Array[] = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i += 1) {
    chans[0][i] = guide[i * 3];
    chans[1][i] = guide[i * 3 + 1];
    chans[2][i] = guide[i * 3 + 2];
  }
  const means = chans.map((c) => boxMean(c, w, h, r));
  const mp = boxMean(p, w, h, r);
  const mip = chans.map((c) => {
    const tmp = new Float32Array(n);
    for (let i = 0; i < n; i += 1) tmp[i] = c[i] * p[i];
    return boxMean(tmp, w, h, r);
  });
  const pairs: [number, number][] = [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2], [2, 2]];
  const mii = pairs.map(([a, b]) => {
    const tmp = new Float32Array(n);
    for (let i = 0; i < n; i += 1) tmp[i] = chans[a][i] * chans[b][i];
    return boxMean(tmp, w, h, r);
  });
  const a = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const b = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const u0 = means[0][i];
    const u1 = means[1][i];
    const u2 = means[2][i];
    const cov = [
      mip[0][i] - u0 * mp[i],
      mip[1][i] - u1 * mp[i],
      mip[2][i] - u2 * mp[i],
    ];
    const rr = mii[0][i] - u0 * u0 + eps;
    const rg = mii[1][i] - u0 * u1;
    const rb = mii[2][i] - u0 * u2;
    const gg = mii[3][i] - u1 * u1 + eps;
    const gb = mii[4][i] - u1 * u2;
    const bb = mii[5][i] - u2 * u2 + eps;
    // adj(Σ) 上三角，乘 cov 后再除以 det，避免构造 3×3 数组。
    const i00 = gg * bb - gb * gb;
    const i01 = gb * rb - rg * bb;
    const i02 = rg * gb - gg * rb;
    const i11 = rr * bb - rb * rb;
    const i12 = rb * rg - rr * gb;
    const i22 = rr * gg - rg * rg;
    const det = rr * i00 + rg * i01 + rb * i02;
    if (Math.abs(det) < 1e-30) continue;
    a[0][i] = (i00 * cov[0] + i01 * cov[1] + i02 * cov[2]) / det;
    a[1][i] = (i01 * cov[0] + i11 * cov[1] + i12 * cov[2]) / det;
    a[2][i] = (i02 * cov[0] + i12 * cov[1] + i22 * cov[2]) / det;
    b[i] = mp[i] - a[0][i] * u0 - a[1][i] * u1 - a[2][i] * u2;
  }
  const ma = a.map((plane) => boxMean(plane, w, h, r));
  const mb = boxMean(b, w, h, r);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = ma[0][i] * chans[0][i] + ma[1][i] * chans[1][i] + ma[2][i] * chans[2][i] + mb[i];
  }
  return out;
}

/** 两个色度平面共用清理后亮度的均值/方差，按 amount 混合回去。 */
function guidedChroma(
  guide: Float32Array,
  planes: [Float32Array, Float32Array],
  w: number,
  h: number,
  r: number,
  eps: number,
  amount: number,
): void {
  const n = w * h;
  if (n === 0) return;
  const mg = boxMean(guide, w, h, r);
  const g2 = new Float32Array(n);
  for (let i = 0; i < n; i += 1) g2[i] = guide[i] * guide[i];
  const mg2 = boxMean(g2, w, h, r);
  const variance = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    variance[i] = Math.max(0, mg2[i] - mg[i] * mg[i]) + eps;
  }

  for (const plane of planes) {
    const mp = boxMean(plane, w, h, r);
    const gp = new Float32Array(n);
    for (let i = 0; i < n; i += 1) gp[i] = guide[i] * plane[i];
    const mgp = boxMean(gp, w, h, r);
    const a = new Float32Array(n);
    const b = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      a[i] = (mgp[i] - mg[i] * mp[i]) / variance[i];
      b[i] = mp[i] - a[i] * mg[i];
    }
    const ma = boxMean(a, w, h, r);
    const mb = boxMean(b, w, h, r);
    for (let i = 0; i < n; i += 1) {
      const filtered = ma[i] * guide[i] + mb[i];
      plane[i] += (filtered - plane[i]) * amount;
    }
  }
}

/** JPEG 8×8 网格线去块：文档锚定的 3×3 平滑（PhotoCraft denoise.rs:134）。 */
function jpegDeblock(luma: Float32Array, w: number, h: number): void {
  const orig = luma.slice();
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      if (x % 8 !== 0 && x % 8 !== 7 && y % 8 !== 0 && y % 8 !== 7) continue;
      let acc = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          acc += orig[(y + dy) * w + (x + dx)];
        }
      }
      const i = y * w + x;
      luma[i] = 0.5 * orig[i] + 0.5 * (acc / 9);
    }
  }
}

/** 按 PhotoCraft Reduce Noise 管线处理 RGBA，alpha 原样保留。 */
export function reduceNoiseGuided(src: RgbaBuffer, spec: DenoiseSpec): RgbaBuffer {
  const { width: w, height: h, data } = src;
  const n = w * h;
  if (n === 0) {
    return { data: new Uint8ClampedArray(0), width: w, height: h };
  }

  const s = clamp(spec.strength, 0, 10) / 10;
  const col = clamp(spec.color, 0, 100) / 100;
  const sh = clamp(spec.sharpen, 0, 100) / 100;
  const keep = clamp(spec.preserve, 0, 100) / 100;
  if (s <= 0 && col <= 0 && sh <= 0 && !spec.jpeg) {
    return { data: new Uint8ClampedArray(data), width: w, height: h };
  }

  const y = new Float32Array(n);
  const cb = new Float32Array(n);
  const cr = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i += 1, p += 4) {
    const r = data[p] / 255;
    const g = data[p + 1] / 255;
    const b = data[p + 2] / 255;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    y[i] = l;
    cb[i] = b - l;
    cr[i] = r - l;
  }

  if (spec.jpeg) jpegDeblock(y, w, h);

  if (s > 0) {
    const radius = Math.min(5, Math.round(1 + clamp(spec.strength, 0, 10) * 0.4));
    const eps = (0.004 + 0.05 * s) ** 2 * (1.05 - keep);
    const filtered = guidedFilterGray(y, y, w, h, radius, eps);
    const amount = Math.sqrt(s);
    for (let i = 0; i < n; i += 1) y[i] += (filtered[i] - y[i]) * amount;
  }

  if (col > 0) {
    const radius = Math.min(9, Math.round(1 + col * 8));
    const eps = (0.01 + 0.05 * col) ** 2;
    guidedChroma(y, [cb, cr], w, h, radius, eps, col);
  }

  if (sh > 0) {
    const blur = gaussianBlurPlane(y, w, h, 1);
    for (let i = 0; i < n; i += 1) y[i] += (y[i] - blur[i]) * sh * 1.2;
  }

  const out = new Uint8ClampedArray(data.length);
  for (let i = 0, p = 0; i < n; i += 1, p += 4) {
    const l = y[i];
    const r = cr[i] + l;
    const b = cb[i] + l;
    const g = (l - 0.299 * r - 0.114 * b) / 0.587;
    out[p] = clamp(r * 255, 0, 255);
    out[p + 1] = clamp(g * 255, 0, 255);
    out[p + 2] = clamp(b * 255, 0, 255);
    out[p + 3] = data[p + 3];
  }
  return { data: out, width: w, height: h };
}
