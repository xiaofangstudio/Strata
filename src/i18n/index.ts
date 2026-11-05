/**
 * 多语言中枢（界面语言）。
 *
 * 设计直接参考 ArtCraft PhotoCraft 的 i18n 体系（见参考仓库
 * `crates/ui-egui/src/i18n/` 与 `xtask/src/i18n_coverage.rs`），但落地方式适配
 * Strata 的 React 架构：
 *
 *  1. **中文是源语言**（`zh-CN.ts` 的 `zhCN`）。Strata 是中文第一的产品，
 *     所以中文永远完整，其它语言缺译时回退到中文 —— 保证界面不空、不溢出、不崩。
 *  2. **跟随系统语言**：首选项默认 `auto`，照搬 PhotoCraft 的 `lang_from_tag`
 *     思路，用 `navigator.language` 推断（zh / en / ja / fr / de / ru）。
 *  3. **注册表 + 覆盖率**：每种语言在 `LANGUAGES` 登记；翻译文件按 `Dict` 类型
 *     书写，缺一个键 tsc 直接报错（编译期覆盖率检查，比 PhotoCraft 的 xtask 更早）。
 *
 * 接法：组件里仍写 `import { zh } from ".../i18n"`，`zh` 是一个**实时代理**，
 * 每次取属性都按「当前语言 → 回退中文」解析，所以切换语言后整棵树重渲染即可生效，
 * 不需要改任何一处 `zh.xxx` 的写法。
 */
import { useSyncExternalStore } from "react";
import { zhCN, type Dict } from "./zh-CN";
import { en } from "./en";
import { ja } from "./ja";
import { fr } from "./fr";
import { de } from "./de";
import { ru } from "./ru";

export type { Dict } from "./zh-CN";

export type LangCode = "zh-CN" | "en" | "ja" | "fr" | "de" | "ru";

export interface LangInfo {
  code: LangCode;
  /** 该语言的自称（用自己语言写），菜单里一眼能认出 */
  native: string;
  /** 英文名，认不得原文的人也能定位 */
  english: string;
}

/** 语言注册表（抄 PhotoCraft 的 `LANGUAGES`）。顺序即菜单顺序。 */
export const LANGUAGES: LangInfo[] = [
  { code: "zh-CN", native: "简体中文", english: "Chinese (Simplified)" },
  { code: "en", native: "English", english: "English" },
  { code: "ja", native: "日本語", english: "Japanese" },
  { code: "fr", native: "Français", english: "French" },
  { code: "de", native: "Deutsch", english: "German" },
  { code: "ru", native: "Русский", english: "Russian" },
];

/** 活动语言：`auto` 表示跟随系统。 */
export type ActiveLang = LangCode | "auto";

const STORAGE_KEY = "strata.lang";

/** 各语言的字典表；中文源在文件里直接赋值，其余语言由各自的 locale 文件注册。 */
const dicts: Partial<Record<LangCode, Dict>> = {
  "zh-CN": zhCN,
};

// 注册各语言（源语言之外）。每种都按 `Dict` 类型书写，tsc 强制全覆盖。
registerDict("en", en);
registerDict("ja", ja);
registerDict("fr", fr);
registerDict("de", de);
registerDict("ru", ru);

/** 抄 PhotoCraft `lang_from_tag`：按语言标签前缀推断，区域变体都归并到主语言。 */
export function langFromTag(tag: string): LangCode {
  const t = tag.toLowerCase();
  if (t.startsWith("zh")) return "zh-CN";
  if (t.startsWith("ja") || t.startsWith("jpn")) return "ja";
  if (t.startsWith("fr")) return "fr";
  if (t.startsWith("de") || t.startsWith("ger")) return "de";
  if (t.startsWith("ru")) return "ru";
  if (t.startsWith("en")) return "en";
  return "zh-CN";
}

function readStored(): ActiveLang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "auto") return "auto";
    if (LANGUAGES.some((l) => l.code === v)) return v as LangCode;
  } catch {
    /* localStorage 不可用时静默回退到 auto */
  }
  return "auto";
}

let current: ActiveLang = readStored();
const listeners = new Set<() => void>();

/** 把 `auto` 解析成具体的语言代码（读系统语言）。 */
export function resolveLang(active: ActiveLang = current): LangCode {
  if (active === "auto") {
    let sys = "zh-CN";
    try {
      sys = typeof navigator !== "undefined" && navigator.language ? navigator.language : "zh-CN";
    } catch {
      /* ignore */
    }
    return langFromTag(sys);
  }
  return active;
}

function activeDict(): Dict {
  return dicts[resolveLang()] ?? zhCN;
}

/** 当前语言的字典（供调试 / 测试用）。 */
export function currentDict(): Dict {
  return activeDict();
}

/** 由 locale 文件在加载时调用，登记一种语言的字典。 */
export function registerDict(code: LangCode, dict: Dict): void {
  dicts[code] = dict;
}

/**
 * 实时代理：任意深度的取属性都按「当前语言 → 回退中文源」解析。
 * 切换语言后只要组件重新渲染（订阅了 `useLang`），读到的就是新语言。
 */
function makeNode(path: string[]): Dict {
  return new Proxy(Object.create(null), {
    get(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      const key = prop as string;
      const full = [...path, key];

      const dig = (root: Dict): unknown => {
        let node: any = root;
        for (const p of full) {
          if (node == null) return undefined;
          node = node[p];
        }
        return node;
      };

      let v = dig(activeDict());
      if (v === undefined) v = dig(zhCN); // 回退到中文源

      if (v && typeof v === "object" && !Array.isArray(v)) {
        return makeNode(full);
      }
      return v;
    },
  }) as unknown as Dict;
}

/** 实时代理字典，组件里照旧用 `zh.menu.file`。 */
export const zh: Dict = makeNode([]);

export function getLang(): ActiveLang {
  return current;
}

export function setLang(code: ActiveLang): void {
  current = code;
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 在组件里订阅语言变化（返回活动语言，含 `auto`），用于触发重渲染。 */
export function useLang(): ActiveLang {
  return useSyncExternalStore(subscribe, getLang);
}

/** 订阅并返回「已解析」的具体语言代码（不含 `auto`）。 */
export function useResolvedLang(): LangCode {
  const active = useLang();
  return resolveLang(active);
}
