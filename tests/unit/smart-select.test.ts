/**
 * 智能选区纯判定函数：色彩范围 / 扩大选取 / 主体 / 天空 / 焦点区域。
 * 只测纯像素判定（*Hit），canvas 落版层不做像素决策、不在 node 里测。
 */
import { describe, expect, it } from "vitest";
import {
  colorRangeHit,
  focusHit,
  growHit,
  skyHit,
  subjectHit,
} from "../../src/core/smartSelect";

function rgba(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const [r, g, b, a] = px(x, y);
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      d[o + 3] = a;
    }
  }
  return d;
}

describe("色彩范围 colorRangeHit", () => {
  it("选中与目标色相近的全部像素（不要求连通）", () => {
    const d = rgba(8, 4, (x) => (x % 3 === 0 ? [200, 40, 40, 255] : [20, 20, 20, 255]));
    const hit = colorRangeHit(d, 8, 4, [200, 40, 40], 30);
    expect(hit[0]).toBe(1); // x=0 红色
    expect(hit[1]).toBe(0); // x=1 暗色
    expect(hit[3]).toBe(1); // x=3 红色
    expect(hit[2 * 8 + 2]).toBe(0);
  });

  it("容差为 0 时只选中完全相等的像素", () => {
    const d = rgba(4, 2, (x) => (x === 1 ? [100, 100, 100, 255] : [101, 100, 100, 255]));
    const hit = colorRangeHit(d, 4, 2, [100, 100, 100], 0);
    expect(hit[1]).toBe(1);
    expect(hit[0]).toBe(0);
  });
});

describe("扩大选取 growHit", () => {
  it("同色图里从选区一路长满", () => {
    const d = rgba(8, 4, () => [120, 120, 120, 255]);
    const sel = new Uint8Array(8 * 4);
    for (let y = 0; y < 4; y += 1) {
      sel[y * 8] = 1;
      sel[y * 8 + 1] = 1;
    }
    const grown = growHit(sel, d, 8, 4, 40);
    expect(grown[8 * 4 - 1]).toBe(1); // 右下角也被长满
  });

  it("边界外颜色差异大时不生长", () => {
    const d = rgba(8, 4, (x) => (x < 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const sel = new Uint8Array(8 * 4);
    for (let y = 0; y < 4; y += 1) {
      sel[y * 8] = 1;
      sel[y * 8 + 1] = 1;
    }
    const grown = growHit(sel, d, 8, 4, 10);
    expect(grown[1 * 8 + 5]).toBe(0);
    expect(grown[1 * 8 + 1]).toBe(1); // 原选区保留
  });

  it("空选区原样返回", () => {
    const d = rgba(4, 4, () => [0, 0, 0, 255]);
    const sel = new Uint8Array(4 * 4);
    const grown = growHit(sel, d, 4, 4, 40);
    for (const v of grown) expect(v).toBe(0);
  });
});

describe("选取主体 subjectHit", () => {
  it("干净背景下把中央主体选出来", () => {
    const d = rgba(16, 16, (x, y) =>
      x >= 6 && x <= 9 && y >= 6 && y <= 9 ? [220, 30, 30, 255] : [240, 240, 240, 255],
    );
    const hit = subjectHit(d, 16, 16);
    expect(hit).not.toBeNull();
    expect(hit![7 * 16 + 7]).toBe(1); // 主体
    expect(hit![1 * 16 + 1]).toBe(0); // 背景
  });

  it("纯色图返回 null（无主体）", () => {
    const d = rgba(12, 12, () => [128, 128, 128, 255]);
    expect(subjectHit(d, 12, 12)).toBeNull();
  });
});

describe("选取天空 skyHit", () => {
  it("上缘连通的蓝色入选，被隔断的蓝色不入选", () => {
    const d = rgba(10, 20, (_x, y) => {
      // 上半蓝、中间一道白墙、下半蓝：下半不与上缘连通
      if (y >= 8 && y <= 11) return [240, 240, 240, 255];
      return [90, 160, 235, 255];
    });
    const hit = skyHit(d, 10, 20);
    expect(hit).not.toBeNull();
    expect(hit![2 * 10 + 5]).toBe(1); // 上部天空
    expect(hit![18 * 10 + 5]).toBe(0); // 墙下的蓝色
  });

  it("没有蓝色像素时返回 null", () => {
    const d = rgba(8, 8, () => [200, 180, 160, 255]);
    expect(skyHit(d, 8, 8)).toBeNull();
  });
});

describe("焦点区域 focusHit", () => {
  it("高对比纹理区入选", () => {
    const d = rgba(16, 16, (x) => (x % 2 === 0 ? [30, 30, 30, 255] : [230, 230, 230, 255]));
    const hit = focusHit(d, 16, 16, 24);
    expect(hit).not.toBeNull();
    expect(hit![4 * 16 + 4]).toBe(1);
  });

  it("纯色图（无细节）返回 null", () => {
    const d = rgba(16, 16, () => [100, 100, 100, 255]);
    expect(focusHit(d, 16, 16, 24)).toBeNull();
  });
});
