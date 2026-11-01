/**
 * 批处理配方（core/recipe.ts）的解析契约。
 *
 * Droplet 文件是要被双击执行的 —— 坏配方绝不能带病运行，
 * 所以这里的每一条都是「不合法就必须拒绝」的硬约束。
 * （文档级操作链需要 canvas，按项目约定留在应用层验证。）
 */
import { describe, expect, it } from "vitest";
import { parseRecipe, recipeOpLabel } from "../../src/core/recipe";

const ok = {
  kind: "strata-droplet",
  version: 1,
  name: "发网图",
  ops: [{ op: "autoContrast" }, { op: "fit", maxSide: 1024 }, { op: "exportPng" }],
};

describe("合法配方", () => {
  it("正常配方原样通过", () => {
    const r = parseRecipe(JSON.stringify(ok));
    expect(r).not.toBeNull();
    expect(r?.name).toBe("发网图");
    expect(r?.ops.length).toBe(3);
  });

  it("kind 或 version 不对就拒绝", () => {
    expect(parseRecipe(JSON.stringify({ ...ok, kind: "other" }))).toBeNull();
    expect(parseRecipe(JSON.stringify({ ...ok, version: 2 }))).toBeNull();
  });

  it("空操作列表拒绝（一个什么都不做的配方没有意义）", () => {
    expect(parseRecipe(JSON.stringify({ ...ok, ops: [] }))).toBeNull();
  });

  it("fit 的 maxSide 必须 ≥ 16 的数字", () => {
    expect(parseRecipe(JSON.stringify({ ...ok, ops: [{ op: "fit", maxSide: 0 }] }))).toBeNull();
    expect(
      parseRecipe(JSON.stringify({ ...ok, ops: [{ op: "fit", maxSide: "big" }] })),
    ).toBeNull();
  });

  it("JPG 质量限制在 10–100", () => {
    expect(parseRecipe(JSON.stringify({ ...ok, ops: [{ op: "exportJpg", quality: 5 }] }))).toBeNull();
    expect(
      parseRecipe(JSON.stringify({ ...ok, ops: [{ op: "exportJpg", quality: 90 }] })),
    ).not.toBeNull();
  });

  it("不认识的 op 直接拒绝而不是悄悄跳过", () => {
    expect(parseRecipe(JSON.stringify({ ...ok, ops: [{ op: "nukeEverything" }] }))).toBeNull();
  });

  it("坏 JSON 与非对象输入都拒绝", () => {
    expect(parseRecipe("{oops")).toBeNull();
    expect(parseRecipe("42")).toBeNull();
    expect(parseRecipe("null")).toBeNull();
  });
});

describe("操作标签", () => {
  it("每个 op 都有可读的中文名", () => {
    expect(recipeOpLabel({ op: "autoContrast" })).toBe("自动对比度");
    expect(recipeOpLabel({ op: "grayscale" })).toBe("转灰度");
    expect(recipeOpLabel({ op: "fit", maxSide: 800 })).toContain("800");
    expect(recipeOpLabel({ op: "exportPng" })).toContain("PNG");
    expect(recipeOpLabel({ op: "exportJpg", quality: 90 })).toContain("90");
  });
});
