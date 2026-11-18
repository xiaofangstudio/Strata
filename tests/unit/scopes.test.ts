/**
 * 示波器纯函数测试：波形图纵轴语义、分量通道分离、矢量图 BT.601 色度落点。
 * 之前零测试——按「早期癌症」口径补上，防的是坐标翻转/通道错位这类静默错误。
 */
import { describe, expect, it } from "vitest";
import {
  computeWaveform,
  computeParade,
  computeVectorscope,
  binIntensity,
  type ScopeBins,
} from "../../src/engine/scopes";

function solid(w: number, h: number, r: number, g: number, b: number, a = 255) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return { data, width: w, height: h };
}

/** 找出 bins 里计数非零的行/列集合。 */
function occupiedRows(b: ScopeBins): Set<number> {
  const s = new Set<number>();
  for (let y = 0; y < b.height; y += 1) {
    for (let x = 0; x < b.width; x += 1) {
      if (b.bins[y * b.width + x] > 0) { s.add(y); break; }
    }
  }
  return s;
}
function occupiedCols(b: ScopeBins): Set<number> {
  const s = new Set<number>();
  for (let x = 0; x < b.width; x += 1) {
    for (let y = 0; y < b.height; y += 1) {
      if (b.bins[y * b.width + x] > 0) { s.add(x); break; }
    }
  }
  return s;
}

describe("computeWaveform 波形图", () => {
  it("纯黑落在最底行、纯白落在最顶行（纵轴翻转正确）", () => {
    const black = computeWaveform(solid(32, 24, 0, 0, 0), "luma", 16);
    const white = computeWaveform(solid(32, 24, 255, 255, 255), "luma", 16);
    expect([...occupiedRows(black)]).toEqual([255]);
    expect([...occupiedRows(white)]).toEqual([0]);
  });

  it("中灰落在正中间行", () => {
    const gray = computeWaveform(solid(32, 24, 128, 128, 128), "luma", 16);
    const rows = [...occupiedRows(gray)];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe(255 - 128);
  });

  it("通道选择取对应分量而非亮度", () => {
    const img = solid(32, 24, 200, 10, 30);
    const r = computeWaveform(img, "r", 16);
    const g = computeWaveform(img, "g", 16);
    const b = computeWaveform(img, "b", 16);
    expect([...occupiedRows(r)]).toEqual([55]);
    expect([...occupiedRows(g)]).toEqual([245]);
    expect([...occupiedRows(b)]).toEqual([225]);
  });

  it("透明像素不计入；全透明时 max=0", () => {
    const empty = computeWaveform(solid(16, 16, 255, 255, 255, 0), "luma", 8);
    expect(empty.max).toBe(0);
    expect(occupiedRows(empty).size).toBe(0);
  });

  it("横向列映射覆盖输出宽度且不出界", () => {
    const out = computeWaveform(solid(64, 16, 100, 100, 100), "luma", 10);
    expect(out.width).toBe(10);
    expect(out.height).toBe(256);
    expect(occupiedCols(out).size).toBe(10);
    expect(out.max).toBeGreaterThan(0);
  });

  it("大图降采样不越界（stepFor 生效）", () => {
    const img = solid(300, 300, 180, 180, 180);
    const out = computeWaveform(img, "luma", 32);
    expect(out.max).toBeGreaterThan(0);
    for (const v of out.bins) expect(Number.isInteger(v)).toBe(true);
  });

  it("空图（0 宽）返回空密度图", () => {
    const out = computeWaveform({ data: new Uint8ClampedArray(0), width: 0, height: 10 });
    expect(out.max).toBe(0);
    expect(out.bins).toHaveLength(256 * 256);
  });
});

describe("computeParade 分量波形", () => {
  it("三个通道都出数且 slotWidth = floor(outW/3)", () => {
    const p = computeParade(solid(48, 32, 180, 90, 40), 384);
    expect(p.slotWidth).toBe(128);
    for (const key of ["r", "g", "b"] as const) {
      expect(p[key].width).toBe(128);
      expect(p[key].max).toBeGreaterThan(0);
    }
    expect([...occupiedRows(p.r)]).toEqual([75]);
    expect([...occupiedRows(p.g)]).toEqual([165]);
    expect([...occupiedRows(p.b)]).toEqual([215]);
  });

  it("outW 很小时 slotWidth 有 8 的下限", () => {
    const p = computeParade(solid(8, 8, 100, 100, 100), 9);
    expect(p.slotWidth).toBe(8);
  });
});

describe("computeVectorscope 矢量图", () => {
  it("中性灰落在正中心（无彩度）", () => {
    const out = computeVectorscope(solid(32, 32, 128, 128, 128), 64);
    expect([...occupiedRows(out)]).toEqual([32]);
    const cols = [...occupiedCols(out)];
    expect(cols).toHaveLength(1);
    expect(Math.abs(cols[0] - 32)).toBeLessThanOrEqual(1);
  });

  it("纯红/绿/蓝落在三个不同的象限（BT.601 色相角正确）", () => {
    const size = 128;
    const center = size / 2;
    const peak = (r: number, g: number, b: number) => {
      const out = computeVectorscope(solid(40, 40, r, g, b), size);
      // 取唯一命中点
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          if (out.bins[y * size + x] > 0) return { x, y };
        }
      }
      throw new Error("no hit");
    };
    const red = peak(255, 0, 0);
    const green = peak(0, 255, 0);
    const blue = peak(0, 0, 255);
    // 红：cb<0 → 偏左；cr>0 → 偏上
    expect(red.x).toBeLessThan(center);
    expect(red.y).toBeLessThan(center);
    // 绿：cb<0 → 偏左；cr<0 → 偏下
    expect(green.x).toBeLessThan(center);
    expect(green.y).toBeGreaterThan(center);
    // 蓝：cb>0 → 偏右；cr<0 → 偏下
    expect(blue.x).toBeGreaterThan(center);
    expect(blue.y).toBeGreaterThan(center);
  });

  it("透明像素不计入；全透明 max=0", () => {
    const out = computeVectorscope(solid(16, 16, 200, 100, 50, 0), 64);
    expect(out.max).toBe(0);
  });

  it("超饱和颜色夹在边界内（不越界写）", () => {
    const out = computeVectorscope(solid(16, 16, 255, 0, 255), 64);
    expect(out.max).toBeGreaterThan(0);
    for (const v of out.bins) expect(Number.isInteger(v)).toBe(true);
  });
});

describe("binIntensity 显示强度", () => {
  it("0 → 0，max → 1，中间单调递增", () => {
    expect(binIntensity(0, 100)).toBe(0);
    expect(binIntensity(100, 100)).toBe(1);
    expect(binIntensity(1, 100)).toBeGreaterThan(0);
    const a = binIntensity(2, 100);
    const b = binIntensity(20, 100);
    const c = binIntensity(80, 100);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it("max<=0 时恒为 0", () => {
    expect(binIntensity(5, 0)).toBe(0);
    expect(binIntensity(5, -1)).toBe(0);
  });
});
