/**
 * 钢笔路径的纯几何部分。
 *
 * 只做点列 → 平滑采样，不碰 canvas，这样曲线插值和「模拟压力」包络都能在
 * node 里单测。真正的描边落在 engine/penStroke.ts。
 */
export interface PenPoint {
  x: number;
  y: number;
}

/** Catmull-Rom 单段插值。端点用自身复制补齐，保证曲线过所有落点。 */
function catmullRom(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/** 把用户落点插成平滑曲线；steps 是每个线段的采样数。 */
export function samplePenPath(
  points: readonly PenPoint[],
  steps = 12,
): PenPoint[] {
  if (points.length === 0) return [];
  if (points.length === 1 || steps < 1) return [{ ...points[0] }];
  const count = Math.max(1, Math.floor(steps));
  const out: PenPoint[] = [{ ...points[0] }];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    for (let s = 1; s <= count; s += 1) {
      const t = s / count;
      out.push({
        x: catmullRom(p0.x, p1.x, p2.x, p3.x, t),
        y: catmullRom(p0.y, p1.y, p2.y, p3.y, t),
      });
    }
  }
  return out;
}

/**
 * PS「模拟压力」的笔宽包络：两端收尖，中段饱满。
 * 0.22 的下限保证端点仍看得见，不会变成断线。
 */
export function penPressureWidth(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 0.22 + 0.78 * Math.sin(Math.PI * clamped);
}
