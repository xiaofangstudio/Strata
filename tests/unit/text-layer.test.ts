/**
 * 文本层的纯逻辑部分：OpenType 字符替换、图层命名。
 *
 * 栅格化本身依赖真实 canvas（测试替身不做光栅化），按项目约定不在 node 里断言像素；
 * 这里只测与像素无关的确定性逻辑。
 */
import { describe, expect, it } from "vitest";
import { substituteOpenType } from "../../src/engine/text";
import { textLayerName } from "../../src/core/textLayer";

describe("OpenType 字符替换", () => {
  it("标准连字把 fi / fl / ff 换成连字码位", () => {
    expect(substituteOpenType("find flag off", { liga: true })).toBe("ﬁnd ﬂag oﬀ");
  });

  it("连字顺序优先处理三字组合（ffi / ffl）", () => {
    expect(substituteOpenType("office baffle", { liga: true })).toBe("oﬃce baﬄe");
  });

  it("没开连字时原样返回", () => {
    expect(substituteOpenType("find flag", {})).toBe("find flag");
    expect(substituteOpenType("find flag", { liga: false })).toBe("find flag");
  });

  it("自由连字只换独立单词（st / ct）", () => {
    expect(substituteOpenType("st ct stone", { dlig: true })).toBe("ﬆ ﬅ stone");
  });

  it("分数换成单个分数码位", () => {
    expect(substituteOpenType("1/2 和 3/4", { frac: true })).toBe("½ 和 ¾");
    expect(substituteOpenType("5/8", { frac: true })).toBe("⅝");
  });

  it("序数把后缀换成上标", () => {
    expect(substituteOpenType("1st 2nd 3rd 4th", { ordn: true })).toBe("1ˢᵗ 2ⁿᵈ 3ʳᵈ 4ᵗʰ");
  });

  it("多个特性可以叠加", () => {
    expect(substituteOpenType("1/2 office", { frac: true, liga: true })).toBe("½ oﬃce");
  });

  it("没有 Unicode 对应码位的特性不改动文本（开关只记录）", () => {
    const src = "Hello 123";
    expect(substituteOpenType(src, { swsh: true })).toBe(src);
    expect(substituteOpenType(src, { onum: true })).toBe(src);
    expect(substituteOpenType(src, { salt: true })).toBe(src);
    expect(substituteOpenType(src, { ornm: true })).toBe(src);
    expect(substituteOpenType(src, { titl: true })).toBe(src);
  });
});

describe("文本层命名", () => {
  it("取第一行文字", () => {
    expect(textLayerName("标题\n正文内容")).toBe("标题");
  });

  it("过长会截断并加省略号", () => {
    const long = "一二三四五六七八九十一二三四五六七八";
    const name = textLayerName(long);
    expect(name.length).toBeLessThanOrEqual(17);
    expect(name.endsWith("…")).toBe(true);
  });

  it("空内容退回「文字」", () => {
    expect(textLayerName("")).toBe("文字");
    expect(textLayerName("   \n第二行")).toBe("第二行");
  });
});
