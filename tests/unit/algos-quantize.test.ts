/**
 * Lab 量化 / 抖动回归测试。
 */
import { describe, expect, it } from "vitest";
import {
  buildPalette,
  labToRgb,
  quantizeRgba,
  rgbToLab,
  webSafePalette,
} from "../../src/engine/algos/quantize";
import { makeBuffer } from "../../src/engine/filters/kernels";
import { toIndexed } from "../../src/core/colorMode";

function bands(): ReturnType<typeof makeBuffer> {
  const w = 48;
  const h = 48;
  const img = makeBuffer(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = (y * w + x) * 4;
      const v = x < 16 ? [220, 30, 30] : x < 32 ? [30, 210, 60] : [40, 60, 220];
      img.data[p] = v[0];
      img.data[p + 1] = v[1];
      img.data[p + 2] = v[2];
      img.data[p + 3] = 255;
    }
  }
  return img;
}

function gradient(): ReturnType<typeof makeBuffer> {
  const w = 64;
  const h = 16;
  const img = makeBuffer(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = (y * w + x) * 4;
      const v = Math.round((x / (w - 1)) * 255);
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
      img.data[p + 3] = 255;
    }
  }
  return img;
}

describe("sRGB / Lab", () => {
  it("黑白红往返误差很小", () => {
    for (const c of [[0, 0, 0], [255, 255, 255], [220, 30, 30]] as const) {
      const lab = rgbToLab(c[0], c[1], c[2]);
      const back = labToRgb(lab[0], lab[1], lab[2]);
      for (let i = 0; i < 3; i += 1) expect(Math.abs(back[i] - c[i])).toBeLessThanOrEqual(2);
    }
  });
});

describe("调色板", () => {
  it("Web-safe 恰好 216 色且只含 6 级值", () => {
    const pal = webSafePalette(216);
    expect(pal.length).toBe(216);
    const levels = new Set([0, 51, 102, 153, 204, 255]);
    for (const c of pal) for (const v of c) expect(levels.has(v)).toBe(true);
  });

  it("三种色带图 perceptual / adaptive 都能提出三色", () => {
    const img = bands();
    for (const kind of ["perceptual", "adaptive"] as const) {
      const pal = buildPalette(img, kind, 3);
      expect(pal.length).toBe(3);
      for (const c of pal) expect(c.every(Number.isFinite)).toBe(true);
    }
  });

  it("exact 只取真实出现过的颜色", () => {
    const pal = buildPalette(bands(), "exact", 8);
    expect(pal.length).toBe(3);
    expect(pal.some((c) => c[0] > 200 && c[1] < 60)).toBe(true);
  });

  it("forced 色排在最前", () => {
    const pal = buildPalette(bands(), "perceptual", 4, [[255, 0, 255]]);
    expect(pal[0]).toEqual([255, 0, 255]);
  });
});

describe("量化与抖动", () => {
  it("输出颜色只来自调色板，透明像素保持透明", () => {
    const img = bands();
    img.data[3] = 0;
    const pal = buildPalette(img, "perceptual", 4);
    const { buf, indices } = quantizeRgba(img, pal, { dither: "diffusion" });
    expect(indices.length).toBe(img.width * img.height);
    expect(buf.data[3]).toBe(0);
    for (let p = 0; p < indices.length; p += 1) {
      if (buf.data[p * 4 + 3] < 8) continue;
      expect(buf.data[p * 4]).toBe(pal[indices[p]][0]);
    }
  });

  it("渐变图用误差扩散打散色带（相邻跳变显著增多）", () => {
    const img = gradient();
    const pal = buildPalette(img, "perceptual", 4);
    const transitions = (dither: "none" | "diffusion") => {
      const out = quantizeRgba(img, pal, { dither }).buf;
      let n = 0;
      for (let x = 1; x < img.width; x += 1) {
        if (out.data[x * 4] !== out.data[(x - 1) * 4]) n += 1;
      }
      return n;
    };
    expect(transitions("none")).toBeLessThanOrEqual(4);
    expect(transitions("diffusion")).toBeGreaterThan(10);
  });

  it("图案/噪声抖动与旧布尔接口都可用", () => {
    const img = gradient();
    for (const dither of ["pattern", "noise", "diffusion"] as const) {
      const out = quantizeRgba(img, buildPalette(img, "web", 8), { dither }).buf;
      expect(out.data.length).toBe(img.data.length);
    }
    const legacy = toIndexed(img, 8, true);
    expect(legacy.palette.length).toBeGreaterThan(0);
    const plain = toIndexed(img, 8, false, { paletteKind: "web" });
    expect(plain.palette.length).toBe(8);
  });
});
