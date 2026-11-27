import { describe, expect, it } from "vitest";
import {
  curvePresetToLinearKnots,
  defaultRawUiParams,
  uiToRawDevelop,
  type RawMeta,
} from "../../src/core/rawDevelopParams";

const meta: RawMeta = {
  source: "sensor",
  wbMultipliers: [1.2, 1, 1.4],
  baselineExposure: 0.25,
  orientation: 1,
  cfa: "RGGB",
};

describe("真 RAW 显影参数映射", () => {
  it("默认参数使用 as-shot 白平衡与 0EV", () => {
    const out = uiToRawDevelop(defaultRawUiParams(), meta);
    expect(out.whiteBalance).toBe("asShot");
    expect(out.wbMultipliers).toBeNull();
    expect(out.exposure).toBe(0);
    expect(out.tone).toEqual({ shadows: 0, highlights: 0, clarity: 0, texture: 0, dehaze: 0 });
  });

  it("色温 / 色调沿相机通道乘数偏移", () => {
    const warm = uiToRawDevelop({ ...defaultRawUiParams(), temperature: 100 }, meta);
    expect(warm.whiteBalance).toBe("custom");
    expect(warm.wbMultipliers![0]).toBeGreaterThan(warm.wbMultipliers![2]);
    const magenta = uiToRawDevelop({ ...defaultRawUiParams(), tint: 100 }, meta);
    expect(magenta.wbMultipliers![1]).toBeLessThan(1);
  });

  it("坏元数据不会让映射抛出或产出 NaN", () => {
    const out = uiToRawDevelop(
      { ...defaultRawUiParams(), temperature: 100 },
      { ...meta, wbMultipliers: [Number.NaN, 0, -1] },
    );
    expect(out.wbMultipliers?.every((v) => Number.isFinite(v) && v > 0)).toBe(true);
  });

  it("UI 曲线预设转成首尾固定、单调的线性节点", () => {
    const identity = curvePresetToLinearKnots(0);
    expect(identity[0]).toEqual([0, 0]);
    expect(identity[identity.length - 1]).toEqual([1, 1]);
    for (let i = 1; i < identity.length; i += 1) {
      expect(identity[i][0]).toBeGreaterThan(identity[i - 1][0]);
      expect(identity[i][1]).toBeGreaterThanOrEqual(identity[i - 1][1]);
    }
    const s = curvePresetToLinearKnots(2);
    expect(s.some((p) => Math.abs(p[0] - p[1]) > 0.01)).toBe(true);
  });

  it("曝光与影调不是先压 8bit 再调的显示域近似", () => {
    const out = uiToRawDevelop({ ...defaultRawUiParams(), exposure: 1.5, highlights: -60 }, meta);
    expect(out.exposure).toBe(1.5);
    expect(out.tone.highlights).toBe(-60);
    // 线性曲线节点不可能是 0..255 控制点直接搬过来
    expect(out.curveKnots.every(([x, y]) => x <= 1 && y <= 1)).toBe(true);
  });
});
