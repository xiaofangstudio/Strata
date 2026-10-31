/**
 * 裁正照片（文件 > 自动 > 裁正照片）。
 *
 * 典型场景：一次扫描/拍摄把好几张照片摆在白底（或黑底）上，想一张张切开。
 * 做法是教科书式的「背景估计 + 连通域」：
 *
 * 1. 从四周采样估计背景色（用中位数，抗单点噪声）
 * 2. 与背景距离超过阈值的像素记为前景
 * 3. 对前景做连通域标记（并查集，四连通），太小的丢弃
 * 4. 每个连通域取外接矩形，稍微外扩一点避免切线
 *
 * 纯函数（RGBA 字节数组进、矩形数组出），可以直接单测。
 */

export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 该区域占整图的比例，用来判断是不是「整张图都是前景」 */
  area: number;
}

/** 是不是几乎整张都是前景（说明根本没有多个照片可分）。 */
export interface CropResult {
  boxes: CropBox[];
  /** true 表示判出来只有一整块，不值得切 */
  singleBlob: boolean;
  background: [number, number, number];
}

/**
 * 估计背景色：取四条边上的像素中位数。
 * 用中位数而不是均值，是因为边上可能正好压着一张照片。
 */
function estimateBackground(
  data: Uint8ClampedArray,
  w: number,
  h: number,
): [number, number, number] {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const push = (x: number, y: number): void => {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 8) return; // 透明像素不算
    rs.push(data[i]);
    gs.push(data[i + 1]);
    bs.push(data[i + 2]);
  };
  const band = Math.max(1, Math.round(Math.min(w, h) * 0.02));
  for (let x = 0; x < w; x += 1) {
    for (let k = 0; k < band; k += 1) {
      push(x, k);
      push(x, h - 1 - k);
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let k = 0; k < band; k += 1) {
      push(k, y);
      push(w - 1 - k, y);
    }
  }
  if (rs.length === 0) return [255, 255, 255];
  const mid = (arr: number[]): number => {
    arr.sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)];
  };
  return [mid(rs), mid(gs), mid(bs)];
}

/**
 * 找出画面里「独立的一张张照片」。
 *
 * @param data RGBA 数据
 * @param w 宽
 * @param h 高
 * @param tolerance 与背景的距离阈值（0–255，默认 32）
 * @param minArea 最小面积占比（默认 0.5%，滤掉灰尘）
 */
export function findPhotoRegions(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  tolerance = 32,
  minArea = 0.005,
): CropResult {
  const total = w * h;
  if (total === 0) return { boxes: [], singleBlob: false, background: [255, 255, 255] };

  const bg = estimateBackground(data, w, h);
  const [br, bgc, bb] = bg;
  const thr2 = tolerance * tolerance;

  // 前景标记
  const fg = new Uint8Array(total);
  for (let p = 0; p < total; p += 1) {
    const i = p * 4;
    if (data[i + 3] < 8) continue;
    const dr = data[i] - br;
    const dg = data[i + 1] - bgc;
    const db = data[i + 2] - bb;
    if (dr * dr + dg * dg + db * db > thr2) fg[p] = 1;
  }

  // 连通域：并查集（四连通），一遍扫描即可
  const parent = new Int32Array(total).fill(-1);
  const find = (a: number): number => {
    let x = a;
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = y * w + x;
      if (!fg[p]) continue;
      parent[p] = p;
      if (x > 0 && fg[p - 1]) union(p, p - 1);
      if (y > 0 && fg[p - w]) union(p, p - w);
    }
  }

  // 统计每个根的外接框与像素数
  const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number; n: number }>();
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = y * w + x;
      if (!fg[p] || parent[p] < 0) continue;
      const root = find(p);
      const cur = boxes.get(root);
      if (!cur) {
        boxes.set(root, { x0: x, y0: y, x1: x, y1: y, n: 1 });
      } else {
        if (x < cur.x0) cur.x0 = x;
        if (y < cur.y0) cur.y0 = y;
        if (x > cur.x1) cur.x1 = x;
        if (y > cur.y1) cur.y1 = y;
        cur.n += 1;
      }
    }
  }

  const minPixels = Math.max(16, Math.floor(total * minArea));
  const out: CropBox[] = [];
  for (const b of boxes.values()) {
    if (b.n < minPixels) continue;
    const pad = 2;
    const x = Math.max(0, b.x0 - pad);
    const y = Math.max(0, b.y0 - pad);
    const x1 = Math.min(w - 1, b.x1 + pad);
    const y1 = Math.min(h - 1, b.y1 + pad);
    out.push({
      x,
      y,
      w: x1 - x + 1,
      h: y1 - y + 1,
      area: (x1 - x + 1) * (y1 - y + 1) / total,
    });
  }

  // 按阅读顺序排（先上后下、先左后右）
  out.sort((a, b) => (Math.abs(a.y - b.y) > a.h * 0.5 ? a.y - b.y : a.x - b.x));

  // 两种「不值得切」的情况：一个框占满画面，或者一个前景都没找到
  // （整张图都是一个颜色时，从四边估出来的背景就是内容本身，前景为空）
  const singleBlob = out.length === 0 || (out.length === 1 && out[0].area > 0.82);
  return { boxes: out, singleBlob, background: bg };
}
