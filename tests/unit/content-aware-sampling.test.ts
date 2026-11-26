import { describe, expect, it } from "vitest";
import {
  countMask,
  downsampleMasks,
  maskBounds,
  paintSamplingStrokes,
  restrictSampling,
  samplingWindow,
  windowSamplingMask,
  type SamplingStroke,
} from "../../src/core/contentAwareSampling";

function maskFrom(w: number, h: number, points: Array<[number, number]>): Uint8Array {
  const m = new Uint8Array(w * h);
  for (const [x, y] of points) m[y * w + x] = 1;
  return m;
}

describe("内容识别填充取样平面", () => {
  it("硬边圆刷按像素中心覆盖，四角不算命中", () => {
    const stroke: SamplingStroke = { add: true, size: 4, points: [[5, 5]] };
    const out = paintSamplingStrokes(new Uint8Array(10 * 10), 10, 10, [stroke]);
    // 半径 2：中心落在 (3.5..6.5)²，但对角 1.5²+1.5² > 2²，去掉四角。
    expect(countMask(out)).toBe(12);
    expect(out[5 * 10 + 5]).toBe(1);
    expect(out[3 * 10 + 3]).toBe(0);
    expect(out[4 * 10 + 4]).toBe(1);
  });

  it("快速拖动的线段不留断点", () => {
    const stroke: SamplingStroke = {
      add: true,
      size: 3,
      points: [[2, 5], [10, 5]],
    };
    const out = paintSamplingStrokes(new Uint8Array(12 * 12), 12, 12, [stroke]);
    // 刷心行 x=1..10 连续命中；上下两行各少两端，远端只有刷心行。
    for (let x = 2; x <= 10; x += 1) expect(out[5 * 12 + x]).toBe(1);
    expect(out[5 * 12 + 1]).toBe(1);
    expect(out[3 * 12 + 5]).toBe(1);
    expect(out[3 * 12 + 1]).toBe(0);
    expect(countMask(out)).toBe(36);
  });

  it("Subtract 只挖掉笔刷经过的像素，保留其余取样区", () => {
    const add: SamplingStroke = { add: true, size: 3, points: [[5, 5]] };
    const sub: SamplingStroke = { add: false, size: 1, points: [[5.5, 5.5]] };
    const base = paintSamplingStrokes(new Uint8Array(10 * 10), 10, 10, [add]);
    const out = paintSamplingStrokes(base, 10, 10, [sub]);
    expect(base[5 * 10 + 5]).toBe(1);
    expect(out[5 * 10 + 5]).toBe(0);
    expect(out[4 * 10 + 5]).toBe(1);
    expect(countMask(base)).toBe(countMask(out) + 1);
  });

  it("多笔按顺序重放，后笔可覆盖前笔", () => {
    const strokes: SamplingStroke[] = [
      { add: true, size: 3, points: [[4, 4]] },
      { add: false, size: 3, points: [[4, 4]] },
      { add: true, size: 1, points: [[4.5, 4.5]] },
    ];
    const out = paintSamplingStrokes(new Uint8Array(8 * 8), 8, 8, strokes);
    expect(countMask(out)).toBe(1);
    expect(out[4 * 8 + 4]).toBe(1);
  });

  it("自动取样窗口外扩并夹回画布", () => {
    const hole = maskFrom(20, 20, [
      [8, 8], [9, 8], [10, 8], [11, 8],
      [8, 9], [9, 9], [10, 9], [11, 9],
      [8, 10], [9, 10], [10, 10], [11, 10],
      [8, 11], [9, 11], [10, 11], [11, 11],
    ]);
    expect(maskBounds(hole, 20, 20)).toEqual({ x: 8, y: 8, width: 4, height: 4 });
    expect(samplingWindow(hole, 20, 20, 4)).toEqual({ x: 4, y: 4, width: 12, height: 12 });
    // 贴边的洞不能扩出画布。
    const edge = maskFrom(20, 20, [[0, 0]]);
    expect(samplingWindow(edge, 20, 20, 8)).toEqual({ x: 0, y: 0, width: 9, height: 9 });
    expect(samplingWindow(new Uint8Array(400), 20, 20)).toBeNull();
  });

  it("窗口掩码与洞取交后排除洞内像素", () => {
    const hole = maskFrom(8, 8, [[3, 3], [4, 3], [3, 4], [4, 4]]);
    const window = windowSamplingMask(8, 8, { x: 2, y: 2, width: 4, height: 4 });
    expect(countMask(window)).toBe(16);
    const usable = restrictSampling(window, hole);
    expect(countMask(usable)).toBe(12);
    expect(usable[3 * 8 + 3]).toBe(0);
    expect(usable[2 * 8 + 2]).toBe(1);
    expect(window[3 * 8 + 3]).toBe(1);
  });

  it("降采样时洞取并集、取样区取交集", () => {
    const hole = maskFrom(4, 4, [[1, 1]]);
    const sample = new Uint8Array(16).fill(1);
    sample[1 * 4 + 1] = 0;
    const small = downsampleMasks(hole, sample, 4, 4, 2, 2);
    expect(small.hole[0]).toBe(1);
    expect(small.hole[1]).toBe(0);
    // 左上 2×2 块里有一个 0，整块在粗层都不可取样。
    expect(small.sample[0]).toBe(0);
    expect(small.sample[3]).toBe(1);
  });
});
