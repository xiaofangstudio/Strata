import { describe, expect, it } from "vitest";
import {
  ADJUST_BRUSH_KINDS,
  DEFAULT_ADJUST_BRUSH_KIND,
  adjustBrushEntry,
  adjustBrushFollowKind,
  adjustBrushRefused,
  adjustBrushStartingState,
  adjustBrushTargetLayer,
  buildAdjustBrushDoc,
  composeMaskAlpha,
} from "../../src/core/adjustmentBrush";
import { adjustDef, newAdjustState, type AdjustState, type StrataLayer } from "../../src/core/layer";
import type { StrataDoc } from "../../src/core/document";

const fakeCanvas = () => ({ width: 4, height: 4 }) as unknown as HTMLCanvasElement;
let seq = 0;

/** 无 DOM 的图层桩：surface 只需占位，本组测试只验证决策与文档结构。 */
function fakeLayer(over: Partial<StrataLayer> = {}): StrataLayer {
  seq += 1;
  return {
    id: `layer-${seq}`,
    name: "layer",
    visible: true,
    opacity: 100,
    blend: "normal",
    locked: false,
    surface: fakeCanvas(),
    kind: "pixel",
    mask: null,
    maskActive: false,
    clip: false,
    styles: [],
    ...over,
  };
}

const makeLayer = (name: string, adjust: AdjustState): StrataLayer =>
  fakeLayer({ name, kind: "adjust", adjust, surface: fakeCanvas() });

function docWith(layers: StrataLayer[]): StrataDoc {
  return {
    id: "doc-1",
    name: "test",
    width: 4,
    height: 4,
    layers,
    activeLayerId: layers[0].id,
  };
}

const px = (alpha: number) => new Uint8ClampedArray([255, 255, 255, alpha]);

describe("调整画笔（移植自 PhotoCraft）", () => {
  it("下拉 14 项全部映射到真实调整类型，未知项退回色阶", () => {
    expect(ADJUST_BRUSH_KINDS).toHaveLength(14);
    for (const e of ADJUST_BRUSH_KINDS) {
      expect(() => adjustDef(e.adjustId)).not.toThrow();
    }
    expect(adjustBrushEntry("不存在的类型").kind).toBe(DEFAULT_ADJUST_BRUSH_KIND);
  });

  it("新层起始参数不是中性值，落笔立刻可见", () => {
    const levels = adjustBrushStartingState("levels");
    expect(levels.params.inBlack).toBe(20);
    expect(levels.params.inWhite).toBe(220);
    expect(adjustBrushStartingState("exposure").params.exposure).toBe(1);
    expect(adjustBrushStartingState("hueSaturation").params.saturate).toBe(30);
    const curves = adjustBrushStartingState("curves");
    expect(curves.curve?.[1].y).toBeCloseTo(191 / 255);
    // 原有 newAdjustState 仍是中性默认，没有被改坏
    expect(newAdjustState("levels").params.inBlack).toBe(0);
  });

  it("索引颜色模式整笔拒绝，其余模式放行", () => {
    const base = docWith([fakeLayer({ name: "底图" })]);
    expect(adjustBrushRefused(base)).toBe(false);
    expect(adjustBrushRefused({ ...base, colorMode: "indexed" })).toBe(true);
  });

  it("同类调整层活动 / 上次目标层优先，普通层不接笔", () => {
    const pixel = fakeLayer({ name: "底图" });
    const levels = fakeLayer({ name: "色阶", kind: "adjust", adjust: adjustBrushStartingState("levels"), mask: fakeCanvas() });
    levels.mask = fakeCanvas();
    const curves = fakeLayer({ name: "曲线", kind: "adjust", adjust: adjustBrushStartingState("curves"), mask: fakeCanvas() });
    curves.mask = fakeCanvas();
    const d = docWith([pixel, levels, curves]);
    expect(adjustBrushTargetLayer({ ...d, activeLayerId: levels.id }, "levels")?.id).toBe(levels.id);
    expect(adjustBrushTargetLayer({ ...d, activeLayerId: pixel.id }, "levels")).toBeNull();
    expect(adjustBrushTargetLayer({ ...d, activeLayerId: curves.id }, "levels", levels.id)?.id).toBe(levels.id);
    expect(adjustBrushTargetLayer({ ...d, activeLayerId: pixel.id }, "levels", curves.id)).toBeNull();
  });

  it("新建调整层落在活动层上方、蒙版启用、选区被清空，且不抢 activeLayerId", () => {
    const pixel = fakeLayer({ name: "底图" });
    const d: StrataDoc = {
      ...docWith([pixel]),
      selection: { width: 4, height: 4, mask: fakeCanvas() } as never,
    };
    const mask = fakeCanvas();
    const built = buildAdjustBrushDoc(d, "levels", mask, { makeLayer });
    expect(built.doc.layers).toHaveLength(2);
    expect(built.doc.layers[1].id).toBe(built.layerId);
    expect(built.doc.layers[1].kind).toBe("adjust");
    expect(built.doc.layers[1].mask).toBe(mask);
    expect(built.doc.layers[1].maskActive).toBe(true);
    expect(built.doc.activeLayerId).toBe(pixel.id);
    expect(built.doc.selection).toBeNull();
  });

  it("选中组时新层插进组内最上层并继承 parent", () => {
    const g = fakeLayer({ name: "组", kind: "group", parent: null });
    g.kind = "group";
    g.parent = null;
    const child = fakeLayer({ name: "子层", parent: g.id });
    child.parent = g.id;
    const d = { ...docWith([g, child]), activeLayerId: g.id };
    const built = buildAdjustBrushDoc(d, "curves", fakeCanvas(), { makeLayer });
    expect(built.doc.layers[0].parent).toBe(g.id);
    expect(built.doc.layers[0].kind).toBe("adjust");
    expect(built.doc.activeLayerId).toBe(g.id);
  });

  it("选中调整层时下拉跟着切类型", () => {
    expect(adjustBrushFollowKind(fakeLayer({ kind: "adjust", adjust: adjustBrushStartingState("photoFilter") }))).toBe("photoFilter");
    expect(adjustBrushFollowKind(fakeLayer({ name: "像素" }))).toBeNull();
  });

  it("Add / Subtract 蒙版合成按 alpha 叠加而不是覆盖", () => {
    const add = composeMaskAlpha(px(0), px(128));
    expect(add[3]).toBe(128);
    expect(add[0]).toBe(255);
    const again = composeMaskAlpha(add, px(128));
    expect(again[3]).toBe(192);
    const sub = composeMaskAlpha(px(255), px(128), true);
    expect(sub[3]).toBe(127);
    expect(composeMaskAlpha(px(200), px(255), false, 0)[3]).toBe(200);
  });
});
