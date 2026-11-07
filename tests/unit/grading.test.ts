/**
 * 调色台内核（engine/grading.ts）。
 *
 * 逐项验证「滑杆一动，像素该往哪儿走」：白平衡的冷暖方向、Lift 抬底、
 * Gain 只动亮部、对比度绕轴心、饱和归零、色相旋转、色轮按亮度分档、
 * 切片器只碰目标色相。所有断言都对着真实数值，不看截图。
 */
import { describe, expect, it } from "vitest";
import {
  applyGrade,
  curveToTable,
  gradeIsNeutral,
  neutralGrade,
  SLICER_RANGES,
} from "../../src/engine/grading";
import { makeBuffer, type RgbaBuffer } from "../../src/engine/filters/kernels";

/** 造一张 1×N 的图，每像素给一个 RGB。 */
function strip(colors: [number, number, number][]): RgbaBuffer {
  const buf = makeBuffer(colors.length, 1);
  colors.forEach(([r, g, b], i) => {
    buf.data[i * 4] = r;
    buf.data[i * 4 + 1] = g;
    buf.data[i * 4 + 2] = b;
    buf.data[i * 4 + 3] = 255;
  });
  return buf;
}

const px = (buf: RgbaBuffer, i: number): [number, number, number] => [
  buf.data[i * 4],
  buf.data[i * 4 + 1],
  buf.data[i * 4 + 2],
];

const run = (colors: [number, number, number][], patch: Record<string, number>) => {
  const p = { ...neutralGrade(), ...patch };
  return applyGrade(strip(colors), p);
};

describe("中性参数", () => {
  it("全默认时逐字节不变（等于不处理）", () => {
    const src = strip([
      [0, 0, 0],
      [128, 64, 32],
      [255, 255, 255],
    ]);
    const out = applyGrade(src, neutralGrade());
    expect([...out.data]).toEqual([...src.data]);
  });

  it("gradeIsNeutral 认得出「没有改动」", () => {
    expect(gradeIsNeutral(neutralGrade())).toBe(true);
    expect(gradeIsNeutral({ ...neutralGrade(), temp: 5 })).toBe(false);
  });
});

describe("白平衡", () => {
  it("色温调暖：中灰的红升、蓝降", () => {
    const out = run([[128, 128, 128]], { temp: 60 });
    const [r, g, b] = px(out, 0);
    expect(r).toBeGreaterThan(128);
    expect(b).toBeLessThan(128);
    expect(Math.abs(g - 128)).toBeLessThan(6);
  });

  it("色温调冷：方向相反", () => {
    const out = run([[128, 128, 128]], { temp: -60 });
    const [r, , b] = px(out, 0);
    expect(r).toBeLessThan(128);
    expect(b).toBeGreaterThan(128);
  });
});

describe("Lift / Gamma / Gain", () => {
  it("Lift 抬黑：纯黑不再是 0，纯白基本不动", () => {
    const out = run([[0, 0, 0], [255, 255, 255]], { liftR: 40, liftG: 40, liftB: 40 });
    expect(px(out, 0)[0]).toBeGreaterThan(20);
    expect(px(out, 1)[0]).toBeGreaterThanOrEqual(250);
  });

  it("Gain 压亮：白变暗，黑保持不动", () => {
    const out = run([[0, 0, 0], [255, 255, 255]], { gainR: -50, gainG: -50, gainB: -50 });
    expect(px(out, 0)[0]).toBe(0);
    expect(px(out, 1)[0]).toBeLessThan(150);
  });

  it("Gamma 只明显动中间调：黑与白基本不动", () => {
    const out = run([[0, 0, 0], [128, 128, 128], [255, 255, 255]], {
      gammaR: 60,
      gammaG: 60,
      gammaB: 60,
    });
    expect(px(out, 0)[0]).toBeLessThan(3);
    expect(px(out, 2)[0]).toBeGreaterThan(250);
    expect(px(out, 1)[0]).toBeGreaterThan(140);
  });
});

describe("对比度与轴心", () => {
  it("轴心处像素几乎不动", () => {
    const out = run([[128, 128, 128]], { contrast: 80, pivot: 50 });
    expect(Math.abs(px(out, 0)[0] - 128)).toBeLessThan(4);
  });

  it("提高对比度：暗的更暗、亮的更亮", () => {
    const out = run([[64, 64, 64], [192, 192, 192]], { contrast: 60, pivot: 50 });
    expect(px(out, 0)[0]).toBeLessThan(64);
    expect(px(out, 1)[0]).toBeGreaterThan(192);
  });
});

describe("饱和度与色相", () => {
  it("饱和度 -100 后三通道归一（灰）", () => {
    const out = run([[200, 60, 40]], { sat: -100 });
    const [r, g, b] = px(out, 0);
    expect(Math.abs(r - g)).toBeLessThanOrEqual(2);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(2);
  });

  it("色相 +120°：红转绿", () => {
    const out = run([[200, 40, 40]], { hue: 120 });
    const [r, g, b] = px(out, 0);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });
});

describe("色轮按亮度分档", () => {
  it("暗部色轮偏红：暗像素被拉红，亮像素几乎不动", () => {
    // 色轮「上 = 红」，所以指针在正上方（y 为负）时才是偏红
    const p = { ...neutralGrade(), darkX: 0, darkY: -90 };
    const out = applyGrade(strip([[30, 30, 30], [230, 230, 230]]), p);
    const darkDelta = px(out, 0)[0] - 30;
    const lightDelta = px(out, 1)[0] - 230;
    expect(darkDelta).toBeGreaterThan(6);
    expect(lightDelta).toBeLessThan(3);
  });

  it("全局色轮对暗亮都有效", () => {
    const p = { ...neutralGrade(), globX: 90 };
    const out = applyGrade(strip([[30, 30, 30], [200, 200, 200]]), p);
    expect(px(out, 0)[0]).toBeGreaterThan(30);
    expect(px(out, 1)[0]).toBeGreaterThan(200);
  });
});

describe("色轮方向与色相环一致", () => {
  /** 中性灰过一遍色轮，返回三通道相对 128 的增量。 */
  const shift = (patch: Record<string, number>): [number, number, number] => {
    const out = run([[128, 128, 128]], patch);
    const [r, g, b] = px(out, 0);
    return [r - 128, g - 128, b - 128];
  };

  // 指针坐标：x 向右正、y 向下正。hue = atan2(x, -y)，即上=0°(红)、
  // 右=90°(黄绿)、下=180°(青)、左=270°(紫)。这四条断言就是色相环的
  // 视觉方向与内核数值方向的对照表 —— 任何一边被改反都会在这里失败。
  it("上 = 红：红通道最高，绿蓝同时被压低", () => {
    const [r, g, b] = shift({ globX: 0, globY: -80 });
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(1);
  });

  it("右 = 黄绿：绿通道最高，红次之，蓝被压低", () => {
    const [r, g, b] = shift({ globX: 80, globY: 0 });
    expect(g).toBeGreaterThan(r);
    expect(r).toBeGreaterThan(b);
  });

  it("下 = 青：绿蓝同升，红被压低", () => {
    const [r, g, b] = shift({ globX: 0, globY: 80 });
    expect(g).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(r);
  });

  it("左 = 紫：蓝通道最高，绿最低", () => {
    const [r, g, b] = shift({ globX: -80, globY: 0 });
    expect(b).toBeGreaterThan(r);
    expect(r).toBeGreaterThan(g);
  });
});

describe("色彩切片器", () => {
  const redKey = SLICER_RANGES.find((r) => r.key === "red")!;

  it("只动目标色相：红色被改，蓝色不动", () => {
    const p = { ...neutralGrade(), [`sl_${redKey.key}_sat`]: -100 };
    const out = applyGrade(strip([[220, 30, 30], [30, 30, 220]]), p);
    const [r1, g1, b1] = px(out, 0);
    // 红像素被抽掉饱和 → 三通道靠拢
    expect(Math.abs(r1 - g1)).toBeLessThan(Math.abs(220 - 30));
    const blue = px(out, 1);
    expect(blue).toEqual([30, 30, 220]);
  });

  it("亮度滑杆只影响目标色域", () => {
    const p = { ...neutralGrade(), [`sl_${redKey.key}_lum`]: 80 };
    const out = applyGrade(strip([[200, 40, 40], [40, 40, 200]]), p);
    expect(px(out, 0)[0]).toBeGreaterThan(200);
    expect(px(out, 1)).toEqual([40, 40, 200]);
  });
});

describe("曲线", () => {
  it("默认曲线表是线性的", () => {
    const t = curveToTable(undefined);
    expect(Math.round(t[0] * 255)).toBe(0);
    expect(Math.round(t[128] * 255)).toBe(128);
    expect(Math.round(t[255] * 255)).toBe(255);
  });

  it("把中点抬上去，中间调整体变亮", () => {
    const out = applyGrade(strip([[128, 128, 128]]), neutralGrade(), {
      rgb: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.7 },
        { x: 1, y: 1 },
      ],
    });
    expect(px(out, 0)[0]).toBeGreaterThan(150);
  });
});

describe("透明度与尺寸", () => {
  it("透明像素不被上色，尺寸保持不变", () => {
    const buf = makeBuffer(2, 1);
    buf.data[3] = 0; // 第 0 个像素全透明
    buf.data[4] = 200;
    buf.data[7] = 255;
    const out = applyGrade(buf, { ...neutralGrade(), temp: 80, darkX: 100 });
    expect(out.width).toBe(2);
    expect(out.height).toBe(1);
    expect(out.data[3]).toBe(0);
    expect(out.data[0]).toBe(0);
  });
});

describe("与调整层体系的接缝", () => {
  it("调色台是可新建的调整层、走像素级通路、默认参数中性", async () => {
    const { ADJUST_DEFS, newAdjustState } = await import("../../src/core/layer");
    const { isPixelAdjust } = await import("../../src/engine/adjustPixels");
    expect(ADJUST_DEFS.some((d) => d.id === "grade")).toBe(true);
    expect(isPixelAdjust("grade")).toBe(true);
    const st = newAdjustState("grade");
    expect(gradeIsNeutral(st.params)).toBe(true);
    // 参数个数 = 一级 19 + 色轮 16 + 切片器 21
    expect(Object.keys(st.params).length).toBe(56);
  });
});
