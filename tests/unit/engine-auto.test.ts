/**
 * 自动调整内核（`auto.ts`）的测试。
 *
 * 这一族功能最容易做坏的地方有三处，这里各钉一条：
 *
 *   1. 把透明像素也算进直方图。一张贴在图上的小图四周大片透明（RGB 全 0），
 *      量出来的暗端永远是 0，于是「自动调整」什么也不做 —— 看起来不灵。
 *      断言 `histogram` 只数 alpha ≥ 8 的像素。
 *   2. 用 min/max 直接取区间。一撮高光噪点就能把整段色阶压扁。断言两侧
 *      各裁掉一小撮像素（`clipRange`）。
 *   3. 自动颜色把暖色景物硬拉成中性灰。断言灰世界增益被夹在 0.82–1.22。
 *
 * 另外钉住「低对比被拉满」「色相不变」「非破坏」三件行为。
 */
import {
  applyLut,
  autoColor,
  autoContrast,
  autoOn,
  autoTone,
  clipRange,
  histogram,
  stretchLut,
} from "../../src/engine/auto";
import { createRaster, type Raster } from "../../src/engine/raster";

/** 逐像素填色（行优先，颜色循环使用）。 */
function from(colors: number[][], w: number, h: number): Raster {
  const r = createRaster(w, h);
  for (let i = 0; i < w * h; i += 1) {
    const c = colors[i % colors.length];
    r.data[i * 4] = c[0];
    r.data[i * 4 + 1] = c[1];
    r.data[i * 4 + 2] = c[2];
    r.data[i * 4 + 3] = c.length > 3 ? c[3] : 255;
  }
  return r;
}

/** 纯色图。 */
function solid(w: number, h: number, c: number[]): Raster {
  return from([c], w, h);
}

/** 一眼看它是「低对比但铺满 0–255 的灰度图」：8×8，灰度 100–150。 */
function lowContrast(w = 8, h = 8): Raster {
  const r = createRaster(w, h);
  for (let i = 0; i < w * h; i += 1) {
    const v = 100 + (i % 51);
    r.data[i * 4] = v;
    r.data[i * 4 + 1] = v;
    r.data[i * 4 + 2] = v;
    r.data[i * 4 + 3] = 255;
  }
  return r;
}

/** 已经铺满 0–255 的灰度图（不该被动）。 */
function fullRange(w = 100, h = 10): Raster {
  const r = createRaster(w, h);
  for (let i = 0; i < w * h; i += 1) {
    const v = i % 2 === 0 ? 0 : 255;
    r.data[i * 4] = v;
    r.data[i * 4 + 1] = v;
    r.data[i * 4 + 2] = v;
    r.data[i * 4 + 3] = 255;
  }
  return r;
}

/** 某通道上实际出现过的值域（忽略透明像素）。 */
function span(r: Raster, c: number): [number, number] {
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < r.data.length; i += 4) {
    if (r.data[i + 3] < 8) continue;
    const v = r.data[i + c];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

function snapshot(r: Raster): number[] {
  return Array.from(r.data);
}

describe("histogram 直方图", () => {
  it("只统计不透明像素", () => {
    const r = from(
      [
        [100, 100, 100, 255],
        [100, 100, 100, 255],
        [200, 200, 200, 0],
        [200, 200, 200, 0],
      ],
      2,
      2,
    );
    const hist = histogram(r);
    expect(hist.count).toBe(2);
    expect(hist.r[100]).toBe(2);
    expect(hist.r[200]).toBe(0);
    expect(hist.g[100]).toBe(2);
    expect(hist.b[100]).toBe(2);
  });

  it("全透明图 count 为 0", () => {
    const hist = histogram(createRaster(8, 8));
    expect(hist.count).toBe(0);
    let total = 0;
    for (let v = 0; v < 256; v += 1) total += hist.r[v];
    expect(total).toBe(0);
  });

  it("每格计数之和等于 count", () => {
    const hist = histogram(lowContrast());
    let total = 0;
    for (let v = 0; v < 256; v += 1) total += hist.r[v];
    expect(total).toBe(hist.count);
    expect(hist.count).toBe(64);
  });

  it("minAlpha 阈值可调（默认 8）", () => {
    const r = from(
      [
        [50, 50, 50, 8],
        [50, 50, 50, 7],
      ],
      2,
      1,
    );
    expect(histogram(r).count).toBe(1);
    expect(histogram(r, 1).count).toBe(2);
  });
});

describe("clipRange 有效区间", () => {
  it("count <= 0 时退回全区间", () => {
    expect(clipRange(new Uint32Array(256), 0)).toEqual([0, 255]);
  });

  it("单颗死黑像素不会把暗端拽到 0", () => {
    const hist = new Uint32Array(256);
    hist[0] = 1; // 一颗噪点
    hist[20] = 1000; // 真正的暗端
    hist[200] = 1000; // 亮端
    const count = 2001;
    expect(clipRange(hist, count)).toEqual([20, 200]);
  });

  it("所有像素都挤在同一个值上时退回全区间", () => {
    const hist = new Uint32Array(256);
    hist[128] = 1000;
    expect(clipRange(hist, 1000)).toEqual([0, 255]);
  });

  it("clip 被夹在 0–0.2 之间", () => {
    const hist = new Uint32Array(256);
    hist[10] = 1;
    hist[20] = 100;
    hist[30] = 1;
    // clip 给个荒唐的大值，也只按 0.2 裁
    const [lo, hi] = clipRange(hist, 102, 5);
    expect(lo).toBeLessThanOrEqual(20);
    expect(hi).toBeGreaterThanOrEqual(20);
  });
});

describe("stretchLut 查找表", () => {
  it("把 [lo, hi] 铺满 0–255", () => {
    const lut = stretchLut(100, 200);
    expect(lut[100]).toBe(0);
    expect(lut[200]).toBe(255);
    expect(lut[0]).toBe(0); // 低于区间的一律压到 0
    expect(lut[255]).toBe(255); // 高于区间的一律顶到 255
  });

  it("线性插值", () => {
    expect(stretchLut(0, 255)[128]).toBe(128);
    // (150-100)*(255/100) 因浮点误差算出 127.4999…，四舍五入落在 127
    expect(stretchLut(100, 200)[150]).toBe(127);
    expect(stretchLut(100, 200)[151]).toBe(130); // 51*2.55 = 130.05 → 130
  });

  it("退化区间是恒等表", () => {
    const lut = stretchLut(50, 50);
    for (let v = 0; v < 256; v += 1) expect(lut[v]).toBe(v);
  });
});

describe("applyLut 就地改写", () => {
  const plus10 = () => {
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v += 1) lut[v] = Math.min(255, v + 10);
    return lut;
  };

  it("透明像素原封不动", () => {
    const r = from(
      [
        [10, 20, 30, 0],
        [10, 20, 30, 255],
      ],
      2,
      1,
    );
    const lut = plus10();
    applyLut(r, lut, lut, lut);
    expect([r.data[0], r.data[1], r.data[2]]).toEqual([10, 20, 30]);
    expect([r.data[4], r.data[5], r.data[6]]).toEqual([20, 30, 40]);
  });

  it("alpha 通道不动", () => {
    const r = solid(2, 2, [10, 20, 30]);
    const lut = plus10();
    applyLut(r, lut, lut, lut);
    expect([r.data[0], r.data[1], r.data[2], r.data[3]]).toEqual([20, 30, 40, 255]);
  });
});

describe("autoContrast 自动对比度", () => {
  it("全透明图什么也不做", () => {
    const rep = autoContrast(createRaster(8, 8));
    expect(rep.changed).toBe(false);
    expect(rep.gains).toBeNull();
    expect(rep.ranges).toEqual([
      [0, 255],
      [0, 255],
      [0, 255],
    ]);
  });

  it("已经铺满 0–255 的图不改动", () => {
    const r = fullRange();
    const before = snapshot(r);
    const rep = autoContrast(r);
    expect(rep.changed).toBe(false);
    expect(snapshot(r)).toEqual(before);
  });

  it("低对比图被拉满 0–255", () => {
    const r = lowContrast();
    const rep = autoContrast(r);
    expect(rep.changed).toBe(true);
    expect(rep.ranges[0]).toEqual([100, 150]);
    expect(span(r, 0)).toEqual([0, 255]);
    expect(span(r, 1)).toEqual([0, 255]);
    expect(span(r, 2)).toEqual([0, 255]);
  });

  it("色相不跑（三通道共用一张表，相对差按同一比例缩放）", () => {
    const r = from(
      [
        [100, 120, 140],
        [150, 170, 190],
      ],
      2,
      1,
    );
    autoContrast(r);
    for (let i = 0; i < 2; i += 1) {
      const o = i * 4;
      // 原本 R < G < B，拉完还得是 R < G < B
      expect(r.data[o]).toBeLessThan(r.data[o + 1]);
      expect(r.data[o + 1]).toBeLessThan(r.data[o + 2]);
    }
  });
});

describe("autoTone 自动色调", () => {
  it("全透明图什么也不做", () => {
    const rep = autoTone(createRaster(8, 8));
    expect(rep.changed).toBe(false);
    expect(rep.gains).toBeNull();
  });

  it("各通道已满量程的图不改动", () => {
    const rep = autoTone(fullRange());
    expect(rep.changed).toBe(false);
  });

  it("偏色图三个通道各自铺满（顺手中和偏色）", () => {
    const w = 8;
    const h = 8;
    const r = createRaster(w, h);
    for (let i = 0; i < w * h; i += 1) {
      r.data[i * 4] = 120 + (i % 61); // R: 120–180
      r.data[i * 4 + 1] = 100 + (i % 51); // G: 100–150
      r.data[i * 4 + 2] = 80 + (i % 51); // B: 80–130
      r.data[i * 4 + 3] = 255;
    }
    const rep = autoTone(r);
    expect(rep.changed).toBe(true);
    expect(rep.ranges[0]).toEqual([120, 180]);
    expect(rep.ranges[1]).toEqual([100, 150]);
    expect(rep.ranges[2]).toEqual([80, 130]);
    expect(span(r, 0)).toEqual([0, 255]);
    expect(span(r, 1)).toEqual([0, 255]);
    expect(span(r, 2)).toEqual([0, 255]);
  });
});

describe("autoColor 自动颜色", () => {
  it("纯灰图不改动，也不报增益", () => {
    const r = solid(10, 10, [128, 128, 128]);
    const rep = autoColor(r);
    expect(rep.changed).toBe(false);
    expect(rep.gains).toBeNull();
  });

  it("明显偏色的图会报出增益，且增益被夹在 0.82–1.22", () => {
    const r = solid(8, 8, [100, 100, 200]);
    const rep = autoColor(r);
    expect(rep.changed).toBe(true);
    expect(rep.gains).not.toBeNull();
    const gains = rep.gains as [number, number, number];
    for (const g of gains) {
      expect(g).toBeGreaterThanOrEqual(0.82 - 1e-9);
      expect(g).toBeLessThanOrEqual(1.22 + 1e-9);
    }
    // 偏蓝 → 蓝通道被压、红绿被抬
    expect(gains[2]).toBeLessThan(1);
    expect(gains[0]).toBeGreaterThan(1);
  });

  it("全透明图什么也不做", () => {
    const rep = autoColor(createRaster(8, 8));
    expect(rep.changed).toBe(false);
    expect(rep.gains).toBeNull();
  });
});

describe("autoOn 非破坏", () => {
  it("返回新图，原图一根像素都不动", () => {
    const src = lowContrast();
    const before = snapshot(src);
    const { raster, report } = autoOn(src, "contrast");
    expect(report.changed).toBe(true);
    expect(snapshot(src)).toEqual(before); // 原图没被碰
    expect(raster).not.toBe(src);
    expect(raster.data).not.toBe(src.data);
    expect(snapshot(raster)).not.toEqual(before); // 副本确实改了
  });

  it("三种 kind 都能跑出报告", () => {
    expect(autoOn(lowContrast(), "contrast").report.changed).toBe(true);
    expect(autoOn(lowContrast(), "tone").report.changed).toBe(true);
    expect(autoOn(solid(8, 8, [100, 100, 200]), "color").report.changed).toBe(true);
  });
});
