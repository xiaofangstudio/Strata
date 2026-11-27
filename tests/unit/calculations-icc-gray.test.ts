/**
 * Calculations Gray 的真 ICC 门控测试（对照新版 PhotoCraft）。
 *
 * 只 mock Tauri 的 ICC 桥：门控、调用参数、单通道取回全是 Strata 自己的逻辑。
 * 非 RGB8/sRGB 必须继续走旧 Rec.601，不能把深水区路径一起改坏。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/engine/cms", () => ({
  builtinProfile: vi.fn(async (id: string) => Uint8Array.from([id.charCodeAt(0)])),
  iccTransform: vi.fn(async (pixels: Uint8Array | Uint8ClampedArray) => {
    const out = new Uint8Array(pixels.length);
    const n = Math.floor(pixels.length / 4);
    for (let p = 0; p < n; p += 1) {
      const o = p * 4;
      out[o] = 200;
      out[o + 1] = 200;
      out[o + 2] = 200;
      out[o + 3] = pixels[o + 3];
    }
    return out;
  }),
}));

import { calcUsesIccGray, grayFromIccOutput } from "../../src/core/calculations";
import { builtinProfile, iccTransform } from "../../src/engine/cms";
import { sampleCalculationChannel } from "../../src/engine/calculations";

const rgba = new Uint8ClampedArray([
  255, 0, 0, 255,
  0, 128, 255, 128,
]);

describe("Calculations Gray 真 ICC 通道", () => {
  beforeEach(() => {
    vi.mocked(builtinProfile).mockClear();
    vi.mocked(iccTransform).mockClear();
  });

  it("只有 RGB / 8bit / sRGB 走 ICC，其它上下文保持旧公式", () => {
    expect(calcUsesIccGray({})).toBe(true);
    expect(calcUsesIccGray({ colorMode: "cmyk" })).toBe(false);
    expect(calcUsesIccGray({ bitsPerChannel: 16 })).toBe(false);
    expect(calcUsesIccGray({ bitsPerChannel: 32 })).toBe(false);
    expect(calcUsesIccGray({ profile: "display-p3" })).toBe(false);
    expect(calcUsesIccGray({ profile: "adobe-rgb" })).toBe(false);
    expect(calcUsesIccGray({ profile: "gray" })).toBe(false);
  });

  it("从 ICC 回传的 [g,g,g,a] 里取首通道", () => {
    const out = new Uint8Array([17, 17, 17, 255, 200, 200, 200, 128]);
    expect(Array.from(grayFromIccOutput(out, 2))).toEqual([17, 200]);
  });

  it("sRGB 灰度真的调用 ICC，取回的灰度不是 Rec.601", async () => {
    const result = await sampleCalculationChannel({ profile: "srgb" }, rgba, "gray");
    expect(result.icc).toBe(true);
    expect(Array.from(result.values)).toEqual([200, 200]);
    expect(vi.mocked(builtinProfile).mock.calls.map((c) => c[0])).toEqual(["srgb", "gray"]);
    expect(vi.mocked(iccTransform)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(iccTransform).mock.calls[0][0]).toBe(rgba);
  });

  it("红通道与非 sRGB 灰度不碰 ICC，保持原采样", async () => {
    const red = await sampleCalculationChannel({}, rgba, "red");
    expect(red.icc).toBe(false);
    expect(Array.from(red.values)).toEqual([255, 0]);

    const gray = await sampleCalculationChannel({ profile: "adobe-rgb" }, rgba, "gray");
    expect(gray.icc).toBe(false);
    expect(gray.values[0]).toBeCloseTo(76, 0);
    expect(vi.mocked(iccTransform)).not.toHaveBeenCalled();
  });
});
