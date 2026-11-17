/**
 * 智能选区：色彩范围 / 扩大选取 / 选取主体 / 天空 / 焦点区域。
 *
 * 架构与滤镜内核一致：**纯像素判定（*Hit 函数）** + **薄薄的 canvas 落版**。
 * 纯函数只吃 RGBA 字节数组、吐 0/1 命中表，node（vitest）可直接断言；
 * canvas 包装层负责读像素、把命中表写进 alpha 蒙版 —— 这层不做像素决策。
 * 均为自研启发式：
 *
 * - 色彩范围：以给定颜色为中心的全图相似色筛选（不要求连通），
 *   即 PS「选择 > 色彩范围」用吸管点了一个颜色的行为。
 * - 扩大选取：从当前选区边界出发，把「与边界像素颜色相近的相邻像素」
 *   逐步吸进来（多源 BFS，局部相似）—— 比几何扩边更贴近 PS 的 Grow。
 * - 选取主体：用画面四周一圈估计背景色，选出与背景差异大的像素。
 *   对背景干净的图片（证件照、商品图）效果最好。
 * - 天空：蓝色相 + 一定亮度的候选像素，只保留与图像上缘连通的部分，
 *   避免把蓝色的衣服、招牌一起选进来。
 * - 焦点区域：modified Laplacian 聚焦测度 + 彩色引导滤波（PhotoCraft focus.rs）。
 */
import { focusAreaHit } from "../engine/algos/focusArea";
import { BG, FG, grabcut, PR_FG } from "../engine/algos/grabcut";
import { subjectSaliencyHit } from "../engine/algos/subject";
import { skyRobustHit } from "../engine/algos/sky";
import type { RgbaBuffer } from "../engine/filters/kernels";
import { createSurface, mustCtx, readPixels } from "../engine/surface";

/* ------------------------------------------------------------ 纯判定函数 */

/** 色彩范围：与 (r,g,b) 的距离平方 ≤ tol²·4 的像素置 1。 */
export function colorRangeHit(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  rgb: readonly [number, number, number],
  tolerance: number,
): Uint8Array {
  const tol = Math.max(0, tolerance) * tolerance * 4;
  const hit = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p += 1) {
    const i = p * 4;
    const dr = d[i] - rgb[0];
    const dg = d[i + 1] - rgb[1];
    const db = d[i + 2] - rgb[2];
    if (dr * dr + dg * dg + db * db <= tol) hit[p] = 1;
  }
  return hit;
}

/**
 * 扩大选取：sel 为 0/1 选区表。多源 BFS —— 新像素只要与「拉它进来的
 * 那个已选像素」颜色相近就加入。返回生长后的选区表（原地新表）。
 */
export function growHit(
  sel: Uint8Array,
  d: Uint8ClampedArray,
  w: number,
  h: number,
  tolerance: number,
): Uint8Array {
  const out = sel.slice();
  const queue: number[] = [];
  for (let p = 0; p < w * h; p += 1) if (sel[p]) queue.push(p);
  if (queue.length === 0) return out;
  const tol = Math.max(0, tolerance) * tolerance * 4;
  let head = 0;
  while (head < queue.length) {
    const p = queue[head];
    head += 1;
    const x = p % w;
    const y = (p / w) | 0;
    const i = p * 4;
    for (let k = 0; k < 4; k += 1) {
      const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0);
      const ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const np = ny * w + nx;
      if (out[np]) continue;
      const j = np * 4;
      const dr = d[j] - d[i];
      const dg = d[j + 1] - d[i + 1];
      const db = d[j + 2] - d[i + 2];
      const da = d[j + 3] - d[i + 3];
      if (dr * dr + dg * dg + db * db + da * da <= tol) {
        out[np] = 1;
        queue.push(np);
      }
    }
  }
  return out;
}

/** 选取主体：返回 null 表示找不到（纯色图 / 边框不可采样）。 */
export function subjectHit(d: Uint8ClampedArray, w: number, h: number): Uint8Array | null {
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!(x < band || y < band || x >= w - band || y >= h - band)) continue;
      const i = (y * w + x) * 4;
      if (d[i + 3] < 32) continue;
      rs.push(d[i]);
      gs.push(d[i + 1]);
      bs.push(d[i + 2]);
    }
  }
  if (rs.length < 16) return null;
  const med = (arr: number[]): number => {
    arr.sort((a, b) => a - b);
    return arr[arr.length >> 1];
  };
  const br = med(rs);
  const bg = med(gs);
  const bb = med(bs);
  // 背景自身的波动（边框内颜色方差）决定阈值，避免噪点背景误吞主体
  let varSum = 0;
  for (let n = 0; n < rs.length; n += 1) {
    const dr = rs[n] - br;
    const dg = gs[n] - bg;
    const db = bs[n] - bb;
    varSum += dr * dr + dg * dg + db * db;
  }
  const sigma = Math.sqrt(varSum / rs.length);
  // 阈值要点：边框本身也可能有好几种颜色（天空/白墙/地面），
  // 那样 sigma 会很大，若直接按 sigma×4 放大会把整张图都判成「背景」。
  // 这里给上限封顶，并且用真实欧氏距离比较（而不是 ThR²×3）。
  const thr = Math.min(120, sigma * 2 + 40);
  const thr2 = thr * thr;
  const hit = new Uint8Array(w * h);
  let count = 0;
  for (let p = 0; p < w * h; p += 1) {
    const i = p * 4;
    const dr = d[i] - br;
    const dg = d[i + 1] - bg;
    const db = d[i + 2] - bb;
    if (dr * dr + dg * dg + db * db > thr2) {
      hit[p] = 1;
      count += 1;
    }
  }
  if (count === 0) return null;
  return hit;
}

/** 选取天空：null 表示画面里没有蓝色候选。 */
export function skyHit(d: Uint8ClampedArray, w: number, h: number): Uint8Array | null {
  const hit = new Uint8Array(w * h);
  let any = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      if (d[i + 3] < 32) continue;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max === min || max === 0) continue;
      const sat = (max - min) / max;
      const val = max / 255;
      if (val < 0.35 || sat < 0.12) continue;
      // 色相在青-蓝-紫蓝（170°~260°）
      const hu =
        max === b
          ? 60 * (4 + (r - g) / (max - min))
          : max === g
            ? 60 * (2 + (b - r) / (max - min))
            : 60 * (((g - b) / (max - min) + 6) % 6);
      if (hu >= 170 && hu <= 260) {
        hit[y * w + x] = 1;
        any += 1;
      }
    }
  }
  if (any === 0) return null;
  // 连通过滤：只保留能从上缘（前 25% 行）走到的候选
  const keep = new Uint8Array(w * h);
  const stack: number[] = [];
  const topLimit = Math.max(1, Math.round(h * 0.25));
  for (let y = 0; y < topLimit; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = y * w + x;
      if (hit[p] && !keep[p]) {
        keep[p] = 1;
        stack.push(p);
      }
    }
  }
  while (stack.length > 0) {
    const p = stack.pop() as number;
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0 && hit[p - 1] && !keep[p - 1]) {
      keep[p - 1] = 1;
      stack.push(p - 1);
    }
    if (x < w - 1 && hit[p + 1] && !keep[p + 1]) {
      keep[p + 1] = 1;
      stack.push(p + 1);
    }
    if (y > 0 && hit[p - w] && !keep[p - w]) {
      keep[p - w] = 1;
      stack.push(p - w);
    }
    if (y < h - 1 && hit[p + w] && !keep[p + w]) {
      keep[p + w] = 1;
      stack.push(p + w);
    }
  }
  return keep;
}

/**
 * 焦点区域：null 表示没有足够的合焦像素。
 * 算法已升级为 PhotoCraft 的 modified Laplacian + 99 分位归一化 +
 * 彩色引导滤波 + 小岛清理；threshold 语义为 In-Focus Range（0..100，越大范围越宽）。
 */
export function focusHit(d: Uint8ClampedArray, w: number, h: number, threshold: number): Uint8Array | null {
  return focusAreaHit(d, w, h, threshold);
}

/* ------------------------------------------------------------ canvas 落版 */

/** 把 0/1 命中表写进一张白底 alpha 蒙版。 */
function maskFrom(w: number, h: number, hit: Uint8Array): HTMLCanvasElement {
  const mask = createSurface(w, h);
  const out = readPixels(mask);
  const od = out.data;
  for (let p = 0; p < w * h; p += 1) {
    if (hit[p]) {
      const i = p * 4;
      od[i] = 255;
      od[i + 1] = 255;
      od[i + 2] = 255;
      od[i + 3] = 255;
    }
  }
  mustCtx(mask).putImageData(out, 0, 0);
  return mask;
}

/** 色彩范围蒙版（供菜单直接调用）。 */
export function colorRangeMask(
  surface: HTMLCanvasElement,
  rgb: readonly [number, number, number],
  tolerance: number,
): HTMLCanvasElement | null {
  const { width: w, height: h } = surface;
  return maskFrom(w, h, colorRangeHit(readPixels(surface).data, w, h, rgb, tolerance));
}

/** 扩大选取蒙版。mask 为空 / surface 尺寸不匹配时返回 null。 */
export function growByColor(
  mask: HTMLCanvasElement,
  surface: HTMLCanvasElement,
  tolerance: number,
): HTMLCanvasElement | null {
  const { width: w, height: h } = surface;
  if (mask.width !== w || mask.height !== h) return null;
  const md = readPixels(mask).data;
  const sel = new Uint8Array(w * h);
  let count = 0;
  for (let p = 0; p < w * h; p += 1) {
    if (md[p * 4 + 3] > 127) {
      sel[p] = 1;
      count += 1;
    }
  }
  if (count === 0) return null;
  return maskFrom(w, h, growHit(sel, readPixels(surface).data, w, h, tolerance));
}

/** 主体蒙版（原始边框背景启发式，保留作兜底）。 */
export function subjectMask(surface: HTMLCanvasElement): HTMLCanvasElement | null {
  const { width: w, height: h } = surface;
  const hit = subjectHit(readPixels(surface).data, w, h);
  return hit ? maskFrom(w, h, hit) : null;
}

/**
 * 主体蒙版（GrabCut 版）：先用边框背景启发式找粗范围，再用图割精修边缘。
 * 工作分辨率压到约 3 万像素，避免大图在主线程卡顿。
 */
export function subjectGrabcutMask(surface: HTMLCanvasElement): HTMLCanvasElement | null {
  const { width: w, height: h } = surface;
  const full = readPixels(surface).data;
  const rough = subjectHit(full, w, h);
  if (!rough) return null;

  let x0 = w;
  let y0 = h;
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < rough.length; i += 1) {
    if (!rough[i]) continue;
    const x = i % w;
    const y = (i / w) | 0;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 <= x0 || y1 <= y0) return null;
  const pad = Math.max(4, Math.round(Math.max(w, h) * 0.04));
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad);
  y1 = Math.min(h - 1, y1 + pad);

  const step = Math.max(1, Math.ceil(Math.sqrt((w * h) / 30000)));
  const sw = Math.ceil(w / step);
  const sh = Math.ceil(h / step);
  const sub = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y += 1) {
    const sy = Math.min(h - 1, y * step);
    for (let x = 0; x < sw; x += 1) {
      const sx = Math.min(w - 1, x * step);
      const from = (sy * w + sx) * 4;
      const to = (y * sw + x) * 4;
      sub[to] = full[from];
      sub[to + 1] = full[from + 1];
      sub[to + 2] = full[from + 2];
      sub[to + 3] = 255;
    }
  }

  const trimap = new Uint8Array(sw * sh).fill(BG);
  for (let y = Math.floor(y0 / step); y <= Math.min(sh - 1, Math.ceil(y1 / step)); y += 1) {
    for (let x = Math.floor(x0 / step); x <= Math.min(sw - 1, Math.ceil(x1 / step)); x += 1) {
      trimap[y * sw + x] = PR_FG;
      const roughIndex = Math.min(h - 1, y * step) * w + Math.min(w - 1, x * step);
      if (rough[roughIndex]) trimap[y * sw + x] = FG;
    }
  }

  const img: RgbaBuffer = { data: sub, width: sw, height: sh };
  const result = grabcut(img, trimap, 5);
  const out = new Uint8Array(w * h);
  let count = 0;
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(sh - 1, Math.floor(y / step));
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(sw - 1, Math.floor(x / step));
      const label = result.trimap[sy * sw + sx];
      if (label === FG || label === PR_FG) {
        out[y * w + x] = 1;
        count += 1;
      }
    }
  }
  return count >= 4 ? maskFrom(w, h, out) : null;
}

/**
 * 主体蒙版（SLIC 显著性 + GrabCut，PhotoCraft subject.rs）。
 * 失败时依次回退到 P1 的 GrabCut 版和原始边框启发式，保证菜单不会空手而归。
 */
export function subjectSaliencyMask(surface: HTMLCanvasElement): HTMLCanvasElement | null {
  const { width: w, height: h } = surface;
  const hit = subjectSaliencyHit(readPixels(surface).data, w, h);
  if (hit) return maskFrom(w, h, hit);
  return subjectGrabcutMask(surface) ?? subjectMask(surface);
}

/** 天空蒙版（原始色相 + 上缘连通启发式，保留作兜底）。 */
export function skyMask(surface: HTMLCanvasElement): HTMLCanvasElement | null {
  const { width: w, height: h } = surface;
  const hit = skyHit(readPixels(surface).data, w, h);
  return hit ? maskFrom(w, h, hit) : null;
}

/** 天空蒙版（颜色先验 + 区域生长 + GMM 补洞 + 引导滤波，PhotoCraft sky.rs）。 */
export function skyRobustMask(surface: HTMLCanvasElement): HTMLCanvasElement | null {
  const { width: w, height: h } = surface;
  const hit = skyRobustHit(readPixels(surface).data, w, h);
  if (hit) return maskFrom(w, h, hit);
  return skyMask(surface);
}

/** 焦点区域蒙版。 */
export function focusMask(surface: HTMLCanvasElement, threshold: number): HTMLCanvasElement | null {
  const { width: w, height: h } = surface;
  const hit = focusHit(readPixels(surface).data, w, h, threshold);
  return hit ? maskFrom(w, h, hit) : null;
}
