/**
 * 油漆桶「连续 / 填所有相近色」的真值测试。
 *
 * 浏览器 Canvas 在 vitest 里没有真实像素，这里只替换 getImageData / putImageData
 * 两个方法，让 floodFill 跑在确定的 RGBA 数组上；断言落的是实际像素，不是调用记录。
 */
import { describe, expect, it } from "vitest";
import { floodFill } from "../../src/engine/paint";

type Pixel = [number, number, number, number];

function fakeCanvas(w: number, h: number, pixels: Pixel[]): {
  surface: HTMLCanvasElement;
  data: () => Uint8ClampedArray;
} {
  const img = {
    data: new Uint8ClampedArray(pixels.flat()),
    width: w,
    height: h,
  };
  const ctx = {
    getImageData: () => ({ data: new Uint8ClampedArray(img.data), width: w, height: h }),
    putImageData: (next: { data: Uint8ClampedArray }) => {
      img.data = new Uint8ClampedArray(next.data);
    },
  };
  return {
    surface: {
      width: w,
      height: h,
      getContext: (kind: string) => (kind === "2d" ? ctx : null),
    } as unknown as HTMLCanvasElement,
    data: () => img.data,
  };
}

function maskCanvas(w: number, h: number, alphas: number[]): HTMLCanvasElement {
  const data = new Uint8ClampedArray(w * h * 4);
  alphas.forEach((a, i) => {
    data[i * 4 + 3] = a;
  });
  return {
    width: w,
    height: h,
    getContext: (kind: string) =>
      kind === "2d"
        ? { getImageData: () => ({ data, width: w, height: h }), putImageData: () => {} }
        : null,
  } as unknown as HTMLCanvasElement;
}

const RED: Pixel = [255, 0, 0, 255];
const BLUE: Pixel = [0, 0, 255, 255];
const GREEN: Pixel = [0, 255, 0, 255];

function isGreen(data: Uint8ClampedArray, i: number): boolean {
  return data[i * 4] === GREEN[0] && data[i * 4 + 1] === GREEN[1] && data[i * 4 + 3] === 255;
}

describe("油漆桶填充范围", () => {
  it("连续模式只填与落点相连的一片，不跨过异色", () => {
    const c = fakeCanvas(4, 1, [RED, BLUE, RED, BLUE]);
    expect(floodFill(c.surface, 0, 0, "#00ff00", 0, null, true)).toBe(true);
    const d = c.data();
    expect(isGreen(d, 0)).toBe(true);
    expect(isGreen(d, 1)).toBe(false);
    expect(isGreen(d, 2)).toBe(false);
  });

  it("非连续模式一次填掉全图所有相近色", () => {
    const c = fakeCanvas(4, 1, [RED, BLUE, RED, BLUE]);
    expect(floodFill(c.surface, 0, 0, "#00ff00", 0, null, false)).toBe(true);
    const d = c.data();
    expect(isGreen(d, 0)).toBe(true);
    expect(isGreen(d, 1)).toBe(false);
    expect(isGreen(d, 2)).toBe(true);
    expect(isGreen(d, 3)).toBe(false);
  });

  it("非连续模式仍受选区 / Alpha 锁定遮罩限制", () => {
    const c = fakeCanvas(4, 1, [RED, BLUE, RED, BLUE]);
    const mask = maskCanvas(4, 1, [255, 0, 0, 0]);
    expect(floodFill(c.surface, 0, 0, "#00ff00", 0, mask, false)).toBe(true);
    const d = c.data();
    expect(isGreen(d, 0)).toBe(true);
    expect(isGreen(d, 2)).toBe(false);
  });
});
