/**
 * Poisson / 调和插值内核。
 *
 * Ported from ArtCraft PhotoCraft (crates/algo/src/poisson.rs), MIT / Apache-2.0。
 * 算法：P. Pérez, M. Gangnet, A. Blake, "Poisson Image Editing", SIGGRAPH 2003。
 *
 * 已知像素作为 Dirichlet 边界，待求像素解 Δv = 0；用 cascadic multigrid + SOR，
 * 比逐像素 Gauss–Seidel 快得多。seamlessClone 保留源图梯度、颜色/亮度贴合目标；
 * membraneFill 则是没有源纹理时从边界向内做调和插值（修复画笔/内容识别填充打底）。
 *
 * 本文件只处理 Float32Array / RgbaBuffer 纯数据，不碰 DOM / Canvas。
 */
import type { RgbaBuffer } from "../filters/kernels";

const TOL = 2e-5;
const FINE_ITERS = 30;
const FINE_OMEGA = 1.7;
const COARSE_ITERS = 2000;
const COARSE_OMEGA = 1.85;
const MAX_DEPTH = 16;

type StopFn = () => boolean;
const neverStop: StopFn = () => false;

function countUnknown(unknown: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < unknown.length; i += 1) if (unknown[i]) n += 1;
  return n;
}

/** SOR：只扫 unknown 像素，边界外邻居按 Neumann 处理（忽略）。 */
function sor(
  w: number,
  h: number,
  unknown: Uint8Array,
  v: Float32Array,
  maxIter: number,
  omega: number,
  stop: StopFn,
): void {
  const cells: number[] = [];
  const masks: number[] = [];
  for (let i = 0; i < w * h; i += 1) {
    if (!unknown[i]) continue;
    const x = i % w;
    const y = (i / w) | 0;
    cells.push(i);
    masks.push(
      (x > 0 ? 1 : 0) |
        (x + 1 < w ? 2 : 0) |
        (y > 0 ? 4 : 0) |
        (y + 1 < h ? 8 : 0),
    );
  }
  for (let iter = 0; iter < maxIter; iter += 1) {
    if (stop()) return;
    let maxDelta = 0;
    for (let k = 0; k < cells.length; k += 1) {
      const i = cells[k];
      const m = masks[k];
      let sum = 0;
      let count = 0;
      if (m & 1) { sum += v[i - 1]; count += 1; }
      if (m & 2) { sum += v[i + 1]; count += 1; }
      if (m & 4) { sum += v[i - w]; count += 1; }
      if (m & 8) { sum += v[i + w]; count += 1; }
      if (count === 0) continue;
      const delta = omega * (sum / count - v[i]);
      v[i] += delta;
      const abs = delta < 0 ? -delta : delta;
      if (abs > maxDelta) maxDelta = abs;
    }
    if (maxDelta < TOL) break;
  }
}

function solveRec(
  w: number,
  h: number,
  unknown: Uint8Array,
  v: Float32Array,
  depth: number,
  stop: StopFn,
): void {
  if (stop()) return;
  const nUnknown = countUnknown(unknown);
  if (nUnknown === 0) return;
  let knownSum = 0;
  let knownCount = 0;
  for (let i = 0; i < w * h; i += 1) {
    if (!unknown[i]) {
      knownSum += v[i];
      knownCount += 1;
    }
  }
  if (knownCount === 0) return; // 没有边界值可插值，保持原样

  if (w >= 8 && h >= 8 && nUnknown > 64 && depth < MAX_DEPTH) {
    const cw = Math.ceil(w / 2);
    const ch = Math.ceil(h / 2);
    const cu = new Uint8Array(cw * ch).fill(1);
    const cv = new Float32Array(cw * ch);
    for (let cy = 0; cy < ch; cy += 1) {
      for (let cx = 0; cx < cw; cx += 1) {
        let sum = 0;
        let count = 0;
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const x = cx * 2 + dx;
            const y = cy * 2 + dy;
            if (x >= w || y >= h || unknown[y * w + x]) continue;
            sum += v[y * w + x];
            count += 1;
          }
        }
        if (count > 0) {
          cu[cy * cw + cx] = 0;
          cv[cy * cw + cx] = sum / count;
        }
      }
    }
    solveRec(cw, ch, cu, cv, depth + 1, stop);

    // 双线性 prolongation，作为细网格 SOR 的初值。
    for (let y = 0; y < h; y += 1) {
      const fy = Math.max(0, Math.min(ch - 1, (y + 0.5) / 2 - 0.5));
      const y0 = Math.floor(fy);
      const y1 = Math.min(ch - 1, y0 + 1);
      const ty = fy - y0;
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        if (!unknown[i]) continue;
        const fx = Math.max(0, Math.min(cw - 1, (x + 0.5) / 2 - 0.5));
        const x0 = Math.floor(fx);
        const x1 = Math.min(cw - 1, x0 + 1);
        const tx = fx - x0;
        const a = cv[y0 * cw + x0] + (cv[y0 * cw + x1] - cv[y0 * cw + x0]) * tx;
        const b = cv[y1 * cw + x0] + (cv[y1 * cw + x1] - cv[y1 * cw + x0]) * tx;
        v[i] = a + (b - a) * ty;
      }
    }
    sor(w, h, unknown, v, FINE_ITERS, FINE_OMEGA, stop);
  } else {
    const mean = knownSum / knownCount;
    for (let i = 0; i < w * h; i += 1) if (unknown[i]) v[i] = mean;
    sor(w, h, unknown, v, COARSE_ITERS, COARSE_OMEGA, stop);
  }
}

/** 解 Δv = 0：unknown=1 为待求像素，v 进入时已知像素已写好边界值。 */
export function solveMembrane(w: number, h: number, unknown: Uint8Array, v: Float32Array): void {
  if (unknown.length !== w * h || v.length !== w * h) {
    throw new Error(`solveMembrane: buffer size mismatch (${w}x${h})`);
  }
  solveRec(w, h, unknown, v, 0, neverStop);
}

/** 每通道独立求解，交错缓冲 w*h*ch → w*h*ch。 */
function perChannel(
  w: number,
  h: number,
  ch: number,
  f: (c: number) => Float32Array,
): Float32Array {
  const n = w * h;
  const out = new Float32Array(n * ch);
  for (let c = 0; c < ch; c += 1) {
    const plane = f(c);
    for (let i = 0; i < n; i += 1) out[i * ch + c] = plane[i];
  }
  return out;
}

/** 无缝克隆：输出 = mask 外 dst；mask 内 src + 边界差值的膜插值。 */
export function seamlessClone(
  w: number,
  h: number,
  ch: number,
  src: Float32Array,
  dst: Float32Array,
  mask: Uint8Array,
): Float32Array {
  const n = w * h;
  if (src.length !== n * ch || dst.length !== n * ch || mask.length !== n) {
    throw new Error(`seamlessClone: buffer size mismatch (${w}x${h}x${ch})`);
  }
  return perChannel(w, h, ch, (c) => {
    const v = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      v[i] = mask[i] ? 0 : dst[i * ch + c] - src[i * ch + c];
    }
    solveMembrane(w, h, mask, v);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      out[i] = mask[i] ? src[i * ch + c] + v[i] : dst[i * ch + c];
    }
    return out;
  });
}

/** 膜填充：没有源纹理时，把已知像素调和插值进 hole。 */
export function membraneFill(
  w: number,
  h: number,
  ch: number,
  img: Float32Array,
  hole: Uint8Array,
): Float32Array {
  const n = w * h;
  if (img.length !== n * ch || hole.length !== n) {
    throw new Error(`membraneFill: buffer size mismatch (${w}x${h}x${ch})`);
  }
  return perChannel(w, h, ch, (c) => {
    const v = new Float32Array(n);
    for (let i = 0; i < n; i += 1) v[i] = hole[i] ? 0 : img[i * ch + c];
    solveMembrane(w, h, hole, v);
    return v;
  });
}

function rgbaToFloat(src: RgbaBuffer): Float32Array {
  const out = new Float32Array(src.data.length);
  for (let i = 0; i < src.data.length; i += 1) out[i] = src.data[i] / 255;
  return out;
}

function floatToRgba(data: Float32Array, width: number, height: number): RgbaBuffer {
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = data[i] * 255;
  return { data: out, width, height };
}

/** RGBA 包装：用于内容识别填充打底，alpha 同样参与调和插值。 */
export function membraneFillRgba(src: RgbaBuffer, hole: Uint8Array): RgbaBuffer {
  const filled = membraneFill(src.width, src.height, 4, rgbaToFloat(src), hole);
  return floatToRgba(filled, src.width, src.height);
}

/** RGBA 包装：src 提纹理，dst 提供边界颜色/亮度。 */
export function seamlessCloneRgba(src: RgbaBuffer, dst: RgbaBuffer, mask: Uint8Array): RgbaBuffer {
  if (src.width !== dst.width || src.height !== dst.height) {
    throw new Error("seamlessCloneRgba: size mismatch");
  }
  const out = seamlessClone(
    dst.width,
    dst.height,
    4,
    rgbaToFloat(src),
    rgbaToFloat(dst),
    mask,
  );
  return floatToRgba(out, dst.width, dst.height);
}
