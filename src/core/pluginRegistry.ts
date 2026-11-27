/**
 * 插件会话注册表。
 *
 * 刻意不写 localStorage / prefs：v0 插件没有可信签名，禁止「下次启动自动加载」。
 * 用户每开一次软件都要重新确认，权限只在本次会话有效；这样坏清单不能常驻。
 */
import type { ParsedPlugin } from "./pluginHost";
import { zh } from "../i18n";

export interface LoadedPlugin {
  /** 用户选中的清单文件路径，只用于列表展示与去重提示。 */
  path: string;
  parsed: ParsedPlugin;
}

/** 注册插件；同名 id 拒绝覆盖，防止两个清单抢同一个菜单命名空间。 */
export function registerPlugin(list: readonly LoadedPlugin[], next: LoadedPlugin): LoadedPlugin[] {
  if (list.some((p) => p.parsed.manifest.id === next.parsed.manifest.id)) {
    throw new Error(String(zh.plugin.duplicate).replace("{id}", next.parsed.manifest.id));
  }
  return [...list, next];
}

/** 卸载插件；不存在的 id 原样返回，避免重复点卸载把别的条目删掉。 */
export function unregisterPlugin(list: readonly LoadedPlugin[], id: string): LoadedPlugin[] {
  const hit = list.some((p) => p.parsed.manifest.id === id);
  return hit ? list.filter((p) => p.parsed.manifest.id !== id) : [...list];
}

/** 菜单动作的完整名字，供菜单 id 与命令面板使用。 */
export function pluginActionId(plugin: LoadedPlugin, menuKey: string): string {
  return `plugin.${plugin.parsed.manifest.id}.${menuKey}`;
}

/** 权限标识只作为内部键，面向用户的一律走六语言文案。 */
export function pluginPermissionLabel(perm: string): string {
  if (perm === "document.read") return String(zh.plugin.permDocRead);
  if (perm === "document.modify") return String(zh.plugin.permDocModify);
  if (perm === "file.write") return String(zh.plugin.permFileWrite);
  return perm;
}
