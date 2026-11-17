/**
 * Select and Mask / matting 内核回归测试。
 */
import { describe, expect, it } from "vitest";
import { refineMask, type MattingParams } from "../../src/engine/algos/matting";
import { makeBuffer } from "../../src/engine/filters/kernels";

function image(w: number, h: number): ReturnType<typeof makeBuffer> {
  const b = makeBuffer(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = (y * w + x) * 4;
      const v = x < w / 2 ? 30 : 220;
      b.data[p] = b.data[p + 1] = b.data[p + 2] = v;
      b.data[p + 3] = 255;
    }
  }
  return b;
}

function hardMask(w: number, h: number): Float32Array {
  const a = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w / 2; x += 1) a[y * w + x] = 1;
  }
  return a;
}

const params = (p: Partial<MattingParams> = {}): MattingParams => ({
  radius: 0,
  smooth: 0,
  feather: 0,
  contrast: 0,
  shiftEdge: 0,
  ...p,
});

describe("matting 抠图精修", () => {
  it("中性参数逐值恒等", () => {
    const img = image(16, 16);
    const a = hardMask(16, 16);
    const out = refineMask(img, a, params());
    expect(Array.from(out)).toEqual(Array.from(a));
  });

  it("radius>0 时图像边缘附近出现软边，远离边缘仍保持 0/1", () => {
    const img = image(32, 32);
    const a = hardMask(32, 32);
    const out = refineMask(img, a, params({ radius: 4 }));
    const at = (x: number, y: number) => out[y * 32 + x];
    expect(at(4, 16)).toBe(1);
    expect(at(28, 16)).toBe(0);
    expect(at(15, 16)).toBeLessThan(1);
    expect(at(15, 16)).toBeGreaterThan(0);
  });

  it("Shift Edge 正向扩大半透明边，负向收缩", () => {
    const img = image(24, 24);
    const a = new Float32Array(24 * 24).fill(0.5);
    const pos = refineMask(img, a, params({ shiftEdge: 100 }));
    const neg = refineMask(img, a, params({ shiftEdge: -100 }));
    expect(pos[0]).toBeGreaterThan(0.9);
    expect(neg[0]).toBeLessThan(0.1);
  });

  it("Contrast 把半透明推向两端，不改变全选/全不选", () => {
    const img = image(16, 16);
    const a = new Float32Array(16 * 16);
    a[0] = 0.5;
    a[1] = 1;
    a[2] = 0;
    const out = refineMask(img, a, params({ contrast: 100 }));
    expect(out[0]).toBeCloseTo(0.5, 5);
    expect(out[1]).toBe(1);
    expect(out[2]).toBe(0);
  });
});
