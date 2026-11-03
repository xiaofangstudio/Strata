/**
 * 导出格式的纯逻辑测试。
 *
 * encodeCanvas 要碰 canvas，按项目约定不在这里测（测试不依赖真实浏览器 API）；
 * 但「文件名怎么替换扩展名」「格式表对不对」是可以离线断言的部分，
 * 也正是最容易写错的地方（比如把 a.png 存成 a.png.jpg）。
 */
import { describe, expect, it } from "vitest";
import { EXPORT_FORMATS, formatSpec, suggestFileName } from "../../src/engine/exportImage";

describe("导出格式表", () => {
  it("三种格式都有扩展名与 MIME", () => {
    for (const f of EXPORT_FORMATS) {
      expect(f.ext.length).toBeGreaterThan(0);
      expect(f.mime).toMatch(/^image\//);
    }
  });

  it("只有 PNG 是无损的", () => {
    expect(EXPORT_FORMATS.filter((f) => !f.lossy).map((f) => f.id)).toEqual(["png"]);
  });

  it("JPEG 的扩展名是 jpg，不是 jpeg", () => {
    expect(formatSpec("jpeg").ext).toBe("jpg");
  });

  it("不认识的格式回落到 PNG", () => {
    // @ts-expect-error 故意传非法值
    expect(formatSpec("avif").id).toBe("png");
  });
});

describe("建议文件名", () => {
  it("替换已有的图片扩展名", () => {
    expect(suggestFileName("猫.png", "jpeg")).toBe("猫.jpg");
    expect(suggestFileName("cat.JPG", "webp")).toBe("cat.webp");
  });

  it("工程扩展名也一并替换", () => {
    expect(suggestFileName("海报.strata", "png")).toBe("海报.png");
    expect(suggestFileName("design.psd", "jpeg")).toBe("design.jpg");
  });

  it("没有扩展名时补上，而不是叠两遍", () => {
    expect(suggestFileName("未命名", "png")).toBe("未命名.png");
    expect(suggestFileName("未命名", "jpeg")).toBe("未命名.jpg");
  });

  it("名字里有点但不是扩展名时不动", () => {
    expect(suggestFileName("v1.2 草图", "png")).toBe("v1.2 草图.png");
  });
});
