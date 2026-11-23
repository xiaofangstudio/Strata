/**
 * 曲线三点吸管的纯计算（和色阶三点吸管同一套语义）。
 *
 * 曲线用归一化坐标：x = 输入亮度，y = 输出亮度。吸管不改像素，只移动控制点：
 *   · 黑场：把最左端点的 x 移到采样值（y 保持 0）；
 *   · 白场：把最右端点的 x 移到采样值（y 保持 1）；
 *   · 灰场：让采样值映射到输出中点，若附近没有控制点就插一个。
 */

import type { CurvePoint } from "../engine/filters";

export type CurvePickKind = "black" | "gray" | "white";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function curveFromPick(
  points: readonly CurvePoint[],
  kind: CurvePickKind,
  /** 采样亮度，0–1。 */
  level: number,
): CurvePoint[] {
  if (points.length < 2) return points.map((p) => ({ ...p }));
  const next = points.map((p) => ({ ...p }));
  const v = clamp(level, 0, 1);
  const first = 0;
  const last = next.length - 1;

  if (kind === "black") {
    // 只能向右推，且不能越过第二个点
    next[first].x = clamp(v, 0, Math.max(0, next[1].x - 0.01));
    next[first].y = 0;
    return next;
  }
  if (kind === "white") {
    // 只能向左推，且不能退到倒数第二个点左边
    next[last].x = clamp(v, Math.min(1, next[last - 1].x + 0.01), 1);
    next[last].y = 1;
    return next;
  }

  // 灰场：夹在两端之间，优先复用已经很靠近的控制点，避免每吸一次就多一个点
  const x = clamp(v, next[first].x + 0.01, next[last].x - 0.01);
  const near = next.findIndex((p) => p !== next[first] && p !== next[last] && Math.abs(p.x - x) < 0.03);
  if (near >= 0) {
    next[near].x = x;
    next[near].y = 0.5;
    return next;
  }
  next.push({ x, y: 0.5 });
  next.sort((a, b) => a.x - b.x);
  return next;
}
