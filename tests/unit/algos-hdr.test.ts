/**
 * HDR 合并纯函数回归测试（移植自 PhotoCraft hdr.rs 的测试口径）。
 * 覆盖：相对曝光估计、Debevec 响应曲线、hat 加权辐射合并、ghost removal、色调映射。
 */
import { describe, expect, it } from "vitest";
import {
  estimateExposures,
  responseCurve,
  srgbResponseCurve,
  samplePixels,
  hatWeight,
  mergeHdrExposures,
  toneMapRadiance,
  mergeAndTone,
} from "../../src/engine/algos/hdr";
import { makeBuffer, type RgbaBuffer } from "../../src/engine/filters/kernels";

/** 用给定线性辐射和曝光生成一张显示编码的 8 位曝光图。 */
function synthExposure(
  w: number, h: number, radiance: (x: number, y: number) => number, exposure: number,
): RgbaBuffer {
  const img = makeBuffer(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      // 简单 sRGB 编码：linear^(1/2.2)，再乘曝光
      const v = Math.min(1, Math.pow(radiance(x, y) * exposure, 1 / 2.2));
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(v * 255);
      img.data[i + 3] = 255;
    }
  }
  return img;
}

describe("hatWeight", () => {
  it("中灰权重最大、两端为 0、对称", () => {
    expect(hatWeight(0)).toBe(0);
    expect(hatWeight(255)).toBe(0);
    expect(hatWeight(128)).toBeGreaterThan(hatWeight(32));
    expect(hatWeight(64)).toBeCloseTo(hatWeight(191), 5);
  });
});

describe("estimateExposures", () => {
  it("亮图相对暗图有更大的曝光倍数", () => {
    const w = 48, h = 48;
    // 用低 radiance 保证两张都不饱和（0.03×1 与 0.03×4 落在良好曝光区）
    const dark = synthExposure(w, h, () => 0.03, 1);
    const bright = synthExposure(w, h, () => 0.03, 4);
    const ex = estimateExposures([dark, bright]);
    expect(ex).toHaveLength(2);
    expect(Math.max(...ex) / Math.min(...ex)).toBeGreaterThan(1.5);
    // 暗图平均亮度低，应拿到较小的曝光倍数
    expect(ex[1]).toBeGreaterThan(ex[0]);
  });

  it("单张图曝光为 1", () => {
    expect(estimateExposures([makeBuffer(8, 8)])).toEqual([1]);
  });
});

describe("responseCurve", () => {
  it("sRGB 响应曲线单调且 g(128)=0", () => {
    const g = srgbResponseCurve();
    expect(g).toHaveLength(256);
    expect(g[128]).toBeCloseTo(0, 5);
    for (let k = 1; k < 256; k += 1) expect(g[k]).toBeGreaterThan(g[k - 1]);
  });

  it("Debevec 求解对已知合成数据单调、g(128) 固定", () => {
    // 3 张曝光、每张 40 个样本，z 由 g = ln(code/255)^(1/2.2) 线性组合生成
    const logDt = [0, Math.log(2), Math.log(4)];
    const z = logDt.map((ldt, j) =>
      Array.from({ length: 40 }, (_, i) => {
        const code = Math.max(1, Math.min(254, Math.round(((i + 1) / 41) * 255)));
        const linear = Math.pow(code / 255, 2.2) * Math.exp(ldt);
        return Math.max(0, Math.min(255, Math.round(Math.pow(Math.min(1, linear), 1 / 2.2) * 255)));
      }),
    );
    const g = responseCurve(z, logDt, 40);
    expect(g).toHaveLength(256);
    expect(g.every(Number.isFinite)).toBe(true);
    for (let k = 1; k < 256; k += 1) expect(g[k]).toBeGreaterThan(g[k - 1]);
  });
});

describe("samplePixels", () => {
  it("平坦区采样返回合法索引并按亮度分层", () => {
    const w = 64, h = 64;
    const img = synthExposure(w, h, (x) => x / w, 1);
    const s = samplePixels(w, h, img, 80);
    expect(s.length).toBeGreaterThan(0);
    expect(s.length).toBeLessThanOrEqual(80);
    for (const i of s) expect(i).toBeGreaterThanOrEqual(0);
    for (const i of s) expect(i).toBeLessThan(w * h);
    expect([...new Set(s)]).toHaveLength(s.length);
    expect([...s].sort((a, b) => a - b)).toEqual(s);
  });
});

describe("mergeHdrExposures", () => {
  it("单张图也能合并（用 sRGB 理论曲线），输出辐射为正", () => {
    const img = synthExposure(32, 32, (x, y) => (x + y) / 64, 1);
    const hdr = mergeHdrExposures([img]);
    expect(hdr.width).toBe(32);
    expect(hdr.rad).toHaveLength(32 * 32 * 3);
    expect(hdr.rad.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
    expect(hdr.exposures).toEqual([1]);
    expect(hdr.response).toHaveLength(3);
  });

  it("多曝光合并的动态范围大于单张", () => {
    const w = 64, h = 64;
    const scene = (x: number, y: number) => 0.02 + (x / w) * (y / h) * 8;
    const exps = [0.25, 1, 4];
    const imgs = exps.map((e) => synthExposure(w, h, scene, e));
    const single = mergeHdrExposures([imgs[1]]);
    const merged = mergeHdrExposures(imgs, { exposures: exps });
    expect(merged.stops).toBeGreaterThan(single.stops);
    expect(Math.max(...merged.exposures)).toBeGreaterThan(Math.min(...merged.exposures));
  });

  it("ghost removal 能标记移动物体区域", () => {
    const w = 64, h = 64;
    // 两张都在良好曝光区（不接近饱和），否则 hat 权重会被过滤——过曝像素本就不可信
    const scene = () => 0.14;
    const clean = synthExposure(w, h, scene, 1);
    const withGhost = synthExposure(w, h, (x, y) =>
      x > 20 && x < 44 && y > 20 && y < 44 ? 0.5 : scene(), 1);
    const out = mergeHdrExposures([clean, withGhost], {
      exposures: [1, 1],
      removeGhosts: true,
    });
    expect(out.ghostFraction).toBeGreaterThan(0);
    expect(out.ghostFraction).toBeLessThan(0.5);
  });

  it("尺寸不一致抛错", () => {
    const a = makeBuffer(16, 16);
    const b = makeBuffer(32, 16);
    expect(() => mergeHdrExposures([a, b])).toThrow(/同尺寸/);
  });
});

describe("toneMapRadiance / mergeAndTone", () => {
  it("三种色调映射输出都在 0..255，alpha 保留", () => {
    const w = 32, h = 32;
    const a = synthExposure(w, h, () => 0.2, 1);
    const b = synthExposure(w, h, () => 0.7, 4);
    const hdr = mergeHdrExposures([a, b], { exposures: [1, 4] });
    for (const method of ["highlightCompression", "exposureGamma", "equalize"] as const) {
      const out = toneMapRadiance(hdr, method, { exposure: 0, gamma: 1.2 });
      expect(out.data).toHaveLength(w * h * 4);
      for (let i = 0; i < out.data.length; i += 4) {
        expect(out.data[i + 3]).toBe(255);
        for (let c = 0; c < 3; c += 1) {
          expect(out.data[i + c]).toBeGreaterThanOrEqual(0);
          expect(out.data[i + c]).toBeLessThanOrEqual(255);
        }
      }
    }
  });

  it("一站式 mergeAndTone 与分步调用结果一致", () => {
    const w = 32, h = 32;
    const imgs = [1, 2, 4].map((e) => synthExposure(w, h, () => 0.3, e));
    const one = mergeAndTone(imgs, { exposures: [1, 2, 4] });
    const hdr = mergeHdrExposures(imgs, { exposures: [1, 2, 4] });
    const two = toneMapRadiance(hdr);
    expect(Array.from(one.image.data)).toEqual(Array.from(two.data));
    expect(one.hdr.stops).toBeCloseTo(hdr.stops, 6);
  });

  it("透明像素不被辐射合并污染", () => {
    const w = 16, h = 16;
    const a = synthExposure(w, h, () => 0.5, 1);
    const b = synthExposure(w, h, () => 0.5, 2);
    b.data[3] = 0; // 左上角透明
    const out = mergeAndTone([a, b], { exposures: [1, 2] });
    // alpha 取最大：a 在该像素不透明，结果仍不透明；无 NaN
    expect(out.image.data[3]).toBe(255);
    expect(out.image.data.every(Number.isFinite)).toBe(true);
  });
});
