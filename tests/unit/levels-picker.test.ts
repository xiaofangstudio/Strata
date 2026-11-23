import { describe, expect, it } from "vitest";
import {
  gammaFromMid,
  gammaMid,
  levelsFromSample,
  sampleLevel,
} from "../../src/core/levelsPicker";

describe("levelsFromSample", () => {
  it("黑场吸管把采样亮度设为新黑场，且不越过白场", () => {
    expect(
      levelsFromSample({ kind: "black", black: 10, white: 220, gamma: 100, channel: "lum", sample: [64, 64, 64] }),
    ).toEqual({ black: 64, white: 220, gamma: 100 });

    const clamped = levelsFromSample({
      kind: "black", black: 10, white: 40, gamma: 100, channel: "lum", sample: [200, 200, 200],
    });
    expect(clamped.black).toBe(39);
    expect(clamped.white).toBe(40);
  });

  it("白场吸管把采样亮度设为新白场，且不低于黑场", () => {
    expect(
      levelsFromSample({ kind: "white", black: 20, white: 240, gamma: 110, channel: "lum", sample: [200, 200, 200] }),
    ).toEqual({ black: 20, white: 200, gamma: 110 });

    const clamped = levelsFromSample({
      kind: "white", black: 180, white: 240, gamma: 100, channel: "lum", sample: [10, 10, 10],
    });
    expect(clamped.white).toBe(181);
  });

  it("灰场吸管让采样亮度落在中点，反算出的 gamma 与手拖一致", () => {
    const black = 12;
    const white = 238;
    const gamma = 155;
    const mid = gammaMid(black, white, gamma);
    const picked = levelsFromSample({
      kind: "gray", black, white, gamma: 100, channel: "lum",
      sample: [mid, mid, mid],
    });
    expect(picked.black).toBe(black);
    expect(picked.white).toBe(white);
    expect(picked.gamma).toBeCloseTo(gamma, 0);
  });

  it("灰场采样落在黑白场之外时安全夹住，不产生 NaN / Infinity", () => {
    for (const v of [0, 4, 250, 255]) {
      const r = levelsFromSample({
        kind: "gray", black: 20, white: 230, gamma: 100, channel: "lum", sample: [v, v, v],
      });
      expect(Number.isFinite(r.gamma)).toBe(true);
      expect(r.gamma).toBeGreaterThanOrEqual(10);
      expect(r.gamma).toBeLessThanOrEqual(300);
    }
    expect(gammaFromMid(0, 255, 127.5)).toBeCloseTo(100, 1);
  });

  it("通道吸管只取对应通道，亮度吸管走加权 luminance", () => {
    const rgb = [210, 40, 90] as const;
    expect(
      sampleLevel({ kind: "black", black: 0, white: 255, gamma: 100, channel: "r", sample: rgb }),
    ).toBe(210);
    expect(
      sampleLevel({ kind: "black", black: 0, white: 255, gamma: 100, channel: "b", sample: rgb }),
    ).toBe(90);
    expect(
      sampleLevel({ kind: "black", black: 0, white: 255, gamma: 100, channel: "lum", sample: rgb }),
    ).toBeCloseTo(0.299 * 210 + 0.587 * 40 + 0.114 * 90, 3);
  });
});
