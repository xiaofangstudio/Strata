/**
 * 内容识别缩放（Seam Carving，Avidan & Shamir, "Seam Carving for
 * Content-Aware Image Resizing", SIGGRAPH 2007）。
 *
 * 纯像素算法，不依赖 DOM / Canvas，node（vitest）可直接断言：
 * - 能量图 = 双向梯度（Sobel 近似），保护纹理丰富区域、删除低能量接缝；
 * - 接缝 = 每行（列）恰好一个像素的 8-连通路径，用 DP O(w·h) 求最小能量；
 * - 横向缩放删竖直缝、纵向缩删水平缝，放大时反向复制最小缝；
 * - 支持保护蒙版（0~255）：蒙版内能量加一个巨大的惩罚值，保证删不到；
 *   以及「抹除蒙版」：蒙版内能量视为 0，优先被删掉（相当于擦除物体）。
 *
 * 大图注意：每次只删/复制一条缝，O(target·w·h)；对话框里对超大图
 * 建议先降采样再操作（UI 层自行取舍）。
 */
import type { RgbaBuffer } from "../engine/filters/kernels";
import { makeBuffer } from "../engine/filters/kernels";

/** 单条缝：每行（或列）一个坐标。竖直缝存 x 坐标（长度 = 高），水平缝存 y。 */
export type Seam = number[];

/** 能量选项。 */
export interface SeamOptions {
  /** 保护蒙版（同尺寸 0~255，值越大越受保护），可省略 */
  protect?: Uint8ClampedArray;
  /** 抹除蒙版（同尺寸 0~255，值越大越先被删除），可省略 */
  remove?: Uint8ClampedArray;
  /** 保护惩罚强度（默认 1e5，够大即可） */
  protectBias?: number;
}

/** 双向梯度能量（Sobel 近似，亮度域）。 */
export function energyMap(src: RgbaBuffer): Float32Array {
  const { width: w, height: h, data } = src;
  const out = new Float32Array(w * h);
  const lum = (o: number): number => 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const xl = (y * w + Math.max(0, x - 1)) * 4;
      const xr = (y * w + Math.min(w - 1, x + 1)) * 4;
      const yu = (Math.max(0, y - 1) * w + x) * 4;
      const yd = (Math.min(h - 1, y + 1) * w + x) * 4;
      const gx = lum(xr) - lum(xl);
      const gy = lum(yd) - lum(yu);
      out[y * w + x] = Math.abs(gx) + Math.abs(gy);
    }
  }
  return out;
}

/**
 * DP 求一条最小能量竖直缝（每行一个 x）。
 * 蒙版与选项直接加在能量上：protect 加惩罚、remove 直接归零。
 */
export function findVerticalSeam(
  energy: Float32Array,
  w: number,
  h: number,
  opts: SeamOptions = {},
): Seam {
  const bias = opts.protectBias ?? 1e5;
  const cost = new Float32Array(w * h);
  const from = new Int32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      let e = energy[i];
      if (opts.protect && opts.protect[i] > 0) e += bias * (opts.protect[i] / 255);
      if (opts.remove && opts.remove[i] > 0) e = 0;
      if (y === 0) {
        cost[i] = e;
        from[i] = -1;
        continue;
      }
      let best = cost[i - w];
      let bx = x;
      if (x > 0 && cost[i - w - 1] < best) {
        best = cost[i - w - 1];
        bx = x - 1;
      }
      if (x < w - 1 && cost[i - w + 1] < best) {
        best = cost[i - w + 1];
        bx = x + 1;
      }
      cost[i] = e + best;
      from[i] = bx;
    }
  }
  // 回溯：最后一行能量最小的位置
  let x = 0;
  let best = cost[(h - 1) * w];
  for (let cx = 1; cx < w; cx += 1) {
    if (cost[(h - 1) * w + cx] < best) {
      best = cost[(h - 1) * w + cx];
      x = cx;
    }
  }
  const seam: Seam = new Array(h);
  for (let y = h - 1; y >= 0; y -= 1) {
    seam[y] = x;
    const p = from[y * w + x];
    x = p < 0 ? x : p;
  }
  return seam;
}

/** DP 求一条最小能量水平缝（每列一个 y）。 */
export function findHorizontalSeam(
  energy: Float32Array,
  w: number,
  h: number,
  opts: SeamOptions = {},
): Seam {
  // 转置成竖直缝问题：列变行
  const te = new Float32Array(w * h);
  const tp = opts.protect ? new Uint8ClampedArray(w * h) : undefined;
  const tr = opts.remove ? new Uint8ClampedArray(w * h) : undefined;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      te[x * h + y] = energy[y * w + x];
      if (tp) tp[x * h + y] = opts.protect![y * w + x];
      if (tr) tr[x * h + y] = opts.remove![y * w + x];
    }
  }
  const tseam = findVerticalSeam(te, h, w, {
    protect: tp,
    remove: tr,
    protectBias: opts.protectBias,
  });
  return tseam; // seam[y 的索引]=原 y 值，按列序排列
}

/** 删掉一条竖直缝：宽度 -1。 */
export function removeVerticalSeam(src: RgbaBuffer, seam: Seam): RgbaBuffer {
  const { width: w, height: h } = src;
  const out = makeBuffer(w - 1, h);
  for (let y = 0; y < h; y += 1) {
    const sx = seam[y];
    let o = (y * (w - 1)) * 4;
    for (let x = 0; x < w; x += 1) {
      if (x === sx) continue;
      const s = (y * w + x) * 4;
      out.data[o] = src.data[s];
      out.data[o + 1] = src.data[s + 1];
      out.data[o + 2] = src.data[s + 2];
      out.data[o + 3] = src.data[s + 3];
      o += 4;
    }
  }
  return out;
}

/** 复制一条竖直缝（放大用）：宽度 +1。 */
export function insertVerticalSeam(src: RgbaBuffer, seam: Seam): RgbaBuffer {
  const { width: w, height: h } = src;
  const out = makeBuffer(w + 1, h);
  for (let y = 0; y < h; y += 1) {
    const sx = seam[y];
    let o = (y * (w + 1)) * 4;
    for (let x = 0; x < w + 1; x += 1) {
      const copyAt = x;
      const from = copyAt <= sx ? copyAt : copyAt - 1;
      const s = (y * w + from) * 4;
      let r = src.data[s];
      let g = src.data[s + 1];
      let b = src.data[s + 2];
      let a = src.data[s + 3];
      if (copyAt === sx) {
        // 与左邻取均值，减少复制缝带来的条纹
        const sl = (y * w + Math.max(0, sx - 1)) * 4;
        r = (r + src.data[sl]) / 2;
        g = (g + src.data[sl + 1]) / 2;
        b = (b + src.data[sl + 2]) / 2;
      }
      out.data[o] = r;
      out.data[o + 1] = g;
      out.data[o + 2] = b;
      out.data[o + 3] = a;
      o += 4;
    }
  }
  return out;
}

/** 删掉一条水平缝：高度 -1。 */
export function removeHorizontalSeam(src: RgbaBuffer, seam: Seam): RgbaBuffer {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h - 1);
  for (let x = 0; x < w; x += 1) {
    const sy = seam[x];
    let o = x * 4;
    for (let y = 0; y < h; y += 1) {
      if (y === sy) continue;
      const s = (y * w + x) * 4;
      out.data[o] = src.data[s];
      out.data[o + 1] = src.data[s + 1];
      out.data[o + 2] = src.data[s + 2];
      out.data[o + 3] = src.data[s + 3];
      o += w * 4;
    }
  }
  return out;
}

/** 复制一条水平缝：高度 +1。 */
export function insertHorizontalSeam(src: RgbaBuffer, seam: Seam): RgbaBuffer {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h + 1);
  for (let x = 0; x < w; x += 1) {
    const sy = seam[x];
    for (let y = 0; y < h + 1; y += 1) {
      const from = y <= sy ? y : y - 1;
      const s = (from * w + x) * 4;
      let r = src.data[s];
      let g = src.data[s + 1];
      let b = src.data[s + 2];
      const a = src.data[s + 3];
      if (y === sy) {
        const su = (Math.max(0, sy - 1) * w + x) * 4;
        r = (r + src.data[su]) / 2;
        g = (g + src.data[su + 1]) / 2;
        b = (b + src.data[su + 2]) / 2;
      }
      const o = (y * w + x) * 4;
      out.data[o] = r;
      out.data[o + 1] = g;
      out.data[o + 2] = b;
      out.data[o + 3] = a;
    }
  }
  return out;
}

/**
 * 内容识别缩放总入口：把 src 缩放到 targetW × targetH。
 * 先做横向（竖直缝），再做纵向（水平缝）；放大方向用复制缝。
 * protect/remove 蒙版只对第一轮有效（几何变了之后蒙版坐标不再成立），
 * 这一点与 Photoshop 的行为一致（保护区随缝移动本身就很难跟踪）。
 */
export function contentAwareScale(
  src: RgbaBuffer,
  targetW: number,
  targetH: number,
  opts: SeamOptions = {},
): RgbaBuffer {
  let cur = src;
  const dw = Math.round(targetW) - src.width;
  const dh = Math.round(targetH) - src.height;
  const vertical = Math.abs(dw);
  const horizontal = Math.abs(dh);

  for (let i = 0; i < vertical; i += 1) {
    const energy = energyMap(cur);
    const seam = findVerticalSeam(energy, cur.width, cur.height, opts);
    cur = dw > 0 ? insertVerticalSeam(cur, seam) : removeVerticalSeam(cur, seam);
  }
  for (let i = 0; i < horizontal; i += 1) {
    const energy = energyMap(cur);
    const seam = findHorizontalSeam(energy, cur.width, cur.height, opts);
    cur = dh > 0 ? insertHorizontalSeam(cur, seam) : removeHorizontalSeam(cur, seam);
  }
  return cur;
}
