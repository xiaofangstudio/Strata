import { describe, expect, it } from "vitest";
import { reorderDockPanel, sanitizeDockOrder } from "../../src/core/dockLayout";

const ALL = ["navigator", "color", "props", "layers", "history"] as const;
type G = (typeof ALL)[number];

describe("dock layout", () => {
  it("拖到可见面板之前", () => {
    const order: G[] = ["navigator", "color", "props", "layers", "history"];
    const visible: G[] = ["color", "props", "layers"];
    expect(reorderDockPanel(order, visible, "layers", 0)).toEqual([
      "navigator", "layers", "color", "props", "history",
    ]);
  });

  it("拖到可见面板之后（落点等于可见长度）", () => {
    const order: G[] = ["navigator", "color", "props", "layers", "history"];
    const visible: G[] = ["color", "props"];
    expect(reorderDockPanel(order, visible, "color", 2)).toEqual([
      "navigator", "props", "color", "layers", "history",
    ]);
  });

  it("不动时保持原顺序", () => {
    const order: G[] = ["color", "props", "layers"];
    expect(reorderDockPanel(order, order, "props", 1)).toEqual(order);
    expect(reorderDockPanel(order, order, "props", 2)).toEqual(order);
  });

  it("越界落点被夹住，不产生重复或丢失", () => {
    const order: G[] = ["color", "props", "layers"];
    const next = reorderDockPanel(order, order, "layers", 999);
    expect([...next].sort()).toEqual([...order].sort());
    expect(next).toEqual(order);
    expect(reorderDockPanel(order, order, "color", -5)).toEqual(order);
  });

  it("隐藏面板的相对位置不被打乱", () => {
    const order: G[] = ["navigator", "color", "history", "props", "layers"];
    const visible: G[] = ["color", "props", "layers"];
    expect(reorderDockPanel(order, visible, "layers", 1)).toEqual([
      "navigator", "color", "history", "layers", "props",
    ]);
  });

  it("工作区顺序：脏 id 丢弃、重复去重、缺项补齐", () => {
    const valid = (v: unknown): v is G => typeof v === "string" && (ALL as readonly string[]).includes(v);
    expect(sanitizeDockOrder(["props", "props", "bogus", "color"], ALL, valid)).toEqual([
      "props", "color", "navigator", "layers", "history",
    ]);
    expect(sanitizeDockOrder([], ALL, valid)).toEqual([...ALL]);
  });
});
