/**
 * 多语言覆盖率（对照 PhotoCraft 的 `xtask/src/i18n_coverage.rs`）。
 *
 * PhotoCraft 用专门的 xtask 扫描源语言键、再比对各语言目录算出覆盖率；
 * Strata 因为 locale 文件带 `Dict` 类型，编译期就强制全覆盖，这里再补一个运行期断言：
 * 每种注册语言的「键树」必须与中文源逐字一致（既不缺译、也不多键）。
 */
import { describe, it, expect } from "vitest";
import { LANGUAGES, currentDict, setLang, resolveLang } from "../../src/i18n";
import { zhCN } from "../../src/i18n/zh-CN";

function leafKeys(obj: unknown, prefix = ""): string[] {
  const out: string[] = [];
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const k of Object.keys(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.push(...leafKeys((obj as Record<string, unknown>)[k], path));
    }
  } else {
    out.push(prefix);
  }
  return out;
}

describe("i18n 覆盖率", () => {
  const source = leafKeys(zhCN).sort();

  it("每种注册语言都有与中文源完全相同的键树（缺译/多键都会失败）", () => {
    for (const lang of LANGUAGES) {
      if (lang.code === "zh-CN") continue;
      setLang(lang.code);
      const target = leafKeys(currentDict()).sort();
      expect(target, `语言 ${lang.code} 的键树应与中文源一致`).toEqual(source);
    }
    setLang("zh-CN");
  });

  it("LANGUAGES 注册表里的每种语言都能被 resolveLang 解析", () => {
    for (const lang of LANGUAGES) {
      expect(resolveLang(lang.code)).toBe(lang.code);
    }
    setLang("zh-CN");
  });
});
