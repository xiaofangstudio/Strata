/**
 * `src/engine/filters.ts` 的纯函数契约。
 *
 * filters.ts 里只有 `svgFilter` / `dropFilter` / `pruneFilters` / `clearFilters`
 * 碰 DOM；其余（传递函数生成、颜色换算、曲线插值、sRGB 传递）全是纯函数，
 * 因此可以在 node 环境下直接打真实断言。
 */
import { describe, expect, it } from "vitest";
import {
  clearFilters,
  clamp01,
  colorMatrixMarkup,
  convolveMarkup,
  curveTable,
  hexToRgb01,
  linearToSrgb,
  luma01,
  lumaMatrixMarkup,
  monotoneAt,
  motionMarkup,
  noiseMarkup,
  pruneFilters,
  rgb01ToHex,
  rgbTransfer,
  srgbToLinear,
  tableOf,
  uniDiscrete,
  uniLinear,
  uniTransfer,
} from "../../src/engine/filters";

const values = (markup: string, attr = "tableValues"): string[] => {
  const m = new RegExp(`${attr}="([^"]*)"`).exec(markup);
  return m ? m[1].split(" ") : [];
};

/** 取出同一属性的「全部」匹配值并摊平 —— rgbTransfer 每个通道各写一次。 */
const valuesAll = (markup: string, attr = "tableValues"): string[] =>
  [...markup.matchAll(new RegExp(`${attr}="([^"]*)"`, "g"))].flatMap((m) => m[1].split(" "));

describe("clamp01 / 颜色换算", () => {
  it("clamp01 把越界值夹到 0–1", () => {
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.25)).toBe(0.25);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(9)).toBe(1);
  });

  it("hexToRgb01 支持带 / 不带 #，非法输入退回中性灰", () => {
    expect(hexToRgb01("#ff0000")).toEqual([1, 0, 0]);
    expect(hexToRgb01("00ff00")).toEqual([0, 1, 0]);
    expect(hexToRgb01("#0000FF")).toEqual([0, 0, 1]);
    expect(hexToRgb01("#ffffff")).toEqual([1, 1, 1]);
    expect(hexToRgb01("#000000")).toEqual([0, 0, 0]);
    expect(hexToRgb01("#fffff")).toEqual([0.5, 0.5, 0.5]);
    expect(hexToRgb01("#gggggg")).toEqual([0.5, 0.5, 0.5]);
  });

  it("rgb01ToHex 往返一致并夹取越界值", () => {
    expect(rgb01ToHex([1, 0, 0])).toBe("#ff0000");
    expect(rgb01ToHex([0, 0, 0])).toBe("#000000");
    expect(rgb01ToHex([1, 1, 1])).toBe("#ffffff");
    // 2 夹到 1 → ff，-1 夹到 0 → 00，0.5 → 128 → 80
    expect(rgb01ToHex([2, -1, 0.5])).toBe("#ff0080");
  });
});

describe("sRGB 传递函数 / 亮度", () => {
  it("端点固定、越界被夹", () => {
    expect(linearToSrgb(0)).toBe(0);
    // 1.055·1^(1/2.4) − 0.055 在 IEEE-754 下约为 0.9999999999999999，
    // 是公式本身的浮点舍入，不是端值漂移，故用 toBeCloseTo 而非严格相等。
    expect(linearToSrgb(1)).toBeCloseTo(1, 12);
    expect(linearToSrgb(2)).toBeCloseTo(1, 12);
    expect(linearToSrgb(-1)).toBe(0);
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 12);
    expect(srgbToLinear(-1)).toBe(0);
  });

  it("编解码互为逆运算", () => {
    for (const v of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(srgbToLinear(linearToSrgb(v))).toBeCloseTo(v, 10);
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 10);
    }
  });

  it("luma01 使用 Rec.709 权重", () => {
    expect(luma01(1, 1, 1)).toBeCloseTo(1, 12);
    expect(luma01(1, 0, 0)).toBeCloseTo(0.2126, 12);
    expect(luma01(0, 1, 0)).toBeCloseTo(0.7152, 12);
    expect(luma01(0, 0, 1)).toBeCloseTo(0.0722, 12);
  });
});

describe("tableOf / 传递函数标记", () => {
  it("默认采样 33 级，首末点等于端值", () => {
    const out = tableOf((x) => x).split(" ");
    expect(out).toHaveLength(33);
    expect(out[0]).toBe("0.00000");
    expect(out[32]).toBe("1.00000");
  });

  it("采样结果被夹到 0–1", () => {
    expect(new Set(tableOf(() => 5).split(" "))).toEqual(new Set(["1.00000"]));
    expect(new Set(tableOf(() => -5).split(" "))).toEqual(new Set(["0.00000"]));
  });

  it("可指定采样级数", () => {
    expect(tableOf((x) => x, 3)).toBe("0.00000 0.50000 1.00000");
  });

  it("uniTransfer 三通道共用一张表", () => {
    const m = uniTransfer("0.00000 1.00000");
    expect(m).toContain('<feFuncR type="table" tableValues="0.00000 1.00000"');
    expect(m).toContain('<feFuncG type="table" tableValues="0.00000 1.00000"');
    expect(m).toContain('<feFuncB type="table" tableValues="0.00000 1.00000"');
    expect(m.startsWith("<feComponentTransfer>")).toBe(true);
  });

  it("uniTransfer 的 inRef 会写成 in 属性", () => {
    expect(uniTransfer("0", "luma")).toContain('<feComponentTransfer in="luma">');
  });

  it("rgbTransfer 三通道各走一条表", () => {
    const m = rgbTransfer("A", "B", "C");
    expect(valuesAll(m, "tableValues")).toEqual(["A", "B", "C"]);
  });

  it("uniDiscrete 生成离散台阶，最少 2 级", () => {
    const six = uniDiscrete(6);
    expect(six).toContain('type="discrete"');
    expect(values(six)).toEqual([
      "0.00000",
      "0.20000",
      "0.40000",
      "0.60000",
      "0.80000",
      "1.00000",
    ]);
    // 1 级会被抬到 2 级，避免退化成单点
    expect(values(uniDiscrete(1))).toEqual(["0.00000", "1.00000"]);
    // 3.4 → round → 3 级
    expect(values(uniDiscrete(3.4))).toEqual(["0.00000", "0.50000", "1.00000"]);
  });

  it("uniLinear 写出 slope / intercept（4 位小数）", () => {
    const m = uniLinear(2, -0.5);
    expect(m).toContain('slope="2.0000"');
    expect(m).toContain('intercept="-0.5000"');
    expect(m).toContain('type="linear"');
  });

  it("colorMatrixMarkup 输出 4×5 矩阵", () => {
    const rows = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
    const m = colorMatrixMarkup(rows);
    expect(m).toContain('<feColorMatrix type="matrix"');
    expect(values(m, "values")).toHaveLength(20);
  });

  it("convolveMarkup 由核长度推出 3×3 阶数", () => {
    const m = convolveMarkup([0, -1, 0, -1, 5, -1, 0, -1, 0]);
    expect(m).toContain('order="3"');
    expect(m).toContain('divisor="1.0000"');
    expect(m).toContain('edgeMode="duplicate"');
    expect(values(m, "kernelMatrix")).toHaveLength(9);
  });

  it("lumaMatrixMarkup 给结果命名并压成灰度", () => {
    const m = lumaMatrixMarkup("luma");
    expect(m).toContain('result="luma"');
    expect(values(m, "values")).toEqual([
      "0.2126", "0.7152", "0.0722", "0", "0",
      "0.2126", "0.7152", "0.0722", "0", "0",
      "0.2126", "0.7152", "0.0722", "0", "0",
      "0", "0", "0", "1", "0",
    ]);
  });
});

describe("motionMarkup / noiseMarkup", () => {
  it("动感模糊把距离按角度摊开", () => {
    expect(motionMarkup(0, 22)).toContain('stdDeviation="10.000 0.000"');
    expect(motionMarkup(90, 22)).toContain('stdDeviation="0.000 10.000"');
  });

  it("颗粒：单色走 saturate 0 + soft-light", () => {
    const m = noiseMarkup({
      size: 3,
      amount: 0.25,
      mono: true,
      mode: "soft-light",
      sharp: true,
      seed: 11,
    });
    expect(m).toContain('type="turbulence"');
    expect(m).toContain('type="saturate" values="0"');
    expect(m).toContain('intercept="0.2500"');
    expect(m).toContain('mode="soft-light"');
    expect(m).toContain('seed="11"');
  });

  it("杂色：彩色走 fractalNoise + overlay，强度被夹到 1", () => {
    const m = noiseMarkup({
      size: 4,
      amount: 2,
      mono: false,
      mode: "overlay",
      sharp: false,
      seed: 5,
    });
    expect(m).toContain('type="fractalNoise"');
    expect(m).toContain('baseFrequency="0.2500"');
    expect(m).toContain('intercept="1.0000"');
    expect(m).toContain('mode="overlay"');
    expect(m).not.toContain('type="saturate"');
  });
});

describe("曲线插值", () => {
  it("identity 曲线保持线性", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    expect(monotoneAt(pts, 0.5)).toBeCloseTo(0.5, 12);
    expect(monotoneAt(pts, 0.25)).toBeCloseTo(0.25, 12);
  });

  it("端点外不外推，空 / 单点有确定返回值", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.25 },
      { x: 1, y: 1 },
    ];
    expect(monotoneAt(pts, -1)).toBe(0);
    expect(monotoneAt(pts, 2)).toBe(1);
    expect(monotoneAt([], 0.42)).toBe(0.42);
    expect(monotoneAt([{ x: 0, y: 0.3 }], 0.9)).toBe(0.3);
  });

  it("curveTable 产出 33 级查找表", () => {
    const t = curveTable([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);
    const out = t.split(" ");
    expect(out).toHaveLength(33);
    expect(out[0]).toBe("0.00000");
    expect(out[32]).toBe("1.00000");
  });
});

describe("无 DOM 环境下的滤镜回收", () => {
  it("clearFilters / pruneFilters 在没有 SVG 根节点时不抛错", () => {
    expect(() => clearFilters()).not.toThrow();
    expect(() => pruneFilters(new Set(["a", "b"]))).not.toThrow();
  });
});
