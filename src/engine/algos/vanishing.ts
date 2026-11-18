/**
 * 消失点几何：透视平面的有效性判定、焦距估计、3D 抬升与投影。
 *
 * 移植自 PhotoCraft `crates/algo/src/vanishing.rs`（MIT / Apache-2.0）。
 * 核心是 Brown–Lowe 的透视几何：平面两组对边的消失点叉积得到相机焦距，
 * 四角凹凸/锐角决定这个平面能不能当「PS 消失点网格」用。
 *
 * 纯函数，只吃数字，不碰 DOM / canvas。UI 可据此在填四角时实时校验、
 * 估计焦距；后续的多平面 tear-off / 透视克隆以此为基础。
 */

type V3 = [number, number, number];
export type Pt2 = [number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => {
  const n = Math.sqrt(dot(a, a));
  return n > 1e-12 ? mul(a, 1 / n) : a;
};

/** 两条 2D 直线（各由两点确定）的交点，齐次坐标。平行时第三分量≈0。 */
export function meet(a: Pt2, b: Pt2, c: Pt2, d: Pt2): V3 {
  const l1 = cross([a[0], a[1], 1], [b[0], b[1], 1]);
  const l2 = cross([c[0], c[1], 1], [d[0], d[1], 1]);
  return cross(l1, l2);
}

/** 透视平面：图像像素坐标的四角，从平面左上开始顺时针。 */
export interface VpPlane {
  corners: [Pt2, Pt2, Pt2, Pt2];
}

/** 平面质量：PS 里蓝（有效）/ 黄（存疑）/ 红（无效）三色网格的判据。 */
export type PlaneCheck = "valid" | "questionable" | "invalid";

/** 有限消失点（非平行对边）判据，带相对阈值避免远处交点误判。 */
function finite(v: V3): boolean {
  return Math.abs(v[2]) > 1e-9 * Math.max(1, Math.abs(v[0]) + Math.abs(v[1]));
}

/** 两组对边的消失点。 */
export function vanishingPoints(p: VpPlane): { v1: V3; v2: V3 } {
  const q = p.corners;
  return {
    v1: meet(q[0], q[1], q[3], q[2]),
    v2: meet(q[0], q[3], q[1], q[2]),
  };
}

/**
 * 由四角与相机中心估计焦距（像素）。两个消失点都有限且与以 c 为中心的相机相容时，
 * f² = -(v1-c)·(v2-c)；retina 是正交的，故这个点积为负。求不出返回 null。
 */
export function planeFocal(p: VpPlane, c: Pt2): number | null {
  const { v1, v2 } = vanishingPoints(p);
  if (!finite(v1) || !finite(v2)) return null;
  const a: Pt2 = [v1[0] / v1[2] - c[0], v1[1] / v1[2] - c[1]];
  const b: Pt2 = [v2[0] / v2[2] - c[0], v2[1] / v2[2] - c[1]];
  const f2 = -(a[0] * b[0] + a[1] * b[1]);
  return f2 > 1 ? Math.sqrt(f2) : null;
}

/** 每个角的转向 sin（顺时针为正）；边太短或非有限返回 null。 */
export function planeTurns(p: VpPlane): number[] | null {
  const q = p.corners;
  if (q.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e9 || Math.abs(y) > 1e9)) return null;
  const edge = (i: number): Pt2 => [q[(i + 1) % 4][0] - q[i][0], q[(i + 1) % 4][1] - q[i][1]];
  const out: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const a = edge(i);
    const b = edge((i + 1) % 4);
    const la = Math.hypot(a[0], a[1]);
    const lb = Math.hypot(b[0], b[1]);
    if (la < 1 || lb < 1) return null;
    out.push((a[0] * b[1] - a[1] * b[0]) / (la * lb));
  }
  return out;
}

/** 判断四角能否作为透视平面（凸、非退化、焦距可解）。 */
export function checkPlane(p: VpPlane, center: Pt2): PlaneCheck {
  const t = planeTurns(p);
  if (!t) return "invalid";
  const sameSign = t.every((v) => v > 0) || t.every((v) => v < 0);
  const min = Math.min(...t.map(Math.abs));
  if (!sameSign || min < Math.sin(Math.PI / 180)) return "invalid";
  // 顺时针与单应矩阵的存在性再筛一次
  if (homographyFromUnitSquare(p) === null) return "invalid";
  if (min < Math.sin(10 * Math.PI / 180)) return "questionable";
  const { v1, v2 } = vanishingPoints(p);
  if (finite(v1) && finite(v2) && planeFocal(p, center) === null) return "questionable";
  return "valid";
}

/**
 * 单位正方形 → 四角的单应矩阵（9 元，行优先，h[8]=1）。
 * 用 8 个未知数的标准 DLT：对每个对应点 (x,y)→(u,v) 建两行，解齐次最小二乘。
 */
export function homographyFromUnitSquare(p: VpPlane): number[] | null {
  const q = p.corners;
  const src: Pt2[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const rows: number[][] = [];
  for (let i = 0; i < 4; i += 1) {
    const [x, y] = src[i];
    const [u, v] = q[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // 高斯消元解 8×9 齐次系统（最后一列是常数项，解归一到 h[8]=1）
  const a = rows.map((r) => r.slice());
  const n = 8;
  for (let col = 0; col < n; col += 1) {
    let piv = col;
    for (let r = col + 1; r < a.length; r += 1) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-12) return null;
    [a[col], a[piv]] = [a[piv], a[col]];
    const d = a[col][col];
    for (let j = col; j <= n; j += 1) a[col][j] /= d;
    for (let r = 0; r < a.length; r += 1) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let j = col; j <= n; j += 1) a[r][j] -= f * a[col][j];
    }
  }
  const h = Array.from({ length: n }, (_, i) => a[i][n]);
  return [...h, 1];
}

/** 已知单应把 (x,y) 映到哪。 */
export function applyPlaneH(h: number[], x: number, y: number): Pt2 {
  const w = h[6] * x + h[7] * y + h[8];
  if (Math.abs(w) < 1e-12) return [NaN, NaN];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

/** 3D 抬升后的平面（相机在原点看向 +z，平面沿法向单位距离）。 */
export interface LiftedPlane {
  focal: number;
  center: Pt2;
  pts: [V3, V3, V3, V3];
}

/** 把图像平面抬升到 3D：每个像素射线与平面的交点。 */
export function liftPlane(p: VpPlane, focal: number, center: Pt2): LiftedPlane {
  const ray = (pt: Pt2): V3 => [(pt[0] - center[0]) / focal, (pt[1] - center[1]) / focal, 1];
  const q = p.corners;
  const dir = (a: Pt2, b: Pt2, c: Pt2, d: Pt2): V3 => {
    const v = meet(a, b, c, d);
    const nearParallel = Math.abs(v[2]) < 1e-9 * Math.max(1, Math.abs(v[0]) + Math.abs(v[1]));
    return nearParallel ? norm([v[0], v[1], 0]) : norm(ray([v[0] / v[2], v[1] / v[2]]));
  };
  const d1 = dir(q[0], q[1], q[3], q[2]);
  const d2 = dir(q[0], q[3], q[1], q[2]);
  let n = norm(cross(d1, d2));
  if (n[2] < 0) n = mul(n, -1);
  const pts = q.map((pt) => {
    const r = ray(pt);
    return mul(r, 1 / Math.max(1e-9, Math.abs(dot(n, r))));
  }) as [V3, V3, V3, V3];
  return { focal, center, pts };
}

/** 3D 点投影回图像。 */
export function projectLifted(l: LiftedPlane, x: V3): Pt2 | null {
  if (x[2] <= 1e-9) return null;
  return [l.center[0] + l.focal * x[0] / x[2], l.center[1] + l.focal * x[1] / x[2]];
}

/** 抬升后平面的边长（u 沿上边，v 沿左边），用于物理尺寸一致的粘贴/克隆。 */
export function liftedLengths(l: LiftedPlane): [number, number] {
  const len = (a: V3, b: V3) => Math.sqrt(dot(sub(a, b), sub(a, b)));
  const p = l.pts;
  return [
    (len(p[0], p[1]) + len(p[3], p[2])) / 2,
    (len(p[0], p[3]) + len(p[1], p[2])) / 2,
  ];
}

/** 四角归一到「从左上开始顺时针」（用户可能乱序点击）。 */
export function normalizePlane(p: VpPlane): VpPlane {
  let q = p.corners;
  const turns = planeTurns(p);
  if (turns && turns.reduce((a, b) => a + b, 0) < 0) q = [q[0], q[3], q[2], q[1]];
  let first = 0;
  for (let i = 1; i < 4; i += 1) {
    if (q[i][0] + q[i][1] < q[first][0] + q[first][1]) first = i;
  }
  return { corners: [q[first], q[(first + 1) % 4], q[(first + 2) % 4], q[(first + 3) % 4]] };
}
