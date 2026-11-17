/**
 * Camera Raw 纯函数段落回归测试。
 * 覆盖单调曲线 LUT、8 色带 HSL mixer、后期暗角，
 * 以及 applyCameraRaw 全链路的中性恒等与新增参数落点。
 *
 * Ported 段落来自 PhotoCraft camera_raw.rs（MIT / Apache-2.0）。
 */
import { describe, expect, it } from "vitest";
import {
  applyHslMixer,
  applyToneCurve,
  applyVignette,
  curveLut,
  lutEval,
  presetCurveLut,
  presetMixer,
} from "../../src/engine/algos/cameraRaw";
import { makeBuffer } from "../../src/engine/filters/kernels";
import { applyPixelAdjust } from "../../src/engine/adjustPixels";
import type { AdjustState } from "../../src/core/layer";

function solid(r: number, g: number, b: number, w = 32, h = 32) {
  const img = makeBuffer(w, h);
  for (let i = 0; i < w * h; i += 1) {
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  return img;
}

type Buf = ReturnType<typeof makeBuffer>;

describe("curveLut / lutEval", () => {
  it("预设 0 是恒等曲线", () => {
    const lut = presetCurveLut(0);
    for (let i = 0; i < 256; i += 1) expect(lut[i]).toBeCloseTo(i / 255, 3);
  });

  it("单调三次曲线不减、端点固定、强 S 中段正确", () => {
    const lut = presetCurveLut(2);
    expect(lut[0]).toBeCloseTo(0, 3);
    expect(lut[255]).toBeCloseTo(1, 3);
    for (let i = 1; i < 256; i += 1) {
      expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1] - 1e-6);
    }
    expect(lut[64]).toBeLessThan(64 / 255);
    expect(lut[192]).toBeGreaterThan(192 / 255);
  });

  it("乱序重复控制点也产出单调 LUT", () => {
    const lut = curveLut([[255, 255], [0, 0], [128, 128], [0, 0]]);
    expect(lut[0]).toBeCloseTo(0, 3);
    expect(lut[255]).toBeCloseTo(1, 3);
    for (let i = 1; i < 256; i += 1) {
      expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1] - 1e-6);
    }
  });

  it("lutEval 区间内插值，越界线性延展", () => {
    const lut = new Float32Array([0, 0.5, 1]);
    expect(lutEval(lut, 0.25)).toBeCloseTo(0.25, 3);
    expect(lutEval(lut, -0.5)).toBeCloseTo(-0.5, 3);
    expect(lutEval(lut, 1.5)).toBeCloseTo(1.5, 3);
  });

  it("applyToneCurve 恒等 LUT 不改像素、不动 alpha", () => {
    const img = solid(120, 40, 200);
    const before = new Uint8ClampedArray(img.data);
    applyToneCurve(img, presetCurveLut(0));
    expect(Array.from(img.data)).toEqual(Array.from(before));
  });
});

describe("applyHslMixer", () => {
  it("中性预设完全不改像素", () => {
    const img = solid(210, 60, 30);
    const before = new Uint8ClampedArray(img.data);
    const m = presetMixer(0);
    applyHslMixer(img.data, m.hue, m.sat, m.lum);
    expect(Array.from(img.data)).toEqual(Array.from(before));
  });

  it("暖橙预设让饱和红发生可见变化，alpha 保持", () => {
    const img = solid(220, 40, 20);
    const before = new Uint8ClampedArray(img.data);
    const m = presetMixer(1);
    applyHslMixer(img.data, m.hue, m.sat, m.lum);
    let changed = 0;
    for (let i = 0; i < before.length; i += 4) {
      if (before[i + 1] !== img.data[i + 1]) changed += 1;
    }
    expect(changed).toBeGreaterThan(0);
    expect(img.data[3]).toBe(255);
  });

  it("灰像素（饱和度为 0）不被 mixer 改动", () => {
    const img = solid(128, 128, 128);
    const before = new Uint8ClampedArray(img.data);
    const m = presetMixer(3);
    applyHslMixer(img.data, m.hue, m.sat, m.lum);
    expect(Array.from(img.data)).toEqual(Array.from(before));
  });
});

describe("applyVignette", () => {
  it("amount=0 完全不改像素", () => {
    const img = solid(100, 100, 100);
    const before = new Uint8ClampedArray(img.data);
    applyVignette(img, { amount: 0, midpoint: 50, highlights: 20 });
    expect(Array.from(img.data)).toEqual(Array.from(before));
  });

  it("正 amount 压暗四角、中心不变，alpha 不变", () => {
    const img = solid(200, 200, 200, 64, 64);
    applyVignette(img, { amount: 100, midpoint: 50 });
    const center = (32 * 64 + 32) * 4;
    const corner = 0;
    expect(img.data[center]).toBeGreaterThan(190);
    expect(img.data[corner]).toBeLessThan(120);
    expect(img.data[corner + 3]).toBe(255);
  });

  it("负 amount 提亮四角，方向与正相反", () => {
    const dark = solid(60, 60, 60, 64, 64);
    applyVignette(dark, { amount: -100, midpoint: 50 });
    expect(dark.data[0]).toBeGreaterThan(70);
    const bright = solid(60, 60, 60, 64, 64);
    applyVignette(bright, { amount: 100, midpoint: 50 });
    expect(bright.data[0]).toBeLessThan(60);
  });
});

describe("applyCameraRaw 新段落接线", () => {
  function raw(params: Record<string, number>): Buf {
    const img = solid(90, 130, 180);
    applyPixelAdjust(
      { id: "cameraraw", params } as unknown as AdjustState,
      img as unknown as ImageData,
    );
    return img;
  }

  it("全中性参数恒等（仅允许 ±1 舍入）", () => {
    const out = raw({});
    for (let i = 0; i < out.data.length; i += 1) {
      if (i % 4 === 3) {
        expect(out.data[i]).toBe(255);
      } else {
        const src = i % 4 === 0 ? 90 : i % 4 === 1 ? 130 : 180;
        expect(Math.abs(out.data[i] - src)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("curve 预设改变像素", () => {
    const out = raw({ curve: 2 });
    expect(out.data[0]).not.toBe(90);
    expect(out.data[3]).toBe(255);
  });

  it("mixerPreset 改变像素", () => {
    const out = raw({ mixerPreset: 3 });
    expect(out.data[0]).not.toBe(90);
    expect(out.data[3]).toBe(255);
  });

  it("vignette 压暗四角而中心基本不变", () => {
    const w = 32;
    const h = 32;
    const img = solid(200, 200, 200, w, h);
    applyPixelAdjust(
      { id: "cameraraw", params: { vignette: 80 } } as unknown as AdjustState,
      img as unknown as ImageData,
    );
    const center = (16 * w + 16) * 4;
    expect(img.data[center]).toBeGreaterThan(190);
    expect(img.data[0]).toBeLessThan(150);
    expect(img.data[3]).toBe(255);
  });
});
