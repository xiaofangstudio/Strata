import { describe, expect, it } from "vitest";
import { blendIfActive, blendIfWeight } from "../../src/engine/blendIf";
import { newBlendIf } from "../../src/core/layer";

describe("Blend If 权重", () => {
  it("默认状态不启用，权重恒为 1", () => {
    const s = newBlendIf();
    expect(blendIfActive(s)).toBe(false);
    expect(blendIfWeight(0.2, 0.8, s)).toBe(1);
  });

  it("本图层黑场半三角：暗部被剔除，亮部保留", () => {
    const s = { ...newBlendIf(), enabled: true, thisBlack: 80, feather: 0 };
    expect(blendIfActive(s)).toBe(true);
    expect(blendIfWeight(0.2, 0.5, s)).toBe(0);
    expect(blendIfWeight(0.4, 0.5, s)).toBe(1);
  });

  it("下一图层白场半三角：亮底色处不混合", () => {
    const s = { ...newBlendIf(), enabled: true, underWhite: 180, feather: 0 };
    expect(blendIfWeight(0.5, 0.3, s)).toBe(1);
    expect(blendIfWeight(0.5, 0.9, s)).toBe(0);
  });

  it("羽化后是平滑斜坡而不是硬切", () => {
    const s = { ...newBlendIf(), enabled: true, thisBlack: 64, feather: 64 };
    const mid = blendIfWeight(96 / 255, 128 / 255, s);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(blendIfWeight(32 / 255, 128 / 255, s)).toBe(0);
    expect(blendIfWeight(160 / 255, 128 / 255, s)).toBe(1);
  });

  it("黑白两端同时收窄时取交集", () => {
    const s = { ...newBlendIf(), enabled: true, thisBlack: 64, thisWhite: 192, feather: 0 };
    expect(blendIfWeight(32 / 255, 128 / 255, s)).toBe(0);
    expect(blendIfWeight(128 / 255, 128 / 255, s)).toBe(1);
    expect(blendIfWeight(224 / 255, 128 / 255, s)).toBe(0);
  });
});
