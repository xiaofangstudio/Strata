import { describe, expect, it } from "vitest";
import {
  isLeafDrawable,
  leafArea,
  leafBounds,
  leafPathLength,
  pushLeafPoint,
  snapLeafEnd,
  smoothLeafPoints,
  type LeafPoint,
} from "../../src/core/leafBrush";

const pts = (...xy: number[]): LeafPoint[] => {
  const out: LeafPoint[] = [];
  for (let i = 0; i < xy.length; i += 2) out.push({ x: xy[i], y: xy[i + 1] });
  return out;
};

describe("柳叶笔几何", () => {
  it("轨迹长度按折线累加", () => {
    expect(leafPathLength(pts(0, 0, 3, 4, 3, 9))).toBeCloseTo(10);
    expect(leafPathLength(pts(5, 5))).toBe(0);
  });

  it("闭合面积用鞋带公式，自交路径按净面积算", () => {
    expect(leafArea(pts(0, 0, 10, 0, 10, 6, 0, 6))).toBe(60);
    expect(leafArea(pts(0, 0, 10, 10, 0, 10, 10, 0))).toBe(0);
    expect(leafArea(pts(0, 0, 10, 0))).toBe(0);
  });

  it("包围盒覆盖整条轨迹", () => {
    expect(leafBounds(pts(4, 9, -2, 3, 7, 1))).toEqual({ x: -2, y: 1, width: 9, height: 8 });
    expect(leafBounds([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("采样丢掉过近的点，但起点永远保留", () => {
    expect(pushLeafPoint([], { x: 1, y: 2 })).toEqual([{ x: 1, y: 2 }]);
    const one = pushLeafPoint(pts(0, 0), { x: 1, y: 0 }, 1.5);
    expect(one).toHaveLength(1);
    expect(pushLeafPoint(pts(0, 0), { x: 2, y: 0 }, 1.5)).toHaveLength(2);
  });

  it("平滑保留两端点，中间点向中点靠拢", () => {
    const source = pts(0, 0, 5, 10, 10, 0);
    const smooth = smoothLeafPoints(source, 1);
    expect(smooth[0]).toEqual(source[0]);
    expect(smooth[2]).toEqual(source[2]);
    expect(smooth[1]).toEqual({ x: 5, y: 0 });
    expect(smoothLeafPoints(source, 0)).toEqual(source);
    expect(smoothLeafPoints(pts(0, 0, 1, 1), 1)).toHaveLength(2);
  });

  it("Shift 把闭合边吸附到 45° 并保留长度", () => {
    const a = { x: 0, y: 0 };
    const flat = snapLeafEnd(a, { x: 10, y: 1 });
    expect(flat.x).toBeCloseTo(Math.hypot(10, 1), 5);
    expect(flat.y).toBeCloseTo(0, 5);
    const diagonal = snapLeafEnd(a, { x: 10, y: 8 });
    expect(diagonal.x).toBeCloseTo(Math.SQRT1_2 * Math.hypot(10, 8), 5);
    expect(diagonal.y).toBeCloseTo(Math.SQRT1_2 * Math.hypot(10, 8), 5);
    expect(snapLeafEnd(a, a)).toEqual(a);
  });

  it("点一下、直线、零面积都不落笔；柳叶弧落笔", () => {
    expect(isLeafDrawable(pts(0, 0))).toBe(false);
    expect(isLeafDrawable(pts(0, 0, 2, 1, 4, 2))).toBe(false);
    expect(isLeafDrawable(pts(0, 0, 20, 0, 40, 0))).toBe(false);
    expect(isLeafDrawable(pts(0, 0, 10, 8, 20, 0))).toBe(true);
  });

  it("放大视图下的小叶片按折算阈值落笔，不再误拒", () => {
    // 400% 视图：屏幕拖约 23px，文档坐标轨迹只有 5.8px 长、面积 3.75px²。
    const tiny = pts(0, 0, 2.5, 1.5, 5, 0);
    // 默认阈值（100% 全图）会把这片小叶子拒掉 —— 正是「画了没反应」的场景。
    expect(isLeafDrawable(tiny)).toBe(false);
    // 按 1/scale 折算后同一笔必须能落笔。
    expect(isLeafDrawable(tiny, Math.max(0.25, 4 / 16), Math.max(2, 8 / 4))).toBe(true);
    // 点一下（不足三个点）在任意缩放下都拒绝。
    expect(isLeafDrawable(pts(0, 0), Math.max(0.25, 4 / 16), Math.max(2, 8 / 4))).toBe(false);
  });
});
