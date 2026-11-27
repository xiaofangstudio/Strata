import { beforeEach, describe, expect, it } from "vitest";
import {
  getComposeTiming,
  recordComposeTiming,
  resetComposeTiming,
} from "../../src/engine/gpu/stats";

describe("GPU / CPU 合成打点", () => {
  beforeEach(() => resetComposeTiming());

  it("样本不足时保持启用", () => {
    recordComposeTiming(10, 20);
    expect(getComposeTiming().enabled).toBe(true);
  });

  it("GPU 持续明显更慢时自动停用主路径", () => {
    for (let i = 0; i < 8; i += 1) recordComposeTiming(10, 20);
    const stats = getComposeTiming();
    expect(stats.samples).toBe(8);
    expect(stats.ratio).toBeCloseTo(2, 5);
    expect(stats.enabled).toBe(false);
  });

  it("GPU 更快时保持启用，窗口不会无限增长", () => {
    for (let i = 0; i < 40; i += 1) recordComposeTiming(20, 5);
    const stats = getComposeTiming();
    expect(stats.samples).toBe(12);
    expect(stats.ratio).toBeCloseTo(0.25, 5);
    expect(stats.enabled).toBe(true);
  });

  it("非法样本不污染统计", () => {
    recordComposeTiming(10, 20);
    recordComposeTiming(Number.NaN, 1);
    recordComposeTiming(0, 1);
    expect(getComposeTiming().samples).toBe(1);
  });
});
