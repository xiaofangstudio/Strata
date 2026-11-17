/**
 * 多尺度内容识别填充增强回归测试。
 */
import { describe, expect, it } from "vitest";
import {
  bestOffset,
  completeInpaint,
  erodeMask,
  holeThickness,
} from "../../src/engine/algos/inpaintComplete";
import { rectMask } from "../../src/engine/inpaint";
import { createRaster, type Raster } from "../../src/engine/raster";

function stripes(w: number, h: number): Raster {
  const r = createRaster(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const v = x % 8 < 4 ? 40 : 220;
      r.data[i] = r.data[i + 1] = r.data[i + 2] = v;
      r.data[i + 3] = 255;
    }
  }
  return r;
}

function punch(r: Raster, rect: { x: number; y: number; width: number; height: number }): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const o = (y * r.width + x) * 4;
      r.data[o] = 255;
      r.data[o + 1] = 0;
      r.data[o + 2] = 255;
      r.data[o + 3] = 255;
    }
  }
}

describe("洞的几何分析", () => {
  it("细长划痕厚度小，大洞厚度大", () => {
    const w = 32;
    const h = 32;
    const thin = new Uint8Array(w * h);
    for (let y = 4; y < 28; y += 1) thin[y * w + 16] = 1;
    const thick = rectMask(w, h, { x: 10, y: 10, width: 12, height: 12 });
    expect(holeThickness(thin, w, h)).toBeLessThanOrEqual(3);
    expect(holeThickness(thick, w, h)).toBeGreaterThan(8);
  });

  it("腐蚀会把洞逐圈缩小", () => {
    const m = rectMask(16, 16, { x: 4, y: 4, width: 8, height: 8 });
    const inner = erodeMask(m, 16, 16, 1);
    expect(inner.reduce((a, b) => a + b, 0)).toBeLessThan(m.reduce((a, b) => a + b, 0));
    expect(inner[8 * 16 + 8]).toBe(1);
  });

  it("bestOffset 能找到条纹周期对应的源位移", () => {
    const w = 48;
    const h = 24;
    const img = stripes(w, h);
    punch(img, { x: 20, y: 4, width: 8, height: 16 });
    const mask = rectMask(w, h, { x: 20, y: 4, width: 8, height: 16 });
    const best = bestOffset(img, mask, 24);
    expect(Number.isFinite(best.score)).toBe(true);
    // 条纹周期 8，最优位移应当接近周期的整数倍
    expect(Math.abs(best.dx) % 8 === 0 || Math.abs(best.dx) % 8 >= 6).toBe(true);
  });
});

describe("多尺度内容识别填充", () => {
  const HOLE = { x: 12, y: 14, width: 8, height: 4 };

  it("洞被填上真实纹理，不再是品红", () => {
    const src = stripes(32, 32);
    punch(src, HOLE);
    const out = completeInpaint(src, rectMask(32, 32, HOLE), { seed: 7, iterations: 3 });
    for (let y = HOLE.y; y < HOLE.y + HOLE.height; y += 1) {
      for (let x = HOLE.x; x < HOLE.x + HOLE.width; x += 1) {
        const o = (y * 32 + x) * 4;
        expect(out.data[o + 1]).toBe(out.data[o]); // 借来的是灰纹，三通道应相同
        expect(out.data[o]).toBeGreaterThanOrEqual(40);
        expect(out.data[o]).toBeLessThanOrEqual(220);
      }
    }
  });

  it("细长划痕.fill 后不残留原物体颜色", () => {
    const w = 48;
    const h = 48;
    const src = stripes(w, h);
    const scratch = new Uint8Array(w * h);
    for (let y = 4; y < 44; y += 1) {
      const x = 24;
      scratch[y * w + x] = 1;
      const o = (y * w + x) * 4;
      src.data[o] = 255;
      src.data[o + 1] = 0;
      src.data[o + 2] = 255;
    }
    const out = completeInpaint(src, scratch, { seed: 11, iterations: 3 });
    for (let y = 4; y < 44; y += 1) {
      const o = (y * w + 24) * 4;
      expect(out.data[o + 1]).toBe(out.data[o]);
      expect(out.data[o]).toBeLessThanOrEqual(220);
    }
  });

  it("固定种子可复现，且原图与洞外像素不动", () => {
    const a = stripes(32, 32);
    punch(a, HOLE);
    const b = stripes(32, 32);
    punch(b, HOLE);
    const mask = rectMask(32, 32, HOLE);
    const before = Array.from(a.data);
    const oa = completeInpaint(a, mask, { seed: 99, iterations: 3 });
    const ob = completeInpaint(b, mask, { seed: 99, iterations: 3 });
    expect(Array.from(oa.data)).toEqual(Array.from(ob.data));
    expect(Array.from(a.data)).toEqual(before);
    for (let i = 0; i < mask.length; i += 1) {
      if (mask[i]) continue;
      expect(Array.from(oa.data.slice(i * 4, i * 4 + 4))).toEqual(before.slice(i * 4, i * 4 + 4));
    }
  });

  it("空掩膜 / 全掩膜不崩", () => {
    const src = stripes(32, 32);
    expect(completeInpaint(src, new Uint8Array(32 * 32)).data.length).toBe(32 * 32 * 4);
    const full = completeInpaint(src, new Uint8Array(32 * 32).fill(1));
    expect(full.data.length).toBe(32 * 32 * 4);
  });
});
