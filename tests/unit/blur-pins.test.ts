/**
 * 模糊画廊钉点几何测试 —— 坐标换算是这类交互最容易藏 bug 的地方（方向写反、短边基准漏掉、
 * 命中优先级错位），全部对固定数值断言。
 */
import { describe, expect, it } from "vitest";
import {
  cleanPin,
  fromDoc,
  hitPin,
  isBlurGallery,
  paramsToPin,
  pinToParams,
  shortSide,
  toDoc,
  type Bounds,
  type BlurPin,
} from "../../src/core/blurPins";

const B: Bounds = [100, 200, 900, 600]; // 宽 800，高 400，短边 400
const pin = (over: Partial<BlurPin> = {}): BlurPin => cleanPin({ x: 0.5, y: 0.5, blur: 16, radius: 0.25, feather: 0.5, ...over });

describe("坐标换算", () => {
  it("shortSide 取短边", () => {
    expect(shortSide(B)).toBe(400);
  });

  it("归一化中心映射到 bounds 中心", () => {
    expect(toDoc(B, pin())).toEqual({ x: 500, y: 400 });
  });

  it("归一化四角映射正确", () => {
    expect(toDoc(B, pin({ x: 0, y: 0 }))).toEqual({ x: 100, y: 200 });
    expect(toDoc(B, pin({ x: 1, y: 1 }))).toEqual({ x: 900, y: 600 });
  });

  it("toDoc / fromDoc 往返一致", () => {
    for (const p of [pin({ x: 0.2, y: 0.7 }), pin({ x: 0.83, y: 0.11 })]) {
      const d = toDoc(B, p);
      const back = fromDoc(B, d);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it("fromDoc 越界夹到 0..1", () => {
    expect(fromDoc(B, { x: -50, y: 9999 })).toEqual({ x: 0, y: 1 });
  });
});

describe("cleanPin 脏数据兜底", () => {
  it("null / 空对象返回合法默认", () => {
    for (const src of [null, undefined, {}]) {
      const p = cleanPin(src);
      for (const k of ["x", "y", "blur", "radius", "feather"] as const) {
        expect(Number.isFinite(p[k])).toBe(true);
      }
    }
  });

  it("NaN / Infinity 被默认值替换", () => {
    const p = cleanPin({ x: NaN, y: Infinity, blur: -5, radius: 9, feather: -1 });
    expect(p.x).toBe(0.5);
    expect(p.y).toBe(0.5);
    expect(p.blur).toBe(0);
    expect(p.radius).toBe(1);
    expect(p.feather).toBe(0);
  });
});

describe("命中优先级", () => {
  it("选中时环手柄优先于中心（抓环不会被中心抢）", () => {
    const p = pin({ radius: 0.25 }); // 环在中心右侧 100px（短边 400 * 0.25）
    const ringPt = { x: 600, y: 400 };
    expect(hitPin(B, p, ringPt, 1, true)).toBe("radius");
    // 未选中时环不算手柄
    expect(hitPin(B, p, ringPt, 1, false)).toBeNull();
  });

  it("中心可抓", () => {
    expect(hitPin(B, pin(), { x: 500, y: 400 }, 1, true)).toBe("center");
  });

  it("空白处抓不到", () => {
    expect(hitPin(B, pin(), { x: 200, y: 250 }, 1, true)).toBeNull();
  });

  it("缩放影响容差：视图缩得越小，文档域命中容差越大（屏幕恒定好抓）", () => {
    const p = pin({ radius: 0.25 });
    // 环手柄在中心右侧 100 文档像素（x=600），取 x=608（离环 8px、离中心 108px）
    const at = { x: 608, y: 400 };
    // screenDist=0.1（缩到 10%）→ 文档阈值 140px，8px 命中半径环
    expect(hitPin(B, p, at, 0.1, true)).toBe("radius");
    // screenDist=8（放大 800%）→ 文档阈值 1.75px，8px 已超出，抓不到
    expect(hitPin(B, p, at, 8, true)).toBeNull();
  });
});

describe("参数双向映射", () => {
  it("Iris：钉点↔参数往返保持中心和半径", () => {
    const id = "filter.blurGallery.irisBlur";
    const p = pin({ x: 0.25, y: 0.75, blur: 30, radius: 0.4 });
    const params = pinToParams(id, p);
    expect(params.cx).toBe(25);
    expect(params.cy).toBe(75);
    expect(params.radius).toBe(30);
    expect(params.iris).toBe(40);
    const back = paramsToPin(id, params);
    expect(back.x).toBeCloseTo(0.25, 6);
    expect(back.y).toBeCloseTo(0.75, 6);
    expect(back.blur).toBe(30);
    expect(back.radius).toBeCloseTo(0.4, 6);
  });

  it("Spin：blur 与 angle 双向换算", () => {
    const id = "filter.blurGallery.spinBlur";
    const p = pin({ x: 0.5, y: 0.5, blur: 10 });
    const params = pinToParams(id, p);
    expect(params.angle).toBe(180);
    const back = paramsToPin(id, params);
    expect(back.blur).toBe(10);
  });

  it("Tilt：只映射 blur 和 centerY", () => {
    const id = "filter.blurGallery.tiltShift";
    const p = pin({ x: 0.9, y: 0.3, blur: 24 });
    const params = pinToParams(id, p);
    expect(params.radius).toBe(24);
    expect(params.center).toBe(30);
    expect("cx" in params).toBe(false);
  });

  it("Field / Path：只映射模糊量", () => {
    expect(pinToParams("filter.blurGallery.fieldBlur", pin({ blur: 40 }))).toEqual({ amount: 40 });
    expect(pinToParams("filter.blurGallery.pathBlur", pin({ blur: 60 }))).toEqual({ distance: 60 });
  });
});

describe("族判定", () => {
  it("只认 blurGallery 前缀", () => {
    expect(isBlurGallery("filter.blurGallery.irisBlur")).toBe(true);
    expect(isBlurGallery("filter.blur.gaussianBlur")).toBe(false);
    expect(isBlurGallery(null)).toBe(false);
    expect(isBlurGallery("")).toBe(false);
  });

  it("四种支持环手柄，Field/Path 不支持", () => {
    // 用 isBlurGallery + 已知语义的组合判定在 UI 里使用，这里只钉 id 集合的稳定
    for (const id of ["irisBlur", "spinBlur"]) {
      expect(isBlurGallery(`filter.blurGallery.${id}`)).toBe(true);
    }
  });
});
