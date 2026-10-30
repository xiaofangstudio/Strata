/**
 * 四点单应（homography）纯数学。
 *
 * 用于「斜切 / 透视 / 扭曲 / 变形」：把单位正方形 (u,v)∈[0,1]² 映射到任意
 * 四边形 p0(左上) p1(右上) p2(右下) p3(左下)。渲染时按输出像素反查 (u,v)，
 * 再在源图上双线性采样。
 *
 * 采用 Heckbert 的单位正方形→四边形闭式解，避免解 8 元线性方程组。
 * 全部为纯函数，node 环境可直接断言。
 */

export interface Pt {
  x: number;
  y: number;
}

/** 3×3 矩阵，行主序。 */
export type Mat3 = [
  number, number, number,
  number, number, number,
  number, number, number,
];

/** 单位正方形 → 四边形 的 3×3 矩阵（映射后需除以 w 分量）。 */
export function unitSquareToQuad(p: readonly Pt[]): Mat3 {
  const [p0, p1, p2, p3] = p;
  const x0 = p0.x;
  const y0 = p0.y;
  const x1 = p1.x;
  const y1 = p1.y;
  const x2 = p2.x;
  const y2 = p2.y;
  const x3 = p3.x;
  const y3 = p3.y;

  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;

  if (dx3 === 0 && dy3 === 0) {
    // 仿射（平行四边形）：g = h = 0
    return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1];
  }
  const den = dx1 * dy2 - dx2 * dy1;
  if (den === 0) {
    // 退化四边形：退回仿射近似，避免除零
    return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1];
  }
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + h * x3;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + h * y3;
  return [a, b, x0, d, e, y0, g, h, 1];
}

/** 3×3 求逆；退化时返回 null。 */
export function invertMat3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (det === 0 || !Number.isFinite(det)) return null;
  const inv = 1 / det;
  return [
    A * inv, -(b * i - c * h) * inv, (b * f - c * e) * inv,
    B * inv, (a * i - c * g) * inv, -(a * f - c * d) * inv,
    C * inv, -(a * h - b * g) * inv, (a * e - b * d) * inv,
  ];
}

/** 应用 3×3 齐次变换，返回欧氏坐标（除以 w）。w≈0 时返回 null。 */
export function applyMat3(m: Mat3, x: number, y: number): Pt | null {
  const X = m[0] * x + m[1] * y + m[2];
  const Y = m[3] * x + m[4] * y + m[5];
  const W = m[6] * x + m[7] * y + m[8];
  if (Math.abs(W) < 1e-9) return null;
  return { x: X / W, y: Y / W };
}

/** 由矩形四角构造四边形（顺时针：左上、右上、右下、左下）。 */
export function rectQuad(x: number, y: number, w: number, h: number): Pt[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

/** 给四边形每个角加偏移（offset[i] = [dx, dy]）。 */
export function offsetQuad(quad: readonly Pt[], off: readonly (readonly [number, number])[]): Pt[] {
  return quad.map((p, i) => ({ x: p.x + (off[i]?.[0] ?? 0), y: p.y + (off[i]?.[1] ?? 0) }));
}
