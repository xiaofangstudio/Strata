import { describe, expect, it } from "vitest";
import {
  DEFAULT_STAR_POINTS,
  STAR_POINTS_MAX,
  STAR_POINTS_MIN,
  clampStarInner,
  clampStarPoints,
  starPointsOutOfRange,
  starVertices,
} from "../../src/core/starShape";

describe("星形工具点数（移植自 PhotoCraft）", () => {
  it("点数独立夹到 3–20，默认 5，超界给出提示", () => {
    expect(DEFAULT_STAR_POINTS).toBe(5);
    expect(clampStarPoints(21)).toBe(STAR_POINTS_MAX);
    expect(clampStarPoints(2)).toBe(STAR_POINTS_MIN);
    expect(clampStarPoints(7.4)).toBe(7);
    expect(clampStarPoints(Number.NaN)).toBe(5);
    expect(starPointsOutOfRange(21)).toBe(true);
    expect(starPointsOutOfRange(20)).toBe(false);
  });

  it("内外半径比例也夹在合法范围", () => {
    expect(clampStarInner(0)).toBeCloseTo(0.05);
    expect(clampStarInner(2)).toBeCloseTo(0.95);
    expect(clampStarInner(Number.NaN)).toBeCloseTo(0.5);
  });

  it("五角星有 10 个交替顶点，首点朝正上", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 100 };
    const v = starVertices(a, b, 5, 0.4);
    expect(v).toHaveLength(10);
    expect(v.filter((p) => p.outer)).toHaveLength(5);
    expect(v[0].x).toBeCloseTo(50);
    expect(v[0].y).toBeCloseTo(0);
    expect(v[1].y).toBeGreaterThan(v[0].y);
  });

  it("三 / 二十点都画得出，外接矩形不变", () => {
    const a = { x: 10, y: 20 };
    const b = { x: 90, y: 80 };
    expect(starVertices(a, b, 3)).toHaveLength(6);
    expect(starVertices(a, b, 200)).toHaveLength(40);
    for (const p of starVertices(a, b, 7, 0.5)) {
      expect(p.x).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(p.x).toBeLessThanOrEqual(90 + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(20 - 1e-9);
      expect(p.y).toBeLessThanOrEqual(80 + 1e-9);
    }
  });
});
