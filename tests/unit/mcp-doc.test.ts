/**
 * MCP 图层文档（mcp/lib/doc.mjs）与绘制层（mcp/lib/draw.mjs）单测。
 *
 * 这层一旦算错，导出的海报会「颜色发灰 / 蒙版切错地方 / 文字没上去」，
 * 而且不会报错。用合成色块把混合公式、区域蒙版、文字渲染钉死。
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error —— mcp 侧是无类型的 .mjs
import { addLayer, createDoc, flatten, layerIndex, mixByMask, regionMask } from "../../mcp/lib/doc.mjs";
// @ts-expect-error —— 同上
import { renderEllipse, renderRect, renderText, toCssColor } from "../../mcp/lib/draw.mjs";

/** 纯色 RGBA 图。 */
function solid(w: number, h: number, rgba: number[]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) data.set(rgba, i * 4);
  return { width: w, height: h, data };
}

function px(img: { width: number; data: Uint8ClampedArray }, x: number, y: number) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

describe("图层合成 flatten", () => {
  it("背景 + 不透明图层：上层直接覆盖", () => {
    let doc = createDoc(4, 4, [0, 0, 0]);
    doc = addLayer(doc, solid(4, 4, [255, 0, 0, 255]));
    expect(px(flatten(doc), 1, 1)).toEqual([255, 0, 0, 255]);
  });

  it("正片叠底：结果等于两色相乘", () => {
    let doc = createDoc(2, 2, [128, 128, 128]);
    doc = addLayer(doc, solid(2, 2, [128, 128, 128, 255]), { blend: "multiply" });
    const out = px(flatten(doc), 0, 0)[0];
    // 0.502 * 0.502 ≈ 0.252 → 64（±2）
    expect(Math.abs(out - 64)).toBeLessThanOrEqual(2);
  });

  it("滤色：结果比两者都亮", () => {
    let doc = createDoc(2, 2, [100, 100, 100]);
    doc = addLayer(doc, solid(2, 2, [100, 100, 100, 255]), { blend: "screen" });
    const out = px(flatten(doc), 0, 0)[0];
    expect(out).toBeGreaterThan(100);
    // 1-(1-0.392)^2 ≈ 0.63 → 161
    expect(Math.abs(out - 161)).toBeLessThanOrEqual(3);
  });

  it("opacity 0.5 的白色层叠在黑底上约等于中灰", () => {
    let doc = createDoc(2, 2, [0, 0, 0]);
    doc = addLayer(doc, solid(2, 2, [255, 255, 255, 255]), { opacity: 0.5 });
    const out = px(flatten(doc), 0, 0)[0];
    expect(Math.abs(out - 128)).toBeLessThanOrEqual(2);
  });

  it("隐藏层不参与合成", () => {
    let doc = createDoc(2, 2, [10, 20, 30]);
    doc = addLayer(doc, solid(2, 2, [255, 0, 0, 255]), { visible: false });
    expect(px(flatten(doc), 0, 0)).toEqual([10, 20, 30, 255]);
  });

  it("图层偏移后只覆盖对应位置", () => {
    let doc = createDoc(6, 6, [0, 0, 0]);
    doc = addLayer(doc, solid(2, 2, [255, 255, 255, 255]), { x: 4, y: 4 });
    const out = flatten(doc);
    expect(px(out, 5, 5)).toEqual([255, 255, 255, 255]);
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 255]);
  });

  it("按名字找图层", () => {
    let doc = createDoc(2, 2, [0, 0, 0]);
    doc = addLayer(doc, solid(2, 2, [0, 0, 0, 255]), { name: "猫 · 脸部" });
    expect(layerIndex(doc, "猫 · 脸部")).toBe(1);
    expect(layerIndex(doc, 0)).toBe(0);
    expect(layerIndex(doc, "不存在")).toBe(-1);
  });
});

describe("区域蒙版 regionMask", () => {
  it("矩形内部为 1、外部为 0", () => {
    const mask = regionMask({ width: 20, height: 20 }, { type: "rect", x: 5, y: 5, width: 10, height: 10 });
    expect(mask[10 * 20 + 10]).toBe(1);
    expect(mask[0]).toBe(0);
    expect(mask[19 * 20 + 19]).toBe(0);
  });

  it("羽化让边界出现中间值", () => {
    const mask = regionMask(
      { width: 40, height: 40 },
      { type: "rect", x: 10, y: 10, width: 20, height: 20, feather: 6 },
    );
    let mids = 0;
    for (const v of mask) if (v > 0.05 && v < 0.95) mids += 1;
    expect(mids).toBeGreaterThan(10);
  });

  it("椭圆蒙版中心为 1、四角为 0", () => {
    const mask = regionMask(
      { width: 40, height: 40 },
      { type: "ellipse", cx: 20, cy: 20, rx: 15, ry: 15 },
    );
    expect(mask[20 * 40 + 20]).toBe(1);
    expect(mask[0]).toBe(0);
  });
});

describe("按蒙版混合 mixByMask", () => {
  it("蒙版 0 保留原图、1 取新图", () => {
    const orig = solid(2, 1, [10, 10, 10, 255]);
    const adj = solid(2, 1, [200, 200, 200, 255]);
    const mask = new Float32Array([0, 1]);
    const out = mixByMask(orig, adj, mask);
    expect(px(out, 0, 0)[0]).toBe(10);
    expect(px(out, 1, 0)[0]).toBe(200);
  });

  it("中间值线性混合", () => {
    const orig = solid(1, 1, [0, 0, 0, 255]);
    const adj = solid(1, 1, [100, 100, 100, 255]);
    const out = mixByMask(orig, adj, new Float32Array([0.5]));
    expect(Math.abs(px(out, 0, 0)[0] - 50)).toBeLessThanOrEqual(1);
  });
});

describe("文字与形状渲染", () => {
  it("中文文字能真正栅格化出不透明像素", () => {
    const img = renderText({ text: "橘猫", size: 64, color: "#000000", padding: 4 });
    expect(img.width).toBeGreaterThan(60);
    expect(img.height).toBeGreaterThan(40);
    let opaque = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 200) opaque += 1;
    expect(opaque).toBeGreaterThan(500); // 真的画上了字，不是空白
  });

  it("多行文字高度随行数增长", () => {
    const one = renderText({ text: "A", size: 40 });
    const two = renderText({ text: "A\nB", size: 40 });
    expect(two.height).toBeGreaterThan(one.height);
  });

  it("虚线框在边上有像素、中心透明", () => {
    const img = renderRect({
      width: 120,
      height: 80,
      stroke: "#ffffff",
      strokeWidth: 4,
      dash: [10, 8],
    });
    // 中心应当是空的（只画了边框）
    expect(px(img, 60, 40)[3]).toBe(0);
    // 上边框某处有像素
    let edge = 0;
    for (let x = 0; x < 120; x += 1) if (px(img, x, 2)[3] > 0) edge += 1;
    expect(edge).toBeGreaterThan(20);
    // 虚线：上边框中应当有「空档」
    let gap = 0;
    for (let x = 0; x < 120; x += 1) if (px(img, x, 2)[3] === 0) gap += 1;
    expect(gap).toBeGreaterThan(5);
  });

  it("椭圆描边中心透明", () => {
    const img = renderEllipse({ width: 100, height: 100, stroke: "#ff0000", strokeWidth: 3 });
    expect(px(img, 50, 50)[3]).toBe(0);
    expect(px(img, 50, 2)[3]).toBeGreaterThan(0);
  });

  it("颜色解析支持 #rgb / #rrggbb / 数组", () => {
    expect(toCssColor("#f00")).toBe("rgba(255, 0, 0, 1)");
    expect(toCssColor("#00ff0080")).toContain("rgba(0, 255, 0,");
    expect(toCssColor([1, 2, 3, 255])).toBe("rgba(1, 2, 3, 255)");
  });
});
