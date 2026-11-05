/**
 * adjust.wgsl 调整算子的纯函数校验（node 环境，不碰 WebGPU / DOM / Canvas）。
 *
 * adjust.wgsl 是「为后续接线做地基」的独立管线，尚未接入运行时，也没有真 WebGPU，
 * 因此这里做两件事：
 *   1) 校验导出的 WGSL 字符串：两份副本逐字一致、八个算子分支齐全、compute 骨架完整、
 *      「移植自 PhotoCraft」的来源声明仍在；
 *   2) 用纯 TS 复刻 WGSL 里八个算子的公式作为「参考实现」，逐项验证参数语义：
 *      中性参数恒等、具体数值、参数确实生效、输出恒在 0..1 且无 NaN、
 *      cs_main 的 alpha 原样保留。参考实现与 WGSL 的 switch 一一对应。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ADJUST_WGSL } from "../../src/engine/gpu/adjust.wgsl.ts";

/* ---------------------------------------------------------------- 两份 WGSL 文本一致 */

const here = dirname(fileURLToPath(import.meta.url));
const tsSource = readFileSync(resolve(here, "../../src/engine/gpu/adjust.wgsl.ts"), "utf8");
const wgslFile = readFileSync(resolve(here, "../../shaders/adjust.wgsl"), "utf8");

const OP_NAMES = [
  "brightness",
  "contrast",
  "exposure",
  "saturation",
  "hue",
  "temperature",
  "gamma",
  "levels",
] as const;

describe("adjust.wgsl 文本与结构", () => {
  it("ADJUST_WGSL 常量与 shaders/adjust.wgsl 逐字一致", () => {
    const m = /export const ADJUST_WGSL = `([\s\S]*?)`;/.exec(tsSource);
    if (!m) throw new Error("未能在 adjust.wgsl.ts 里提取 ADJUST_WGSL 模板字符串");
    expect(m[1].replace(/\r\n/g, "\n")).toBe(wgslFile.replace(/\r\n/g, "\n"));
  });

  it("compute 管线骨架齐全（@compute / workgroup_size / cs_main / 两个 binding / Params）", () => {
    expect(ADJUST_WGSL).toContain("@compute @workgroup_size(8, 8)");
    expect(ADJUST_WGSL).toContain("fn cs_main");
    expect(ADJUST_WGSL).toContain("struct AdjustParams");
    expect(ADJUST_WGSL).toContain("@group(0) @binding(0)");
    expect(ADJUST_WGSL).toContain("@group(0) @binding(1)");
    expect(ADJUST_WGSL).toContain("fn unpack(");
    expect(ADJUST_WGSL).toContain("fn pack(");
    expect(ADJUST_WGSL).toContain("fn apply_adjust(");
  });

  it("八个算子各有一条 case 分支与一个 fn 实现", () => {
    for (let op = 1; op <= 8; op += 1) {
      expect(ADJUST_WGSL).toContain(`case ${op}u:`);
    }
    for (const name of OP_NAMES) {
      expect(ADJUST_WGSL).toContain(`fn adjust_${name}(`);
    }
  });

  it("保留「移植自 PhotoCraft」的来源声明注释（MIT/Apache-2.0）", () => {
    expect(ADJUST_WGSL).toContain("ArtCraft PhotoCraft");
    expect(ADJUST_WGSL).toContain("MIT/Apache-2.0 双授权");
    expect(wgslFile).toContain("ArtCraft PhotoCraft");
  });
});

/* ---------------------------------------------------------------- 纯 TS 参考实现（复刻 WGSL 公式） */

type RGB = readonly [number, number, number];
type RGBA = readonly [number, number, number, number];
/** AdjustParams 的 p0..p8（f32）。 */
type Params = readonly [number, number, number, number, number, number, number, number, number];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp01v = (c: RGB): RGB => [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
const fract = (v: number): number => v - Math.floor(v);

const mk = (
  p0 = 0, p1 = 0, p2 = 0, p3 = 0, p4 = 0,
  p5 = 0, p6 = 0, p7 = 0, p8 = 0,
): Params => [p0, p1, p2, p3, p4, p5, p6, p7, p8];

/** 对齐 src/engine/filters.ts::srgbToLinear / linearToSrgb（WGSL::srgb_to_linear / linear_to_srgb）。 */
const srgbToLinear = (v: number): number => {
  const x = clamp01(v);
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};
const linearToSrgb = (v: number): number => {
  const x = clamp01(v);
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
};

/** 对齐 WGSL::rgb_to_hsl / hsl_to_rgb。 */
function rgbToHsl(c: RGB): RGB {
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  const l = (mx + mn) * 0.5;
  const d = mx - mn;
  if (d <= 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === c[0]) h = ((c[1] - c[2]) / d + (c[1] >= c[2] ? 0 : 6)) / 6;
  else if (mx === c[1]) h = ((c[2] - c[0]) / d + 2) / 6;
  else h = ((c[0] - c[1]) / d + 4) / 6;
  return [fract(h + 1), s, l];
}
function hueChannel(t0: number, p: number, q: number): number {
  let t = t0;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 0.5) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
function hslToRgb(hsl: RGB): RGB {
  const [h, s, l] = hsl;
  if (s <= 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hueChannel(h + 1 / 3, p, q), hueChannel(h, p, q), hueChannel(h - 1 / 3, p, q)];
}

/* ---- 八个算子 ---- */

// 1 brightness：c·(1+p0)
const refBrightness = (c: RGB, p0: number): RGB =>
  clamp01v([c[0] * (1 + p0), c[1] * (1 + p0), c[2] * (1 + p0)]);

// 2 contrast：(c-0.5)·(1+p0)+0.5
const refContrast = (c: RGB, p0: number): RGB =>
  clamp01v([
    (c[0] - 0.5) * (1 + p0) + 0.5,
    (c[1] - 0.5) * (1 + p0) + 0.5,
    (c[2] - 0.5) * (1 + p0) + 0.5,
  ]);

// 3 exposure：线性光域乘 2^EV + offset，再 pow(·,1/gamma) 回写
function refExposure(c: RGB, ev: number, offset: number, gamma: number): RGB {
  const gain = Math.pow(2, ev);
  const ig = 1 / Math.max(0.01, gamma);
  const ch = (v: number): number => {
    const lin = srgbToLinear(v) * gain + offset;
    const y = lin > 0 ? Math.pow(lin, ig) : 0;
    return linearToSrgb(y);
  };
  return [ch(c[0]), ch(c[1]), ch(c[2])];
}

// 4 saturation：以 Rec.709 亮度为轴线性缩放
function refSaturation(c: RGB, p0: number): RGB {
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return clamp01v([
    l + (1 + p0) * (c[0] - l),
    l + (1 + p0) * (c[1] - l),
    l + (1 + p0) * (c[2] - l),
  ]);
}

// 5 hue：HSL 色相旋转
function refHue(c: RGB, degrees: number): RGB {
  const hsl = rgbToHsl(c);
  return hslToRgb([fract(hsl[0] + degrees / 360 + 1), hsl[1], hsl[2]]);
}

// 6 temperature：暖抬红压蓝，色调走绿—洋红
function refTemperature(c: RGB, temp: number, tint: number): RGB {
  const gr = 1 + 0.32 * temp + 0.14 * tint;
  const gg = 1 - 0.2 * tint;
  const gb = 1 - 0.32 * temp + 0.14 * tint;
  return clamp01v([c[0] * gr, c[1] * gg, c[2] * gb]);
}

// 7 gamma：pow(c, 1/p0)
function refGamma(c: RGB, gamma: number): RGB {
  const inv = 1 / Math.max(gamma, 0.01);
  return clamp01v([
    Math.pow(Math.max(c[0], 0), inv),
    Math.pow(Math.max(c[1], 0), inv),
    Math.pow(Math.max(c[2], 0), inv),
  ]);
}

// 8 levels：输入色阶 → 灰度系数 → 输出色阶
function levelsChannel(
  v: number, inBlack: number, inWhite: number, invGamma: number,
  outBlack: number, outWhite: number,
): number {
  const span = Math.max(inWhite - inBlack, 1 / 255);
  const t = clamp01((v - inBlack) / span);
  const w = Math.pow(Math.max(t, 0), Math.max(invGamma, 0.001));
  return clamp01(outBlack + w * (outWhite - outBlack));
}
function refLevels(c: RGB, p: Params): RGB {
  const ch = (v: number): number => levelsChannel(v, p[0], p[1], p[2], p[3], p[4]);
  return [ch(c[0]), ch(c[1]), ch(c[2])];
}

/** 复刻 WGSL::apply_adjust 的 switch；未知 op 返回原色（恒等）。 */
function refApply(op: number, c: RGB, p: Params): RGB {
  switch (op) {
    case 1: return refBrightness(c, p[0]);
    case 2: return refContrast(c, p[0]);
    case 3: return refExposure(c, p[0], p[1], p[2]);
    case 4: return refSaturation(c, p[0]);
    case 5: return refHue(c, p[0]);
    case 6: return refTemperature(c, p[0], p[1]);
    case 7: return refGamma(c, p[0]);
    case 8: return refLevels(c, p);
    default: return c;
  }
}

/** 复刻 cs_main：unpack → apply_adjust → pack；alpha 原样保留。 */
function refApplyPixel(rgba8: RGBA, op: number, p: Params): RGBA {
  const c0 = rgba8[0] / 255;
  const c1 = rgba8[1] / 255;
  const c2 = rgba8[2] / 255;
  const a = rgba8[3] / 255;
  const rgb = refApply(op, [c0, c1, c2], p);
  const q = (v: number): number => Math.floor(clamp01(v) * 255 + 0.5) & 0xff;
  return [q(rgb[0]) / 255, q(rgb[1]) / 255, q(rgb[2]) / 255, q(a) / 255];
}

/* ---------------------------------------------------------------- 参数与样本 */

/** 各算子的「中性参数」——此时输出应等于输入。 */
const NEUTRAL: Record<number, Params> = {
  1: mk(0),
  2: mk(0),
  3: mk(0, 0, 1),          // EV=0, offset=0, gamma=1
  4: mk(0),
  5: mk(0),
  6: mk(0, 0),             // temp=0, tint=0
  7: mk(1),                // gamma=1
  8: mk(0, 1, 1, 0, 1),   // inBlack=0, inWhite=1, invGamma=1, outBlack=0, outWhite=1
};

/** 非中性参数集，用来验证「参数确实生效」与输出边界。 */
const ACTIVE: Record<number, Params> = {
  1: mk(0.6),
  2: mk(-0.7),
  3: mk(1.5, 0.05, 1.3),
  4: mk(-0.8),
  5: mk(120),
  6: mk(0.9, -0.4),
  7: mk(2.2),
  8: mk(0.2, 0.8, 1.6, 0.1, 0.9),
};

/** 0 / 255 / 中灰 / 原色 / 近黑近白等极值样本（0..1）。 */
const RGB_SAMPLES: readonly RGB[] = [
  [0, 0, 0],
  [1, 1, 1],
  [0.5, 0.5, 0.5],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [0.8, 0.2, 0.4],
  [1 / 255, 2 / 255, 3 / 255],
  [254 / 255, 253 / 255, 252 / 255],
  [0.1, 0.9, 0.35],
];

/** 8 位 RGBA：含全透明 / 半透明 / 不透明。 */
const RGBA_SAMPLES: readonly RGBA[] = [
  [0, 0, 0, 255],
  [255, 255, 255, 255],
  [128, 64, 32, 128],
  [10, 200, 100, 64],
  [255, 0, 0, 0],
  [1, 2, 3, 192],
];

const near = (got: RGB, want: RGB, eps = 1e-9): void => {
  for (let i = 0; i < 3; i += 1) expect(Math.abs(got[i] - want[i])).toBeLessThanOrEqual(eps);
};

/* ---------------------------------------------------------------- 测试 */

describe("adjust 算子：中性参数恒等", () => {
  for (let op = 1; op <= 8; op += 1) {
    it(`op ${op} (${OP_NAMES[op - 1]})：中性参数下 10 组样本逐像素不变`, () => {
      for (const c of RGB_SAMPLES) near(refApply(op, c, NEUTRAL[op]), c);
    });
  }

  it("未知 op（0 / 9 / 99）一律恒等", () => {
    for (const op of [0, 9, 99]) {
      for (const c of RGB_SAMPLES) near(refApply(op, c, ACTIVE[1]), c);
    }
  });
});

describe("adjust 算子：具体数值语义", () => {
  it("brightness p0=0.6：线性放大并 clamp 到 1", () => {
    near(refBrightness([0.2, 0.3, 0.4], 0.6), [0.32, 0.48, 0.64]);
    near(refBrightness([0.9, 0.9, 0.9], 0.6), [1, 1, 1]);
  });

  it("contrast p0=1：以 0.5 为轴拉开，两端 clamp", () => {
    near(refContrast([0, 0.5, 1], 1), [0, 0.5, 1]);
    near(refContrast([0.25, 0.75, 0.4], 1), [0, 1, 0.3]);
  });

  it("saturation p0=-1：完全去饱和成 Rec.709 灰度", () => {
    const l = 0.2126 * 0.8 + 0.7152 * 0.2 + 0.0722 * 0.4;
    near(refSaturation([0.8, 0.2, 0.4], -1), [l, l, l]);
  });

  it("hue +120°：纯红 → 纯绿（HSL 色相旋转）", () => {
    near(refHue([1, 0, 0], 120), [0, 1, 0]);
    near(refHue([1, 0, 0], 360), [1, 0, 0]); // 转一整圈回到原色
    near(refHue([0.5, 0.5, 0.5], 90), [0.5, 0.5, 0.5]); // 灰色无色相，不变
  });

  it("temperature temp=1：抬红压蓝，绿通道不动", () => {
    near(refTemperature([0.5, 0.5, 0.5], 1, 0), [0.66, 0.5, 0.34]);
  });

  it("gamma p0=2：pow(c, 0.5) 即开方", () => {
    near(refGamma([0.25, 0.25, 0.25], 2), [0.5, 0.5, 0.5]);
  });

  it("levels：输入 0.25..0.75 映射到 0..1，输出色阶再缩放", () => {
    const p = mk(0.25, 0.75, 1, 0, 1);
    near(refLevels([0, 0.5, 1], p), [0, 0.5, 1]);
    expect(levelsChannel(0, 0.25, 0.75, 1, 0, 1)).toBeCloseTo(0, 9);
    expect(levelsChannel(0.5, 0.25, 0.75, 1, 0, 1)).toBeCloseTo(0.5, 9);
    expect(levelsChannel(1, 0.25, 0.75, 1, 0, 1)).toBeCloseTo(1, 9);
    // 输出色阶 0.2..0.8：0 → 0.2，1 → 0.8
    expect(levelsChannel(0, 0, 1, 1, 0.2, 0.8)).toBeCloseTo(0.2, 9);
    expect(levelsChannel(1, 0, 1, 1, 0.2, 0.8)).toBeCloseTo(0.8, 9);
  });

  it("exposure：EV=+1 提亮、EV=-1 压暗，offset / gamma 参与运算", () => {
    const c: RGB = [0.4, 0.4, 0.4];
    const up = refExposure(c, 1, 0, 1);
    const down = refExposure(c, -1, 0, 1);
    expect(up[0]).toBeGreaterThan(c[0]);
    expect(down[0]).toBeLessThan(c[0]);
    near(refExposure(c, 0, 0, 1), c);
  });
});

describe("adjust 算子：参数生效 / 输出边界 / alpha 保留", () => {
  it("八个算子换上非中性参数后，至少有一组像素结果改变", () => {
    for (let op = 1; op <= 8; op += 1) {
      let changed = false;
      for (const c of RGB_SAMPLES) {
        const a = refApply(op, c, NEUTRAL[op]);
        const b = refApply(op, c, ACTIVE[op]);
        for (let i = 0; i < 3; i += 1) {
          if (Math.abs(a[i] - b[i]) > 1e-6) changed = true;
        }
      }
      expect(changed, `op ${op} 的参数未生效`).toBe(true);
    }
  });

  it("全部算子 × 全部参数 × 全部像素：输出有限且恒在 0..1", () => {
    for (let op = 1; op <= 8; op += 1) {
      for (const p of [NEUTRAL[op], ACTIVE[op], mk(-1), mk(3), mk(0, 0, 0.1)]) {
        for (const c of RGB_SAMPLES) {
          for (const v of refApply(op, c, p)) {
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it("cs_main 等价参考：alpha 通道原样保留，且 RGB 经 8 位量化", () => {
    for (let op = 1; op <= 8; op += 1) {
      for (const rgba of RGBA_SAMPLES) {
        const out = refApplyPixel(rgba, op, ACTIVE[op]);
        expect(out[3]).toBe(rgba[3] / 255);
        for (let i = 0; i < 3; i += 1) {
          expect(Number.isFinite(out[i])).toBe(true);
          expect(out[i] * 255).toBeCloseTo(Math.round(out[i] * 255), 9);
          expect(out[i]).toBeGreaterThanOrEqual(0);
          expect(out[i]).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
