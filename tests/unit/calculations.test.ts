import { describe, expect, it } from "vitest";
import {
  CALC_BLENDS,
  DEFAULT_CALC_PARAMS,
  blendCalcChannels,
  resultToImage,
  resultToMask,
  sampleCalcChannel,
} from "../../src/core/calculations";

const px = (r: number, g: number, b: number, a = 255) =>
  new Uint8ClampedArray([r, g, b, a]);

describe("图像计算（移植自 PhotoCraft Calculations）", () => {
  it("可以取任意原色 / 灰度 / 透明度通道", () => {
    const src = new Uint8ClampedArray([...px(255, 0, 0), ...px(0, 128, 255, 64)]);
    expect(Array.from(sampleCalcChannel(src, "red"))).toEqual([255, 0]);
    expect(Array.from(sampleCalcChannel(src, "green"))).toEqual([0, 128]);
    expect(Array.from(sampleCalcChannel(src, "blue"))).toEqual([0, 255]);
    expect(Array.from(sampleCalcChannel(src, "alpha"))).toEqual([255, 64]);
    expect(Array.from(sampleCalcChannel(src, "alpha:custom"))).toEqual([255, 64]);
    expect(sampleCalcChannel(src, "gray")[0]).toBeCloseTo(76, 0);
  });

  it("混合模式：红 × 绿 = 黑，绿 0 与红 1 滤色 = 白", () => {
    const red = new Uint8ClampedArray([255]);
    const green = new Uint8ClampedArray([0]);
    const p = { ...DEFAULT_CALC_PARAMS };
    expect(blendCalcChannels(red, green, { ...p, blend: "multiply" })[0]).toBe(0);
    expect(blendCalcChannels(green, red, { ...p, blend: "screen" })[0]).toBe(255);
    expect(blendCalcChannels(red, green, { ...p, blend: "add" })[0]).toBe(255);
    expect(blendCalcChannels(red, green, { ...p, blend: "subtract" })[0]).toBe(255);
    expect(blendCalcChannels(red, green, { ...p, blend: "difference" })[0]).toBe(255);
    expect(CALC_BLENDS).toHaveLength(6);
  });

  it("50% 不透明度落在两来源中间，反相 / scale / offset 都生效", () => {
    const p = { ...DEFAULT_CALC_PARAMS };
    const half = blendCalcChannels(new Uint8ClampedArray([0]), new Uint8ClampedArray([255]), {
      ...p,
      blend: "screen",
      opacity: 50,
    });
    expect(half[0]).toBe(128);
    const gray = new Uint8ClampedArray([100]);
    expect(blendCalcChannels(gray, gray, { ...p, blend: "normal", invert2: true })[0]).toBe(155);
    expect(blendCalcChannels(gray, gray, { ...p, blend: "normal", invertResult: true })[0]).toBe(155);
    expect(blendCalcChannels(gray, gray, { ...p, blend: "normal", invert2: true, invertResult: true })[0]).toBe(100);
    expect(blendCalcChannels(gray, gray, { ...p, blend: "normal", offset: 20 })[0]).toBe(120);
    expect(blendCalcChannels(new Uint8ClampedArray([200]), new Uint8ClampedArray([200]), {
      ...p,
      blend: "multiply",
      scale: 2,
    })[0]).toBe(255);
  });

  it("结果既能当灰度图显示，也能当选区遮罩", () => {
    const v = new Uint8ClampedArray([0, 128, 255]);
    expect(Array.from(resultToImage(v).slice(0, 8))).toEqual([0, 0, 0, 255, 128, 128, 128, 255]);
    expect(Array.from(resultToMask(v).slice(0, 8))).toEqual([255, 255, 255, 0, 255, 255, 255, 128]);
  });
});
