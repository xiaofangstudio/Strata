/**
 * 软件混合（11 种 Canvas2D 不提供的模式）的纯数学校验。
 *
 * 只测公式本身，不碰画布 —— 逐像素路径的正确性完全取决于这几个公式，
 * 公式对了，合成式（alpha 混合）就是规范里那一条，不用重复验证。
 */
import { describe, expect, it } from "vitest";
import { SOFT_BLENDS, SOFT_DISSOLVE, isSoft } from "../../src/engine/blend";
import { BLEND_MODES, isSoftBlend, type BlendId } from "../../src/core/layer";

type Tri = readonly [number, number, number];

const call = (id: string, b: Tri, s: Tri): Tri => SOFT_BLENDS[id](b, s);

/** 浮点噪声下的逐通道近似相等。 */
const near = (got: readonly number[], want: readonly number[]): void => {
  expect(got).toHaveLength(want.length);
  got.forEach((v, i) => expect(v).toBeCloseTo(want[i], 6));
};

describe("软件混合公式", () => {
  it("线性加深：b + s - 1，且不为负", () => {
    near(call("linear-burn", [0.8, 0.8, 0.8], [0.6, 0.6, 0.6]), [0.4, 0.4, 0.4]);
    near(call("linear-burn", [0.2, 0.2, 0.2], [0.1, 0.1, 0.1]), [0, 0, 0]);
  });

  it("线性减淡：b + s，且不超过 1", () => {
    near(call("linear-dodge", [0.3, 0.3, 0.3], [0.4, 0.4, 0.4]), [0.7, 0.7, 0.7]);
    near(call("linear-dodge", [0.9, 0.9, 0.9], [0.9, 0.9, 0.9]), [1, 1, 1]);
  });

  it("线性光：b + 2s - 1", () => {
    near(call("linear-light", [0.5, 0.5, 0.5], [0.75, 0.75, 0.75]), [1, 1, 1]);
    near(call("linear-light", [0.5, 0.5, 0.5], [0.25, 0.25, 0.25]), [0, 0, 0]);
  });

  it("实色混合：只剩 0 或 1", () => {
    near(call("hard-mix", [0.7, 0.2, 0.5], [0.4, 0.9, 0.5]), [1, 1, 1]);
    near(call("hard-mix", [0.1, 0.1, 0.1], [0.1, 0.1, 0.1]), [0, 0, 0]);
  });

  it("减去 / 划分", () => {
    near(call("subtract", [0.9, 0.9, 0.9], [0.4, 0.4, 0.4]), [0.5, 0.5, 0.5]);
    near(call("divide", [0.8, 0.8, 0.8], [0.5, 0.5, 0.5]), [1, 1, 1]);
    // 除以 0 视为全白，不能出现 Infinity / NaN
    near(call("divide", [0.5, 0.5, 0.5], [0, 0, 0]), [1, 1, 1]);
  });

  it("点光：上层暗于中灰取更暗，亮于中灰取更亮", () => {
    near(call("pin-light", [0.6, 0.6, 0.6], [0.2, 0.2, 0.2]), [0.4, 0.4, 0.4]);
    near(call("pin-light", [0.6, 0.6, 0.6], [0.8, 0.8, 0.8]), [0.6, 0.6, 0.6]);
  });

  it("亮光：上下半程分别走加深 / 减淡", () => {
    // s = 0.25 → colorBurn(b, 0.5) = 1 - min(1, (1-b)/0.5)
    near(call("vivid-light", [0.5, 0.5, 0.5], [0.25, 0.25, 0.25]), [0, 0, 0]);
    // s = 0.75 → colorDodge(b, 0.5) = min(1, b/0.5)
    near(call("vivid-light", [0.8, 0.8, 0.8], [0.75, 0.75, 0.75]), [1, 1, 1]);
  });

  it("深色 / 浅色：按视亮度整体二选一，通道不混", () => {
    const dark: Tri = [0.9, 0.1, 0.1]; // 视亮度低
    const light: Tri = [0.1, 0.9, 0.9]; // 视亮度高
    near(call("darker-color", dark, light), dark);
    near(call("lighter-color", dark, light), light);
    // 底层换成更亮的那个，结论随之翻转 —— 证明比较的是亮度而非逐通道最小值
    near(call("darker-color", light, dark), dark);
    near(call("lighter-color", light, dark), light);
  });

  it("所有公式的输出都落在 0..1，且没有 NaN", () => {
    const samples = [0, 0.25, 0.5, 0.75, 1];
    for (const id of Object.keys(SOFT_BLENDS)) {
      for (const x of samples) {
        for (const y of samples) {
          const out = SOFT_BLENDS[id]([x, x, x], [y, y, y]);
          for (const v of out) {
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });
});

describe("软件混合清单与图层表一致", () => {
  it("blend.ts 认的模式，layer.ts 都标了 soft（反之亦然）", () => {
    for (const b of BLEND_MODES) {
      const inBlend = b.id === SOFT_DISSOLVE || b.id in SOFT_BLENDS;
      expect(isSoft(b.id)).toBe(inBlend);
      expect(isSoftBlend(b.id)).toBe(inBlend);
    }
  });

  it("16 GPU + 11 软件 = 27，且软件模式在 blend.ts 里都有实现", () => {
    const soft = BLEND_MODES.filter((b) => b.soft).map((b) => b.id as BlendId);
    expect(BLEND_MODES.length - soft.length).toBe(16);
    for (const id of soft) {
      expect(id === SOFT_DISSOLVE || id in SOFT_BLENDS).toBe(true);
    }
  });
});
