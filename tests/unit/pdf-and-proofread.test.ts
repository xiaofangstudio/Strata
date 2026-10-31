/**
 * PDF 写出器与文字检查。
 */
import { describe, expect, it } from "vitest";
import { buildPdf, countPdfPages, pdfHead } from "../../src/core/pdf";
import { applyFixes, checkText } from "../../src/core/proofread";

const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

describe("PDF 写出器", () => {
  it("有正确的文件头与页数", () => {
    const bytes = buildPdf([
      { jpeg: fakeJpeg, width: 100, height: 50, dpi: 72 },
      { jpeg: fakeJpeg, width: 100, height: 50, dpi: 72 },
    ]);
    expect(pdfHead(bytes)).toBe("%PDF-1.4");
    expect(countPdfPages(bytes)).toBe(2);
  });

  it("页尺寸按 dpi 换算成 pt", () => {
    // 300dpi 的 300px 图 = 1 英寸 = 72pt
    const bytes = buildPdf([{ jpeg: fakeJpeg, width: 300, height: 150, dpi: 300 }]);
    const text = Array.from(bytes).map((b) => String.fromCharCode(b)).join("");
    expect(text).toContain("/MediaBox [0 0 72.00 36.00]");
  });

  it("包含 xref 与 EOF 结尾", () => {
    const bytes = buildPdf([{ jpeg: fakeJpeg, width: 10, height: 10 }]);
    const text = Array.from(bytes).map((b) => String.fromCharCode(b)).join("");
    expect(text).toContain("xref");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("/Filter /DCTDecode");
  });

  it("没有页面时报错", () => {
    expect(() => buildPdf([])).toThrow();
  });
});

describe("文字检查", () => {
  it("抓重复词（英文与中文）", () => {
    expect(checkText("this is the the end").some((i) => i.kind === "duplicate")).toBe(true);
    expect(checkText("我们我们走").some((i) => i.kind === "duplicate")).toBe(true);
  });

  it("抓中英之间缺空格", () => {
    const issues = checkText("用Photoshop修图");
    expect(issues.filter((i) => i.kind === "spacing").length).toBe(2);
  });

  it("抓中文里的半角标点", () => {
    const issues = checkText("先这样,再那样");
    const p = issues.find((i) => i.kind === "fullwidth");
    expect(p?.fix).toBe("，");
  });

  it("抓多余空格", () => {
    const issues = checkText("a    b");
    expect(issues.some((i) => i.kind === "doubleSpace")).toBe(true);
  });

  it("抓常见错拼并保留大小写", () => {
    expect(checkText("Teh cat").find((i) => i.kind === "typo")?.fix).toBe("The");
    expect(checkText("recieve").find((i) => i.kind === "typo")?.fix).toBe("receive");
  });

  it("修正是幂等的：改完再查不该再报同类问题", () => {
    const src = "我们我们用Photoshop修图,好吗";
    const first = checkText(src);
    const fixed = applyFixes(src, first);
    const second = checkText(fixed);
    expect(second.filter((i) => i.kind === "fullwidth").length).toBe(0);
    expect(second.filter((i) => i.kind === "duplicate").length).toBe(0);
  });

  it("干净的文字不报问题", () => {
    expect(checkText("这张照片用了 3 档曝光。").length).toBe(0);
  });
});
