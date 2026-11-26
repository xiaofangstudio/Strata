import { describe, expect, it } from "vitest";
import {
  ROTATE_INTERPOLATIONS,
  rotateOutputSize,
  settleRotationAngle,
  signedRotationDegrees,
} from "../../src/core/transform";

describe("任意角度旋转画布", () => {
  it("角度夹到 ±359.99 且留两位小数，坏值归零", () => {
    expect(settleRotationAngle(12.345)).toBe(12.35);
    expect(settleRotationAngle(400)).toBe(359.99);
    expect(settleRotationAngle(-400)).toBe(-359.99);
    expect(settleRotationAngle(Number.NaN)).toBe(0);
  });

  it("方向决定正负号，正角按顺时针", () => {
    expect(signedRotationDegrees(30, "cw")).toBe(30);
    expect(signedRotationDegrees(30, "ccw")).toBe(-30);
    expect(signedRotationDegrees(400, "cw")).toBe(359.99);
  });

  it("外接矩形随角度变化，90 度刚好交换宽高", () => {
    expect(rotateOutputSize(100, 40, 0)).toEqual({ width: 100, height: 40 });
    expect(rotateOutputSize(100, 40, 90)).toEqual({ width: 40, height: 100 });
    const mid = rotateOutputSize(100, 40, 30);
    expect(mid.width).toBeGreaterThan(100);
    expect(mid.height).toBeGreaterThan(40);
  });

  it("三种插值档位都有明确 id", () => {
    expect(ROTATE_INTERPOLATIONS).toEqual(["bicubic", "bilinear", "nearest"]);
  });
});
