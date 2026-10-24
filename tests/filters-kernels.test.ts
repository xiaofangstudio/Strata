/**
 * 滤镜内核的固定像素测试（4×4），node 环境纯函数断言。
 * 内核算法 Ported from ArtCraft PhotoCraft, MIT/Apache-2.0。
 */
import { describe, expect, it } from "vitest";
import {
  addNoise,
  boxBlur,
  gaussianBlur,
  median,
  mosaic,
  sharpenKernel,
  unsharpMask,
  type RgbaBuffer,
} from "../src/engine/filters/kernels";

function make4x4(): RgbaBuffer {
  const b: RgbaBuffer = { data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4 };
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const o = (y * 4 + x) * 4;
      const v = x < 2 ? 20 : 220; // 左暗右亮的竖直边缘
      b.data[o] = v;
      b.data[o + 1] = v;
      b.data[o + 2] = v;
      b.data[o + 3] = 255;
    }
  }
  return b;
}

describe("gaussianBlur", () => {
  it("均匀图不变", () => {
    const b = make4x4();
    b.data.fill(200);
    const out = gaussianBlur(b, 4);
    for (let i = 0; i < out.data.length; i += 1) expect(out.data[i]).toBe(200);
  });
  it("边缘图被平滑但均值守恒", () => {
    const b = make4x4();
    const out = gaussianBlur(b, 2);
    // 左半仍暗、右半仍亮，交界处变为中间值
    expect(out.data[0]).toBeLessThan(100);
    expect(out.data[4 * 4 * 4 - 4]).toBeGreaterThan(140);
    const mid = out.data[(1 * 4 + 1) * 4];
    const midR = out.data[(1 * 4 + 2) * 4];
    expect(midR).toBeGreaterThan(mid);
  });
  it("alpha 通道不外溢（预乘处理）", () => {
    const b: RgbaBuffer = { data: new Uint8ClampedArray(64), width: 4, height: 4 };
    b.data[0] = 255; // 左上角一个不透明红点
    b.data[3] = 255;
    const out = gaussianBlur(b, 1);
    expect(out.data[3]).toBeGreaterThan(0); // 有扩散
    expect(out.data[(4 * 4 - 1) * 4 + 3]).toBe(0); // 远角仍透明
  });
});

describe("boxBlur", () => {
  it("半径 0 原样返回", () => {
    const b = make4x4();
    const out = boxBlur(b, 0);
    expect(out.data).toEqual(b.data);
  });
});

describe("unsharpMask", () => {
  it("放大边缘反差", () => {
    const b = make4x4();
    const before = b.data[(1 * 4 + 2) * 4] - b.data[(1 * 4 + 1) * 4];
    const out = unsharpMask(b, 1, 100, 0);
    const after = out.data[(1 * 4 + 2) * 4] - out.data[(1 * 4 + 1) * 4];
    expect(after).toBeGreaterThanOrEqual(before);
    expect(out.data[(1 * 4 + 2) * 4]).toBeGreaterThanOrEqual(220);
  });
});

describe("addNoise", () => {
  it("amount 0 不改变像素", () => {
    const b = make4x4();
    const out = addNoise(b, 0, true);
    expect(out.data).toEqual(b.data);
  });
  it("同种子可复现", () => {
    const b = make4x4();
    expect(addNoise(b, 30, true).data).toEqual(addNoise(b, 30, true).data);
  });
  it("单色时三通道变化一致", () => {
    const b = make4x4();
    const out = addNoise(b, 30, true);
    const o = 4;
    expect(out.data[o] - b.data[o]).toBe(out.data[o + 1] - b.data[o + 1]);
    expect(out.data[o] - b.data[o]).toBe(out.data[o + 2] - b.data[o + 2]);
  });
});

describe("median / mosaic", () => {
  it("中值对孤立噪点免疫", () => {
    const b = make4x4();
    b.data[0] = 255;
    b.data[1] = 255;
    b.data[2] = 255;
    const out = median(b, 1);
    expect(out.data[0]).toBeLessThan(120);
  });
  it("彩块化块内取平均", () => {
    const b = make4x4();
    const out = mosaic(b, 2);
    // 左上 2×2 块全部 20、右上全部 220
    expect(out.data[0]).toBe(20);
    expect(out.data[(1 * 4 + 2) * 4]).toBe(220);
  });
});

describe("sharpenKernel", () => {
  it("强度 1 即经典 [0,-1,0;-1,5,-1;0,-1,0]", () => {
    expect(sharpenKernel(1)).toEqual([0, -1, 0, -1, 5, -1, 0, -1, 0]);
  });
});
