/**
 * Focus Area（焦区域）纯判定内核。
 *
 * Ported from ArtCraft PhotoCraft (crates/algo/src/segment/focus.rs),
 * MIT / Apache-2.0。Nayar & Nakagawa 的 modified Laplacian 聚焦测度：
 * 局部锐度 → 99 分位归一化 → 阈值化 → 彩色引导滤波贴合物体边缘 → 清理小岛。
 *
 * 仍只吃 RGBA 字节数组、吐 0/1 命中表；大图先在 ≤1MP 的工作分辨率上算，
 * 再映射回原分辨率，避免 24MP 图片在 UI 线程卡顿。
 */
import { boxMean, guidedFilterColor } from "./guidedFilter";

const WORK_PX = 1_000_000;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 清理过小的连通块（4 邻域），保留视觉上成片的合焦区域。 */
function cleanMask(mask: Uint8Array, w: number, h: number): void {
  const n = w * h;
  const minSize = Math.max(8, Math.floor(n * 0.002));
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  for (let seed = 0; seed < n; seed += 1) {
    if (!mask[seed] || seen[seed]) continue;
    let head = 0;
    let tail = 0;
    stack[tail++] = seed;
    seen[seed] = 1;
    const pixels: number[] = [];
    while (head < tail) {
      const i = stack[head++];
      pixels.push(i);
      const x = i % w;
      const y = (i / w) | 0;
      const neighbors = [
        x > 0 ? i - 1 : -1,
        x + 1 < w ? i + 1 : -1,
        y > 0 ? i - w : -1,
        y + 1 < h ? i + w : -1,
      ];
      for (const j of neighbors) {
        if (j < 0 || seen[j] || !mask[j]) continue;
        seen[j] = 1;
        stack[tail++] = j;
      }
    }
    if (pixels.length >= minSize) continue;
    for (const i of pixels) mask[i] = 0;
  }
}

/**
 * 计算焦点区域选区。
 * threshold 沿用现有 UI 的 0..100：越大表示“合焦范围”越宽（PhotoCraft 的 in-focus range）。
 */
export function focusAreaHit(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  threshold: number,
): Uint8Array | null {
  const full = w * h;
  if (w < 4 || h < 4 || d.length < full * 4) return null;

  const step = Math.max(1, Math.ceil(Math.sqrt(full / WORK_PX)));
  const ww = Math.ceil(w / step);
  const hh = Math.ceil(h / step);
  const n = ww * hh;
  const guide = new Float32Array(n * 3);
  const luma = new Float32Array(n);
  for (let y = 0; y < hh; y += 1) {
    for (let x = 0; x < ww; x += 1) {
      const sx = Math.min(w - 1, x * step);
      const sy = Math.min(h - 1, y * step);
      const src = (sy * w + sx) * 4;
      const dst = y * ww + x;
      const r = d[src] / 255;
      const g = d[src + 1] / 255;
      const b = d[src + 2] / 255;
      guide[dst * 3] = r;
      guide[dst * 3 + 1] = g;
      guide[dst * 3 + 2] = b;
      luma[dst] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }

  // Modified Laplacian（SML）：横向 + 纵向二阶差分绝对值之和。
  const lap = new Float32Array(n);
  const at = (x: number, y: number) =>
    luma[clamp(y, 0, hh - 1) * ww + clamp(x, 0, ww - 1)];
  for (let y = 0; y < hh; y += 1) {
    for (let x = 0; x < ww; x += 1) {
      const i = y * ww + x;
      const c = luma[i];
      lap[i] =
        Math.abs(2 * c - at(x - 1, y) - at(x + 1, y)) +
        Math.abs(2 * c - at(x, y - 1) - at(x, y + 1));
    }
  }

  const radius = Math.max(3, Math.floor(Math.min(ww, hh) / 60));
  const energy = boxMean(lap, ww, hh, radius);
  const sorted = energy.slice().sort();
  const p99Raw = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
  const p99 = Number.isFinite(p99Raw) && p99Raw > 0 ? p99Raw : 1e-6;
  const sharp = new Float32Array(n);
  for (let i = 0; i < n; i += 1) sharp[i] = Math.min(1, energy[i] / p99);

  const range = clamp(threshold / 100, 0, 1);
  const t = 0.05 + 0.9 * (1 - range) ** 2;
  const bin = new Float32Array(n);
  for (let i = 0; i < n; i += 1) bin[i] = sharp[i] >= t ? 1 : 0;

  const gfRadius = Math.max(2, Math.floor(Math.min(ww, hh) / 50));
  const smooth = guidedFilterColor(guide, bin, ww, hh, gfRadius, 1e-2);
  const workMask = new Uint8Array(n);
  let any = 0;
  for (let i = 0; i < n; i += 1) {
    if (smooth[i] >= 0.5) {
      workMask[i] = 1;
      any += 1;
    }
  }
  if (any === 0) return null;
  cleanMask(workMask, ww, hh);

  // 映射回原分辨率；3× 陡峭化模拟 PhotoCraft 的软边缘上采样后的过渡收窄。
  const hit = new Uint8Array(full);
  let count = 0;
  for (let y = 0; y < h; y += 1) {
    const wy = Math.min(hh - 1, Math.floor(y / step));
    for (let x = 0; x < w; x += 1) {
      const wx = Math.min(ww - 1, Math.floor(x / step));
      const wi = wy * ww + wx;
      if (!workMask[wi]) continue;
      const steep = clamp((smooth[wi] - 0.5) * 3 + 0.5, 0, 1);
      const value = steep >= 0.5 ? 1 : 0;
      hit[y * w + x] = value;
      count += value;
    }
  }
  return count >= 4 ? hit : null;
}
