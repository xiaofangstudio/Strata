/**
 * 内容识别缩放（接缝雕刻）。
 *
 * 覆盖：能量图、竖直/水平缝的 DP、删缝/复制缝、保护蒙版、
 * 以及「整幅文档缩到目标尺寸」的总入口。
 */
import { describe, expect, it } from "vitest";
import {
  contentAwareScale,
  energyMap,
  findHorizontalSeam,
  findVerticalSeam,
  insertHorizontalSeam,
  insertVerticalSeam,
  removeHorizontalSeam,
  removeVerticalSeam,
} from "../../src/core/seamCarve";
import type { RgbaBuffer } from "../../src/engine/filters/kernels";

function make(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): RgbaBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const [r, g, b, a] = px(x, y);
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
  }
  return { data, width: w, height: h };
}

describe("能量图", () => {
  it("纯色图能量处处为 0", () => {
    const e = energyMap(make(4, 4, () => [100, 150, 200, 255]));
    for (const v of e) expect(v).toBe(0);
  });

  it("竖条边界处能量高、平坦区能量低", () => {
    const e = energyMap(make(6, 4, (x) => (x < 3 ? [0, 0, 0, 255] : [255, 255, 255, 255])));
    expect(e[2]).toBeGreaterThan(0); // 边界左侧
    expect(e[0]).toBe(0); // 平坦区
  });
});

describe("最小缝（DP）", () => {
  it("竖直缝每行恰好一个 x，且相邻行 x 差 ≤ 1（8-连通）", () => {
    const e = energyMap(make(8, 8, (x, y) => {
      const v = (x === 3 && y < 6 ? 0 : ((x * 37 + y * 11) % 7) * 30);
      return [v, v, v, 255];
    }));
    const seam = findVerticalSeam(e, 8, 8);
    expect(seam.length).toBe(8);
    for (let y = 1; y < seam.length; y += 1) {
      expect(Math.abs(seam[y] - seam[y - 1])).toBeLessThanOrEqual(1);
    }
  });

  it("全部零能量时缝贴着最左列（并列取首个）", () => {
    const e = new Float32Array(4 * 4);
    const seam = findVerticalSeam(e, 4, 4);
    for (const x of seam) expect(x).toBe(0);
  });

  it("保护蒙版内的像素绝不会出现在缝里", () => {
    const w = 6;
    const h = 6;
    // 中间一列给巨大能量，等价于保护
    const e = new Float32Array(w * h);
    for (let y = 0; y < h; y += 1) e[y * w + 2] = 1e9;
    const seam = findVerticalSeam(e, w, h);
    for (const x of seam) expect(x).not.toBe(2);
  });

  it("protect 选项（SeamOptions）同样把 protected 列排除在外", () => {
    const w = 6;
    const h = 6;
    const e = new Float32Array(w * h);
    const protect = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y += 1) protect[y * w + 4] = 255;
    const seam = findVerticalSeam(e, w, h, { protect });
    for (const x of seam) expect(x).not.toBe(4);
  });

  it("水平缝每列恰好一个 y", () => {
    const e = energyMap(make(8, 8, (_x, y) => {
      const v = (y * 23) % 5 === 0 ? 255 : (y * 13) % 3;
      return [v * 30, v * 30, v * 30, 255];
    }));
    const seam = findHorizontalSeam(e, 8, 8);
    expect(seam.length).toBe(8);
    for (let x = 1; x < seam.length; x += 1) {
      expect(Math.abs(seam[x] - seam[x - 1])).toBeLessThanOrEqual(1);
    }
  });
});

describe("删缝与复制缝", () => {
  it("删竖直缝后宽 -1、每行少一个像素", () => {
    const src = make(5, 4, (x, y) => [x * 10 + y, x * 10 + y, x * 10 + y, 255]);
    const e = energyMap(src);
    const seam = findVerticalSeam(e, 5, 4);
    const out = removeVerticalSeam(src, seam);
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
    expect(out.data.length).toBe(4 * 4 * 4);
  });

  it("复制竖直缝后宽 +1、原像素序列保持相对顺序", () => {
    const src = make(3, 1, (x) => [x * 100, x * 100, x * 100, 255]);
    const seam = [1, 1, 1]; // 每行复制 x=1
    const out = insertVerticalSeam(src, seam);
    expect(out.width).toBe(4);
    // 复制缝处与左邻取均值：(100 + 0)/2 = 50，其余保序
    expect(Array.from(out.data.slice(0, 16))).toEqual([0, 0, 0, 255, 50, 50, 50, 255, 100, 100, 100, 255, 200, 200, 200, 255]);
  });

  it("删水平缝后高 -1", () => {
    const src = make(4, 5, (_x, y) => [y * 10, y * 10, y * 10, 255]);
    const e = energyMap(src);
    const seam = findHorizontalSeam(e, 4, 5);
    const out = removeHorizontalSeam(src, seam);
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
  });

  it("复制水平缝后高 +1", () => {
    const src = make(2, 3, (_x, y) => [y * 60, y * 60, y * 60, 255]);
    const seam = [1, 1]; // 每列复制 y=1
    const out = insertHorizontalSeam(src, seam);
    expect(out.width).toBe(2);
    expect(out.height).toBe(4);
  });
});

describe("内容识别缩放总入口", () => {
  it("横向缩小：宽达到目标、高不变，主体（高能量列）保留", () => {
    // 左侧平坦灰 + 右侧一条强对比竖条
    const src = make(12, 8, (x) => (x >= 9 ? [255, 255, 255, 255] : [40, 40, 40, 255]));
    const out = contentAwareScale(src, 10, 8);
    expect(out.width).toBe(10);
    expect(out.height).toBe(8);
    // 平坦区被优先删掉，右侧竖条仍应在
    let bright = 0;
    for (let i = 0; i < out.data.length; i += 4) if (out.data[i] > 200) bright += 1;
    expect(bright).toBeGreaterThan(0);
  });

  it("纵向缩小：高达到目标、宽不变", () => {
    const src = make(6, 12, (_x, y) => [y * 20, y * 20, y * 20, 255]);
    const out = contentAwareScale(src, 6, 9);
    expect(out.width).toBe(6);
    expect(out.height).toBe(9);
  });

  it("放大：复制低能量缝，尺寸变大", () => {
    const src = make(4, 4, () => [120, 120, 120, 255]);
    const out = contentAwareScale(src, 6, 4);
    expect(out.width).toBe(6);
    expect(out.height).toBe(4);
    // 纯色图放大后仍是纯色
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(120);
      expect(out.data[i + 3]).toBe(255);
    }
  });

  it("protect 蒙版保护的列不会被删掉", () => {
    // 要删掉 1 列：右侧亮条受保护 → 删的应是左侧暗区
    const src = make(8, 6, (x) => (x >= 6 ? [255, 255, 255, 255] : [10, 10, 10, 255]));
    const protect = new Uint8ClampedArray(8 * 6);
    for (let y = 0; y < 6; y += 1) {
      protect[y * 8 + 6] = 255;
      protect[y * 8 + 7] = 255;
    }
    const out = contentAwareScale(src, 7, 6, { protect });
    expect(out.width).toBe(7);
    // 至少还有一个亮像素在
    let bright = 0;
    for (let i = 0; i < out.data.length; i += 4) if (out.data[i] > 200) bright += 1;
    expect(bright).toBeGreaterThan(0);
  });

  it("尺寸不变时原样返回内容", () => {
    const src = make(4, 4, (x, y) => [x + y, x + y, x + y, 255]);
    const out = contentAwareScale(src, 4, 4);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });
});
