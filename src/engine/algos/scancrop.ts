/**
 * 扫描裁剪 / 裁正照片：从平板扫描图里自动找出每张照片的四边形，
 * 量出旋转角，供上层按四角透视裁正。
 *
 * Ported from ArtCraft PhotoCraft (crates/algo/src/scancrop.rs), MIT / Apache-2.0。
 * 纯函数：吃裸 RGBA，不碰 DOM；在 ≤800px 的工作分辨率上检测，结果换算回全分辨率。
 *
 * 流程：边框中值色作背景 → 色彩距离经 Otsu 选阈值 → 形态学闭/开 →
 * 8 连通域 → 每域凸包的**最小面积外接矩形**（ Freeman–Shapira：一条边与凸包边共线）
 * → 归一化到 −45..45° 的旋转角。
 */
import type { RgbaBuffer } from "../filters/kernels";

export interface FoundPhoto {
  /** 中心（全分辨率像素）。 */
  center: [number, number];
  /** 沿自身轴的长边 / 短边（全分辨率像素）。 */
  width: number;
  height: number;
  /** 照片 x 轴在扫描图里的角度（度，−45..45）；要把照片转正，需反向旋转。 */
  angle: number;
  /** 面积占扫描图比例。 */
  area: number;
  /** 四角（全分辨率像素），顺时针从自身坐标的左上起。 */
  corners: [number, number][];
}

type Pt = [number, number];

/** Otsu 阈值（输入 0..1），返回 0..1 的切分点。 */
export function otsu(v: Float32Array): number {
  const B = 256;
  const hist = new Float64Array(B);
  for (const x of v) hist[Math.min(B - 1, Math.max(0, Math.floor(x * (B - 1))))] += 1;
  let total = 0;
  let sum = 0;
  for (let i = 0; i < B; i += 1) { total += hist[i]; sum += i * hist[i]; }
  let wb = 0, sb = 0, best = 0, thr = 0;
  for (let i = 0; i < B; i += 1) {
    wb += hist[i];
    if (wb === 0) continue;
    const wf = total - wb;
    if (wf === 0) break;
    sb += i * hist[i];
    const mb = sb / wb;
    const mf = (sum - sb) / wf;
    const between = wb * wf * (mb - mf) * (mb - mf);
    if (between > best) { best = between; thr = i; }
  }
  return (thr + 0.5) / (B - 1);
}

/** 可分离方形结构元的形态学膨胀 / 腐蚀。 */
export function morph(
  w: number, h: number, m: Uint8Array, r: number, dilate: boolean,
): Uint8Array {
  const pass = (src: Uint8Array, horizontal: boolean): Uint8Array => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let acc = dilate ? 0 : 1;
        for (let d = -r; d <= r; d += 1) {
          const xx = horizontal ? x + d : x;
          const yy = horizontal ? y : y + d;
          const v = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : src[yy * w + xx];
          if (dilate) acc |= v;
          else acc &= v;
        }
        out[y * w + x] = acc;
      }
    }
    return out;
  };
  return pass(pass(m, true), false);
}

/** Andrew 单调链凸包。 */
export function convexHull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const dedup: Pt[] = [];
  for (const q of p) {
    if (!dedup.length || dedup[dedup.length - 1][0] !== q[0] || dedup[dedup.length - 1][1] !== q[1]) dedup.push(q);
  }
  if (dedup.length < 3) return dedup;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const q of dedup) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = dedup.length - 1; i >= 0; i -= 1) {
    const q = dedup[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** 凸包的最小面积外接矩形：返回 (中心, 宽, 高, 角度度)。 */
export function minRect(hull: readonly Pt[]): { center: Pt; width: number; height: number; angle: number } {
  let best = { area: Infinity, center: [0, 0] as Pt, width: 0, height: 0, angle: 0 };
  const n = hull.length;
  if (n < 3) return best;
  for (let i = 0; i < n; i += 1) {
    const a = hull[i];
    const b = hull[(i + 1) % n];
    const th = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const s = Math.sin(th), c = Math.cos(th);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of hull) {
      const u = c * p[0] + s * p[1];
      const v = -s * p[0] + c * p[1];
      x0 = Math.min(x0, u); x1 = Math.max(x1, u);
      y0 = Math.min(y0, v); y1 = Math.max(y1, v);
    }
    const area = (x1 - x0) * (y1 - y0);
    if (area < best.area) {
      const cu = (x0 + x1) / 2;
      const cv = (y0 + y1) / 2;
      best = {
        area,
        center: [c * cu - s * cv, s * cu + c * cv],
        width: x1 - x0,
        height: y1 - y0,
        angle: th * 180 / Math.PI,
      };
    }
  }
  let { width, height, angle } = best;
  while (angle > 45) { angle -= 90; [width, height] = [height, width]; }
  while (angle < -45) { angle += 90; [width, height] = [height, width]; }
  return { center: best.center, width, height, angle };
}

/** 由中心/尺寸/角度算四角（顺时针，从自身坐标左上起）。 */
export function photoCorners(p: FoundPhoto): Pt[] {
  const s = Math.sin(p.angle * Math.PI / 180);
  const c = Math.cos(p.angle * Math.PI / 180);
  const hw = p.width / 2;
  const hh = p.height / 2;
  return ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as Pt[]).map(([x, y]) => [
    p.center[0] + c * x - s * y,
    p.center[1] + s * x + c * y,
  ]);
}

/**
 * 从扫描图里找出每张照片。阈值按边框中值色 + Otsu 自动定，
 * 小于全图 1% 的连通域当噪点丢弃。返回按阅读顺序（先上后下、再左后右）。
 */
export function findPhotos(img: RgbaBuffer): FoundPhoto[] {
  const { data, width: w, height: h } = img;
  if (w < 8 || h < 8) return [];
  const k = Math.max(1, Math.ceil(Math.max(w, h) / 800));
  const sw = Math.ceil(w / k);
  const sh = Math.ceil(h / k);
  const cnt = new Uint32Array(sw * sh);
  const small = new Float64Array(sw * sh * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = Math.floor(y / k) * sw + Math.floor(x / k);
      const p = (y * w + x) * 4;
      small[i * 3] += data[p];
      small[i * 3 + 1] += data[p + 1];
      small[i * 3 + 2] += data[p + 2];
      cnt[i] += 1;
    }
  }
  for (let i = 0; i < sw * sh; i += 1) {
    const n = Math.max(1, cnt[i]);
    small[i * 3] /= n; small[i * 3 + 1] /= n; small[i * 3 + 2] /= n;
  }
  // 背景 = 边框逐通道中值
  const border: number[][] = [[], [], []];
  for (let x = 0; x < sw; x += 1) {
    for (const row of [0, sh - 1]) {
      const i = row * sw + x;
      for (let c = 0; c < 3; c += 1) border[c].push(small[i * 3 + c]);
    }
  }
  for (let y = 0; y < sh; y += 1) {
    for (const col of [0, sw - 1]) {
      const i = y * sw + col;
      for (let c = 0; c < 3; c += 1) border[c].push(small[i * 3 + c]);
    }
  }
  const bg = border.map((v) => { v.sort((a, b) => a - b); return v[v.length >> 1]; });
  const dist = new Float32Array(sw * sh);
  for (let i = 0; i < sw * sh; i += 1) {
    const dr = small[i * 3] - bg[0];
    const dg = small[i * 3 + 1] - bg[1];
    const db = small[i * 3 + 2] - bg[2];
    dist[i] = Math.sqrt(dr * dr + dg * dg + db * db) / Math.sqrt(3);
  }
  const thr = Math.max(0.04, otsu(dist));
  let mask: Uint8Array = new Uint8Array(sw * sh);
  for (let i = 0; i < sw * sh; i += 1) mask[i] = dist[i] > thr ? 1 : 0;
  // 闭运算补照片内部斑点、开运算去灰尘，再一轮开-闭细修
  const r = Math.max(1, Math.round(Math.max(sw, sh) / 200));
  mask = morph(sw, sh, morph(sw, sh, mask, r, true), r, false);
  mask = morph(sw, sh, morph(sw, sh, mask, 1, false), 1, true);

  // 8 连通域
  const label = new Int32Array(sw * sh).fill(-1);
  const comps: number[][] = [];
  for (let s = 0; s < sw * sh; s += 1) {
    if (!mask[s] || label[s] >= 0) continue;
    const id = comps.length;
    const stack = [s];
    label[s] = id;
    const px: number[] = [];
    while (stack.length) {
      const i = stack.pop()!;
      px.push(i);
      const x = i % sw;
      const y = Math.floor(i / sw);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
          const j = yy * sw + xx;
          if (mask[j] && label[j] < 0) { label[j] = id; stack.push(j); }
        }
      }
    }
    comps.push(px);
  }

  const total = sw * sh;
  const out: FoundPhoto[] = [];
  for (const comp of comps) {
    if (comp.length / total <= 0.01) continue;
    // 边界像素的四角（全分辨率坐标）：只取邻域有背景的像素
    const pts: Pt[] = [];
    for (const i of comp) {
      const x = i % sw, y = Math.floor(i / sw);
      const boundary = x === 0 || y === 0 || x + 1 === sw || y + 1 === sh ||
        !mask[i - 1] || !mask[i + 1] || !mask[i - sw] || !mask[i + sw];
      if (!boundary) continue;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as Pt[]) {
        pts.push([(x + dx) * k, (y + dy) * k]);
      }
    }
    const rect = minRect(convexHull(pts));
    const inset = k;
    const photo: FoundPhoto = {
      center: rect.center,
      width: Math.max(1, rect.width - 2 * inset),
      height: Math.max(1, rect.height - 2 * inset),
      angle: rect.angle,
      area: comp.length / total,
      corners: [],
    };
    photo.corners = photoCorners(photo);
    out.push(photo);
  }
  // 阅读顺序：按中心 y 分带（带高 = 最小照片短边 / 3），带内按 x
  const band = out.reduce((m, p) => Math.min(m, Math.min(p.width, p.height)), Infinity) / 3 || 1;
  out.sort((a, b) =>
    (Math.floor(a.center[1] / band) - Math.floor(b.center[1] / band)) ||
    (a.center[0] - b.center[0]),
  );
  return out;
}
