/** 图案叠加预设：分组、解析与确定性绘制的纯逻辑测试。 */
import { describe, expect, it } from "vitest";
import { newLayerStyle } from "../../src/core/layer";
import {
  PATTERN_GROUP_ORDER,
  PATTERN_PRESETS,
  drawPatternPreset,
  findPatternPreset,
  patternPresetsByGroup,
  type PatternPreset,
} from "../../src/core/patternPresets";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function fakeCtx() {
  const rects: Rect[] = [];
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    clearRect: () => undefined,
    fillRect: (x: number, y: number, w: number, h: number) => rects.push({ x, y, w, h }),
    beginPath: () => undefined,
    arc: () => undefined,
    fill: () => undefined,
    stroke: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rects };
}

describe("图案叠加真预设", () => {
  it("预设按基础 / 纹理 / 织物分组，id 唯一", () => {
    const ids = PATTERN_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PATTERN_GROUP_ORDER.flatMap((g) => patternPresetsByGroup(g))).toHaveLength(PATTERN_PRESETS.length);
    expect(PATTERN_GROUP_ORDER).toEqual(["basic", "texture", "fabric"]);
  });

  it("builtin: 前缀与普通 id 都能解析", () => {
    expect(findPatternPreset("builtin:dots")?.id).toBe("dots");
    expect(findPatternPreset("weave")?.group).toBe("fabric");
    expect(findPatternPreset("builtin:nope")).toBeNull();
  });

  it("新加的图案叠加样式默认用真棋盘预设，不是空 patternId", () => {
    expect(newLayerStyle("patternoverlay").patternId).toBe("builtin:checker");
    expect(newLayerStyle("dropshadow").patternId).toBeUndefined();
  });

  it("棋盘真的画交错方块", () => {
    const { ctx, rects } = fakeCtx();
    drawPatternPreset(ctx, PATTERN_PRESETS[0], 48);
    // 背景一次 + 交错方块；不是只填一块纯色
    expect(rects.length).toBeGreaterThan(8);
    expect(rects.some((r) => r.x === 0 && r.y === 0 && r.w === 12 && r.h === 12)).toBe(true);
  });

  it("所有预设都能绘制，噪点是确定性的", () => {
    for (const preset of PATTERN_PRESETS) {
      const { ctx } = fakeCtx();
      expect(() => drawPatternPreset(ctx, preset, 48)).not.toThrow();
    }
    const noise: PatternPreset = PATTERN_PRESETS.find((p) => p.id === "noise")!;
    const a = fakeCtx();
    const b = fakeCtx();
    drawPatternPreset(a.ctx, noise, 48);
    drawPatternPreset(b.ctx, noise, 48);
    expect(a.rects).toEqual(b.rects);
  });
});
