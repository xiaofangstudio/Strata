/**
 * 色彩配置文件换算 + 自动对齐偏移估计。
 */
import { describe, expect, it } from "vitest";
import { convertProfile } from "../../src/core/colorProfile";
import { estimateShift } from "../../src/core/stackOps";
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

const solid = (r: number, g: number, b: number) => make(2, 2, () => [r, g, b, 255]);
const at = (buf: RgbaBuffer, x = 0, y = 0) => {
  const o = (y * buf.width + x) * 4;
  return [buf.data[o], buf.data[o + 1], buf.data[o + 2]];
};

describe("色彩配置文件换算", () => {
  it("同空间是恒等变换", () => {
    const src = solid(30, 120, 200);
    const out = convertProfile(src, "srgb", "srgb");
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it("白色在 sRGB / P3 / Adobe RGB 之间都还是白色", () => {
    const src = solid(255, 255, 255);
    for (const to of ["display-p3", "adobe-rgb"] as const) {
      const out = convertProfile(src, "srgb", to);
      expect(at(out)[0]).toBeGreaterThanOrEqual(253);
      expect(at(out)[1]).toBeGreaterThanOrEqual(253);
      expect(at(out)[2]).toBeGreaterThanOrEqual(253);
    }
  });

  it("sRGB 纯红转 P3 后红通道下降（P3 的红色原色更靠外）", () => {
    const src = solid(255, 0, 0);
    const out = convertProfile(src, "srgb", "display-p3");
    const [r, g] = at(out);
    expect(r).toBeLessThan(255);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(0);
  });

  it("sRGB → P3 → sRGB 往返误差在个位数以内", () => {
    const src = make(3, 1, (x) => {
      const cs: [number, number, number][] = [
        [200, 40, 40],
        [40, 160, 90],
        [30, 60, 200],
      ];
      const c = cs[x];
      return [c[0], c[1], c[2], 255];
    });
    const mid = convertProfile(src, "srgb", "display-p3");
    const back = convertProfile(mid, "display-p3", "srgb");
    for (let x = 0; x < 3; x += 1) {
      for (let c = 0; c < 3; c += 1) {
        expect(Math.abs(at(back, x)[c] - at(src, x)[c])).toBeLessThanOrEqual(4);
      }
    }
  });

  it("转灰度走线性光亮度再按 gamma 编码（纯红约 127，不是 54）", () => {
    const src = solid(255, 0, 0);
    const out = convertProfile(src, "srgb", "gray");
    // 色彩管理里的灰度是「相对亮度 Y」，Y=0.2126 经 gamma 编码 ≈ 0.50 → 127。
    // 注意这与「图像 > 模式 > 灰度」用的 gamma 空间加权（纯红 ≈ 76）不是一回事：
    // 那是模式转换，这里是配置文件转换。
    expect(at(out)[0]).toBeGreaterThan(120);
    expect(at(out)[0]).toBeLessThan(134);
    expect(at(out)[0]).toBe(at(out)[1]);
    expect(at(out)[1]).toBe(at(out)[2]);
  });

  it("灰度转彩色三通道相同", () => {
    const out = convertProfile(solid(128, 128, 128), "gray", "srgb");
    expect(at(out)).toEqual([128, 128, 128]);
  });
});

describe("自动对齐的偏移估计", () => {
  /**
   * 长周期平滑图案：几个不同波长/方向的正弦叠加。
   * 不要用「模 255 的线性斜坡」——那是周期约 7px 的锯齿，任何配准都会
   * 在伪周期上对错位（这个坑踩过）。
   */
  const pattern = (w: number, h: number, sx: number, sy: number) =>
    make(w, h, (x, y) => {
      const px = x - sx;
      const py = y - sy;
      const outside = px < 0 || py < 0 || px >= w || py >= h;
      const v = outside
        ? 20
        : 128 +
          40 * Math.sin(px / 9) +
          30 * Math.cos(py / 13) +
          25 * Math.sin((px + py) / 17) +
          18 * Math.cos((px - 2 * py) / 23);
      return [v, v, v, 255];
    });

  it("内容整体右移下移后，估计出的偏移量是对称的负值", () => {
    const ref = pattern(96, 96, 0, 0);
    const moved = pattern(96, 96, 6, 4);
    const { dx, dy } = estimateShift(ref, moved);
    expect(Math.abs(dx + 6)).toBeLessThanOrEqual(2);
    expect(Math.abs(dy + 4)).toBeLessThanOrEqual(2);
  });

  it("完全相同的两层估计偏移为 0", () => {
    const ref = pattern(64, 64, 0, 0);
    const same = pattern(64, 64, 0, 0);
    const { dx, dy } = estimateShift(ref, same);
    expect(Math.abs(dx)).toBeLessThanOrEqual(1);
    expect(Math.abs(dy)).toBeLessThanOrEqual(1);
  });
});
