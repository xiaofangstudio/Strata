import { describe, expect, it } from "vitest";
import { EditHistory } from "../../src/core/editHistory";
import { isTextEditingTarget } from "../../src/ui/hooks/useDialogUndo";

describe("EditHistory", () => {
  it("每次离散改动记一步，新的改动清空 redo 分支", () => {
    const h = new EditHistory(0);
    expect(h.settle(10)).toBe(true);
    expect(h.settle(20)).toBe(true);
    expect(h.canUndo).toBe(true);
    expect(h.canRedo).toBe(false);

    const back = h.step(20, "undo");
    expect(back).toEqual({ value: 10, changed: true });
    expect(h.canRedo).toBe(true);

    h.settle(30);
    expect(h.canRedo).toBe(false);
  });

  it("手势中的中间值不进历史，松手后整段只算一步", () => {
    const h = new EditHistory(0);
    h.settle(10); // 手势前已有的一个稳定状态
    expect(h.settle(11, true)).toBe(false);
    expect(h.settle(17, true)).toBe(false);
    expect(h.settle(23, true)).toBe(false);
    expect(h.depth).toBe(1);

    expect(h.settle(23, false)).toBe(true);
    expect(h.depth).toBe(2);
    expect(h.step(23, "undo")).toEqual({ value: 10, changed: true });
  });

  it("值没变时不记历史", () => {
    const h = new EditHistory(5);
    expect(h.settle(5)).toBe(false);
    expect(h.depth).toBe(0);
  });

  it("undo / redo 到头时安全 no-op", () => {
    const h = new EditHistory("a");
    expect(h.step("a", "undo")).toEqual({ value: "a", changed: false });
    expect(h.step("a", "redo")).toEqual({ value: "a", changed: false });
  });

  it("undo 后再 redo 回到同一个值", () => {
    const h = new EditHistory({ amount: 0 });
    const b = { amount: 8 };
    h.settle(b);

    const back = h.step(b, "undo");
    expect(back.changed).toBe(true);
    const forward = h.step(back.value, "redo");
    expect(forward).toEqual({ value: b, changed: true });
  });

  it("超过上限丢最旧的一步", () => {
    const h = new EditHistory(0, 3);
    for (let i = 1; i <= 5; i += 1) h.settle(i);
    expect(h.depth).toBe(3);

    let cur = 5;
    for (let i = 0; i < 3; i += 1) cur = h.step(cur, "undo").value;
    expect(cur).toBe(2); // 0 / 1 已被挤掉
    expect(h.step(cur, "undo").changed).toBe(false);
  });

  it("reset 清空整条历史", () => {
    const h = new EditHistory(0);
    h.settle(1);
    h.settle(2);
    h.reset(99);
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    expect(h.step(99, "undo").changed).toBe(false);
  });
});

describe("isTextEditingTarget", () => {
  it("文本类控件让位给原生撤销", () => {
    expect(isTextEditingTarget("INPUT", "text", false)).toBe(true);
    expect(isTextEditingTarget("INPUT", "number", false)).toBe(true);
    expect(isTextEditingTarget("TEXTAREA", "", false)).toBe(true);
    expect(isTextEditingTarget("DIV", "", true)).toBe(true);
  });

  it("滑杆 / 按钮 / 选择框不吞对话框撤销", () => {
    expect(isTextEditingTarget("INPUT", "range", false)).toBe(false);
    expect(isTextEditingTarget("INPUT", "checkbox", false)).toBe(false);
    expect(isTextEditingTarget("BUTTON", "", false)).toBe(false);
    expect(isTextEditingTarget("SELECT", "", false)).toBe(false);
  });
});
