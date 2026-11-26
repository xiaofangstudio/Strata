import { describe, expect, it } from "vitest";
import {
  closestOnSegment,
  intersectLines,
  perspectiveFor,
  perspectiveSegments,
  perspectiveThreshold,
  snapToPerspective,
  vanishingPointFromEdges,
  type PerspectiveSegment,
} from "../../src/core/perspective";

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("透视绘图辅助几何", () => {
  it("模式决定灭点数量，关闭时不留导线", () => {
    expect(perspectiveFor("off", 800, 600).points).toHaveLength(0);
    expect(perspectiveFor("one", 800, 600).points).toEqual([{ x: 400, y: 300 }]);
    expect(perspectiveFor("two", 800, 600).points).toHaveLength(2);
    expect(perspectiveFor("three", 800, 600).points).toHaveLength(3);
    const t = perspectiveFor("off", 800, 600);
    expect(perspectiveSegments(t, 800, 600)).toHaveLength(0);
  });

  it("平行线求交返回 null，交叉线求交给出正确灭点", () => {
    expect(
      intersectLines({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 }),
    ).toBeNull();
    const p = vanishingPointFromEdges(
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 10 },
    );
    expect(p).not.toBeNull();
    near(p!.x, 0);
    near(p!.y, 0);
  });

  it("导线从灭点出发，两点透视含地平线", () => {
    const one = perspectiveFor("one", 800, 600);
    const segs = perspectiveSegments(one, 800, 600);
    expect(segs.length).toBeGreaterThan(0);
    for (const s of segs) {
      near(s.x1, one.points[0].x);
      near(s.y1, one.points[0].y);
      expect(s.vp).toBe(0);
    }
    const two = perspectiveFor("two", 800, 600);
    expect(perspectiveSegments(two, 800, 600).some((s) => s.vp === -1)).toBe(true);
  });

  it("点到线段取垂足；端点外夹取，零长度不炸", () => {
    const seg: PerspectiveSegment = { x1: 0, y1: 0, x2: 10, y2: 0, vp: 0 };
    const hit = closestOnSegment({ x: 5, y: 3 }, seg);
    near(hit.point.x, 5);
    near(hit.point.y, 0);
    near(hit.distance, 3);
    const outside = closestOnSegment({ x: -4, y: 0 }, seg);
    near(outside.point.x, 0);
    near(outside.distance, 4);
    const dot: PerspectiveSegment = { x1: 2, y1: 2, x2: 2, y2: 2, vp: 0 };
    near(closestOnSegment({ x: 5, y: 2 }, dot).distance, 3);
  });

  it("吸附落在导线上，远处不吸；开关与阈值生效", () => {
    const state = perspectiveFor("one", 800, 600);
    const seg = perspectiveSegments(state, 800, 600)[0];
    // 取线段中点，沿法向偏 2px，应该吸回线段
    const mx = (seg.x1 + seg.x2) / 2;
    const my = (seg.y1 + seg.y2) / 2;
    const dx = seg.x2 - seg.x1;
    const dy = seg.y2 - seg.y1;
    const len = Math.hypot(dx, dy);
    const off = { x: mx - (dy / len) * 2, y: my + (dx / len) * 2 };
    const snapped = snapToPerspective(off, state, 800, 600, perspectiveThreshold(60));
    expect(snapped).not.toBeNull();
    near(closestOnSegment(snapped!, seg).distance, 0, 1e-6);
    expect(snapToPerspective(off, { ...state, snap: false }, 800, 600, 100)).toBeNull();
    expect(snapToPerspective({ x: -9999, y: -9999 }, state, 800, 600, 8)).toBeNull();
  });

  it("强度映射有上下限", () => {
    expect(perspectiveThreshold(0)).toBe(2);
    expect(perspectiveThreshold(100)).toBe(12);
    expect(perspectiveThreshold(Number.NaN)).toBe(2);
  });
});
