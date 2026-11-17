/**
 * P2-A：SLIC 显著性主体 / 稳健天空选区回归测试。
 */
import { describe, expect, it } from "vitest";
import {
  keepMainAndNearby,
  otsu,
  saliency,
  subjectSaliencyHit,
} from "../../src/engine/algos/subject";
import {
  colourPrior,
  skyLikelihood,
  skyMaskLow,
  skyRobustHit,
} from "../../src/engine/algos/sky";
import { makeBuffer } from "../../src/engine/filters/kernels";

function scene(): { d: Uint8ClampedArray; w: number; h: number } {
  const w = 48;
  const h = 48;
  const b = makeBuffer(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = (y * w + x) * 4;
      const obj = x >= 18 && x < 30 && y >= 18 && y < 30;
      const v = obj ? 235 : 40;
      b.data[p] = v;
      b.data[p + 1] = obj ? 35 : 42;
      b.data[p + 2] = obj ? 35 : 45;
      b.data[p + 3] = 255;
    }
  }
  return { d: b.data, w, h };
}

describe("显著性主体", () => {
  it("Otsu 在双峰分布上给出中间阈值", () => {
    const v = new Float32Array(200);
    for (let i = 0; i < 100; i += 1) v[i] = 0.1;
    for (let i = 100; i < 200; i += 1) v[i] = 0.9;
    // Otsu 在两峰之间任取一点方差相同，取第一次达到最大值的 bin 是标准行为。
    const t = otsu(v);
    expect(t).toBeGreaterThan(0.1);
    expect(t).toBeLessThan(0.9);
    expect(v.filter((x) => x < t).every((x) => x < 0.2)).toBe(true);
    expect(v.filter((x) => x >= t).every((x) => x > 0.8)).toBe(true);
  });

  it("显著图在中心物体上高于边框背景", () => {
    const { d, w, h } = scene();
    const s = saliency(d, w, h);
    let obj = 0;
    let bg = 0;
    let nObj = 0;
    let nBg = 0;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        if (x >= 20 && x < 28 && y >= 20 && y < 28) { obj += s[i]; nObj += 1; }
        if (x < 4 || y < 4) { bg += s[i]; nBg += 1; }
      }
    }
    expect(obj / nObj).toBeGreaterThan(bg / nBg);
  });

  it("主体命中表覆盖中心物体、不覆盖角落", () => {
    const { d, w, h } = scene();
    const hit = subjectSaliencyHit(d, w, h);
    expect(hit).not.toBeNull();
    expect(hit![24 * w + 24]).toBe(1);
    expect(hit![3 * w + 3]).toBe(0);
  });

  it("只保留主连通块，远处斑点被丢掉", () => {
    const w = 64;
    const h = 64;
    const m = new Uint8Array(w * h);
    for (let y = 20; y < 40; y += 1) for (let x = 20; x < 40; x += 1) m[y * w + x] = 1;
    m[60 * w + 60] = 1;
    const out = keepMainAndNearby(m, w, h);
    expect(out[30 * w + 30]).toBe(1);
    expect(out[60 * w + 60]).toBe(0);
  });
});

describe("稳健天空", () => {
  it("蓝天颜色先验高于红墙和暗灰", () => {
    expect(colourPrior(60, 120, 230)).toBeGreaterThan(colourPrior(200, 60, 60));
    expect(colourPrior(60, 120, 230)).toBeGreaterThan(colourPrior(40, 40, 40));
  });

  it("似然图顶部蓝天高于底部建筑", () => {
    const w = 48;
    const h = 48;
    const b = makeBuffer(w, h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const p = (y * w + x) * 4;
        if (y < 24) { b.data[p] = 70; b.data[p + 1] = 130; b.data[p + 2] = 230; }
        else { b.data[p] = 150; b.data[p + 1] = 110; b.data[p + 2] = 80; }
        b.data[p + 3] = 255;
      }
    }
    const like = skyLikelihood(b.data, w, h);
    let top = 0;
    let bottom = 0;
    for (let x = 0; x < w; x += 1) {
      top += like[12 * w + x];
      bottom += like[36 * w + x];
    }
    expect(top / w).toBeGreaterThan(bottom / w);
    const mask = skyMaskLow(b.data, w, h, 50);
    expect(mask).not.toBeNull();
    expect(mask![12 * w + 24]).toBe(1);
    expect(mask![36 * w + 24]).toBe(0);
  });

  it("全分辨率结果确定性且不含 NaN 边界", () => {
    const w = 40;
    const h = 40;
    const b = makeBuffer(w, h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const p = (y * w + x) * 4;
        if (y < 20) { b.data[p] = 70; b.data[p + 1] = 130; b.data[p + 2] = 230; }
        else { b.data[p] = 150; b.data[p + 1] = 110; b.data[p + 2] = 80; }
        b.data[p + 3] = 255;
      }
    }
    const a = skyRobustHit(b.data, w, h, 50, 50);
    const c = skyRobustHit(b.data, w, h, 50, 50);
    expect(a).not.toBeNull();
    expect(Array.from(a!)).toEqual(Array.from(c!));
    expect(a![39 * w + 39]).toBe(0);
  });
});
