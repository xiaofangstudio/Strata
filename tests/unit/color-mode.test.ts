/**
 * 颜色模式转换纯函数：位图 / 双色调 / 索引 / CMYK / Lab / 多通道。
 */
import { describe, expect, it } from "vitest";
import {
  applyPalette,
  medianCutPalette,
  splitChannels,
  toBitmap,
  toCmyk,
  toDuotone,
  toIndexed,
  toLab,
} from "../../src/core/colorMode";
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

const solid = (w: number, h: number, r: number, g: number, b: number) => make(w, h, () => [r, g, b, 255]);
const at = (buf: RgbaBuffer, x: number, y: number) => {
  const o = (y * buf.width + x) * 4;
  return [buf.data[o], buf.data[o + 1], buf.data[o + 2], buf.data[o + 3]];
};

describe("位图模式", () => {
  it("阈值以上全白、以下全黑，没有中间灰", () => {
    const src = make(4, 1, (x) => {
      const v = [40, 120, 140, 220][x];
      return [v, v, v, 255];
    });
    const out = toBitmap(src, 128, 0);
    expect(at(out, 0, 0)[0]).toBe(0);
    expect(at(out, 1, 0)[0]).toBe(0);
    expect(at(out, 2, 0)[0]).toBe(255);
    expect(at(out, 3, 0)[0]).toBe(255);
  });

  it("半调模式仍然只有黑白两色", () => {
    const src = solid(16, 16, 150, 150, 150);
    const out = toBitmap(src, 128, 4);
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i] === 0 || out.data[i] === 255).toBe(true);
    }
  });
});

describe("双色调", () => {
  it("暗部靠深色、亮部靠浅色", () => {
    const src = make(2, 1, (x) => (x === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const out = toDuotone(src, [10, 20, 60], [240, 220, 160], 100);
    expect(at(out, 0, 0)).toEqual([10, 20, 60, 255]);
    expect(at(out, 1, 0)).toEqual([240, 220, 160, 255]);
  });

  it("浓度 0 时保留原色", () => {
    const src = solid(2, 2, 200, 30, 30);
    const out = toDuotone(src, [0, 0, 0], [255, 255, 255], 0);
    expect(at(out, 1, 1)).toEqual([200, 30, 30, 255]);
  });
});

describe("索引颜色", () => {
  it("调色板数量不超过请求值", () => {
    const src = make(16, 16, (x, y) => [(x * 16) % 256, (y * 16) % 256, 128, 255]);
    const pal = medianCutPalette(src, 8);
    expect(pal.length).toBeLessThanOrEqual(8);
    expect(pal.length).toBeGreaterThan(0);
  });

  it("量化结果的每个像素都等于调色板中的某个颜色", () => {
    const src = make(12, 12, (x, y) => [(x * 20) % 256, (y * 20) % 256, (x * y) % 256, 255]);
    const { buf, palette } = toIndexed(src, 6, false);
    const key = new Set(palette.map((c) => `${c[0]},${c[1]},${c[2]}`));
    for (let i = 0; i < buf.data.length; i += 4) {
      expect(key.has(`${buf.data[i]},${buf.data[i + 1]},${buf.data[i + 2]}`)).toBe(true);
    }
  });

  it("纯色图量化后仍是那个颜色", () => {
    const src = solid(8, 8, 33, 66, 99);
    const { buf } = toIndexed(src, 4, false);
    expect(at(buf, 3, 3)).toEqual([33, 66, 99, 255]);
  });

  it("按调色板重新映射可换色", () => {
    const src = solid(4, 4, 10, 200, 10);
    const out = applyPalette(src, [[255, 0, 0]]);
    expect(at(out, 0, 0)).toEqual([255, 0, 0, 255]);
  });
});

describe("CMYK 模拟", () => {
  it("白色保持白色", () => {
    const out = toCmyk(solid(2, 2, 255, 255, 255), 300, 0);
    expect(at(out, 0, 0)[0]).toBe(255);
  });

  it("UCR 为 0 时灰度基本还原", () => {
    const out = toCmyk(solid(2, 2, 128, 128, 128), 400, 0);
    const [r] = at(out, 0, 0);
    expect(Math.abs(r - 128)).toBeLessThanOrEqual(2);
  });

  it("UCR 越高灰阶越暗（黑版加得多）", () => {
    const base = toCmyk(solid(2, 2, 128, 128, 128), 400, 0);
    const heavy = toCmyk(solid(2, 2, 128, 128, 128), 400, 80);
    expect(at(heavy, 0, 0)[0]).toBeLessThan(at(base, 0, 0)[0]);
  });

  it("油墨总量收紧后四色被等比压缩，画面变亮（墨少了）", () => {
    const src = solid(2, 2, 20, 10, 60);
    const loose = toCmyk(src, 400, 0);
    const tight = toCmyk(src, 120, 0);
    expect(at(tight, 0, 0)[0]).toBeGreaterThan(at(loose, 0, 0)[0]);
  });
});

describe("Lab 模拟", () => {
  it("彩度上限很大时往返误差很小", () => {
    const src = make(4, 1, (x) => {
      const cs: [number, number, number][] = [
        [200, 40, 40],
        [40, 160, 90],
        [30, 60, 200],
        [128, 128, 128],
      ];
      const c = cs[x];
      return [c[0], c[1], c[2], 255];
    });
    const out = toLab(src, 200);
    for (let x = 0; x < 4; x += 1) {
      const a = at(out, x, 0);
      const b = at(src, x, 0);
      expect(Math.abs(a[0] - b[0])).toBeLessThanOrEqual(3);
      expect(Math.abs(a[1] - b[1])).toBeLessThanOrEqual(3);
      expect(Math.abs(a[2] - b[2])).toBeLessThanOrEqual(3);
    }
  });

  it("彩度设小后颜色被收向中性", () => {
    const src = solid(2, 2, 255, 0, 0);
    const out = toLab(src, 30);
    const [r, g, b] = at(out, 0, 0);
    // 红被收色 → 绿蓝被抬高、红被压低
    expect(g).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(r).toBeLessThan(255);
  });
});

describe("多通道拆分", () => {
  it("拆出四张灰度图，取值与对应通道一致", () => {
    const src = make(1, 1, () => [10, 20, 30, 200]);
    const { channels, names } = splitChannels(src);
    expect(channels.length).toBe(4);
    expect(names.length).toBe(4);
    expect(channels[0].data[0]).toBe(10);
    expect(channels[1].data[0]).toBe(20);
    expect(channels[2].data[0]).toBe(30);
    expect(channels[3].data[0]).toBe(200);
    // 每张都是灰度（三通道同值）
    expect(channels[0].data[1]).toBe(10);
    expect(channels[0].data[2]).toBe(10);
  });
});
