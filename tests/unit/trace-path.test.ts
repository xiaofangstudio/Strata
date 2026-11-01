/**
 * Alpha 轮廓描迹（core/tracePath.ts）的契约。
 *
 * 全部用手工构造的小掩码验证：矩形要合并成 4 个角、带洞的环要出两个环、
 * 两块分离的图形要各自成环、阈值要真的按 Alpha 过滤。
 */
import { describe, expect, it } from "vitest";
import {
  loopsToSvg,
  loopsToSvgPath,
  traceAlphaLoops,
} from "../../src/core/tracePath";

/** 造一张 4×4 的 RGBA。alpha 列表按行填，缺省全透明。 */
function make(w: number, h: number, alphas: Record<number, number>): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (const [i, a] of Object.entries(alphas)) {
    data[Number(i) * 4 + 3] = a;
    data[Number(i) * 4] = 200;
    data[Number(i) * 4 + 1] = 30;
    data[Number(i) * 4 + 2] = 30;
  }
  return data;
}

describe("矩形轮廓", () => {
  it("2×2 实心块合并成 4 个角", () => {
    // 4×4，(1,1)(2,1)(1,2)(2,2) 不透明
    const data = make(4, 4, { 5: 255, 6: 255, 9: 255, 10: 255 });
    const loops = traceAlphaLoops(data, 4, 4);
    expect(loops.length).toBe(1);
    expect(loops[0].map((p) => [p.x, p.y])).toEqual([
      [1, 1],
      [3, 1],
      [3, 3],
      [1, 3],
    ]);
  });

  it("整幅对齐画布边界的实心块，角落在 (0,0)-(w,h)", () => {
    const data = make(2, 2, { 0: 255, 1: 255, 2: 255, 3: 255 });
    const loops = traceAlphaLoops(data, 2, 2);
    expect(loops.length).toBe(1);
    expect(loops[0].map((p) => [p.x, p.y]).sort()).toEqual([
      [0, 0],
      [0, 2],
      [2, 0],
      [2, 2],
    ]);
  });
});

describe("洞与多块", () => {
  it("3×3 环中心 1 像素洞：外环 + 内环各一", () => {
    // 5×5，(1..3, 1..3) 不透明但 (2,2) 透明（下标 12）
    const alphas: Record<number, number> = {};
    for (let y = 1; y <= 3; y += 1)
      for (let x = 1; x <= 3; x += 1) alphas[y * 5 + x] = 255;
    delete alphas[12];
    const data = make(5, 5, alphas);
    const loops = traceAlphaLoops(data, 5, 5);
    expect(loops.length).toBe(2);
    const sizes = loops.map((l) => l.length).sort((a, b) => a - b);
    // 外环 4 角，内环（1×1 的洞）也是 4 角
    expect(sizes).toEqual([4, 4]);
  });

  it("两块分离的图形各自成环", () => {
    const data = make(6, 2, { 0: 255, 5: 255 });
    const loops = traceAlphaLoops(data, 6, 2);
    expect(loops.length).toBe(2);
  });
});

describe("阈值", () => {
  it("Alpha 低于阈值不算不透明，调低阈值就回来了", () => {
    const data = make(3, 3, { 4: 100 });
    expect(traceAlphaLoops(data, 3, 3, 128).length).toBe(0);
    expect(traceAlphaLoops(data, 3, 3, 80).length).toBe(1);
  });
});

describe("SVG 输出", () => {
  it("path 的 d 以 M 开头 Z 结尾，evenodd 写进 fill-rule", () => {
    const data = make(4, 4, { 5: 255, 6: 255, 9: 255, 10: 255 });
    const loops = traceAlphaLoops(data, 4, 4);
    const d = loopsToSvgPath(loops);
    expect(d.startsWith("M1 1")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    const svg = loopsToSvg(loops, 4, 4);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('fill-rule="evenodd"');
  });
});
