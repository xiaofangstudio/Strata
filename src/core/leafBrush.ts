/**
 * 柳叶笔的几何纯函数。
 *
 * 柳叶笔不是笔刷，而是形状工具：按下起点、拖出一条轨迹、松手后
 * 「轨迹 + 起点到终点的闭合边」围成柳叶形色块并填充。画圈时按
 * 路径自身围出的区域填充；按住 Shift 时把闭合边吸附成水平/垂直/45°。
 *
 * 这里只处理点列，不碰 DOM / Canvas，便于单测钉死边界行为。
 */

export interface LeafPoint {
  x: number;
  y: number;
}

export type LeafMode = "solid" | "hollow" | "blur";

/** 点列长度过短、面积过小都不落笔，避免点一下就冒出一个小黑点。 */
export function leafPathLength(points: readonly LeafPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

/** 鞋带公式：闭合区域面积（绝对值）。自交路径按非零环绕抵消后的净面积。 */
export function leafArea(points: readonly LeafPoint[]): number {
  if (points.length < 3) return 0;
  let twice = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

export function leafBounds(points: readonly LeafPoint[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 拖动采样：离上一个点太近就丢掉，防止长笔画攒出上万个点。 */
export function pushLeafPoint(
  points: readonly LeafPoint[],
  next: LeafPoint,
  minDistance = 1.5,
): LeafPoint[] {
  const last = points[points.length - 1];
  if (!last) return [next];
  if (Math.hypot(next.x - last.x, next.y - last.y) < minDistance) return [...points];
  return [...points, next];
}

/**
 * 轻度平滑：每个中间点向相邻两点中点靠拢，端点不动。
 * strength 0 = 原样；1 = 直接到中点。只做一遍，保留用户手腕的抖动特征。
 */
export function smoothLeafPoints(
  points: readonly LeafPoint[],
  strength = 0.5,
): LeafPoint[] {
  if (points.length < 3) return [...points];
  const k = Math.max(0, Math.min(1, strength));
  if (k === 0) return [...points];
  const out: LeafPoint[] = [{ ...points[0] }];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    out.push({
      x: cur.x + ((prev.x + next.x) / 2 - cur.x) * k,
      y: cur.y + ((prev.y + next.y) / 2 - cur.y) * k,
    });
  }
  out.push({ ...points[points.length - 1] });
  return out;
}

/** 按住 Shift：把「终点 → 起点」这条闭合边吸附到水平 / 垂直 / 45°。 */
export function snapLeafEnd(a: LeafPoint, b: LeafPoint): LeafPoint {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { ...b };
  const step = Math.PI / 4;
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}

/** 是否值得落笔：至少三个采样点、轨迹够长、闭合面积不为零。 */
export function isLeafDrawable(points: readonly LeafPoint[], minArea = 4): boolean {
  if (points.length < 3 || leafPathLength(points) < 8) return false;
  return leafArea(points) >= minArea;
}
