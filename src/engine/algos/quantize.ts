/**
 * 索引色调色板构建与抖动。
 *
 * Ported from ArtCraft PhotoCraft (crates/algo/src/quantize.rs), MIT / Apache-2.0。
 * sRGB→CIELAB 感知中位切分 + k-means 细化；Selective 吸附 Web-safe；
 * Adaptive 按 RGB 直方图频率加权；抖动支持误差扩散 / Bayer 图案 / 确定性噪声。
 * 纯函数，不碰 DOM。
 */
import type { RgbaBuffer } from "../filters/kernels";

export type Rgb = readonly [number, number, number];
export type PaletteKind = "exact" | "web" | "uniform" | "perceptual" | "selective" | "adaptive";
export type DitherKind = "none" | "diffusion" | "pattern" | "noise";

export interface QuantizeOptions {
  dither?: DitherKind;
  /** 0~100，抖动强度。 */
  amount?: number;
  /** 透明像素使用的调色板索引。 */
  transparentIndex?: number;
  seed?: number;
}

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/* ------------------------------------------------------------- sRGB / Lab */

export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);
  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047;
  const y = 0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl;
  const z = (0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl) / 1.08883;
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb(l: number, a: number, b: number): Rgb {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const x = labFInv(fx) * 0.95047;
  const y = labFInv(fy);
  const z = labFInv(fz) * 1.08883;
  return [
    clamp255(linearToSrgb(3.2404542 * x - 1.5371385 * y - 0.4985314 * z)),
    clamp255(linearToSrgb(-0.9692660 * x + 1.8760108 * y + 0.0415560 * z)),
    clamp255(linearToSrgb(0.0556434 * x - 0.2040259 * y + 1.0572252 * z)),
  ];
}

function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(v: number): number {
  const c = Math.max(0, Math.min(1, v));
  return (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255;
}

function labF(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

function labFInv(t: number): number {
  const c = t ** 3;
  return c > 0.008856 ? c : (t - 16 / 116) / 7.787;
}

/* --------------------------------------------------- 加权中位切分 + k-means */

interface Sample {
  v: Rgb;
  weight: number;
}

function weightedCut(samples: Sample[], n: number): Sample[][] {
  let boxes: Sample[][] = [samples];
  while (boxes.length < n) {
    let best = -1;
    let bestRange = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i];
      if (box.length < 2) continue;
      let range = 0;
      for (let d = 0; d < 3; d += 1) {
        let lo = Infinity;
        let hi = -Infinity;
        for (const s of box) {
          if (s.v[d] < lo) lo = s.v[d];
          if (s.v[d] > hi) hi = s.v[d];
        }
        range = Math.max(range, hi - lo);
      }
      if (range > bestRange) {
        bestRange = range;
        best = i;
      }
    }
    if (best < 0 || bestRange <= 1e-9) break;
    const box = boxes[best];
    let dim = 0;
    let widest = -Infinity;
    for (let d = 0; d < 3; d += 1) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const s of box) {
        if (s.v[d] < lo) lo = s.v[d];
        if (s.v[d] > hi) hi = s.v[d];
      }
      if (hi - lo > widest) {
        widest = hi - lo;
        dim = d;
      }
    }
    box.sort((a, b) => a.v[dim] - b.v[dim]);
    let total = 0;
    for (const s of box) total += s.weight;
    let acc = 0;
    let cut = 0;
    for (; cut < box.length - 1; cut += 1) {
      acc += box[cut].weight;
      if (acc >= total / 2) break;
    }
    const left = box.slice(0, cut + 1);
    const right = box.slice(cut + 1);
    boxes = boxes.filter((_, i) => i !== best);
    if (left.length) boxes.push(left);
    if (right.length) boxes.push(right);
  }
  return boxes;
}

function centroid(box: Sample[]): [number, number, number] {
  let w = 0;
  const v: [number, number, number] = [0, 0, 0];
  for (const s of box) {
    w += s.weight;
    v[0] += s.v[0] * s.weight;
    v[1] += s.v[1] * s.weight;
    v[2] += s.v[2] * s.weight;
  }
  const d = Math.max(1e-9, w);
  return [v[0] / d, v[1] / d, v[2] / d];
}

function kmeans(samples: Sample[], centers: [number, number, number][], iters = 3): void {
  for (let iter = 0; iter < iters; iter += 1) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const s of samples) {
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < centers.length; i += 1) {
        const c = centers[i];
        const d = (c[0] - s.v[0]) ** 2 + (c[1] - s.v[1]) ** 2 + (c[2] - s.v[2]) ** 2;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      const acc = sums[best];
      acc[0] += s.v[0] * s.weight;
      acc[1] += s.v[1] * s.weight;
      acc[2] += s.v[2] * s.weight;
      acc[3] += s.weight;
    }
    for (let i = 0; i < centers.length; i += 1) {
      const acc = sums[i];
      if (acc[3] <= 0) continue;
      centers[i] = [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3]];
    }
  }
}

function samplePixels(src: RgbaBuffer, limit = 20000): number[] {
  const { width: w, height: h, data } = src;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / limit)));
  const out: number[] = [];
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const p = y * w + x;
      if (data[p * 4 + 3] >= 8) out.push(p);
    }
  }
  return out;
}

const WEB_LEVELS = [0, 51, 102, 153, 204, 255];

/** Web-safe 216 色。 */
export function webSafePalette(colors = 216): Rgb[] {
  const all: Rgb[] = [];
  for (const r of WEB_LEVELS) for (const g of WEB_LEVELS) for (const b of WEB_LEVELS) all.push([r, g, b]);
  const n = Math.max(1, Math.min(all.length, Math.round(colors)));
  if (n === all.length) return all;
  return Array.from({ length: n }, (_, i) => all[Math.round((i * (all.length - 1)) / (n - 1))]);
}

function uniformPalette(colors: number): Rgb[] {
  const n = Math.max(1, Math.min(256, Math.round(colors)));
  const side = Math.max(1, Math.round(Math.cbrt(n)));
  const out: Rgb[] = [];
  for (let r = 0; r < side && out.length < n; r += 1) {
    for (let g = 0; g < side && out.length < n; g += 1) {
      for (let b = 0; b < side && out.length < n; b += 1) {
        out.push([
          Math.round((r * 255) / Math.max(1, side - 1)),
          Math.round((g * 255) / Math.max(1, side - 1)),
          Math.round((b * 255) / Math.max(1, side - 1)),
        ]);
      }
    }
  }
  return out;
}

function dedupe(palette: Rgb[]): Rgb[] {
  const seen = new Set<string>();
  return palette.filter((p) => {
    const k = `${p[0]},${p[1]},${p[2]}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 构建调色板；forced 色强制排在最前。 */
export function buildPalette(
  src: RgbaBuffer,
  kind: PaletteKind,
  colors: number,
  forced: Rgb[] = [],
): Rgb[] {
  const n = Math.max(1, Math.min(256, Math.round(colors)));
  const data = src.data;
  const picked = samplePixels(src);
  let palette: Rgb[];

  if (kind === "web") {
    palette = webSafePalette(n);
  } else if (kind === "uniform") {
    palette = uniformPalette(n);
  } else if (kind === "exact" || picked.length <= n) {
    const counts = new Map<string, { c: Rgb; count: number }>();
    for (const p of picked) {
      const i = p * 4;
      const c: Rgb = [data[i], data[i + 1], data[i + 2]];
      const k = `${c[0]},${c[1]},${c[2]}`;
      const prev = counts.get(k);
      if (prev) prev.count += 1;
      else counts.set(k, { c, count: 1 });
    }
    palette = [...counts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, n)
      .map((e) => e.c);
  } else if (kind === "adaptive") {
    // 5bit RGB 直方图 → 频率加权中位切分
    const hist = new Map<number, { c: Rgb; weight: number }>();
    for (const p of picked) {
      const i = p * 4;
      const r = data[i] >> 3;
      const g = data[i + 1] >> 3;
      const b = data[i + 2] >> 3;
      const key = (r << 10) | (g << 5) | b;
      const prev = hist.get(key);
      if (prev) prev.weight += 1;
      else hist.set(key, { c: [r * 8 + 4, g * 8 + 4, b * 8 + 4], weight: 1 });
    }
    const samples: Sample[] = [...hist.values()].map((e) => ({ v: e.c, weight: e.weight }));
    const centers = weightedCut(samples, n).map(centroid);
    kmeans(samples, centers);
    palette = centers.map((c) => [clamp255(c[0]), clamp255(c[1]), clamp255(c[2])]);
  } else {
    // perceptual / selective：Lab 中位切分 + k-means
    const samples: Sample[] = picked.map((p) => {
      const i = p * 4;
      return { v: rgbToLab(data[i], data[i + 1], data[i + 2]), weight: 1 };
    });
    const centers = weightedCut(samples, n).map(centroid);
    kmeans(samples, centers);
    palette = centers.map((c) => labToRgb(c[0], c[1], c[2]));
    if (kind === "selective") {
      palette = palette.map((c) => {
        let best: Rgb = c;
        let bd = 26 * 26;
        for (const web of WEB_LEVELS) {
          for (const wg of WEB_LEVELS) {
            for (const wb of WEB_LEVELS) {
              const d = (web - c[0]) ** 2 + (wg - c[1]) ** 2 + (wb - c[2]) ** 2;
              if (d < bd) {
                bd = d;
                best = [web, wg, wb];
              }
            }
          }
        }
        return best;
      });
    }
  }
  const out = dedupe([...forced, ...palette]).slice(0, n);
  return out.length ? out : [[0, 0, 0]];
}

/* ------------------------------------------------------------------ 量化 */

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;

function nearestIndex(palette: Rgb[], r: number, g: number, b: number): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < palette.length; i += 1) {
    const p = palette[i];
    const dr = p[0] - r;
    const dg = p[1] - g;
    const db = p[2] - b;
    // 加权欧氏距离，近似 Lab 的感知权重
    const d = 0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

function noiseAt(p: number, seed: number): number {
  let x = (p ^ seed) >>> 0;
  x = (x + 0x6d2b79f5) >>> 0;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}

/** 把 RGBA 图量化到给定调色板，返回像素缓冲与每像素索引。 */
export function quantizeRgba(
  src: RgbaBuffer,
  palette: Rgb[],
  opts: QuantizeOptions = {},
): { buf: RgbaBuffer; indices: Uint8Array } {
  if (!palette.length) throw new Error("quantizeRgba: empty palette");
  const { width: w, height: h, data } = src;
  const dither = opts.dither ?? "none";
  const amount = Math.max(0, Math.min(100, opts.amount ?? 100)) / 100;
  const transparentIndex = Math.max(0, Math.min(255, opts.transparentIndex ?? 0));
  const seed = opts.seed ?? 12345;
  const out: RgbaBuffer = {
    data: new Uint8ClampedArray(w * h * 4),
    width: w,
    height: h,
  };
  const indices = new Uint8Array(w * h);
  const work = new Float32Array(w * h * 3);
  for (let p = 0; p < w * h; p += 1) {
    const i = p * 4;
    work[p * 3] = data[i];
    work[p * 3 + 1] = data[i + 1];
    work[p * 3 + 2] = data[i + 2];
  }
  const spread = (p: number, x: number, y: number, k: number, er: number, eg: number, eb: number): void => {
    const nx = x + (p === 0 ? 1 : p === 1 ? -1 : p === 2 ? 0 : 1);
    const ny = y + (p === 0 ? 0 : 1);
    if (nx < 0 || nx >= w || ny < 0 || ny >= h) return;
    const q = ny * w + nx;
    work[q * 3] += er * k * amount;
    work[q * 3 + 1] += eg * k * amount;
    work[q * 3 + 2] += eb * k * amount;
  };

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = y * w + x;
      const o = p * 4;
      if (data[o + 3] < 8) {
        indices[p] = transparentIndex;
        out.data[o + 3] = data[o + 3];
        continue;
      }
      let r = work[p * 3];
      let g = work[p * 3 + 1];
      let b = work[p * 3 + 2];
      if (dither === "pattern") {
        const t = (BAYER4[y & 3][x & 3] + 0.5) / 16 - 0.5;
        r += t * 64 * amount;
        g += t * 64 * amount;
        b += t * 64 * amount;
      } else if (dither === "noise") {
        const t = noiseAt(p, seed) - 0.5;
        r += t * 64 * amount;
        g += t * 64 * amount;
        b += t * 64 * amount;
      }
      const idx = nearestIndex(palette, r, g, b);
      const c = palette[idx];
      indices[p] = idx;
      out.data[o] = c[0];
      out.data[o + 1] = c[1];
      out.data[o + 2] = c[2];
      out.data[o + 3] = data[o + 3];
      if (dither !== "diffusion") continue;
      const er = r - c[0];
      const eg = g - c[1];
      const eb = b - c[2];
      spread(0, x, y, 7 / 16, er, eg, eb);
      spread(1, x, y, 3 / 16, er, eg, eb);
      spread(2, x, y, 5 / 16, er, eg, eb);
      spread(3, x, y, 1 / 16, er, eg, eb);
    }
  }
  return { buf: out, indices };
}
