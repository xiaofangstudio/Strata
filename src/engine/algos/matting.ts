/**
 * Select and Mask / Refine Edge 抠图精修内核。
 *
 * Ported from ArtCraft PhotoCraft (crates/algo/src/matting.rs), MIT / Apache-2.0。
 * 核心：用原图做导引图的 guided filter 让硬选区在头发/模糊边缘处软化；
 * 再按 Photoshop 顺序做 Smooth → Feather → Contrast → Shift Edge。
 * smart radius 用局部梯度在“小半径保边”和“大半径软边”之间混合。
 *
 * 纯函数：只吃 RGBA 字节 + 0..1 alpha，不碰 DOM / Canvas。
 */
import {
  boxMean,
  guidedFilterColor,
  gaussianBlurPlane,
} from "./guidedFilter";
import type { RgbaBuffer } from "../filters/kernels";

export interface MattingParams {
  /** 边缘检测半径（像素），0 = 不用图像导引。 */
  radius: number;
  /** 0..100。 */
  smooth: number;
  /** 像素。 */
  feather: number;
  /** 0..100。 */
  contrast: number;
  /** -100..100。 */
  shiftEdge: number;
}

export const DEFAULT_MATTING_PARAMS: MattingParams = {
  radius: 0,
  smooth: 0,
  feather: 0,
  contrast: 0,
  shiftEdge: 0,
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 原图 RGB → n*3 交错 0..1，以及 0..1 亮度。 */
function decompose(img: RgbaBuffer): { guide: Float32Array; luma: Float32Array } {
  const n = img.width * img.height;
  const guide = new Float32Array(n * 3);
  const luma = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const p = i * 4;
    const r = img.data[p] / 255;
    const g = img.data[p + 1] / 255;
    const b = img.data[p + 2] / 255;
    guide[i * 3] = r;
    guide[i * 3 + 1] = g;
    guide[i * 3 + 2] = b;
    luma[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return { guide, luma };
}

/** 二值选中区的边界带（布尔），以及局部梯度强度（0..1）。 */
function edgeInfo(luma: Float32Array, bin: Uint8Array, w: number, h: number) {
  const boundary = new Float32Array(w * h);
  let any = false;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const v = bin[i];
      const diff =
        (x > 0 && bin[i - 1] !== v) ||
        (x + 1 < w && bin[i + 1] !== v) ||
        (y > 0 && bin[i - w] !== v) ||
        (y + 1 < h && bin[i + w] !== v);
      if (diff) {
        boundary[i] = 1;
        any = true;
      }
    }
  }
  const grad = new Float32Array(w * h);
  if (any) {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        const gx = luma[y * w + Math.min(w - 1, x + 1)] - luma[y * w + Math.max(0, x - 1)];
        const gy = luma[Math.min(h - 1, y + 1) * w + x] - luma[Math.max(0, y - 1) * w + x];
        grad[i] = Math.sqrt(gx * gx + gy * gy);
      }
    }
  }
  return { boundary, grad };
}

/**
 * 精修 0..1 alpha。返回新数组，不修改输入。
 */
export function refineMask(
  img: RgbaBuffer,
  alpha: Float32Array,
  params: MattingParams,
): Float32Array {
  const w = img.width;
  const h = img.height;
  const n = w * h;
  if (n === 0 || alpha.length !== n) return new Float32Array(0);

  let a: Float32Array = alpha.slice();
  const radius = Math.max(0, Math.round(params.radius));
  if (radius > 0 && img.data.length === n * 4) {
    const { guide, luma } = decompose(img);
    const bin = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) bin[i] = a[i] >= 0.5 ? 1 : 0;
    const { boundary, grad } = edgeInfo(luma, bin, w, h);
    const band = boxMean(boundary, w, h, Math.max(1, radius));
    const gradMean = boxMean(grad, w, h, Math.max(1, radius));
    const r = Math.min(64, Math.max(1, radius));
    const near = guidedFilterColor(guide, a, w, h, r, 1e-4);
    let far: Float32Array = near;
    if (r < 64) {
      const r2 = Math.min(64, r * 2);
      far = guidedFilterColor(guide, a, w, h, r2, 1e-4);
    }
    for (let i = 0; i < n; i += 1) {
      if (band[i] <= 0) continue;
      const sharpness = Math.min(1, gradMean[i] / 0.08);
      a[i] = near[i] * sharpness + far[i] * (1 - sharpness);
    }
  }

  const smoothSigma = (Math.max(0, params.smooth) / 100) * 4;
  if (smoothSigma > 0.05) a = gaussianBlurPlane(a, w, h, smoothSigma);
  const featherSigma = Math.max(0, params.feather) / 2;
  if (featherSigma > 0.05) a = gaussianBlurPlane(a, w, h, featherSigma);

  const contrast = 1 + Math.max(0, params.contrast) / 50;
  if (contrast > 1) {
    for (let i = 0; i < n; i += 1) a[i] = clamp01((a[i] - 0.5) * contrast + 0.5);
  }

  const shift = Math.max(-100, Math.min(100, params.shiftEdge)) / 100;
  if (shift !== 0) {
    const odds = 49 ** shift;
    for (let i = 0; i < n; i += 1) {
      const v = clamp01(a[i]);
      if (v <= 0 || v >= 1) continue;
      const o = (v / (1 - v)) * odds;
      a[i] = o / (1 + o);
    }
  }

  for (let i = 0; i < n; i += 1) a[i] = clamp01(a[i]);
  return a;
}
