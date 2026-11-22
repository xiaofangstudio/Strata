import { describe, expect, it } from "vitest";
import { parseNumericExpression } from "../../src/ui/numericExpression";

const o = (current?: number) => ({ min: 0, max: 200, current, dpi: 96 });

describe("parseNumericExpression — 专业数值框表达式", () => {
  it("普通数字与 clamp", () => {
    expect(parseNumericExpression("120", o())).toMatchObject({ ok: true, value: 120 });
    expect(parseNumericExpression("999", o())).toMatchObject({ ok: true, value: 200 });
    expect(parseNumericExpression("-5", o())).toMatchObject({ ok: true, value: 0 });
  });

  it("四则运算与括号、运算优先级", () => {
    expect(parseNumericExpression("120+10", o())).toMatchObject({ ok: true, value: 130 });
    expect(parseNumericExpression("(40+8)*2", o())).toMatchObject({ ok: true, value: 96 });
    expect(parseNumericExpression("100/4+25", o())).toMatchObject({ ok: true, value: 50 });
    expect(parseNumericExpression("2*3+4*5", o())).toMatchObject({ ok: true, value: 26 });
  });

  it("百分号 = 相对 min..max 区间，不是简单除以 100", () => {
    expect(parseNumericExpression("50%", o())).toMatchObject({ ok: true, value: 100 });
    expect(parseNumericExpression("25%", { min: -100, max: 100 })).toMatchObject({
      ok: true,
      value: -50,
    });
  });

  it("单位按 dpi 换算成像素值", () => {
    expect(parseNumericExpression("1in", o())).toMatchObject({ ok: true, value: 96 });
    expect(parseNumericExpression("1cm", o()).value).toBeCloseTo(37.795, 2);
    expect(parseNumericExpression("12pt", o()).value).toBeCloseTo(16, 5);
    expect(parseNumericExpression("25mm", o()).value).toBeCloseTo(94.488, 2);
  });

  it("+=/-= 相对当前值，不与负数字面量歧义", () => {
    expect(parseNumericExpression("+=12", o(100))).toMatchObject({ ok: true, value: 112 });
    expect(parseNumericExpression("-=30", o(100))).toMatchObject({ ok: true, value: 70 });
    expect(parseNumericExpression("-5", o(100))).toMatchObject({ ok: true, value: 0 }); // 绝对值，非相对
  });

  it("表达式里也能用单位与百分号", () => {
    expect(parseNumericExpression("1in+8", o()).value).toBe(104);
    expect(parseNumericExpression("50%+8", o()).value).toBe(108);
  });

  it("非法输入绝不出 NaNaN / Infinity，返回当前值或 min", () => {
    expect(parseNumericExpression("1/0", o(50)).ok).toBe(false);
    expect(parseNumericExpression("1/0", o(50)).value).toBe(50);
    expect(parseNumericExpression("(", o(50)).ok).toBe(false);
    expect(parseNumericExpression("12)", o(50)).ok).toBe(false);
    expect(parseNumericExpression("1..2", o(50)).ok).toBe(false);
    expect(parseNumericExpression("abc", o(50)).ok).toBe(false);
    expect(parseNumericExpression("2furlong", o(50)).ok).toBe(false);
    expect(parseNumericExpression("1+", o(50)).ok).toBe(false);
    expect(parseNumericExpression("", o(50)).ok).toBe(false);
    expect(parseNumericExpression("1==1", o(50)).ok).toBe(false);
  });

  it("缺 current 时相对调整安全失败", () => {
    expect(parseNumericExpression("+=10", o()).ok).toBe(false);
  });

  it("没有任何 eval 注入面：JS 关键字与方括号全部拒绝", () => {
    expect(parseNumericExpression("alert(1)", o(50)).ok).toBe(false);
    expect(parseNumericExpression("window[0]", o(50)).ok).toBe(false);
  });
});
