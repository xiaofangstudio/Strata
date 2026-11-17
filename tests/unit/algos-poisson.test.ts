/**
 * Poisson / 调和插值内核回归测试。
 */
import { describe, expect, it } from "vitest";
import {
  membraneFill,
  membraneFillRgba,
  seamlessClone,
  solveMembrane,
} from "../../src/engine/algos/poisson";
import { makeBuffer } from "../../src/engine/filters/kernels";

describe("Poisson 调和求解", () => {
  it("一维 Dirichlet 边界解出单调插值", () => {
    const w = 5;
    const h = 1;
    const unknown = new Uint8Array([0, 1, 1, 1, 0]);
    const v = new Float32Array([0, 0, 0, 0, 1]);
    solveMembrane(w, h, unknown, v);
    expect(v[0]).toBe(0);
    expect(v[4]).toBe(1);
    expect(v[1]).toBeGreaterThan(v[0]);
    expect(v[2]).toBeGreaterThan(v[1]);
    expect(v[3]).toBeGreaterThan(v[2]);
    expect(v[3]).toBeLessThan(v[4]);
  });

  it("没有已知像素时保持输入，不崩不 NaN", () => {
    const unknown = new Uint8Array(9).fill(1);
    const v = new Float32Array(9).fill(0.37);
    solveMembrane(3, 3, unknown, v);
    expect(Array.from(v)).toEqual(Array.from(new Float32Array(9).fill(0.37)));
  });

  it("尺寸不匹配时明确报错", () => {
    expect(() => solveMembrane(4, 4, new Uint8Array(8), new Float32Array(16))).toThrow();
  });
});

describe("seamlessClone 无缝克隆", () => {
  it("mask 外逐值等于 dst，mask 内保留 src 纹理并贴合边界亮度", () => {
    const w = 32;
    const h = 32;
    const ch = 1;
    const dst = new Float32Array(w * h);
    const src = new Float32Array(w * h);
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        dst[i] = 0.2 + (y / (h - 1)) * 0.2; // 目标里是一条缓慢变化的灰带
        src[i] = (x + y) % 2 === 0 ? 0.15 : 0.85; // 源是棋盘纹理
        if (x >= 12 && x < 20 && y >= 12 && y < 20) mask[i] = 1;
      }
    }
    const out = seamlessClone(w, h, ch, src, dst, mask);
    for (let i = 0; i < w * h; i += 1) {
      if (!mask[i]) expect(out[i]).toBeCloseTo(dst[i], 5);
    }
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < w * h; i += 1) {
      if (!mask[i]) continue;
      lo = Math.min(lo, out[i]);
      hi = Math.max(hi, out[i]);
    }
    expect(hi - lo).toBeGreaterThan(0.3); // 纹理没被抹平
    expect((lo + hi) / 2).toBeGreaterThan(0.25); // 亮度被拉向目标
    expect((lo + hi) / 2).toBeLessThan(0.55);
  });
});

describe("membraneFill / RGBA 包装", () => {
  it("把边界颜色调和插值进洞，洞外不动", () => {
    const w = 16;
    const h = 16;
    const img = new Float32Array(w * h);
    const hole = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) img[y * w + x] = x / (w - 1);
    }
    for (let y = 5; y < 11; y += 1) {
      for (let x = 5; x < 11; x += 1) hole[y * w + x] = 1;
    }
    const out = membraneFill(w, h, 1, img, hole);
    for (let i = 0; i < w * h; i += 1) {
      if (!hole[i]) expect(out[i]).toBeCloseTo(img[i], 5);
    }
    const center = out[8 * w + 8];
    expect(center).toBeGreaterThan(0.2);
    expect(center).toBeLessThan(0.8);
  });

  it("RGBA 包装只改洞内，alpha 也按边界插值", () => {
    const src = makeBuffer(16, 16);
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        const p = (y * 16 + x) * 4;
        src.data[p] = x < 8 ? 0 : 255;
        src.data[p + 1] = 0;
        src.data[p + 2] = 0;
        src.data[p + 3] = x < 8 ? 0 : 255;
      }
    }
    const hole = new Uint8Array(16 * 16);
    for (let y = 6; y < 10; y += 1) {
      for (let x = 6; x < 10; x += 1) hole[y * 16 + x] = 1;
    }
    const out = membraneFillRgba(src, hole);
    const insideAlpha = out.data[(8 * 16 + 8) * 4 + 3];
    expect(insideAlpha).toBeGreaterThan(0);
    expect(insideAlpha).toBeLessThan(255);
    expect(out.data[0]).toBe(src.data[0]);
    expect(out.data[3]).toBe(src.data[3]);
  });
});
