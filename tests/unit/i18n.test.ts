/**
 * 多语言中枢的试验（对照 PhotoCraft 的 i18n 设计）。
 *
 * 验证：实时代理、跟随系统语言、缺失键回退到中文源、订阅通知。
 * 这里不碰任何浏览器渲染 API，纯 node 环境即可跑。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  zh,
  getLang,
  setLang,
  resolveLang,
  langFromTag,
  subscribe,
  registerDict,
  type Dict,
} from "../../src/i18n";

beforeEach(() => {
  setLang("zh-CN");
});

describe("i18n 实时代理", () => {
  it("默认中文源：取中文词条", () => {
    expect(zh.menu.file).toBe("文件");
    expect(zh.tools.brush).toBe("画笔");
  });

  it("切换到英文后实时返回英文（不重导模块）", () => {
    setLang("en");
    expect(zh.menu.file).toBe("File");
    expect(zh.tools.brush).toBe("Brush");
  });

  it("深层嵌套也走代理（options.brushPanel.title）", () => {
    setLang("en");
    expect(zh.options.brushPanel.title).toBe("Brush Settings");
  });
});

describe("缺失键回退到中文源", () => {
  it("只译了 app 的 fr 字典，menu 缺译时回退中文", () => {
    const frPartial = {
      app: { name: "Strata", tagline: "", studio: "", version: "" },
    } as unknown as Dict;
    registerDict("fr", frPartial);
    setLang("fr");
    expect(zh.app.name).toBe("Strata"); // 自己的译文
    expect(zh.menu.file).toBe("文件"); // 回退中文
    setLang("zh-CN");
  });
});

describe("跟随系统语言（抄 PhotoCraft lang_from_tag）", () => {
  it("区域变体归并到主语言", () => {
    expect(langFromTag("zh-CN")).toBe("zh-CN");
    expect(langFromTag("zh-Hans")).toBe("zh-CN");
    expect(langFromTag("en-US")).toBe("en");
    expect(langFromTag("ja-JP")).toBe("ja");
    expect(langFromTag("fr-FR")).toBe("fr");
    expect(langFromTag("de-DE")).toBe("de");
    expect(langFromTag("ru-RU")).toBe("ru");
    expect(langFromTag("xx-yy")).toBe("zh-CN"); // 未知回退中文
  });

  it("resolveLang('auto') 解析出具体语言代码", () => {
    const r = resolveLang("auto");
    expect(["zh-CN", "en", "ja", "fr", "de", "ru"]).toContain(r);
  });
});

describe("订阅与持久化", () => {
  it("setLang 通知订阅者并改变 getLang", () => {
    let fired = 0;
    const unsub = subscribe(() => {
      fired += 1;
    });
    setLang("en");
    expect(fired).toBe(1);
    expect(getLang()).toBe("en");
    unsub();
    setLang("zh-CN");
  });
});
