/**
 * 文字引擎的纯逻辑校验（node 环境，无 Canvas）。
 *
 * 栅格化本身依赖 Canvas2D，交给运行时与人工验收；这里只钉死那些
 * 「一旦写错就静默出错」的地方：多行拆分、字体串拼装顺序、字体族清单。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEXT,
  TEXT_FAMILIES,
  fontStack,
  fontString,
  textLines,
} from "../../src/engine/text";

describe("textLines", () => {
  it("把 CRLF / CR 统一成 LF 后按行拆开", () => {
    expect(textLines("a\r\nb\rc\nd")).toEqual(["a", "b", "c", "d"]);
  });

  it("空串算一行，末尾换行保留空行", () => {
    expect(textLines("")).toEqual([""]);
    expect(textLines("x\n")).toEqual(["x", ""]);
  });

  it("连续空行不合并", () => {
    expect(textLines("x\n\ny")).toEqual(["x", "", "y"]);
  });
});

describe("fontStack / fontString", () => {
  it("每个字体族都有非空的 label 与 font-family 串", () => {
    expect(TEXT_FAMILIES.length).toBeGreaterThanOrEqual(4);
    for (const f of TEXT_FAMILIES) {
      expect(f.label.trim().length).toBeGreaterThan(0);
      expect(f.stack.trim().length).toBeGreaterThan(0);
    }
    // id 不重复
    const ids = TEXT_FAMILIES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("已知 id 取到对应字体族，未知 id 退回第一个", () => {
    expect(fontStack("sans")).toBe(TEXT_FAMILIES[0].stack);
    expect(fontStack("song")).toBe(TEXT_FAMILIES[1].stack);
    // @ts-expect-error 故意传非法值：生产代码兜底不抛错
    expect(fontStack("nope")).toBe(TEXT_FAMILIES[0].stack);
  });

  it("字体串顺序为 style → weight → size → family，且加粗/斜体可选", () => {
    const plain = fontString({ ...DEFAULT_TEXT, size: 48 });
    expect(plain.startsWith("400 48px ")).toBe(true);
    expect(plain).toContain("Microsoft YaHei");

    const fancy = fontString({ ...DEFAULT_TEXT, size: 32, bold: true, italic: true });
    expect(fancy.startsWith("italic 700 32px ")).toBe(true);
  });

  it("字号被四舍五入且不小于 1（避免 0px 静默不显示）", () => {
    expect(fontString({ ...DEFAULT_TEXT, size: 0 })).toContain(" 1px ");
    expect(fontString({ ...DEFAULT_TEXT, size: 12.6 })).toContain(" 13px ");
  });
});
