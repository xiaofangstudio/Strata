/**
 * 数位板输入解析单测（六项差距全修 · 第 2 项）。
 * 纯函数，node 环境；不构造 PointerEvent。
 */
import { describe, expect, it } from "vitest";
import { penPressureOf, penSampleOf, tiltToBrush } from "../../src/engine/pen";

describe("penSampleOf", () => {
  it("鼠标 / 触摸没有数位板字段时给恒等采样", () => {
    const s = penSampleOf({ pressure: 0.5, pointerType: "mouse" });
    expect(s).toEqual({
      pressure: 0.5,
      tiltX: 0,
      tiltY: 0,
      twist: 0,
      eraser: false,
      pointerType: "mouse",
    });
  });

  it("完整笔事件解析倾角与自转", () => {
    const s = penSampleOf({
      pressure: 0.8,
      tiltX: 30,
      tiltY: -40,
      twist: 12,
      pointerType: "pen",
      buttons: 1,
    });
    expect(s.pressure).toBe(0.8);
    expect(s.tiltX).toBe(30);
    expect(s.tiltY).toBe(-40);
    expect(s.twist).toBe(12);
    expect(s.eraser).toBe(false);
  });

  it("buttons 位 32 与 button=5 都识别为擦除笔端", () => {
    expect(penSampleOf({ buttons: 33, pointerType: "pen" }).eraser).toBe(true);
    expect(penSampleOf({ button: 5, pointerType: "pen" }).eraser).toBe(true);
    expect(penSampleOf({ buttons: 1, pointerType: "pen" }).eraser).toBe(false);
  });

  it("越界值与缺失值都被夹紧，不产生 NaN", () => {
    const s = penSampleOf({ pressure: 3, tiltX: 200, tiltY: -200, twist: 999 });
    expect(s.pressure).toBe(1);
    expect(s.tiltX).toBe(90);
    expect(s.tiltY).toBe(-90);
    expect(s.twist).toBe(359);
    expect(penSampleOf(undefined).pointerType).toBe("mouse");
  });
});

describe("penPressureOf", () => {
  it("笔用真实压力，鼠标异常值退回 0.5", () => {
    expect(penPressureOf(penSampleOf({ pressure: 0.25, pointerType: "pen" }), true)).toBe(0.25);
    expect(penPressureOf(penSampleOf({ pressure: 0.5, pointerType: "mouse" }), true)).toBe(0.5);
  });

  it("关闭压感后一律 0.5", () => {
    expect(penPressureOf(penSampleOf({ pressure: 0.9, pointerType: "pen" }), false)).toBe(0.5);
  });
});

describe("tiltToBrush", () => {
  it("笔垂直时是恒等变换", () => {
    const s = penSampleOf({ tiltX: 0, tiltY: 0, twist: 0 });
    expect(tiltToBrush(s, 100)).toEqual({ roundnessScale: 1, spinDeg: 0, tilt: 0 });
  });

  it("倾斜强度为 0 时不形变", () => {
    const s = penSampleOf({ tiltX: 60, tiltY: 0, twist: 45 });
    expect(tiltToBrush(s, 0)).toEqual({ roundnessScale: 1, spinDeg: 0, tilt: 2 / 3 });
  });

  it("完全倾斜时圆度被压扁且有下限", () => {
    const s = penSampleOf({ tiltX: 90, tiltY: 0, twist: 0 });
    const t = tiltToBrush(s, 100);
    expect(t.tilt).toBe(1);
    expect(t.roundnessScale).toBeCloseTo(0.12);
    // 向右倾斜 → 方位角 0° → 椭圆短轴旋转 90°
    expect(t.spinDeg).toBe(90);
    expect(tiltToBrush(s, 200).roundnessScale).toBe(0.12);
  });

  it("自转叠加到旋转角上", () => {
    const s = penSampleOf({ tiltX: 90, tiltY: 0, twist: 30 });
    expect(tiltToBrush(s, 50).spinDeg).toBe(120);
  });
});
