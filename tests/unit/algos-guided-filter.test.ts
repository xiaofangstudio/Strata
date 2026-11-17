/**
 * Guided filter 降噪内核回归测试。
 *
 * 验证三件真事：
 * 1. strength=0 原样返回；
 * 2. 固定种子噪声图的总偏差下降；
 * 3. 高对比边缘不被抹平（guided filter 相对 median 的核心优势）；
 * 4. alpha 不被算法改动。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DENOISE_SPEC,
  reduceNoiseGuided,
} from "../../src/engine/algos/guidedFilter";
import { makeBuffer, rng, type RgbaBuffer } from "../../src/engine/filters/kernels";

function fillGray(w: number, h: number, valueAt: (x: number, y: number) => number): RgbaBuffer {
  const buf = makeBuffer(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = (y * w + x) * 4;
      const v = valueAt(x, y);
      buf.data[p] = v;
      buf.data[p + 1] = v;
      buf.data[p + 2] = v;
      buf.data[p + 3] = 255;
    }
  }
  return buf;
}

function deviationFrom(src: RgbaBuffer, ideal: RgbaBuffer): number {
  let sum = 0;
  for (let i = 0; i < src.data.length; i += 4) {
    sum += Math.abs(src.data[i] - ideal.data[i]);
  }
  return sum;
}

describe("guided filter 降噪", () => {
  it("strength=0/color=0/sharpen=0 时逐字节恒等", () => {
    const src = makeBuffer(8, 8);
    for (let i = 0; i < src.data.length; i += 4) {
      src.data[i] = (i * 7) & 255;
      src.data[i + 1] = (i * 11) & 255;
      src.data[i + 2] = (i * 13) & 255;
      src.data[i + 3] = 200;
    }
    const out = reduceNoiseGuided(src, {
      ...DEFAULT_DENOISE_SPEC,
      strength: 0,
      color: 0,
      sharpen: 0,
      jpeg: false,
    });
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it("固定种子噪声的偏差明显下降", () => {
    const w = 48;
    const h = 48;
    const rand = rng(20261117);
    const ideal = fillGray(w, h, (x) => 40 + (x / (w - 1)) * 150);
    const noisy = makeBuffer(w, h);
    noisy.data.set(ideal.data);
    for (let i = 0; i < noisy.data.length; i += 4) {
      const n = (rand() * 2 - 1) * 28;
      noisy.data[i] += n;
      noisy.data[i + 1] += n;
      noisy.data[i + 2] += n;
    }
    const out = reduceNoiseGuided(noisy, {
      strength: 8,
      preserve: 20,
      color: 50,
      sharpen: 0,
      jpeg: false,
    });
    const before = deviationFrom(noisy, ideal);
    const after = deviationFrom(out, ideal);
    expect(after).toBeLessThan(before * 0.8);
  });

  it("高对比边缘保持陡峭，不被邻域抹成灰色", () => {
    const w = 40;
    const h = 40;
    const rand = rng(7);
    const src = fillGray(w, h, (x) => (x < w / 2 ? 16 : 240));
    for (let i = 0; i < src.data.length; i += 4) {
      const n = (rand() * 2 - 1) * 6;
      src.data[i] += n;
      src.data[i + 1] += n;
      src.data[i + 2] += n;
    }
    const out = reduceNoiseGuided(src, {
      strength: 10,
      preserve: 100,
      color: 0,
      sharpen: 0,
      jpeg: false,
    });
    const at = (buf: RgbaBuffer, x: number, y: number) => buf.data[(y * w + x) * 4];
    const edge = at(out, w / 2, h / 2) - at(out, w / 2 - 1, h / 2);
    expect(edge).toBeGreaterThan(170);
  });

  it("alpha 通道原样保留", () => {
    const src = makeBuffer(16, 16);
    for (let i = 0; i < src.data.length; i += 4) {
      src.data[i] = (i * 17) & 255;
      src.data[i + 1] = (i * 29) & 255;
      src.data[i + 2] = (i * 31) & 255;
      src.data[i + 3] = (i / 4) & 255;
    }
    const out = reduceNoiseGuided(src, {
      strength: 6,
      preserve: 50,
      color: 40,
      sharpen: 20,
      jpeg: true,
    });
    for (let i = 3; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(src.data[i]);
    }
  });
});
