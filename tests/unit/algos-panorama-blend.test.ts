/**
 * 全景融合纯函数测试：金字塔降/升采样、push-pull 填洞、最小代价接缝、多频段融合。
 * 断言口径对齐 PhotoCraft panorama/blend.rs 的测试（seams_avoid_disagreement_and_multiband_is_seamless）。
 */
import { describe, expect, it } from "vitest";
import {
  blendLevels,
  reducePlane,
  expandPlane,
  pushPull,
  seamLabels,
  multiband,
  type RoiImage,
} from "../../src/engine/algos/panoramaBlend";

describe("金字塔基本算子", () => {
  it("blendLevels 随尺寸增大但不超过 7", () => {
    expect(blendLevels(16, 16)).toBe(1);
    expect(blendLevels(64, 64)).toBe(3);
    expect(blendLevels(4096, 2048)).toBe(7);
  });

  it("reduce 平滑：常数图保持常数", () => {
    const w = 16, h = 12, ch = 3;
    const src = new Float32Array(w * h * ch).fill(0.6);
    const r = reducePlane(w, h, ch, src);
    expect(r.w).toBe(8);
    expect(r.h).toBe(6);
    for (const v of r.data) expect(v).toBeCloseTo(0.6, 5);
  });

  it("expand 双线性：常数图保持常数且尺寸正确", () => {
    const sw = 8, sh = 6, ch = 1;
    const src = new Float32Array(sw * sh * ch).fill(0.3);
    const up = expandPlane(sw, sh, ch, src, 16, 12);
    expect(up).toHaveLength(16 * 12 * ch);
    for (const v of up) expect(v).toBeCloseTo(0.3, 5);
  });

  it("push-pull 把洞填成邻域均值而非黑色", () => {
    const w = 8, h = 8, ch = 1;
    const px = new Float32Array(w * h);
    const wt = new Float32Array(w * h);
    for (let i = 0; i < w * h; i += 1) {
      px[i] = 1;
      wt[i] = 1;
    }
    const hole = 4 * w + 4;
    px[hole] = 0;
    wt[hole] = 0;
    pushPull(w, h, ch, px, wt);
    // 洞被邻近的 1 填充（不应该是 0）
    expect(px[hole]).toBeGreaterThan(0.8);
  });
});

describe("seamLabels 最小代价接缝", () => {
  it("两图重叠、其中一列差异大：接缝绕开差异列", () => {
    const w = 80, h = 30;
    const a = new Float32Array(w * h).fill(0.2);
    const b = new Float32Array(w * h).fill(0.2);
    // 图 b 在 x=50 处有一列明显不同的内容（模拟移动物体）
    for (let y = 0; y < h; y += 1) b[y * w + 50] = 0.9;
    const coverA = new Uint8Array(w * h);
    const coverB = new Uint8Array(w * h);
    // a 覆盖全图；b 覆盖 x∈[30,70]，重心偏右（有明确的一侧）
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        coverA[y * w + x] = 1;
        if (x >= 30 && x < 70) coverB[y * w + x] = 1;
      }
    }
    const labels = seamLabels(w, h, [a, b], [coverA, coverB], [0, 1]);
    // b 应拿到它那一侧重叠区（居中退化分支不适用），差异列由某一方完整保留
    let bCount = 0;
    for (let i = 0; i < w * h; i += 1) if (labels[i] === 1) bCount += 1;
    expect(bCount).toBeGreaterThan(0);
    expect(bCount).toBeLessThan(40 * h);
    // 同一列内的归属应一致（接缝是逐行的竖直路径，不会把差异列撕成两半）
    const colOwners = new Set<number>();
    for (let y = 0; y < h; y += 1) colOwners.add(labels[y * w + 50]);
    expect(colOwners.size).toBe(1);
  });

  it("无重叠时各自保留自己的区域", () => {
    const w = 40, h = 20;
    const luma = [new Float32Array(w * h).fill(0.5), new Float32Array(w * h).fill(0.5)];
    const ca = new Uint8Array(w * h), cb = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (x < 20) ca[y * w + x] = 1;
        else cb[y * w + x] = 1;
      }
    }
    const labels = seamLabels(w, h, luma, [ca, cb], [0, 1]);
    expect(labels[0]).toBe(0);
    expect(labels[39]).toBe(1);
  });
});

describe("multiband 多频段融合", () => {
  it("单张图原样输出（常数区域不漂移）", () => {
    const w = 64, h = 48, ch = 3;
    const px = new Float32Array(w * h * ch).fill(0.5);
    const alpha = new Float32Array(w * h).fill(1);
    const im: RoiImage = { x0: 0, y0: 0, w, h, ch, px, alpha };
    const out = multiband(w, h, [im], [new Float32Array(w * h).fill(1)], 3);
    for (let i = 0; i < 100; i += 1) expect(out.color[i]).toBeCloseTo(0.5, 4);
    for (const v of out.coverage) expect(v).toBeCloseTo(1, 5);
  });

  it("两张相邻图拼出完整画布，交界处覆盖不缺失", () => {
    const w = 80, h = 40, ch = 1;
    const mk = (x0: number): RoiImage => {
      const px = new Float32Array(w * h * ch).fill(0.4);
      const alpha = new Float32Array(w * h);
      // 只给 x∈[x0,x0+48) 有效，覆盖到画布中部
      for (let y = 0; y < h; y += 1) {
        for (let x = x0; x < Math.min(w, x0 + 48); x += 1) alpha[y * w + x] = 1;
      }
      return { x0: 0, y0: 0, w, h, ch, px, alpha };
    };
    const a = mk(0);
    const b = mk(32);
    const out = multiband(w, h, [a, b], [new Float32Array(w * h).fill(1), new Float32Array(w * h).fill(1)], 3);
    // 左端只被 a 覆盖、右端只被 b 覆盖，中间两者重叠 —— 颜色都应保持 0.4
    for (const x of [4, 40, 76]) {
      expect(out.color[(20 * w + x) * ch]).toBeCloseTo(0.4, 3);
      expect(out.coverage[20 * w + x]).toBeGreaterThan(0.9);
    }
  });

  it("ROI 只在局部时，画布其余区域保持 0", () => {
    const w = 64, h = 32, ch = 1;
    const im: RoiImage = {
      x0: 16, y0: 8, w: 16, h: 16, ch,
      px: new Float32Array(16 * 16).fill(0.7),
      alpha: new Float32Array(16 * 16).fill(1),
    };
    const out = multiband(w, h, [im], [new Float32Array(16 * 16).fill(1)], 3);
    expect(out.coverage[0]).toBe(0);
    expect(out.coverage[(20 * w + 24)]).toBe(1);
    expect(out.color[(20 * w + 24) * ch]).toBeCloseTo(0.7, 3);
  });
});
