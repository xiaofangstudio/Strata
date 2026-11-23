import { describe, expect, it } from "vitest";
import {
  colorWarnings,
  isPrintableApprox,
  isWebSafe,
  nearestPrintable,
  nearestWebSafe,
} from "../../src/core/colorWarnings";

describe("网页安全色", () => {
  it("216 色立方体上的颜色安全，其它不安全", () => {
    expect(isWebSafe("#003366")).toBe(true);
    expect(isWebSafe("#ff0000")).toBe(true);
    expect(isWebSafe("#ff3365")).toBe(false);
  });

  it("修正到最近的 51 倍数并夹在 0–255", () => {
    expect(nearestWebSafe("#ff3366")).toBe("#ff3366");
    expect(nearestWebSafe("#123456")).toBe("#003366");
    expect(nearestWebSafe("#fefefe")).toBe("#ffffff");
  });
});

describe("近似印刷色域", () => {
  it("屏幕原色被判为界外，柔和中间调保留", () => {
    expect(isPrintableApprox("#ff0000")).toBe(false);
    expect(isPrintableApprox("#00ff00")).toBe(false);
    expect(isPrintableApprox("#0000ff")).toBe(false);
    expect(isPrintableApprox("#c07050")).toBe(true);
    expect(isPrintableApprox("#808080")).toBe(true);
  });

  it("修正值一定可打印，且保持大致明暗", () => {
    const fixed = nearestPrintable("#ff0000");
    expect(isPrintableApprox(fixed)).toBe(true);
    expect(parseInt(fixed.slice(1, 3), 16)).toBeGreaterThan(0);
    expect(fixed).not.toBe("#ff0000");
  });

  it("本来可打印的颜色原样返回", () => {
    expect(nearestPrintable("#808080")).toBe("#808080");
  });

  it("汇总同时报告两类警告", () => {
    const w = colorWarnings("#ff0000");
    expect(w.webSafe).toBe(true);
    expect(w.outOfGamut).toBe(true);
    expect(w.nearestGamut).not.toBe("#ff0000");
  });
});
