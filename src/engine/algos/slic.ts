/**
 * SLIC 超像素。
 *
 * Ported from ArtCraft PhotoCraft (crates/algo/src/segment/slic.rs), MIT / Apache-2.0。
 * Achanta et al., "SLIC Superpixels Compared to State-of-the-Art Superpixel Methods",
 * IEEE PAMI 2012：CIELAB + xy 的局部 k-means，距离 D = sqrt(dLab² + (dxy/S·m)²)。
 */
export interface Superpixels {
  w: number;
  h: number;
  labels: Int32Array;
  count: number;
  step: number;
}

/** sRGB 0..1 → CIELAB D65（L 0..100）。 */
export function rgbToLab(c: readonly [number, number, number]): [number, number, number] {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const r = lin(c[0]);
  const g = lin(c[1]);
  const b = lin(c[2]);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** 从 RGBA 字节生成 Lab 平面（n*3）。 */
export function rgbaToLabPlanes(data: Uint8ClampedArray, w: number, h: number): Float32Array {
  const n = w * h;
  const lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const p = i * 4;
    const c = rgbToLab([data[p] / 255, data[p + 1] / 255, data[p + 2] / 255]);
    lab[i * 3] = c[0];
    lab[i * 3 + 1] = c[1];
    lab[i * 3 + 2] = c[2];
  }
  return lab;
}

/** 在 Lab 图上跑 SLIC。compactness 典型值 10，iters 典型值 10。 */
export function slicLab(
  lab: Float32Array,
  w: number,
  h: number,
  target: number,
  compactness = 10,
  iters = 10,
): Superpixels {
  const n = w * h;
  if (n === 0) return { w, h, labels: new Int32Array(0), count: 0, step: 1 };
  const s = Math.max(1, Math.sqrt(n / Math.max(1, target)));
  const at = (x: number, y: number): [number, number, number] => {
    const i = (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 3;
    return [lab[i], lab[i + 1], lab[i + 2]];
  };
  const grad = (x: number, y: number): number => {
    const l = at(x - 1, y);
    const r = at(x + 1, y);
    const u = at(x, y - 1);
    const d = at(x, y + 1);
    return (l[0] - r[0]) ** 2 + (l[1] - r[1]) ** 2 + (l[2] - r[2]) ** 2 +
      (u[0] - d[0]) ** 2 + (u[1] - d[1]) ** 2 + (u[2] - d[2]) ** 2;
  };

  // 网格播种 + 3×3 最低梯度
  const centers: number[][] = [];
  for (let cy = s / 2; cy < h; cy += s) {
    for (let cx = s / 2; cx < w; cx += s) {
      let bx = Math.floor(cx);
      let by = Math.floor(cy);
      let best = Infinity;
      for (let yy = Math.max(0, by - 1); yy <= Math.min(h - 1, by + 1); yy += 1) {
        for (let xx = Math.max(0, bx - 1); xx <= Math.min(w - 1, bx + 1); xx += 1) {
          const g = grad(xx, yy);
          if (g < best) {
            best = g;
            bx = xx;
            by = yy;
          }
        }
      }
      const c = at(bx, by);
      centers.push([c[0], c[1], c[2], bx, by]);
    }
  }
  const count = centers.length;
  let labels = new Int32Array(n).fill(-1);
  const dist = new Float32Array(n).fill(Infinity);
  const wxy = (compactness / s) ** 2;
  const window = Math.ceil(2 * s);

  for (let iter = 0; iter < Math.max(1, iters); iter += 1) {
    dist.fill(Infinity);
    for (let k = 0; k < count; k += 1) {
      const c = centers[k];
      const x0 = Math.max(0, Math.floor(c[3] - window));
      const x1 = Math.min(w - 1, Math.ceil(c[3] + window));
      const y0 = Math.max(0, Math.floor(c[4] - window));
      const y1 = Math.min(h - 1, Math.ceil(c[4] + window));
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const i = y * w + x;
          const dx = x - c[3];
          const dy = y - c[4];
          const p = i * 3;
          const d = (lab[p] - c[0]) ** 2 + (lab[p + 1] - c[1]) ** 2 + (lab[p + 2] - c[2]) ** 2 +
            (dx * dx + dy * dy) * wxy;
          if (d < dist[i]) {
            dist[i] = d;
            labels[i] = k;
          }
        }
      }
    }
    const sums = Array.from({ length: count }, () => [0, 0, 0, 0, 0, 0]);
    for (let i = 0; i < n; i += 1) {
      const k = labels[i];
      if (k < 0) continue;
      const p = i * 3;
      const s6 = sums[k];
      s6[0] += lab[p];
      s6[1] += lab[p + 1];
      s6[2] += lab[p + 2];
      s6[3] += i % w;
      s6[4] += (i / w) | 0;
      s6[5] += 1;
    }
    for (let k = 0; k < count; k += 1) {
      const s6 = sums[k];
      if (s6[5] === 0) continue;
      centers[k] = [
        s6[0] / s6[5], s6[1] / s6[5], s6[2] / s6[5],
        s6[3] / s6[5], s6[4] / s6[5],
      ];
    }
  }

  // 连通性：极小的碎片并入相邻最常见的标签。
  const minSize = Math.max(4, Math.floor(n / Math.max(1, count * 6)));
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  for (let seed = 0; seed < n; seed += 1) {
    if (seen[seed] || labels[seed] < 0) continue;
    const k = labels[seed];
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
      const nb = [x > 0 ? i - 1 : -1, x + 1 < w ? i + 1 : -1, y > 0 ? i - w : -1, y + 1 < h ? i + w : -1];
      for (const j of nb) {
        if (j < 0 || seen[j] || labels[j] !== k) continue;
        seen[j] = 1;
        stack[tail++] = j;
      }
    }
    if (pixels.length >= minSize) continue;
    for (const i of pixels) {
      const x = i % w;
      const y = (i / w) | 0;
      const nb = [x > 0 ? i - 1 : -1, x + 1 < w ? i + 1 : -1, y > 0 ? i - w : -1, y + 1 < h ? i + w : -1];
      const votes = new Map<number, number>();
      for (const j of nb) if (j >= 0 && labels[j] !== k) votes.set(labels[j], (votes.get(labels[j]) ?? 0) + 1);
      let best = -1;
      let bestN = 0;
      for (const [kk, nn] of votes) if (nn > bestN) { best = kk; bestN = nn; }
      if (best >= 0) labels[i] = best;
    }
  }

  return { w, h, labels, count, step: s };
}
