import { describe, expect, it } from "vitest";
import { dabFalloff, sampleAvg, smudgeDeltaStamp, smudgeStamp } from "../../src/engine/smudge";

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
});
