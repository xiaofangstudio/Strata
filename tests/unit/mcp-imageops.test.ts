/**
 * MCP 图像管线（mcp/lib/imageOps.mjs）单测。
 *
 * 这些函数是「外部 AI 通过 MCP 修图」的像素底座，出错了不会报错、
 * 只会默默产出一张废图 —— 所以用合成图把关键数学钉死：
 *  · 抠图：纯色背景上的方块必须被完整抠出，边界对齐；
 *  · 合成：alpha-over 的半透明混合要按预乘公式走；
 *  · 光效：screen 混合必须只提亮不压暗；暗角只压边不压中心；
 *  · 缩放：双线性插值在纯色图上必须恒等。
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error —— mcp 侧是纯 .mjs，没有类型声明，测试里按 JS 用
import {
  bilinearResize,
  compositeOver,
  contentBounds,
  cutout,
  softShadow,
  vignette,
} from "../../mcp/lib/imageOps.mjs";

/** 造一张 w×h 的 RGBA 图，`paint(x,y)` 返回 [r,g,b,a]。 */
function makeImage(w: number, h: number, paint: (x: number, y: number) => number[]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width: w, height: h, data };
}

/** 取某像素。 */
function px(img: { width: number; data: Uint8ClampedArray }, x: number, y: number) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

describe("cutout 抠图", () => {
  // 40×40 蓝底，中间 16×16 红方块（8..23）
  const img = makeImage(40, 40, (x, y) =>
    x >= 8 && x < 24 && y >= 8 && y < 24 ? [200, 30, 30, 255] : [20, 40, 200, 255],
  );

  it("纯色背景上的方块被完整抠出并裁到包围盒", () => {
    const s = cutout(img, { tolerance: 20, feather: 0, trim: true });
    expect(s.width).toBe(16);
    expect(s.height).toBe(16);
    // 裁完第一像素就是红方块的中心色
    expect(px(s, 0, 0)).toEqual([200, 30, 30, 255]);
  });

  it("背景完全透明（四角 alpha 为 0）", () => {
    const s = cutout(img, { tolerance: 20, feather: 0, trim: false });
    expect(px(s, 0, 0)[3]).toBe(0);
    expect(px(s, 39, 39)[3]).toBe(0);
    // 主体中心不透明
    expect(px(s, 15, 15)[3]).toBe(255);
  });

  it("invert 模式反过来：主体挖空、背景保留", () => {
    const s = cutout(img, { tolerance: 20, feather: 0, invert: true, trim: false });
    expect(px(s, 15, 15)[3]).toBe(0); // 方块位置被挖空
    expect(px(s, 0, 0)[3]).toBe(255); // 背景还在
  });

  it("容差过小时背景抠不干净（主体包围盒会变大）", () => {
    // 噪点背景：容差过小，洪水填充推不动 → 主体判定成整幅
    const noisy = makeImage(30, 30, (x, y) => {
      const n = (x * 7 + y * 13) % 60;
      return [n, n, n, 255];
    });
    const tight = cutout(noisy, { tolerance: 2, feather: 0, trim: true });
    expect(tight.width).toBeGreaterThan(20);
  });
});

describe("compositeOver 合成", () => {
  it("不透明叠层直接覆盖", () => {
    const base = makeImage(10, 10, () => [0, 0, 0, 255]);
    const over = makeImage(4, 4, () => [255, 255, 255, 255]);
    const out = compositeOver(base, over, 3, 3, 1);
    expect(px(out, 3, 3)).toEqual([255, 255, 255, 255]);
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 255]); // 叠层外不动
  });

  it("半透明叠层按 alpha 混合", () => {
    const base = makeImage(4, 4, () => [0, 0, 0, 255]);
    const over = makeImage(4, 4, () => [255, 255, 255, 128]);
    const out = compositeOver(base, over, 0, 0, 1);
    const [r] = px(out, 1, 1);
    // 128/255 ≈ 0.502 → 结果约 128（±2 容差，取整方式可能差 1）
    expect(Math.abs(r - 128)).toBeLessThanOrEqual(2);
  });

  it("整体不透明度作用在叠层 alpha 上", () => {
    const base = makeImage(4, 4, () => [0, 0, 0, 255]);
    const over = makeImage(4, 4, () => [255, 255, 255, 255]);
    const out = compositeOver(base, over, 0, 0, 0.5);
    const [r] = px(out, 2, 2);
    expect(Math.abs(r - 128)).toBeLessThanOrEqual(2);
  });

  it("越界部分被裁掉，不写坏底图", () => {
    const base = makeImage(6, 6, () => [10, 20, 30, 255]);
    const over = makeImage(4, 4, () => [255, 0, 0, 255]);
    const out = compositeOver(base, over, 4, 4, 1);
    expect(px(out, 5, 5)).toEqual([255, 0, 0, 255]);
    expect(px(out, 0, 0)).toEqual([10, 20, 30, 255]);
  });
});

describe("光效", () => {
  it("暗角只压四角、不动中心", () => {
    const base = makeImage(40, 40, () => [200, 200, 200, 255]);
    const out = vignette(base, { strength: 0.5, extent: 0.7 });
    const center = px(out, 20, 20)[0];
    const corner = px(out, 0, 0)[0];
    expect(center).toBe(200);
    expect(corner).toBeLessThan(center);
  });

  it("接触阴影压暗指定区域、不改远处", () => {
    const base = makeImage(60, 60, () => [220, 220, 220, 255]);
    const out = softShadow(base, { cx: 30, cy: 50, rx: 14, ry: 5, opacity: 0.6, blur: 4 });
    const under = px(out, 30, 50)[0];
    const far = px(out, 30, 5)[0];
    expect(under).toBeLessThan(far);
    expect(far).toBe(220);
  });
});

describe("bilinearResize / contentBounds", () => {
  it("纯色图缩放后颜色不变", () => {
    const base = makeImage(20, 10, () => [90, 120, 150, 255]);
    const out = bilinearResize(base, 37, 13);
    expect(out.width).toBe(37);
    expect(out.height).toBe(13);
    expect(px(out, 18, 6)).toEqual([90, 120, 150, 255]);
  });

  it("contentBounds 圈出不透明区域", () => {
    const img = makeImage(20, 20, (x, y) =>
      x >= 5 && x < 15 && y >= 6 && y < 12 ? [255, 255, 255, 255] : [0, 0, 0, 0],
    );
    expect(contentBounds(img)).toEqual({ x: 5, y: 6, width: 10, height: 6 });
  });
});
