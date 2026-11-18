/**
 * 图像配准：Harris 角点 + steered BRIEF 描述子 + 汉明匹配（Lowe ratio + 互近邻）
 * + 鲁棒模型拟合（平移 / 相似 / 单应，归一化 DLT + RANSAC）。
 *
 * Ported from ArtCraft PhotoCraft (crates/algo/src/features.rs), MIT / Apache-2.0。
 * 纯函数、确定性（固定种子 RNG）：图像是 w×h 的 0..1 亮度平面，不碰 DOM。
 *
 * 用于 Edit › Auto-Align Layers 与全景拼接的第一步配准：
 *  - Harris & Stephens 1988：结构张量 det − k·trace² + 高斯窗 + 非极大抑制 + 最小间距。
 *  - BRIEF (Calonder 2010) / ORB steered (Rublee 2011)：31×31 平滑块上 256 次强度比较，
 *    按强度质心方向旋转。
 *  - Lowe 2004 ratio test + 互近邻。
 *  - RANSAC (Fischler & Bolles 1981) + Hartley 1997 归一化 DLT，内点最小二乘重拟合。
 */
import type { RgbaBuffer } from "../filters/kernels";

export type Pt2 = [number, number];
export type Descriptor = [number, number, number, number]; // 4×u64 位（用 number 存 32 位安全位段，下面用 4×2 数组更稳）
export type Desc = [number, number, number, number, number, number, number, number]; // 8×32bit = 256bit

export interface Corner {
  x: number;
  y: number;
  score: number;
}

export type RegModel = "translation" | "similarity" | "homography";

/** 行主序 3×3 射影矩阵：[x',y',w'] = H·[x,y,1]。 */
export type Homography = [number, number, number, number, number, number, number, number, number];

export const IDENTITY: Homography = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const PATCH_RADIUS = 15;

export function hApply(h: Homography, x: number, y: number): Pt2 {
  const w = h[6] * x + h[7] * y + h[8];
  if (Math.abs(w) < 1e-12) return [NaN, NaN];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

export function hMul(a: Homography, b: Homography): Homography {
  const out = new Array<number>(9) as Homography;
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return out;
}

export function hInverse(m: Homography): Homography | null {
  const c: Homography = [
    m[4] * m[8] - m[5] * m[7],
    m[2] * m[7] - m[1] * m[8],
    m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8],
    m[0] * m[8] - m[2] * m[6],
    m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6],
    m[1] * m[6] - m[0] * m[7],
    m[0] * m[4] - m[1] * m[3],
  ];
  const det = m[0] * c[0] + m[1] * c[3] + m[2] * c[6];
  if (Math.abs(det) < 1e-12) return null;
  return c.map((v) => v / det) as Homography;
}

/** SplitMix64 确定性 RNG。 */
class Rng {
  constructor(private s: number) {}
  next(): number {
    this.s = (this.s + 0x9e3779b97f4a7c15) >>> 0;
    let z = this.s;
    z = Math.imul(z ^ (z >>> 30), 0xbf58476d) >>> 0;
    z = Math.imul(z ^ (z >>> 27), 0x94d049bb) >>> 0;
    return (z ^ (z >>> 31)) >>> 0;
  }
  unit(): number { return this.next() / 0x100000000; }
  below(n: number): number { return this.next() % Math.max(1, n); }
}

/** 可分离盒式模糊（边缘夹取，running sum）。 */
export function boxBlur(w: number, h: number, v: Float32Array, r: number): Float32Array {
  if (w === 0 || h === 0) return new Float32Array(0);
  const den = 2 * r + 1;
  const tmp = new Float32Array(w * h);
  const atX = (row: number, k: number) => v[row * w + Math.min(w - 1, Math.max(0, k))];
  for (let y = 0; y < h; y += 1) {
    let acc = 0;
    for (let k = -r; k <= r; k += 1) acc += atX(y, k);
    for (let x = 0; x < w; x += 1) {
      tmp[y * w + x] = acc / den;
      acc += atX(y, x + r + 1) - atX(y, x - r);
    }
  }
  const out = new Float32Array(w * h);
  const atY = (col: number, k: number) => tmp[Math.min(h - 1, Math.max(0, k)) * w + col];
  for (let x = 0; x < w; x += 1) {
    let acc = 0;
    for (let k = -r; k <= r; k += 1) acc += atY(x, k);
    for (let y = 0; y < h; y += 1) {
      out[y * w + x] = acc / den;
      acc += atY(x, y + r + 1) - atY(x, y - r);
    }
  }
  return out;
}

/* ------------------------------------------------------------ Harris */

/** Harris 角点检测：结构张量 + 非极大抑制 + 最小间距，按分数降序取 max 个。 */
export function harris(
  w: number, h: number, img: Float32Array,
  max = 600, minDist = 8, valid?: Uint8Array,
): Corner[] {
  if (w < 2 * PATCH_RADIUS + 3 || h < 2 * PATCH_RADIUS + 3) return [];
  const xx = new Float32Array(w * h);
  const yy = new Float32Array(w * h);
  const xy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const p = (dx: number, dy: number) => img[(y + dy) * w + (x + dx)];
      const gx = (p(1, -1) + 2 * p(1, 0) + p(1, 1)) - (p(-1, -1) + 2 * p(-1, 0) + p(-1, 1));
      const gy = (p(-1, 1) + 2 * p(0, 1) + p(1, 1)) - (p(-1, -1) + 2 * p(0, -1) + p(1, -1));
      xx[y * w + x] = gx * gx;
      yy[y * w + x] = gy * gy;
      xy[y * w + x] = gx * gy;
    }
  }
  const sx = boxBlur(w, h, boxBlur(w, h, xx, 1), 1);
  const sy = boxBlur(w, h, boxBlur(w, h, yy, 1), 1);
  const sxy = boxBlur(w, h, boxBlur(w, h, xy, 1), 1);
  const r = new Float32Array(w * h);
  let peak = 0;
  for (let i = 0; i < r.length; i += 1) {
    r[i] = sx[i] * sy[i] - sxy[i] * sxy[i] - 0.04 * (sx[i] + sy[i]) ** 2;
    if (r[i] > peak) peak = r[i];
  }
  if (peak <= 0) return [];
  const m = PATCH_RADIUS + 1;
  const cand: Corner[] = [];
  for (let y = m; y < h - m; y += 1) {
    for (let x = m; x < w - m; x += 1) {
      const v = r[y * w + x];
      if (v < peak * 0.01) continue;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          if (r[(y + dy) * w + (x + dx)] > v) { isMax = false; break; }
        }
      }
      if (!isMax) continue;
      if (valid) {
        let all = true;
        for (let yy = y - PATCH_RADIUS; yy <= y + PATCH_RADIUS && all; yy += 5) {
          for (let xx = x - PATCH_RADIUS; xx <= x + PATCH_RADIUS; xx += 5) {
            if (!valid[yy * w + xx]) { all = false; break; }
          }
        }
        if (!all) continue;
      }
      cand.push({ x, y, score: v });
    }
  }
  cand.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
  const cell = Math.max(1, minDist);
  const gw = Math.ceil(w / cell) + 1;
  const gh = Math.ceil(h / cell) + 1;
  const grid: Pt2[][] = Array.from({ length: gw * gh }, () => []);
  const out: Corner[] = [];
  for (const c of cand) {
    const gx = Math.floor(c.x / cell);
    const gy = Math.floor(c.y / cell);
    let near = false;
    for (let yy = Math.max(0, gy - 1); yy <= Math.min(gh - 1, gy + 1) && !near; yy += 1) {
      for (let xx = Math.max(0, gx - 1); xx <= Math.min(gw - 1, gx + 1); xx += 1) {
        if (grid[yy * gw + xx].some(([px, py]) => Math.hypot(px - c.x, py - c.y) < minDist)) {
          near = true; break;
        }
      }
    }
    if (near) continue;
    grid[gy * gw + gx].push([c.x, c.y]);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/* ------------------------------------------------------------ BRIEF */

let briefPairs: number[][] | null = null;

/** 256 个固定的高斯采样对（σ=31/5，裁剪到 ±13），确定性生成一次。 */
function getPairs(): number[][] {
  if (briefPairs) return briefPairs;
  const rng = new Rng(0x0b21ef00);
  const gauss = () => {
    const u = Math.max(1e-12, rng.unit());
    const v = rng.unit();
    return Math.min(13, Math.max(-13, Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * 31 / 5));
  };
  briefPairs = Array.from({ length: 256 }, () => [gauss(), gauss(), gauss(), gauss()]);
  return briefPairs;
}

/** Steered-BRIEF 描述子：256 位存成 8 个 32 位字。 */
export function describe(
  w: number, h: number, img: Float32Array, corners: readonly Corner[], upright = false,
): Desc[] {
  const smooth = boxBlur(w, h, img, 2);
  const at = (x: number, y: number) => {
    const xi = Math.min(w - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(h - 1, Math.max(0, Math.round(y)));
    return smooth[yi * w + xi];
  };
  const pairs = getPairs();
  return corners.map((c) => {
    let s = 0;
    let co = 1;
    if (!upright) {
      let m10 = 0;
      let m01 = 0;
      const r = PATCH_RADIUS;
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          if (dx * dx + dy * dy <= r * r) {
            const v = at(c.x + dx, c.y + dy);
            m10 += dx * v;
            m01 += dy * v;
          }
        }
      }
      const len = Math.hypot(m10, m01);
      s = len > 1e-9 ? m01 / len : 0;
      co = len > 1e-9 ? m10 / len : 1;
    }
    const d = new Array<number>(8).fill(0) as Desc;
    for (let i = 0; i < pairs.length; i += 1) {
      const p = pairs[i];
      const ax = c.x + p[0] * co - p[1] * s;
      const ay = c.y + p[0] * s + p[1] * co;
      const bx = c.x + p[2] * co - p[3] * s;
      const by = c.y + p[2] * s + p[3] * co;
      if (at(ax, ay) < at(bx, by)) d[i >>> 5] |= (1 << (i & 31));
    }
    return d;
  });
}

/** 汉明距离（256 位）。 */
export function hamming(a: Desc, b: Desc): number {
  let n = 0;
  for (let i = 0; i < 8; i += 1) {
    let x = (a[i] ^ b[i]) >>> 0;
    while (x) { x &= x - 1; n += 1; }
  }
  return n;
}

/** Lowe ratio test + 互近邻匹配，返回 (a 索引, b 索引) 对。 */
export function matchDescriptors(a: readonly Desc[], b: readonly Desc[], ratio = 0.85): Pt2[] {
  const best = (d: Desc, set: readonly Desc[]): [number, number, number] => {
    let first = -1;
    let d1 = Infinity;
    let d2 = Infinity;
    for (let j = 0; j < set.length; j += 1) {
      const h = hamming(d, set[j]);
      if (h < d1) { d2 = d1; d1 = h; first = j; }
      else if (h < d2) d2 = h;
    }
    return [first, d1, d2];
  };
  const out: Pt2[] = [];
  for (let i = 0; i < a.length; i += 1) {
    const [j, d1, d2] = best(a[i], b);
    if (j < 0 || d1 > 80 || (d2 < Infinity && d1 > ratio * d2)) continue;
    const [k] = best(b[j], a);
    if (k === i) out.push([i, j]);
  }
  return out;
}

/* ------------------------------------------------------------ 模型拟合 */

function solve(n: number, mat: number[], rhs: number[]): number[] | null {
  const a = mat.slice();
  const b = rhs.slice();
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let i = c + 1; i < n; i += 1) if (Math.abs(a[i * n + c]) > Math.abs(a[p * n + c])) p = i;
    if (Math.abs(a[p * n + c]) < 1e-12) return null;
    if (p !== c) {
      for (let k = 0; k < n; k += 1) { const t = a[c * n + k]; a[c * n + k] = a[p * n + k]; a[p * n + k] = t; }
      const t = b[c]; b[c] = b[p]; b[p] = t;
    }
    for (let r = c + 1; r < n; r += 1) {
      const f = a[r * n + c] / a[c * n + c];
      for (let k = c; k < n; k += 1) a[r * n + k] -= f * a[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) {
    let s = 0;
    for (let k = r + 1; k < n; k += 1) s += a[r * n + k] * x[k];
    x[r] = (b[r] - s) / a[r * n + r];
  }
  return x;
}

function leastSquares(rows: [number[], number][], n: number): number[] | null {
  const ata = new Array<number>(n * n).fill(0);
  const atb = new Array<number>(n).fill(0);
  for (const [r, b] of rows) {
    for (let i = 0; i < n; i += 1) {
      atb[i] += r[i] * b;
      for (let j = 0; j < n; j += 1) ata[i * n + j] += r[i] * r[j];
    }
  }
  return solve(n, ata, atb);
}

function normaliser(pts: readonly Pt2[]): Homography {
  const n = Math.max(1, pts.length);
  const cx = pts.reduce((s, p) => s + p[0], 0) / n;
  const cy = pts.reduce((s, p) => s + p[1], 0) / n;
  const d = pts.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / n;
  const sc = d > 1e-12 ? Math.SQRT2 / d : 1;
  return [sc, 0, -sc * cx, 0, sc, -sc * cy, 0, 0, 1];
}

/** 最小二乘拟合把 src[i] 映到 dst[i] 的模型（最小集合上精确）。 */
export function fit(model: RegModel, src: readonly Pt2[], dst: readonly Pt2[]): Homography | null {
  const n = src.length;
  if (model === "translation") {
    if (n === 0) return null;
    let tx = 0, ty = 0;
    for (let i = 0; i < n; i += 1) { tx += dst[i][0] - src[i][0]; ty += dst[i][1] - src[i][1]; }
    return [1, 0, tx / n, 0, 1, ty / n, 0, 0, 1];
  }
  if (model === "similarity") {
    if (n < 2) return null;
    const rows: [number[], number][] = [];
    for (let i = 0; i < n; i += 1) {
      const [x, y] = src[i];
      const [u, v] = dst[i];
      rows.push([[x, -y, 1, 0], u]);
      rows.push([[y, x, 0, 1], v]);
    }
    const p = leastSquares(rows, 4);
    if (!p) return null;
    return [p[0], -p[1], p[2], p[1], p[0], p[3], 0, 0, 1];
  }
  if (n < 4) return null;
  const ts = normaliser(src);
  const td = normaliser(dst);
  const rows: [number[], number][] = [];
  for (let i = 0; i < n; i += 1) {
    const [x, y] = hApply(ts, src[i][0], src[i][1]);
    const [u, v] = hApply(td, dst[i][0], dst[i][1]);
    rows.push([[x, y, 1, 0, 0, 0, -u * x, -u * y], u]);
    rows.push([[0, 0, 0, x, y, 1, -v * x, -v * y], v]);
  }
  const hh = leastSquares(rows, 8);
  if (!hh) return null;
  const hn: Homography = [hh[0], hh[1], hh[2], hh[3], hh[4], hh[5], hh[6], hh[7], 1];
  const inv = hInverse(td);
  if (!inv) return null;
  const m = hMul(hMul(inv, hn), ts);
  if (Math.abs(m[8]) < 1e-12) return null;
  return m.map((v) => v / m[8]) as Homography;
}

function minPoints(model: RegModel): number {
  return model === "translation" ? 1 : model === "similarity" ? 2 : 4;
}

/** RANSAC：iters 次随机最小采样，取内点最多的模型，再用全部内点重拟合。 */
export function ransac(
  model: RegModel, src: readonly Pt2[], dst: readonly Pt2[],
  iters = 1000, threshold = 3, seed = 7,
): { model: Homography; inliers: number[] } | null {
  const k = minPoints(model);
  const n = src.length;
  if (n < k) return null;
  const rng = new Rng((seed ^ 0xa11c0de5) >>> 0);
  const inliersOf = (hm: Homography) => {
    const out: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const [x, y] = hApply(hm, src[i][0], src[i][1]);
      if (Number.isFinite(x) && Math.hypot(x - dst[i][0], y - dst[i][1]) <= threshold) out.push(i);
    }
    return out;
  };
  let best: { model: Homography; inliers: number[] } | null = null;
  for (let t = 0; t < Math.max(1, iters); t += 1) {
    const idx: number[] = [];
    while (idx.length < k) {
      if (n === k) { for (let i = 0; i < k; i += 1) idx.push(i); break; }
      const i = rng.below(n);
      if (!idx.includes(i)) idx.push(i);
    }
    const s = idx.map((i) => src[i]);
    const d = idx.map((i) => dst[i]);
    const hm = fit(model, s, d);
    if (!hm) continue;
    const inl = inliersOf(hm);
    if (!best || inl.length > best.inliers.length) best = { model: hm, inliers: inl };
  }
  if (!best || best.inliers.length < k) return null;
  const s = best.inliers.map((i) => src[i]);
  const d = best.inliers.map((i) => dst[i]);
  const h2 = fit(model, s, d) ?? best.model;
  const inl2 = inliersOf(h2);
  return inl2.length >= best.inliers.length ? { model: h2, inliers: inl2 } : best;
}

/** 亮度平面配准一站式：检测角点 → 描述 → 匹配 → RANSAC。返回 moving→reference 的矩阵与内点数。 */
export function register(
  w: number, h: number,
  reference: Float32Array, moving: Float32Array,
  model: RegModel = "homography",
  validRef?: Uint8Array, validMov?: Uint8Array,
): { model: Homography; inliers: number } | null {
  const upright = model === "translation";
  const minDist = Math.min(24, Math.max(4, Math.max(w, h) / 60));
  const ca = harris(w, h, reference, 600, minDist, validRef);
  const cb = harris(w, h, moving, 600, minDist, validMov);
  if (ca.length < 4 || cb.length < 4) return null;
  const da = describe(w, h, reference, ca, upright);
  const db = describe(w, h, moving, cb, upright);
  const matches = matchDescriptors(db, da, 0.85);
  const src: Pt2[] = matches.map(([i]) => [cb[i].x, cb[i].y]);
  const dst: Pt2[] = matches.map(([, j]) => [ca[j].x, ca[j].y]);
  const threshold = Math.min(4, Math.max(1.5, Math.max(w, h) / 400));
  const res = ransac(model, src, dst, 1000, threshold, 7);
  if (!res || res.inliers.length < Math.max(6, minPoints(model))) return null;
  return { model: res.model, inliers: res.inliers.length };
}

/** 从 RGBA 取亮度平面（0..1），供 register/harris 使用。 */
export function lumaPlane(img: RgbaBuffer): Float32Array {
  const out = new Float32Array(img.width * img.height);
  for (let p = 0; p < out.length; p += 1) {
    const i = p * 4;
    out[p] = (0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]) / 255;
  }
  return out;
}
