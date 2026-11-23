import { describe, expect, it } from "vitest";
import { curveFromPick } from "../../src/core/curvePicker";
import type { CurvePoint } from "../../src/engine/filters";

const base = (): CurvePoint[] => [{ x: 0, y: 0 }, { x: 1, y: 1 }];

describe("curveFromPick", () => {
  it("黑场吸管移动最左端点且不越过第二个点", () => {
    const r = curveFromPick([{ x: 0, y: 0 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 }], "black", 0.2);
    expect(r[0]).toEqual({ x: 0.2, y: 0 });
    expect(r[1]).toEqual({ x: 0.5, y: 0.7 });
    const clamped = curveFromPick(base(), "black", 1);
    expect(clamped[0].x).toBe(0.99); // 只剩两个点时贴住右端但不越过
  });

  it("白场吸管移动最右端点且不退过倒数第二个点", () => {
    const r = curveFromPick([{ x: 0, y: 0 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 }], "white", 0.8);
    expect(r[2]).toEqual({ x: 0.8, y: 1 });
    const clamped = curveFromPick(base(), "white", 0);
    expect(clamped[1].x).toBe(0.01);
  });

  it("灰场吸管插值出中点控制点并保持 x 有序", () => {
    const r = curveFromPick(base(), "gray", 0.35);
    expect(r).toHaveLength(3);
    expect(r[1]).toEqual({ x: 0.35, y: 0.5 });
    expect(r.map((p) => p.x)).toEqual([0, 0.35, 1]);
  });

  it("灰场重复取样复用同一点，不会堆出一串控制点", () => {
    const first = curveFromPick(base(), "gray", 0.4);
    const second = curveFromPick(first, "gray", 0.42);
    expect(second).toHaveLength(3);
    expect(second[1]).toEqual({ x: 0.42, y: 0.5 });
  });

  it("采样值越界时安全夹住，不破坏单调顺序", () => {
    for (const v of [-1, 0, 1, 2]) {
      const r = curveFromPick(base(), "gray", v);
      expect(r.every((p) => p.x >= 0 && p.x <= 1)).toBe(true);
      for (let i = 1; i < r.length; i += 1) expect(r[i].x).toBeGreaterThan(r[i - 1].x);
    }
  });
});
