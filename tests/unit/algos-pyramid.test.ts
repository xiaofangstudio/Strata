/**
 * 拉普拉斯金字塔融合回归测试。
 */
import { describe, expect, it } from "vitest";
import {
  autoLevels,
  collapsePyramid,
  fuseStackPyramid,
  laplacianPyramid,
  reducePlane,
  expandPlane,
  type Plane,
} from "../../src/engine/algos/pyramid";
import { makeBuffer } from "../../src/engine/filters/kernels";

function energy(img: { data: Uint8ClampedArray; width: number; height: number }): number {
  const { width: w, height: h, data } = img;
  const lum = (x: number, y: number) => {
    const p = (y * w + x) * 4;
    return 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  };
  let sum = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      sum += Math.abs(4 * lum(x, y) - lum(x - 1, y) - lum(x + 1, y) - lum(x, y - 1) - lum(x, y + 1));
      count += 1;
    }
  }
  return sum / Math.max(1, count);
}

describe("拉普拉斯金字塔", () => {
  it("autoLevels 在短边 <=8 停止", () => {
    expect(autoLevels(64, 64)).toBe(4);
    expect(autoLevels(8, 8)).toBe(1);
    expect(autoLevels(16, 32)).toBe(2);
  });

  it("reduce/expand 之后 collapse 精确还原", () => {
    const w = 16;
    const h = 16;
    const data = new Float32Array(w * h);
    for (let i = 0; i < data.length; i += 1) data[i] = (i * 37) % 251;
    const src: Plane = { data, width: w, height: h };
    const levels = autoLevels(w, h);
    const out = collapsePyramid(laplacianPyramid(src, levels));
    expect(out.width).toBe(w);
    for (let i = 0; i < data.length; i += 1) expect(out.data[i]).toBeCloseTo(data[i], 3);
  });

  it("奇数尺寸不越界", () => {
    const data = new Float32Array(15 * 13).fill(33);
    const small = reducePlane({ data, width: 15, height: 13 });
    expect(small.width).toBe(8);
    expect(small.height).toBe(7);
    const back = expandPlane(small, 15, 13);
    expect(back.data.length).toBe(15 * 13);
  });
});

describe("焦堆栈融合", () => {
  it("相同图融合等于原图", () => {
    const w = 32;
    const h = 32;
    const a = makeBuffer(w, h);
    for (let p = 0; p < w * h; p += 1) {
      a.data[p * 4] = (p * 13) % 256;
      a.data[p * 4 + 1] = (p * 29) % 256;
      a.data[p * 4 + 2] = (p * 7) % 256;
      a.data[p * 4 + 3] = 255;
    }
    const b = makeBuffer(w, h);
    b.data.set(a.data);
    const out = fuseStackPyramid([a, b]);
    for (let i = 0; i < a.data.length; i += 1) {
      if (i % 4 === 3) continue;
      expect(Math.abs(out.data[i] - a.data[i])).toBeLessThanOrEqual(1);
    }
  });

  it("两张互补焦面融合后两侧都变清晰", () => {
    const w = 64;
    const h = 64;
    const make = (sharpLeft: boolean) => {
      const img = makeBuffer(w, h);
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const p = (y * w + x) * 4;
          const sharp = sharpLeft ? x < w / 2 : x >= w / 2;
          const stripe = Math.floor(x / 3) % 2 === 0;
          const v = sharp && stripe ? 240 : sharp ? 20 : 120;
          img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
          img.data[p + 3] = 255;
        }
      }
      return img;
    };
    const left = make(true);
    const right = make(false);
    const fused = fuseStackPyramid([left, right], { halo: 1 });
    const crop = (img: typeof fused, x0: number, x1: number) => {
      const sub = makeBuffer(x1 - x0, h);
      for (let y = 0; y < h; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const s = (y * w + x) * 4;
          const d = (y * (x1 - x0) + (x - x0)) * 4;
          sub.data.set(img.data.subarray(s, s + 4), d);
        }
      }
      return sub;
    };
    // 左半边只有 left 图清晰、右半边只有 right 图清晰：
    // 融合结果在两侧都应远高于「另一张模糊图」的局部能量。
    const leftBlurred = energy(crop(right, 2, 30));
    const rightBlurred = energy(crop(left, 34, 62));
    const leftAfter = energy(crop(fused, 2, 30));
    const rightAfter = energy(crop(fused, 34, 62));
    expect(leftBlurred).toBeLessThan(5);
    expect(rightBlurred).toBeLessThan(5);
    expect(leftAfter).toBeGreaterThan(100);
    expect(rightAfter).toBeGreaterThan(100);
  });

  it("尺寸不一致会明确报错", () => {
    expect(() => fuseStackPyramid([makeBuffer(8, 8), makeBuffer(9, 8)])).toThrow(/size mismatch/);
  });
});
