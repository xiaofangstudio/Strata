/**
 * 透视绘图辅助的几何纯函数。
 *
 * 只处理点、线段与灭点，不碰 Canvas / DOM。浮层负责画导线，绘制管线负责
 * 把端点吸附到导线；两边都调用这里的同一套函数，导线和吸附不会各算各的。
 */

export type PerspectiveMode = "off" | "one" | "two" | "three";

export interface PerspectivePoint {
  x: number;
  y: number;
}

export interface PerspectiveState {
  mode: PerspectiveMode;
  /** 灭点，文档坐标；数量由 mode 决定 */
  points: PerspectivePoint[];
  /** 是否把直线 / 形状端点吸附到导线 */
  snap: boolean;
  /** 吸附强度 0–100，越大命中范围越宽 */
  strength: number;
}

export interface PerspectiveSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 属于哪个灭点；-1 是地平线 */
  vp: number;
}

/** 新建一个模式下的默认灭点布局；关闭时不留残余导线。 */
export function perspectiveFor(
  mode: PerspectiveMode,
  width: number,
  height: number,
): PerspectiveState {
  let points: PerspectivePoint[] = [];
  if (mode === "one") points = [{ x: width / 2, y: height / 2 }];
  else if (mode === "two") {
    points = [
      { x: width * 0.16, y: height / 2 },
      { x: width * 0.84, y: height / 2 },
    ];
  } else if (mode === "three") {
    points = [
      { x: width * 0.16, y: height / 2 },
      { x: width * 0.84, y: height / 2 },
      { x: width / 2, y: height * 0.12 },
    ];
  }
  return { mode, points, snap: true, strength: 60 };
}

/** 两直线求交；平行 / 退化返回 null，绝不返回 Infinity 坐标。 */
export function intersectLines(
  a: PerspectivePoint,
  b: PerspectivePoint,
  c: PerspectivePoint,
  d: PerspectivePoint,
): PerspectivePoint | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-9) return null;
  const qp = { x: c.x - a.x, y: c.y - a.y };
  const t = (qp.x * s.y - qp.y * s.x) / denom;
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

/** 由两组「平行」边的方向线求灭点；本质上就是直线求交。 */
export function vanishingPointFromEdges(
  a1: PerspectivePoint,
  a2: PerspectivePoint,
  b1: PerspectivePoint,
  b2: PerspectivePoint,
): PerspectivePoint | null {
  return intersectLines(a1, a2, b1, b2);
}

/**
 * 构造导线：每个灭点向四条边上等距采样点拉射线，射线延长到画布外一截，
 * 让吸附在边缘也有效。两点 / 三点透视再补一条穿过前两个灭点的地平线。
 */
export function perspectiveSegments(
  state: PerspectiveState,
  width: number,
  height: number,
): PerspectiveSegment[] {
  if (state.mode === "off" || state.points.length === 0) return [];
  const perEdge = state.mode === "one" ? 4 : 3;
  const samples: PerspectivePoint[] = [];
  for (let i = 0; i <= perEdge; i += 1) {
    const t = i / perEdge;
    samples.push({ x: t * width, y: 0 }, { x: t * width, y: height });
    samples.push({ x: 0, y: t * height }, { x: width, y: t * height });
  }
  const out: PerspectiveSegment[] = [];
  state.points.forEach((vp, index) => {
    for (const target of samples) {
      // 灭点刚好落在采样点上时射线退化，跳过（否则吸附会把点吸到自身）
      if (Math.hypot(target.x - vp.x, target.y - vp.y) < 1e-6) continue;
      out.push({
        x1: vp.x,
        y1: vp.y,
        x2: vp.x + (target.x - vp.x) * 1.4,
        y2: vp.y + (target.y - vp.y) * 1.4,
        vp: index,
      });
    }
  });
  if (state.mode !== "one" && state.points.length >= 2) {
    const a = state.points[0];
    const b = state.points[1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.hypot(dx, dy) > 1e-6) {
      out.push({
        x1: a.x - dx * 2,
        y1: a.y - dy * 2,
        x2: b.x + dx * 2,
        y2: b.y + dy * 2,
        vp: -1,
      });
    }
  }
  return out;
}

/** 点到线段的最近点，含投影落点 / 垂直距离；零长度线段安全。 */
export function closestOnSegment(
  p: PerspectivePoint,
  seg: PerspectiveSegment,
): { point: PerspectivePoint; distance: number } {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) {
    return { point: { x: seg.x1, y: seg.y1 }, distance: Math.hypot(p.x - seg.x1, p.y - seg.y1) };
  }
  const t = Math.max(0, Math.min(1, ((p.x - seg.x1) * dx + (p.y - seg.y1) * dy) / len2));
  const q = { x: seg.x1 + t * dx, y: seg.y1 + t * dy };
  return { point: q, distance: Math.hypot(p.x - q.x, p.y - q.y) };
}

/** 吸附强度 → 屏幕像素阈值；强度 60 约等于 8px。 */
export function perspectiveThreshold(strength: number): number {
  const s = Number.isFinite(strength) ? Math.max(0, Math.min(100, strength)) : 0;
  return 2 + s / 10;
}

/**
 * 把点吸到最近的透视导线。候选按垂直距离排序，同距时取先构造的那条，
 * 保证拖动过程中不会在两条线之间来回跳。
 */
export function snapToPerspective(
  p: PerspectivePoint,
  state: PerspectiveState,
  width: number,
  height: number,
  threshold: number,
): PerspectivePoint | null {
  if (!state.snap || state.mode === "off") return null;
  let best: PerspectivePoint | null = null;
  let bestD = threshold;
  for (const seg of perspectiveSegments(state, width, height)) {
    const hit = closestOnSegment(p, seg);
    // 严格小于才替换：等距时保留先出现的候选，避免抖动
    if (hit.distance < bestD) {
      bestD = hit.distance;
      best = hit.point;
    }
  }
  return best;
}
