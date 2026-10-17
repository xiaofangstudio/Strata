/**
 * `src/i18n/zh-CN.ts` 的字典结构契约。
 *
 * 该模块是纯数据（`export const zh = {...} as const`），不碰任何浏览器 API，
 * 可以直接在 node 环境下导入并断言。
 *
 * 除了运行时对象本身，这里还额外读取源文件做一次「同层键无重复」的结构扫描：
 * TS 对象字面量里重复的键在运行时会被后者覆盖，光看 `zh` 是发现不了的，
 * 只有扫源码文本才能把这个问题揪出来。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { zh } from "../../src/i18n/zh-CN";

/** 顶层分组，按源码里的出现顺序排列。 */
const TOP_GROUPS = [
  "app",
  "theme",
  "menu",
  "tools",
  "options",
  "selection",
  "colorPanel",
  "panel",
  "layers",
  "palette",
  "start",
  "preferences",
  "shortcuts",
  "about",
  "editor",
  "status",
  "dialog",
  "liquify",
  "inpaint",
  "hint",
  "error",
] as const;

/** 需求里点名要覆盖的「关键分组」。 */
const KEY_GROUPS = [
  "menu",
  "tools",
  "editor",
  "dialog",
  "options",
  "selection",
  "panel",
  "layers",
  "palette",
  "start",
  "preferences",
  "status",
  "hint",
  "error",
] as const;

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, "../../src/i18n/zh-CN.ts");
const source = readFileSync(sourcePath, "utf8");

/** 把源码按顶层分组切成「行数组」，key 为分组名。 */
function groupBodies(text: string): Map<string, string[]> {
  const bodies = new Map<string, string[]>();
  let current: string | null = null;
  let body: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const start = /^ {2}([A-Za-z_$][\w$]*): \{$/.exec(line);
    if (start) {
      current = start[1];
      body = [];
      bodies.set(current, body);
      continue;
    }
    // 顶层分组的闭合花括号缩进恰好是 2 个空格。
    if (current !== null && /^ {2}\},?$/.test(line)) {
      current = null;
      body = [];
      continue;
    }
    if (current !== null) body.push(line);
  }
  return bodies;
}

/** 取出某个分组体内「直接子键」（缩进 4 个空格）的名字。 */
function directKeys(body: readonly string[]): string[] {
  const keys: string[] = [];
  for (const line of body) {
    const m = /^ {4}([A-Za-z_$][\w$]*):(\s|$)/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

function duplicates(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) dup.add(name);
    seen.add(name);
  }
  return [...dup];
}

describe("zh 顶层结构", () => {
  it("导出对象存在，且顶层分组与预期完全一致（含顺序）", () => {
    expect(zh).toBeTypeOf("object");
    expect(Object.keys(zh)).toEqual([...TOP_GROUPS]);
  });

  it("每个顶层分组的取值都是非空对象", () => {
    for (const group of TOP_GROUPS) {
      const value = (zh as Record<string, unknown>)[group];
      expect(value, `分组 ${group} 应存在`).toBeTypeOf("object");
      expect(Object.keys(value as object).length, `分组 ${group} 不应为空`).toBeGreaterThan(0);
    }
  });
});

describe("zh 关键分组内容", () => {
  it("menu 覆盖主菜单的八个一级菜单项", () => {
    for (const key of ["file", "edit", "image", "adjust", "layer", "select", "view", "help"]) {
      expect(zh.menu[key as keyof typeof zh.menu]).toBeTypeOf("string");
    }
    expect(zh.menu.layer).toBe("图层");
    expect(zh.menu.edit).toBe("编辑");
  });

  it("关键分组里直接子级的字符串取值均为非空（已去除首尾空白）", () => {
    for (const group of KEY_GROUPS) {
      const value = (zh as Record<string, Record<string, unknown>>)[group];
      for (const [key, leaf] of Object.entries(value)) {
        if (typeof leaf === "string") {
          expect(leaf.trim().length, `${group}.${key} 不应为空串`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("editor / dialog / options 的代表性文案正确落位", () => {
    expect(zh.editor.untitled).toBe("未命名");
    expect(zh.editor.fit).toBe("适应窗口");
    expect(zh.dialog.confirm).toBe("确定");
    expect(zh.dialog.cancel).toBe("取消");
    expect(zh.options.opacity).toBe("不透明度");
    expect(zh.options.tolerance).toBe("容差");
  });

  it("shortcuts.rows 与 about.facts 是结构化数组且元素字段完整", () => {
    expect(Array.isArray(zh.shortcuts.rows)).toBe(true);
    expect(zh.shortcuts.rows.length).toBeGreaterThan(0);
    for (const row of zh.shortcuts.rows) {
      expect(row.keys.trim().length).toBeGreaterThan(0);
      expect(row.desc.trim().length).toBeGreaterThan(0);
    }

    expect(Array.isArray(zh.about.facts)).toBe(true);
    expect(zh.about.facts.length).toBeGreaterThan(0);
    for (const fact of zh.about.facts) {
      expect(fact.k.trim().length).toBeGreaterThan(0);
      // facts 允许出现空占位值（如「版本」在运行时填充），这里只要求是字符串。
      expect(typeof fact.v).toBe("string");
    }
  });
});

describe("zh 源码结构扫描（运行时看不到的重复键）", () => {
  const bodies = groupBodies(source);

  it("源码里确实能解析出全部 21 个顶层分组", () => {
    expect([...bodies.keys()]).toEqual([...TOP_GROUPS]);
  });

  it("顶层分组名没有重复", () => {
    const declared = [...source.matchAll(/^ {2}([A-Za-z_$][\w$]*): \{$/gm)].map((m) => m[1]);
    expect(duplicates(declared)).toEqual([]);
    expect(declared).toHaveLength(TOP_GROUPS.length);
  });

  it("每个分组内部的直接子键没有重复", () => {
    for (const [group, body] of bodies) {
      const keys = directKeys(body);
      expect(keys.length, `分组 ${group} 应至少有一个直接子键`).toBeGreaterThan(0);
      expect(duplicates(keys), `分组 ${group} 内出现重复键`).toEqual([]);
    }
  });
});
