import { describe, expect, it } from "vitest";
import {
  dabFalloff,
  normSmudgeAngle,
  rotatedTipNorm,
  sampleAvg,
  smudgeDeltaStamp,
  smudgeStamp,
} from "../../src/engine/smudge";

function img(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return data;
}

describe("涂抹工具纯函数", () => {
  it("取样只取圆内、按 alpha 加权，透明区域不把颜色拉黑", () => {
    const data = img(9, 9, () => [200, 100, 50, 255]);
    const c = sampleAvg(data, 9, 9, 4, 4, 2);
    expect(c[0]).toBeCloseTo(200, 0);
    expect(c[1]).toBeCloseTo(100, 0);
    expect(c[2]).toBeCloseTo(50, 0);
  });

  it("混合是朝取样色靠拢，不会越界，也不会一次盖死", () => {
    const data = img(9, 9, () => [0, 0, 0, 255]);
    smudgeStamp(data, 9, 9, 4, 4, 2, [200, 100, 50, 255], 0.25, 100);
    const center = (4 * 9 + 4) * 4;
    expect(data[center]).toBe(50);
    expect(data[center + 1]).toBe(25);
    expect(data[center + 2]).toBeGreaterThan(10);
    expect(data[center]).toBeLessThan(200);
  });

  it("增量画布保持预乘前 RGBA 合法，透明底色不会被画黑", () => {
    const delta = img(9, 9, () => [0, 0, 0, 0]);
    smudgeDeltaStamp(delta, 9, 9, 4, 4, 2, [200, 100, 50, 255], 0.4, 100);
    const i = (4 * 9 + 4) * 4;
    expect(delta[i + 3]).toBeGreaterThan(0);
    expect(delta[i]).toBeGreaterThan(60);
    expect(delta[i]).toBeLessThanOrEqual(200);
    expect(delta[i + 3]).toBeLessThanOrEqual(255);
  });

  it("遮罩外不落色；边缘羽化按硬度渐变", () => {
    const data = img(9, 9, () => [0, 0, 0, 255]);
    const mask = img(9, 9, (x) => [0, 0, 0, x < 5 ? 255 : 0]);
    smudgeStamp(data, 9, 9, 4, 4, 2, [255, 255, 255, 255], 0.5, 100, mask);
    expect(data[(4 * 9 + 3) * 4]).toBeGreaterThan(120);
    expect(data[(4 * 9 + 5) * 4]).toBe(0);
    expect(dabFalloff(0, 4, 100)).toBe(1);
    expect(dabFalloff(3.9, 4, 100)).toBe(1);
    expect(dabFalloff(4, 4, 100)).toBe(0);
    expect(dabFalloff(3, 4, 0)).toBeGreaterThan(0);
    expect(dabFalloff(3, 4, 0)).toBeLessThan(1);
  });

  it("涂抹角度规整为整数 −180…180", () => {
    expect(normSmudgeAngle(45.6)).toBe(46);
    expect(normSmudgeAngle(181)).toBe(-179);
    expect(normSmudgeAngle(-181)).toBe(179);
    expect(normSmudgeAngle(Number.NaN)).toBe(0);
  });

  it("椭圆笔尖的长短轴方向不同，正圆时角度不改变形状", () => {
    const shape = { angleDeg: 0, roundness: 50 };
    expect(rotatedTipNorm(8, 0, 10, shape)).toBeLessThan(1);
    expect(rotatedTipNorm(0, 8, 10, shape)).toBeGreaterThan(1);
    expect(rotatedTipNorm(8, 0, 10, { angleDeg: 90, roundness: 50 })).toBeGreaterThan(1);
    expect(rotatedTipNorm(6, 6, 10, { angleDeg: 37, roundness: 100 })).toBeCloseTo(
      Math.hypot(6, 6) / 10,
      6,
    );
  });

  it("角度真的改变取样像素，不是挂在选项栏上的假控件", () => {
    // 横向色带：椭圆长轴沿 X 时会把右侧亮色带进取样，旋转 90° 后不会。
    const data = img(31, 31, (x) => [(x > 17 ? 255 : 0), 0, 0, 255]);
    const flat = sampleAvg(data, 31, 31, 15, 15, 10, { angleDeg: 0, roundness: 45 });
    const turned = sampleAvg(data, 31, 31, 15, 15, 10, { angleDeg: 90, roundness: 45 });
    expect(flat[0]).toBeGreaterThan(turned[0] + 20);
  });
});
