import { describe, expect, it } from "vitest";
import {
  normalizeSettings,
  parseList,
  pickPreset,
  pickRecent,
  pushRecent,
  upsertPreset,
} from "../../src/core/newDocSettings";

describe("新建文档设置库", () => {
  it("设置解析：合法通过、越界夹不住的整条拒绝", () => {
    expect(normalizeSettings({ w: 1920, h: 1080, dpi: 72, bg: "white" })).toEqual({
      w: 1920,
      h: 1080,
      dpi: 72,
      bg: "white",
    });
    // 任意颜色走十六进制。
    expect(normalizeSettings({ w: 100, h: 100, dpi: 300, bg: "#123abc" })).toBeTruthy();
    // 越界 / 非法背景整条拒绝，不猜。
    expect(normalizeSettings({ w: 0, h: 100, dpi: 72, bg: "white" })).toBeNull();
    expect(normalizeSettings({ w: 99999, h: 100, dpi: 72, bg: "white" })).toBeNull();
    expect(normalizeSettings({ w: 100, h: 100, dpi: 0, bg: "white" })).toBeNull();
    expect(normalizeSettings({ w: 100, h: 100, dpi: 72, bg: "red" })).toBeNull();
    expect(normalizeSettings("x")).toBeNull();
  });

  it("recent：重复设置先去重再置顶，封顶 8 条", () => {
    const a = { w: 1920, h: 1080, dpi: 72, bg: "white" };
    const b = { w: 1080, h: 1080, dpi: 72, bg: "transparent" };
    let list = pushRecent([], a, 100);
    list = pushRecent(list, b, 200);
    list = pushRecent(list, a, 300);
    expect(list.map((e) => e.at)).toEqual([300, 200]);
    for (let i = 0; i < 12; i += 1) {
      list = pushRecent(list, { ...a, w: 100 + i }, 400 + i);
    }
    expect(list.length).toBe(8);
    expect(list[0].w).toBe(111);
  });

  it("命名预设：同名覆盖保留原位置语义（移除旧的追加新的），空名不进", () => {
    let list = upsertPreset([], { name: "缩略图", w: 300, h: 300, dpi: 72, bg: "white" });
    list = upsertPreset(list, { name: "长图", w: 800, h: 3000, dpi: 72, bg: "white" });
    list = upsertPreset(list, { name: "缩略图", w: 400, h: 400, dpi: 72, bg: "black" });
    expect(list.map((p) => p.name)).toEqual(["长图", "缩略图"]);
    expect(list[1].w).toBe(400);
    expect(upsertPreset(list, { name: "  ", w: 1, h: 1, dpi: 1, bg: "white" })).toBe(list);
    // 非法设置不落库。
    expect(
      upsertPreset(list, { name: "坏", w: 0, h: 1, dpi: 1, bg: "white" }),
    ).toBe(list);
  });

  it("localStorage 解析：坏 JSON 与坏条目丢弃，好条目保留", () => {
    const raw = JSON.stringify([
      { w: 800, h: 600, dpi: 72, bg: "white", at: 123 },
      "垃圾",
      { w: -1, h: 2, dpi: 2, bg: "white" },
      { w: 300, h: 300, dpi: 72, bg: "black", name: "方图" },
    ]);
    // recent 视角不看 name：800×600 与 300×300 两条都是合法设置。
    expect(parseList(raw, pickRecent)).toEqual([
      { w: 800, h: 600, dpi: 72, bg: "white", at: 123 },
      { w: 300, h: 300, dpi: 72, bg: "black", at: 0 },
    ]);
    expect(parseList(raw, pickPreset)).toEqual([
      { w: 300, h: 300, dpi: 72, bg: "black", name: "方图" },
    ]);
    expect(parseList("不是 JSON", pickRecent)).toEqual([]);
    expect(parseList(null, pickRecent)).toEqual([]);
    // 缺 at 的 recent 给 0 而不是整条丢。
    expect(parseList(JSON.stringify([{ w: 1, h: 1, dpi: 1, bg: "black" }]), pickRecent)).toEqual([
      { w: 1, h: 1, dpi: 1, bg: "black", at: 0 },
    ]);
  });
});
