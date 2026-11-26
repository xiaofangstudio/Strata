/**
 * 星形形状工具（移植自 PhotoCraft Star tool 的 points 参数，#16867）。
 *
 * 上游的关键修正是：星形点数有自己独立的选项（默认 5，整数 3–20），不能和
 * 多边形边数共用；输入超界时夹到最近端并明确提示。这里把这段决策做成纯函数，
 * 画布绘制只负责把返回的顶点连成闭合路径。
 */

export const STAR_POINTS_MIN = 3;
export const STAR_POINTS_MAX = 20;
export const DEFAULT_STAR_POINTS = 5;
export const DEFAULT_STAR_INNER = 0.5;

export interface StarPoint {
  x: number;
  y: number;
  /** true = 外顶点，false = 内凹点 */
  outer: boolean;
}

/** 把任意输入夹到合法的星形点数；NaN / 空值回默认 5。 */
export function clampStarPoints(value: number | null | undefined): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_STAR_POINTS;
  return Math.min(STAR_POINTS_MAX, Math.max(STAR_POINTS_MIN, n));
}

/** 是否超界（用于明确提示「已插入最接近的整数」）。 */
export function starPointsOutOfRange(value: number | null | undefined): boolean {
  const n = Number(value);
  return Number.isFinite(n) && (n < STAR_POINTS_MIN || n > STAR_POINTS_MAX);
}

/** 内半径比例：0.05–0.95，越接近 0 越尖锐。 */
export function clampStarInner(value: number | null | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_STAR_INNER;
  return Math.min(0.95, Math.max(0.05, n));
}

/**
 * 生成星形顶点：从正上方开始，外 / 内交替，共 points×2 个点。
 * 用外接矩形定义半径，因此 Shift 约束出的正方形会画成等臂星形。
 */
export function starVertices(
  a: { x: number; y: number },
  b: { x: number; y: number },
  points: number,
  innerRatio: number = DEFAULT_STAR_INNER,
): StarPoint[] {
  const n = clampStarPoints(points);
  const inner = clampStarInner(innerRatio);
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const rx = Math.abs(b.x - a.x) / 2;
  const ry = Math.abs(b.y - a.y) / 2;
  const out: StarPoint[] = [];
  for (let i = 0; i < n * 2; i += 1) {
    // -π/2 起笔：第一个尖角朝上，与参考工具的星形一致
    const angle = -Math.PI / 2 + (i * Math.PI) / n;
    const r = i % 2 === 0 ? 1 : inner;
    out.push({ x: cx + Math.cos(angle) * rx * r, y: cy + Math.sin(angle) * ry * r, outer: i % 2 === 0 });
  }
  return out;
}
