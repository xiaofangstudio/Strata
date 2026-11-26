import { describe, expect, it } from "vitest";
import {
  clampRadialSectors,
  radialConfigFrom,
  radialDistanceToCenter,
  radialPoints,
} from "../../src/core/radialSymmetry";

const center = { x: 0, y: 0 };
const near = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("径向对称几何", () => {
  it("2 扇区 = 原点 + 180° 对点", () => {
    const pts = radialPoints(10, 4, { sectors: 2, center });
    expect(pts).toHaveLength(2);
    near(pts[0].x, 10);
    near(pts[0].y, 4);
    near(pts[1].x, -10);
    near(pts[1].y, -4, 1e-8);
  });

  it("4 / 8 / 12 扇区都落在等角圆周上，距离不变", () => {
    for (const n of [4, 8, 12]) {
      const pts = radialPoints(10, 0, { sectors: n, center });
      expect(pts).toHaveLength(n);
      for (let i = 0; i < n; i += 1) {
        const a = (Math.PI * 2 * i) / n;
        near(pts[i].x, Math.cos(a) * 10);
        near(pts[i].y, Math.sin(a) * 10, 1e-8);
        near(radialDistanceToCenter(pts[i], center), 10, 1e-8);
      }
    }
  });

  it("奇数扇区镜像会补出另一组点，不退化", () => {
    const pts = radialPoints(10, 3, { sectors: 3, mirror: true, center });
    expect(pts).toHaveLength(6);
    expect(pts.some((p) => Math.abs(p.y - 3) < 1e-8)).toBe(true);
    expect(pts.some((p) => Math.abs(p.y + 3) < 1e-8)).toBe(true);
  });

  it("镜像轴上的重复点会被去重", () => {
    const pts = radialPoints(10, 0, { sectors: 4, mirror: true, center });
    expect(pts).toHaveLength(4);
  });

  it("中心点可偏移；退化输入安全夹取", () => {
    const c = { x: 100, y: 200 };
    const pts = radialPoints(110, 205, { sectors: 2, center: c });
    expect(pts).toHaveLength(2);
    near(pts[0].x, 110);
    near(pts[0].y, 205);
    near(pts[1].x, 90);
    near(pts[1].y, 195);
    expect(clampRadialSectors(1)).toBe(2);
    expect(clampRadialSectors(99)).toBe(32);
    expect(clampRadialSectors(Number.NaN)).toBe(2);
    expect(radialPoints(Number.NaN, 1, { sectors: 4 })).toEqual([]);
  });

  it("画笔选项派生配置：非径向返回 null，扇区夹取，中心回退", () => {
    expect(radialConfigFrom({ symmetry: "both", radialSectors: 8 })).toBeNull();
    expect(radialConfigFrom(null)).toBeNull();
    expect(radialConfigFrom({ symmetry: "radial", radialSectors: 99 })).toEqual({
      sectors: 32,
      mirror: false,
      center: null,
    });
    const c = { x: 120, y: 80 };
    expect(
      radialConfigFrom({ symmetry: "radial", radialSectors: 4, radialMirror: true }, c),
    ).toEqual({ sectors: 4, mirror: true, center: c });
    expect(
      radialConfigFrom(
        { symmetry: "radial", radialSectors: 6, radialCenter: { x: 3, y: 4 } },
        c,
      )?.center,
    ).toEqual({ x: 3, y: 4 });
  });
});
