/**
 * ARAP（As-Rigid-As-Possible）木偶变形。
 *
 * Ported from ArtCraft PhotoCraft (crates/algo/src/puppet.rs), MIT / Apache-2.0
 * 的算法口径。Igarashi et al. "As-Rigid-As-Possible Shape Manipulation"：
 * 网格每个三角形只允许刚体旋转，局部求最佳旋转、全局 Gauss–Seidel/SOR 更新顶点位置，
 * 交替迭代。相比 MLS，大角度旋转时面积和角度保持得更好。
 *
 * 纯函数：只吃 RGBA 缓冲与钉点，不碰 DOM。
 */
import { makeBuffer, sampleBilinear, type RgbaBuffer } from "../filters/kernels";
import type { WarpPin } from "../meshWarp";

export interface ArapOptions {
  /** 网格间距（像素），默认按钉点间距取 8~24。 */
  cell?: number;
  /** 局部/全局迭代次数，默认 30。 */
  iterations?: number;
  /** SOR 松弛系数，默认 1.2。 */
  omega?: number;
}

interface Tri {
  a: number;
  b: number;
  c: number;
  cr: number;
  ci: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 由钉点分布估计合适的网格间距。 */
function autoCell(pins: readonly WarpPin[], w: number, h: number): number {
  let minD = Infinity;
  for (let i = 0; i < pins.length; i += 1) {
    for (let j = i + 1; j < pins.length; j += 1) {
      minD = Math.min(minD, Math.hypot(pins[i].ox - pins[j].ox, pins[i].oy - pins[j].oy));
    }
  }
  return clamp(Math.round(Math.min(Math.min(w, h) / 6, Math.max(4, minD / 2))), 4, 24);
}

/** 计算网格顶点的目标位置；返回 null 表示钉点不足。 */
export function solveArapMesh(
  w: number,
  h: number,
  pins: readonly WarpPin[],
  opts: ArapOptions = {},
): { cols: number; rows: number; rest: Float64Array; solved: Float64Array } | null {
  if (pins.length < 3) return null;
  const cell = clamp(Math.round(opts.cell ?? autoCell(pins, w, h)), 4, 64);
  const cols = clamp(Math.ceil((w - 1) / cell) + 1, 3, 64);
  const rows = clamp(Math.ceil((h - 1) / cell) + 1, 3, 64);
  const n = cols * rows;
  const rest = new Float64Array(n * 2);
  const solved = new Float64Array(n * 2);
  const sx = (w - 1) / (cols - 1);
  const sy = (h - 1) / (rows - 1);
  for (let gy = 0; gy < rows; gy += 1) {
    for (let gx = 0; gx < cols; gx += 1) {
      const i = (gy * cols + gx) * 2;
      rest[i] = gx * sx;
      rest[i + 1] = gy * sy;
      solved[i] = rest[i];
      solved[i + 1] = rest[i + 1];
    }
  }

  // 钉点吸附到最近的网格顶点（硬约束）。
  const pinned = new Uint8Array(n);
  for (const pin of pins) {
    const gx = clamp(Math.round(pin.ox / sx), 0, cols - 1);
    const gy = clamp(Math.round(pin.oy / sy), 0, rows - 1);
    const i = gy * cols + gx;
    pinned[i] = 1;
    solved[i * 2] = pin.x;
    solved[i * 2 + 1] = pin.y;
  }

  const tris: Tri[] = [];
  for (let gy = 0; gy < rows - 1; gy += 1) {
    for (let gx = 0; gx < cols - 1; gx += 1) {
      const a = gy * cols + gx;
      const b = a + 1;
      const c = a + cols + 1;
      const d = a + cols;
      tris.push({ a, b, c, cr: 1, ci: 0 });
      tris.push({ a, b: c, c: d, cr: 1, ci: 0 });
    }
  }

  const omega = clamp(opts.omega ?? 1.2, 0.5, 1.9);
  const iters = clamp(Math.round(opts.iterations ?? 30), 1, 100);
  for (let iter = 0; iter < iters; iter += 1) {
    // 局部步：每个三角形求最佳刚体旋转（复数闭式 u = Σ f·conj(e) / |·|）。
    for (const t of tris) {
      let sr = 0;
      let si = 0;
      const p0 = t.a * 2;
      const p1 = t.b * 2;
      const p2 = t.c * 2;
      for (const [pi, qi] of [[p1, t.b * 2], [p2, t.c * 2]] as const) {
        const ex = rest[pi] - rest[p0];
        const ey = rest[pi + 1] - rest[p0 + 1];
        const fx = solved[qi] - solved[t.a * 2];
        const fy = solved[qi + 1] - solved[t.a * 2 + 1];
        sr += fx * ex + fy * ey;
        si += fy * ex - fx * ey;
      }
      const m = Math.hypot(sr, si);
      if (m > 1e-9) {
        t.cr = sr / m;
        t.ci = si / m;
      }
    }

    // 全局步：q_i ← q_i + ω(mean(q_j + R_ij(p_i−p_j)) − q_i)。
    const acc = new Float64Array(n * 2);
    const cnt = new Uint16Array(n);
    for (const t of tris) {
      for (const [i, j, k] of [[t.a, t.b, t.c], [t.b, t.a, t.c], [t.c, t.a, t.b]] as const) {
        if (pinned[i]) continue;
        for (const other of [j, k]) {
          const dx = rest[i * 2] - rest[other * 2];
          const dy = rest[i * 2 + 1] - rest[other * 2 + 1];
          acc[i * 2] += solved[other * 2] + dx * t.cr - dy * t.ci;
          acc[i * 2 + 1] += solved[other * 2 + 1] + dx * t.ci + dy * t.cr;
        }
        cnt[i] += 2;
      }
    }
    for (let i = 0; i < n; i += 1) {
      if (pinned[i] || !cnt[i]) continue;
      const tx = acc[i * 2] / cnt[i];
      const ty = acc[i * 2 + 1] / cnt[i];
      solved[i * 2] += omega * (tx - solved[i * 2]);
      solved[i * 2 + 1] += omega * (ty - solved[i * 2 + 1]);
    }
  }
  return { cols, rows, rest, solved };
}

/** 网格三角形空间索引，避免逐像素暴力遍历所有三角形。 */
function buildBuckets(
  mesh: { cols: number; rows: number; rest: Float64Array; solved: Float64Array },
  w: number,
): { tris: Tri[]; buckets: Map<number, number[]> } {
  const tris: Tri[] = [];
  for (let gy = 0; gy < mesh.rows - 1; gy += 1) {
    for (let gx = 0; gx < mesh.cols - 1; gx += 1) {
      const a = gy * mesh.cols + gx;
      const b = a + 1;
      const c = a + mesh.cols + 1;
      const d = a + mesh.cols;
      tris.push({ a, b, c, cr: 1, ci: 0 });
      tris.push({ a, b: c, c: d, cr: 1, ci: 0 });
    }
  }
  const bs = 16;
  const bw = Math.ceil(w / bs) + 1;
  const buckets = new Map<number, number[]>();
  for (let ti = 0; ti < tris.length; ti += 1) {
    const t = tris[ti];
    const x0 = Math.min(mesh.solved[t.a * 2], mesh.solved[t.b * 2], mesh.solved[t.c * 2]);
    const x1 = Math.max(mesh.solved[t.a * 2], mesh.solved[t.b * 2], mesh.solved[t.c * 2]);
    const y0 = Math.min(mesh.solved[t.a * 2 + 1], mesh.solved[t.b * 2 + 1], mesh.solved[t.c * 2 + 1]);
    const y1 = Math.max(mesh.solved[t.a * 2 + 1], mesh.solved[t.b * 2 + 1], mesh.solved[t.c * 2 + 1]);
    for (let by = Math.max(0, Math.floor(y0 / bs)); by <= Math.min(bw, Math.floor(y1 / bs)); by += 1) {
      for (let bx = Math.max(0, Math.floor(x0 / bs)); bx <= Math.min(bw, Math.floor(x1 / bs)); bx += 1) {
        const key = by * (bw + 1) + bx;
        let list = buckets.get(key);
        if (!list) { list = []; buckets.set(key, list); }
        list.push(ti);
      }
    }
  }
  return { tris, buckets };
}

/** ARAP 变形：输出同尺寸缓冲，反向映射到原图采样。 */
export function arapWarp(
  src: RgbaBuffer,
  pins: readonly WarpPin[],
  opts: ArapOptions = {},
): RgbaBuffer {
  const out = makeBuffer(src.width, src.height);
  const mesh = solveArapMesh(src.width, src.height, pins, opts);
  if (!mesh) {
    out.data.set(src.data);
    return out;
  }
  const { tris, buckets } = buildBuckets(mesh, src.width);
  const bs = 16;
  const bw = Math.ceil(src.width / bs) + 1;
  const sample = new Uint8ClampedArray(4);
  for (let y = 0; y < src.height; y += 1) {
    for (let x = 0; x < src.width; x += 1) {
      const key = Math.floor(y / bs) * (bw + 1) + Math.floor(x / bs);
      const candidates = buckets.get(key);
      const o = (y * src.width + x) * 4;
      if (!candidates || !candidates.length) {
        out.data.set(src.data.subarray(o, o + 4), o);
        continue;
      }
      let done = false;
      for (const ti of candidates) {
        const t = tris[ti];
        const ax = mesh.solved[t.a * 2];
        const ay = mesh.solved[t.a * 2 + 1];
        const bx = mesh.solved[t.b * 2];
        const by = mesh.solved[t.b * 2 + 1];
        const cx = mesh.solved[t.c * 2];
        const cy = mesh.solved[t.c * 2 + 1];
        const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(den) < 1e-9) continue;
        const l0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den;
        const l1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
        const l2 = 1 - l0 - l1;
        if (l0 < -1e-4 || l1 < -1e-4 || l2 < -1e-4) continue;
        const rx = l0 * mesh.rest[t.a * 2] + l1 * mesh.rest[t.b * 2] + l2 * mesh.rest[t.c * 2];
        const ry = l0 * mesh.rest[t.a * 2 + 1] + l1 * mesh.rest[t.b * 2 + 1] + l2 * mesh.rest[t.c * 2 + 1];
        sampleBilinear(src, rx, ry, sample, 0);
        for (let c = 0; c < 4; c += 1) out.data[o + c] = sample[c];
        done = true;
        break;
      }
      if (!done) out.data.set(src.data.subarray(o, o + 4), o);
    }
  }
  return out;
}
