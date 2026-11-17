/**
 * SLIC / GMM / GrabCut 图割选区回归测试。
 */
import { describe, expect, it } from "vitest";
import { Gmm, subsample } from "../../src/engine/algos/gmm";
import { grabcut, objectSelectMask, PR_FG } from "../../src/engine/algos/grabcut";
import { rgbToLab, rgbaToLabPlanes, slicLab } from "../../src/engine/algos/slic";
import { makeBuffer } from "../../src/engine/filters/kernels";

describe("SLIC 超像素", () => {
  it("RGB→Lab 黑白红在合理范围", () => {
    const white = rgbToLab([1, 1, 1]);
    const black = rgbToLab([0, 0, 0]);
    const red = rgbToLab([1, 0, 0]);
    expect(white[0]).toBeGreaterThan(95);
    expect(black[0]).toBeLessThan(5);
    expect(red[1]).toBeGreaterThan(40);
    expect(red[2]).toBeGreaterThan(40);
  });

  it("两段色块图被分成有限个连通超像素", () => {
    const w = 32;
    const h = 32;
    const img = makeBuffer(w, h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const p = (y * w + x) * 4;
        const v = x < 16 ? 40 : 210;
        img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
        img.data[p + 3] = 255;
      }
    }
    const lab = rgbaToLabPlanes(img.data, w, h);
    const sp = slicLab(lab, w, h, 24, 10, 6);
    expect(sp.count).toBeGreaterThan(0);
    expect(sp.labels.length).toBe(w * h);
    for (const l of sp.labels) expect(l).toBeGreaterThanOrEqual(0);
    expect(new Set(Array.from(sp.labels)).size).toBeGreaterThan(1);
  });
});

describe("GMM", () => {
  it("两簇样本拟合后，各簇中心对数概率更高", () => {
    const samples: [number, number, number][] = [];
    for (let i = 0; i < 40; i += 1) {
      samples.push([0.1 + (i % 5) * 0.01, 0.1 + (i % 3) * 0.01, 0.1]);
      samples.push([0.8 + (i % 5) * 0.01, 0.8 + (i % 3) * 0.01, 0.8]);
    }
    const gmm = Gmm.fit(subsample(samples, 100), 2);
    expect(gmm).not.toBeNull();
    const low = gmm!.logLikelihood([0.1, 0.1, 0.1]);
    const high = gmm!.logLikelihood([0.8, 0.8, 0.8]);
    const mid = gmm!.logLikelihood([0.45, 0.45, 0.45]);
    expect(low).toBeGreaterThan(mid);
    expect(high).toBeGreaterThan(mid);
  });
});

describe("GrabCut", () => {
  it("矩形对象选择能分出明显前景块", () => {
    const w = 40;
    const h = 40;
    const img = makeBuffer(w, h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const p = (y * w + x) * 4;
        const inside = x >= 14 && x < 26 && y >= 14 && y < 26;
        const v = inside ? 220 : 30;
        img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
        img.data[p + 3] = 255;
      }
    }
    const mask = objectSelectMask(img, { x: 13, y: 13, width: 14, height: 14 });
    expect(mask[20 * w + 20]).toBe(1);
    expect(mask[3 * w + 3]).toBe(0);
  });

  it("无前景样本时不会崩", () => {
    const img = makeBuffer(16, 16);
    const trimap = new Uint8Array(16 * 16).fill(PR_FG);
    const out = grabcut(img, trimap, 1);
    expect(out.trimap.length).toBe(16 * 16);
  });
});
