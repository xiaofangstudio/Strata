/**
 * 修边算法（纯像素）+ 第五批菜单背后的核心操作契约。
 *
 * 修边在 `core/matte.ts` 里是纯数组运算，直接断言数值；
 * 填充层 / 背景层 / 样式烘焙 / 任意角度旋转用最小 canvas 替身只断言结构。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decontaminateData,
  defringeData,
  removeBlackMatteData,
  removeWhiteMatteData,
} from "../../src/core/matte";
import {
  addGradientFillLayer,
  addLayerStyle,
  addPatternFillLayer,
  backgroundFromLayer,
  bakeStyledLayer,
  layerFromBackground,
} from "../../src/core/layerOps";
import { rotateDocumentArbitrary } from "../../src/core/transform";
import { docFromBlank, type StrataDoc } from "../../src/core/document";
import { installDomStub, type DomStub } from "../helpers/canvas";

describe("修边算法（纯像素）", () => {
  it("移去黑色杂边：按 alpha 反预乘", () => {
    const d = new Uint8ClampedArray([50, 50, 50, 128]);
    removeBlackMatteData(d);
    // 50 / (128/255) ≈ 99.6 → 100
    expect(d[0]).toBeCloseTo(100, 0);
    expect(d[3]).toBe(128);
  });

  it("移去白色杂边：按 c=(c−255·(1−a))/a 反解", () => {
    const a = 128;
    const alpha = a / 255;
    const cOut = 200;
    // 由 c_out = c·a + 255·(1−a) 反推 c
    const expected = Math.min(255, Math.max(0, (cOut - 255 * (1 - alpha)) / alpha));
    const d = new Uint8ClampedArray([cOut, cOut, cOut, a]);
    removeWhiteMatteData(d);
    expect(d[0]).toBeCloseTo(expected, 0);
  });

  it("全不透明或全透明的像素保持不变", () => {
    const d = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 0]);
    removeBlackMatteData(d);
    removeWhiteMatteData(d);
    expect(Array.from(d)).toEqual([10, 20, 30, 255, 40, 50, 60, 0]);
  });

  it("去边：半透明中心取最近不透明邻居的颜色，alpha 不变", () => {
    // 3×1：左红不透明、中间半透明暗色、右透明
    const w = 3;
    const h = 1;
    const d = new Uint8ClampedArray([
      255, 0, 0, 255,
      10, 10, 10, 100,
      0, 0, 0, 0,
    ]);
    defringeData(d, w, h, 2);
    expect(d[4]).toBe(255);
    expect(d[5]).toBe(0);
    expect(d[6]).toBe(0);
    expect(d[7]).toBe(100);
  });

  it("净化颜色：半透明像素按透明度向邻域更不透明的颜色靠拢", () => {
    // 2×1：左不透明 (200,100,50)，右半透明黑 a=0.5
    const d = new Uint8ClampedArray([
      200, 100, 50, 255,
      0, 0, 0, 128,
    ]);
    decontaminateData(d, 2, 1);
    // t = 1 − a ≈ 0.498 → 0*(0.502) + 200*0.498 ≈ 99.6
    expect(d[4]).toBeCloseTo(100, 0);
    expect(d[5]).toBeCloseTo(50, 0);
    expect(d[7]).toBe(128);
  });
});

describe("填充层 / 背景层 / 样式烘焙 / 任意角度旋转（结构）", () => {
  let dom: DomStub;
  beforeAll(() => {
    dom = installDomStub();
  });
  afterAll(() => {
    dom.restore();
  });

  const blank = (w = 100, h = 100): StrataDoc => docFromBlank(w, h, "t", "transparent");

  it("渐变填充层：新增一个名字带「渐变填充」的图层", () => {
    const doc = blank();
    const next = addGradientFillLayer(doc, "#000000", "#ffffff");
    expect(next.layers.length).toBe(doc.layers.length + 1);
    expect(next.layers.some((l) => l.name.includes("渐变填充"))).toBe(true);
  });

  it("图案填充层：新增一个名字带「图案填充」的图层", () => {
    const doc = blank();
    const next = addPatternFillLayer(doc, "#000000", "#ffffff", 8);
    expect(next.layers.some((l) => l.name.includes("图案填充"))).toBe(true);
  });

  it("由背景图层：解锁并改名", () => {
    const doc = blank();
    const next = layerFromBackground(doc);
    const l = next.layers.find((x) => x.id === next.activeLayerId)!;
    expect(l.locked).toBe(false);
  });

  it("转为背景图层：锁定且改名「背景」", () => {
    const doc = blank();
    const l0 = doc.layers.find((x) => x.id === doc.activeLayerId)!;
    const renamed = {
      ...doc,
      layers: doc.layers.map((x) => (x.id === l0.id ? { ...x, name: "临时层" } : x)),
    };
    const next = backgroundFromLayer(renamed);
    const l = next.layers.find((x) => x.id === next.activeLayerId)!;
    expect(l.locked).toBe(true);
    expect(l.name).toBe("背景");
  });

  it("样式烘焙：生成新图层并清空原图层样式", () => {
    const doc = blank();
    const styled = addLayerStyle(doc, "dropshadow");
    const active = styled.layers.find((x) => x.id === styled.activeLayerId)!;
    expect(active.styles?.length).toBeGreaterThan(0);

    const baked = bakeStyledLayer(styled);
    expect(baked.layers.length).toBe(styled.layers.length + 1);
    expect(baked.layers.some((l) => l.name.endsWith("样式"))).toBe(true);
    const orig = baked.layers.find((x) => x.id === active.id)!;
    expect(orig.styles?.length ?? 0).toBe(0);
  });

  it("任意角度旋转：90° 后宽高互换", () => {
    const doc = blank(100, 50);
    const next = rotateDocumentArbitrary(doc, 90);
    expect(next.width).toBe(50);
    expect(next.height).toBe(100);
  });
});
