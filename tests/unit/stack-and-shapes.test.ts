/**
 * 堆栈模式（逐像素统计）与形状布尔运算的纯函数。
 */
import { describe, expect, it } from "vitest";
import { applyStackMode, type StackMode } from "../../src/core/stackModes";
import { combineAlpha } from "../../src/core/shapeCombine";
import type { RgbaBuffer } from "../../src/engine/filters/kernels";

function buf(values: number[]): RgbaBuffer {
  const data = new Uint8ClampedArray(values.length * 4);
  values.forEach((v, i) => {
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = v === 0 ? 0 : 255;
  });
  return { data, width: values.length, height: 1 };
}

const stack = (...sets: number[][]): RgbaBuffer[] => sets.map(buf);

describe("堆栈模式", () => {
  it("最大值取最亮的那层", () => {
    const out = applyStackMode(stack([10, 200], [90, 30], [50, 120]), "maximum");
    expect(out.data[0]).toBe(90);
    expect(out.data[4]).toBe(200);
  });

  it("最小值取最暗的那层", () => {
    const out = applyStackMode(stack([10, 200], [90, 30], [50, 120]), "minimum");
    expect(out.data[0]).toBe(10);
    expect(out.data[4]).toBe(30);
  });

  it("平均值是算术平均", () => {
    const out = applyStackMode(stack([10], [40], [130]), "mean");
    expect(out.data[0]).toBe(60);
  });

  it("中间值抗单点离群（去闪光/去路人）", () => {
    const out = applyStackMode(stack([50], [50], [255], [50], [50]), "median");
    expect(out.data[0]).toBe(50);
  });

  it("总和累加并夹到 255", () => {
    const out = applyStackMode(stack([10], [20], [30]), "summation");
    expect(out.data[0]).toBe(60);
    const clip = applyStackMode(stack([200], [200]), "summation");
    expect(clip.data[0]).toBe(255);
  });

  it("范围 = 最大值 - 最小值", () => {
    const out = applyStackMode(stack([10], [90], [40]), "range");
    expect(out.data[0]).toBe(80);
  });

  it("方差在样本全同为零、样本分散时为正", () => {
    const same = applyStackMode(stack([60], [60], [60]), "variance");
    expect(same.data[0]).toBe(0);
    const spread = applyStackMode(stack([0], [255]), "variance");
    expect(spread.data[0]).toBeGreaterThan(0);
  });

  it("标准偏差随离散度增大", () => {
    const small = applyStackMode(stack([100], [110]), "standardDeviation");
    const big = applyStackMode(stack([0], [200]), "standardDeviation");
    expect(big.data[0]).toBeGreaterThan(small.data[0]);
  });

  it("偏度在对称样本上落在中值附近", () => {
    const out = applyStackMode(stack([50], [100], [150]), "skewness");
    expect(Math.abs(out.data[0] - 128)).toBeLessThan(6);
  });

  it("峰度对尖峰样本给出更大值（同样 5 个样本）", () => {
    // 均匀分布 [80..120] 的尾巴很薄；含极端值的样本尾巴厚，峰度更大
    const light = applyStackMode(
      stack([80], [90], [100], [110], [120]),
      "kurtosis",
    );
    // 单点离群 = 尖峰厚尾（峰度应当更大）
    const heavy = applyStackMode(
      stack([100], [100], [100], [100], [200]),
      "kurtosis",
    );
    expect(heavy.data[0]).toBeGreaterThan(light.data[0]);
  });

  it("熵在样本全同时为 0", () => {
    const out = applyStackMode(stack([80], [80], [80], [80]), "entropy");
    expect(out.data[0]).toBe(0);
  });

  it("alpha 取平均（统计量只作用于颜色）", () => {
    const a: RgbaBuffer = { data: new Uint8ClampedArray([100, 100, 100, 255]), width: 1, height: 1 };
    const b: RgbaBuffer = { data: new Uint8ClampedArray([100, 100, 100, 0]), width: 1, height: 1 };
    const out = applyStackMode([a, b], "mean");
    expect(out.data[3]).toBe(128);
  });

  it("所有模式都能跑通且不越界", () => {
    const modes: StackMode[] = [
      "entropy", "kurtosis", "maximum", "mean", "median", "minimum",
      "range", "skewness", "standardDeviation", "summation", "variance",
    ];
    for (const m of modes) {
      const out = applyStackMode(stack([0, 128, 255], [30, 90, 200]), m);
      expect(out.width).toBe(3);
      for (const v of out.data) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(255);
      }
    }
  });
});

describe("形状布尔运算", () => {
  it("并集取较大覆盖率", () => {
    expect(combineAlpha(100, 200, "unite")).toBe(200);
    expect(combineAlpha(200, 100, "unite")).toBe(200);
  });

  it("减去顶层：下面的减上面的，不会为负", () => {
    expect(combineAlpha(200, 60, "subtract")).toBe(140);
    expect(combineAlpha(50, 200, "subtract")).toBe(0);
  });

  it("交集取较小覆盖率", () => {
    expect(combineAlpha(200, 60, "intersect")).toBe(60);
  });

  it("排除重叠取差值", () => {
    expect(combineAlpha(200, 60, "exclude")).toBe(140);
    expect(combineAlpha(60, 200, "exclude")).toBe(140);
  });

  it("空层参与时等价于恒等", () => {
    expect(combineAlpha(120, 0, "unite")).toBe(120);
    expect(combineAlpha(120, 0, "subtract")).toBe(120);
    expect(combineAlpha(120, 0, "exclude")).toBe(120);
    expect(combineAlpha(120, 0, "intersect")).toBe(0);
  });
});
