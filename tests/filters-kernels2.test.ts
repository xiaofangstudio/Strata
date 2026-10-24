import { describe, expect, it } from "vitest";
import {
  emboss,
  findEdges,
  grain,
  halftone,
  oilPaint,
  patchwork,
  pinch,
  ripple,
  solarize,
  twirl,
  watercolor,
  wave,
  wind,
  type RgbaBuffer,
} from "../src/engine/filters/kernels";

function solid(w: number, h: number, r: number, g: number, b: number): RgbaBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}

function gradient(w: number, h: number): RgbaBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = (x * 255) / (w - 1);
      data[o + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

describe("扭曲内核", () => {
  it("twirl 角度为 0 时逐像素等于原图", () => {
    const src = gradient(8, 8);
    const out = twirl(src, 0, 100);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it("twirl 保持 alpha 不变", () => {
    const src = gradient(8, 8);
    const out = twirl(src, 200, 100);
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(255);
  });

  it("wave 幅度为 0 时等于原图", () => {
    const src = gradient(8, 8);
    expect(Array.from(wave(src, 0, 32).data)).toEqual(Array.from(src.data));
  });

  it("ripple 扰动为 0 时等于原图", () => {
    const src = gradient(8, 8);
    expect(Array.from(ripple(src, 0, 32).data)).toEqual(Array.from(src.data));
  });

  it("pinch 数量为 0 时等于原图", () => {
    const src = gradient(8, 8);
    expect(Array.from(pinch(src, 0).data)).toEqual(Array.from(src.data));
  });
});

describe("风格化内核", () => {
  it("findEdges 在平坦图上全白", () => {
    const out = findEdges(solid(6, 6, 100, 150, 200));
    for (let i = 0; i < out.data.length; i += 4) expect(out.data[i]).toBe(255);
  });

  it("findEdges 在垂直跳变处变暗", () => {
    const src = solid(8, 8, 0, 0, 0);
    for (let y = 0; y < 8; y += 1)
      for (let x = 4; x < 8; x += 1) {
        const o = (y * 8 + x) * 4;
        src.data[o] = src.data[o + 1] = src.data[o + 2] = 255;
      }
    const out = findEdges(src);
    const o = (4 * 8 + 4) * 4; // 跳变列
    expect(out.data[o]).toBeLessThan(200);
  });

  it("emboss 平坦图输出中灰", () => {
    const out = emboss(solid(6, 6, 128, 128, 128), 135, 3, 100);
    for (let i = 0; i < out.data.length; i += 4) expect(out.data[i]).toBe(128);
  });

  it("solarize 只反转超过中灰的通道", () => {
    const src = solid(2, 2, 200, 60, 255);
    const out = solarize(src);
    const o = 0;
    expect(out.data[o]).toBe(55); // 255-200
    expect(out.data[o + 1]).toBe(60); // 不变
    expect(out.data[o + 2]).toBe(0); // 255-255
  });

  it("wind 种子相同则结果可复现", () => {
    const src = gradient(8, 8);
    expect(Array.from(wind(src, 4).data)).toEqual(Array.from(wind(src, 4).data));
  });

  it("oilPaint 输出与输入同尺寸、alpha 保持", () => {
    const src = gradient(8, 8);
    const out = oilPaint(src, 2);
    expect(out.width).toBe(8);
    expect(out.height).toBe(8);
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(255);
  });
});

describe("纹理 / 素描 / 艺术效果内核", () => {
  it("grain 强度为 0 时等于原图，且种子可复现", () => {
    const src = gradient(8, 8);
    expect(Array.from(grain(src, 0).data)).toEqual(Array.from(src.data));
    expect(Array.from(grain(src, 20).data)).toEqual(Array.from(grain(src, 20).data));
  });

  it("patchwork 与 halftone 保持尺寸与 alpha", () => {
    const src = gradient(8, 8);
    for (const out of [patchwork(src, 4), halftone(src, 4), watercolor(src, 1)]) {
      expect(out.width).toBe(8);
      expect(out.height).toBe(8);
      for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(255);
    }
  });

  it("halftone 黑图格子中心为黑点、白图全白", () => {
    const black = halftone(solid(8, 8, 0, 0, 0), 8);
    expect(black.data[(4 * 8 + 4) * 4]).toBe(0);
    const white = halftone(solid(8, 8, 255, 255, 255), 8);
    for (let i = 0; i < white.data.length; i += 4) expect(white.data[i]).toBe(255);
  });
});
