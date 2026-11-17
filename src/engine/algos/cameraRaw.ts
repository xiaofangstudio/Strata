/**
 * Camera Raw 可独立成纯函数的段落：单调三次曲线 LUT、8 色带 HSL mixer、
 * 后期裁切暗角。
 *
 * Ported from ArtCraft PhotoCraft (crates/algo/src/camera_raw.rs), MIT / Apache-2.0。
 * 不换 strata_raw 解码、不换 strata_cms；只处理 0..1 浮点颜色，不碰 DOM。
 */
import type { RgbaBuffer } from "../filters/kernels";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / Math.max(1e-6, e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Fritsch–Carlson 单调三次插值，控制点 x/y 均为 0..255（兼容 UI 曲线点）。 */
export function curveLut(pts: readonly (readonly [number, number])[], n = 256): Float32Array {
  const p = pts
    .map((q) => [q[0] / 255, q[1] / 255] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const unique: [number, number][] = [];
  for (const q of p) if (!unique.length || Math.abs(unique[unique.length - 1][0] - q[0]) > 1e-6) unique.push(q);
  const identity = (i: number) => i / Math.max(1, n - 1);
  if (unique.length < 2) return Float32Array.from({ length: n }, (_, i) => identity(i));

  const m = unique.length;
  const d: number[] = [];
  for (let k = 0; k < m - 1; k += 1) d.push((unique[k + 1][1] - unique[k][1]) / Math.max(1e-6, unique[k + 1][0] - unique[k][0]));
  const t = new Array<number>(m);
  t[0] = d[0];
  t[m - 1] = d[m - 2];
  for (let k = 1; k < m - 1; k += 1) t[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2;
  for (let k = 0; k < m - 1; k += 1) {
    if (d[k] === 0) { t[k] = 0; t[k + 1] = 0; continue; }
    const a = t[k] / d[k];
    const b = t[k + 1] / d[k];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      t[k] = tau * a * d[k];
      t[k + 1] = tau * b * d[k];
    }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const x = identity(i);
    if (x <= unique[0][0]) { out[i] = clamp01(unique[0][1]); continue; }
    if (x >= unique[m - 1][0]) { out[i] = clamp01(unique[m - 1][1]); continue; }
    let k = 0;
    while (k < m - 2 && x > unique[k + 1][0]) k += 1;
    const hh = unique[k + 1][0] - unique[k][0];
    const s = (x - unique[k][0]) / hh;
    const h00 = 2 * s ** 3 - 3 * s * s + 1;
    const h10 = s ** 3 - 2 * s * s + s;
    const h01 = -2 * s ** 3 + 3 * s * s;
    const h11 = s ** 3 - s * s;
    out[i] = clamp01(h00 * unique[k][1] + h10 * hh * t[k] + h01 * unique[k + 1][1] + h11 * hh * t[k + 1]);
  }
  return out;
}

/** 线性求值 LUT（0..1 外线性延展）。 */
export function lutEval(lut: Float32Array, v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return v + lut[0];
  if (v > 1) return lut[lut.length - 1] + (v - 1);
  const x = v * (lut.length - 1);
  const i = Math.min(lut.length - 2, Math.floor(x));
  return lut[i] + (lut[i + 1] - lut[i]) * (x - i);
}

/** 内置曲线预设：0 线性、1 柔 S、2 强 S、3 胶片褪色、4 压高光。 */
export function presetCurveLut(preset: number): Float32Array {
  const table: (readonly (readonly [number, number])[])[] = [
    [[0, 0], [255, 255]],
    [[0, 0], [64, 54], [192, 205], [255, 255]],
    [[0, 0], [64, 40], [192, 218], [255, 255]],
    [[0, 18], [64, 70], [192, 206], [255, 238]],
    [[0, 0], [128, 126], [192, 176], [255, 226]],
  ];
  return curveLut(table[Math.min(table.length - 1, Math.max(0, Math.round(preset)))]);
}

/** 对 RGBA 的 RGB 三通道应用曲线 LUT，alpha 不变。 */
export function applyToneCurve(img: RgbaBuffer, lut: Float32Array): void {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    d[i] = Math.round(lutEval(lut, d[i] / 255) * 255);
    d[i + 1] = Math.round(lutEval(lut, d[i + 1] / 255) * 255);
    d[i + 2] = Math.round(lutEval(lut, d[i + 2] / 255) * 255);
  }
}

/** 8 色带中心色相（度）：红/橙/黄/绿/青/蓝/紫/洋红。 */
export const BAND_HUES = [0, 30, 60, 120, 180, 220, 270, 320] as const;

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const dl = mx - mn;
  const s = l > 0.5 ? dl / (2 - mx - mn) : dl / (mx + mn);
  let h: number;
  if (mx === r) h = ((g - b) / dl + 6) % 6;
  else if (mx === g) h = (b - r) / dl + 2;
  else h = (r - g) / dl + 4;
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  return [clamp01(r + m), clamp01(g + m), clamp01(b + m)];
}

/** 8 色带 mixer：每个色带可调色相偏移、饱和度倍率、明度。band 参数 -100..100。 */
export function applyHslMixer(
  d: Uint8ClampedArray,
  hue: readonly number[],
  sat: readonly number[],
  lum: readonly number[],
): void {
  if (hue.length < 8 || sat.length < 8 || lum.length < 8) return;
  const neutral = [...hue, ...sat, ...lum].every((v) => Math.abs(v) < 1e-6);
  if (neutral) return;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const [h, s, l] = rgbToHsl(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
    if (s < 1e-4) continue;
    // 相邻两带线性混合，避免色带边界跳变
    let k = 0;
    let bd = Infinity;
    for (let b = 0; b < 8; b += 1) {
      let dist = Math.abs(h - BAND_HUES[b]);
      dist = Math.min(dist, 360 - dist);
      if (dist < bd) { bd = dist; k = b; }
    }
    const next = (k + 1) % 8;
    let dn = Math.abs(h - BAND_HUES[next]);
    dn = Math.min(dn, 360 - dn);
    const prev = (k + 7) % 8;
    let dp = Math.abs(h - BAND_HUES[prev]);
    dp = Math.min(dp, 360 - dp);
    const toward = dn <= dp ? next : prev;
    const spread = Math.min(dn, dp);
    const alpha = spread > 1e-4 ? clamp01(1 - bd / (bd + spread)) : 1;
    const mix = (arr: readonly number[]) => arr[k] * alpha + arr[toward] * (1 - alpha);
    const [r, g, b] = hslToRgb(
      h + mix(hue) * 1.8,
      clamp01(s * (1 + mix(sat) / 100)),
      clamp01(l + mix(lum) / 200),
    );
    d[i] = Math.round(r * 255);
    d[i + 1] = Math.round(g * 255);
    d[i + 2] = Math.round(b * 255);
  }
}

export interface VignetteOptions {
  /** -100 去暗角 / +100 加暗角。 */
  amount: number;
  /** 0..100，半径起点。 */
  midpoint?: number;
  /** 高光保护 0..100。 */
  highlights?: number;
}

/** 8 色带 mixer 预设：0 中性、1 暖橙、2 冷蓝、3 青橙、4 褪色胶片。 */
export function presetMixer(index: number): {
  hue: number[];
  sat: number[];
  lum: number[];
} {
  const presets = [
    { hue: [0, 0, 0, 0, 0, 0, 0, 0], sat: [0, 0, 0, 0, 0, 0, 0, 0], lum: [0, 0, 0, 0, 0, 0, 0, 0] },
    { hue: [4, 3, 0, -2, -4, -3, 0, 2], sat: [8, 6, 0, -8, -10, -6, 0, 5], lum: [2, 1, 0, -1, -2, -1, 0, 1] },
    { hue: [-3, -2, 0, 2, 4, 5, 3, -1], sat: [-5, -3, 0, 4, 8, 10, 5, -2], lum: [-1, 0, 0, 1, 2, 2, 1, 0] },
    { hue: [-5, -3, 0, -4, 8, 6, 2, -2], sat: [10, 6, 0, -4, 12, 10, 4, 6], lum: [3, 2, 0, -2, 1, 0, 0, 2] },
    { hue: [0, 0, 0, 0, 0, 0, 0, 0], sat: [-12, -10, -8, -10, -12, -10, -8, -10], lum: [4, 3, 2, 3, 2, 2, 3, 4] },
  ];
  return presets[Math.min(presets.length - 1, Math.max(0, Math.round(index)))];
}

/** 后期裁切暗角：负 amount 提亮四角，正 amount 压暗四角。 */
export function applyVignette(img: RgbaBuffer, opts: VignetteOptions): void {
  const amt = Math.max(-100, Math.min(100, opts.amount)) / 100;
  if (Math.abs(amt) < 1e-6) return;
  const { width: w, height: h, data: d } = img;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const ax = Math.max(1, cx);
  const ay = Math.max(1, cy);
  const mid = Math.min(0.95, Math.max(0.05, (opts.midpoint ?? 50) / 100));
  const e0 = mid * 0.7;
  const e1 = Math.max(e0 + 0.05, mid * 0.7 + 0.55);
  const hl = Math.max(0, Math.min(100, opts.highlights ?? 0)) / 100;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0) continue;
      const r = Math.hypot((x - cx) / ax, (y - cy) / ay) / Math.SQRT2;
      const m = smoothstep(e0, e1, r);
      if (m <= 0) continue;
      // 正 amount → gain<1 压暗四角；负 amount → gain>1 提亮四角
      let gain = 2 ** (-amt * 2 * m);
      if (amt < 0 && hl > 0) {
        const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        gain += (1 - gain) * smoothstep(0.6, 1, l) * hl;
      }
      for (let c = 0; c < 3; c += 1) d[i + c] = Math.round(clamp01((d[i + c] / 255) * gain) * 255);
    }
  }
}
