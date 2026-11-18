/**
 * 滤镜库效果堆栈核心契约：链式应用、显隐、重排，且绝不改 activeLayerId。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { docFromBlank, type StrataDoc } from "../../src/core/document";
import { newAdjustState } from "../../src/core/layer";
import { applyFilterStack, itemState, moveItem, toggleItem, type FilterStackItem } from "../../src/core/filterStack";
import { installDomStub, type DomStub } from "../helpers/canvas";

let dom: DomStub;
beforeAll(() => { dom = installDomStub(); });
afterAll(() => { dom.restore(); });

const blank = (w = 60, h = 60): StrataDoc => docFromBlank(w, h);
const item = (uid: string, id: FilterStackItem["id"], visible = true): FilterStackItem => ({
  uid, id, params: newAdjustState(id).params, visible,
});

describe("applyFilterStack", () => {
  it("空堆栈返回原文档同引用", () => {
    const doc = blank();
    expect(applyFilterStack(doc, []).doc).toBe(doc);
    expect(applyFilterStack(doc, []).applied).toBe(0);
  });

  it("全部隐藏时不产生任何效果", () => {
    const doc = blank();
    const r = applyFilterStack(doc, [item("1", "blur", false), item("2", "sharpen", false)]);
    expect(r.doc).toBe(doc);
    expect(r.applied).toBe(0);
  });

  it("两个效果链式叠加，应用计数为 2", () => {
    const doc = blank();
    const r = applyFilterStack(doc, [item("1", "blur"), item("2", "grain")]);
    expect(r.applied).toBe(2);
    expect(r.doc).not.toBe(doc);
    expect(r.doc.layers).not.toBe(doc.layers);
  });

  it("活动层 id 不变（铁律）", () => {
    const doc = blank();
    const active = doc.activeLayerId;
    const r = applyFilterStack(doc, [item("1", "blur"), item("2", "sharpen")]);
    expect(r.doc.activeLayerId).toBe(active);
    expect(active).toBe(doc.activeLayerId);
  });

  it("隐藏项跳过、可见项照常应用", () => {
    const doc = blank();
    const r = applyFilterStack(doc, [item("1", "blur", false), item("2", "grain")]);
    expect(r.applied).toBe(1);
  });

  it("同种类可以叠两次（uid 与调整种类无关）", () => {
    const doc = blank();
    const r = applyFilterStack(doc, [item("a", "blur"), item("b", "blur")]);
    expect(r.applied).toBe(2);
  });

  it("锁定活动层时不崩、返回原文档", () => {
    const doc = blank();
    const locked: StrataDoc = {
      ...doc,
      layers: doc.layers.map((l, i) => (i === 0 ? { ...l, locked: true } : l)),
    };
    const r = applyFilterStack(locked, [item("1", "blur")]);
    expect(r.applied).toBe(0);
    expect(r.doc).toBe(locked);
  });

  it("itemState 只取 id 与 params，不带 uid/visible", () => {
    const it = item("xyz", "sharpen", false);
    expect(itemState(it)).toEqual({ id: "sharpen", params: it.params });
  });
});

describe("堆栈操作纯函数", () => {
  const items = [item("1", "blur"), item("2", "grain"), item("3", "sharpen")];

  it("moveItem 上移/下移，不改原数组", () => {
    const up = moveItem(items, 2, 0);
    expect(up.map((x) => x.uid)).toEqual(["3", "1", "2"]);
    expect(items.map((x) => x.uid)).toEqual(["1", "2", "3"]);
    const down = moveItem(items, 0, 2);
    expect(down.map((x) => x.uid)).toEqual(["2", "3", "1"]);
  });

  it("moveItem 越界原样复制", () => {
    expect(moveItem(items, -1, 0)).toEqual(items);
    expect(moveItem(items, 0, 99)).toEqual(items);
    expect(moveItem(items, 1, 1)).toEqual(items);
  });

  it("toggleItem 切换显隐、不改原数组", () => {
    const out = toggleItem(items, 1);
    expect(out[1].visible).toBe(false);
    expect(items[1].visible).toBe(true);
    expect(toggleItem(items, 99)).toEqual(items);
  });

  it("不同顺序都完整应用全部可见项", () => {
    const doc = blank();
    const a = applyFilterStack(doc, [item("1", "blur"), item("2", "sharpen")]);
    const b = applyFilterStack(doc, [item("2", "sharpen"), item("1", "blur")]);
    // canvas 桩不真画像素，无法断言两种顺序的像素差异（那是 e2e 的活）；
    // 这里只钉控制流：顺序无关地全部应用、都产生新文档、活动层都不变。
    expect(a.applied).toBe(2);
    expect(b.applied).toBe(2);
    expect(a.doc).not.toBe(doc);
    expect(b.doc).not.toBe(doc);
    expect(a.doc.activeLayerId).toBe(doc.activeLayerId);
    expect(b.doc.activeLayerId).toBe(doc.activeLayerId);
    // 顺序由 items 数组顺序决定，重排逻辑由 moveItem 的测试钉死
  });
});
