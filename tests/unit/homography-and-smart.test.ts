/**
 * 四点单应（纯数学）+ 智能对象最小集 + 样式定义扩展。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMat3,
  invertMat3,
  rectQuad,
  unitSquareToQuad,
} from "../../src/core/homography";
import {
  convertSmartObjectToLayers,
  convertToSmartObject,
  newSmartObjectViaCopy,
  rasterizeSmartObject,
} from "../../src/core/layerOps";
import { STYLE_DEFS, newLayerStyle } from "../../src/core/layer";
import { docFromBlank, type StrataDoc } from "../../src/core/document";
import { installDomStub, type DomStub } from "../helpers/canvas";

describe("四点单应（纯数学）", () => {
  it("单位正方形映射到自身", () => {
    const q = rectQuad(0, 0, 1, 1);
    const H = unitSquareToQuad(q);
    const c = applyMat3(H, 0.5, 0.5)!;
    expect(c.x).toBeCloseTo(0.5, 6);
    expect(c.y).toBeCloseTo(0.5, 6);
    const tl = applyMat3(H, 0, 0)!;
    expect(tl.x).toBeCloseTo(0, 6);
    expect(tl.y).toBeCloseTo(0, 6);
  });

  it("逆矩阵可把目标点还原回单位坐标", () => {
    const q = rectQuad(10, 20, 100, 50);
    const H = unitSquareToQuad(q);
    const inv = invertMat3(H)!;
    // 先正变换，再逆变换
    const fwd = applyMat3(H, 0.25, 0.75)!;
    const back = applyMat3(inv, fwd.x, fwd.y)!;
    expect(back.x).toBeCloseTo(0.25, 6);
    expect(back.y).toBeCloseTo(0.75, 6);
  });

  it("平行四边形走仿射分支，角点精确落位", () => {
    // 上边整体右移 10 的平行四边形
    const q = [
      { x: 10, y: 0 },
      { x: 110, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ];
    const H = unitSquareToQuad(q);
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ] as const) {
      const p = applyMat3(H, u, v)!;
      const expectIdx = v === 0 ? (u === 0 ? 0 : 1) : u === 1 ? 2 : 3;
      expect(p.x).toBeCloseTo(q[expectIdx].x, 6);
      expect(p.y).toBeCloseTo(q[expectIdx].y, 6);
    }
  });

  it("退化四边形不会返回 NaN", () => {
    const degenerate = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 1 },
      { x: 0, y: 0 },
    ];
    const H = unitSquareToQuad(degenerate);
    const p = applyMat3(H, 0.5, 0.5);
    expect(p === null || Number.isFinite(p.x)).toBe(true);
  });
});

describe("智能对象最小集（结构）", () => {
  let dom: DomStub;
  beforeAll(() => {
    dom = installDomStub();
  });
  afterAll(() => {
    dom.restore();
  });

  const blank = (): StrataDoc => docFromBlank(40, 30, "t", "transparent");
  const active = (doc: StrataDoc) => doc.layers.find((l) => l.id === doc.activeLayerId)!;

  /** 给当前图层表面补一个 toDataURL 替身。 */
  const stubDataUrl = (doc: StrataDoc) => {
    const l = active(doc);
    (l.surface as unknown as { toDataURL: () => string }).toDataURL = () =>
      "data:image/png;base64,AAAA";
    return doc;
  };

  it("转为智能对象：写入 smart 并改名", () => {
    const doc = stubDataUrl(blank());
    const next = convertToSmartObject(doc);
    const l = active(next);
    expect(l.smart).toBe("data:image/png;base64,AAAA");
    expect(l.name).toContain("智能对象");
  });

  it("栅格化：清除 smart，保留像素", () => {
    const doc = stubDataUrl(blank());
    const smart = convertToSmartObject(doc);
    const raster = rasterizeSmartObject(smart);
    expect(active(raster).smart).toBeUndefined();
    expect(active(raster).surface).toBeTruthy();
  });

  it("转换为图层：等同栅格化", () => {
    const doc = stubDataUrl(blank());
    const next = convertSmartObjectToLayers(convertToSmartObject(doc));
    expect(active(next).smart).toBeUndefined();
  });

  it("通过拷贝新建智能对象：多一层且都带 smart", () => {
    const doc = stubDataUrl(blank());
    const smart = convertToSmartObject(doc);
    const copy = newSmartObjectViaCopy(smart);
    expect(copy.layers.length).toBe(smart.layers.length + 1);
    expect(copy.layers.filter((l) => l.smart).length).toBeGreaterThanOrEqual(2);
  });

  it("非智能对象上调用栅格化/拷贝是安全的空操作", () => {
    const doc = stubDataUrl(blank());
    expect(rasterizeSmartObject(doc)).toBe(doc);
    expect(newSmartObjectViaCopy(doc)).toBe(doc);
  });
});

describe("新样式可渲染（烟测）", () => {
  let dom: DomStub;
  beforeAll(() => {
    dom = installDomStub();
  });
  afterAll(() => {
    dom.restore();
  });

  it("四种新样式都能画到画布上且不抛错", async () => {
    const { paintStyledLayer } = await import("../../src/engine/styles");
    const { addLayerStyle } = await import("../../src/core/layerOps");
    const { createSurface } = await import("../../src/engine/surface");
    for (const id of [
      "bevelemboss",
      "satin",
      "gradientoverlay",
      "patternoverlay",
    ] as const) {
      const styled = addLayerStyle(docFromBlank(40, 30, "t", "transparent"), id);
      const layer = styled.layers.find((l) => l.id === styled.activeLayerId)!;
      const ctx = createSurface(40, 30).getContext("2d")!;
      expect(() => paintStyledLayer(ctx, layer)).not.toThrow();
    }
  });
});

describe("样式定义扩展", () => {
  it("共 10 种样式，新增 4 种能生成默认值", () => {
    const ids = STYLE_DEFS.map((d) => d.id);
    for (const id of [
      "bevelemboss",
      "satin",
      "gradientoverlay",
      "patternoverlay",
    ] as const) {
      expect(ids).toContain(id);
      const s = newLayerStyle(id);
      expect(s.id).toBe(id);
      expect(s.enabled).toBe(true);
      expect(s.opacity).toBeGreaterThan(0);
    }
    expect(STYLE_DEFS.length).toBe(10);
  });
});
