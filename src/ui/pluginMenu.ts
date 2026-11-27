/**
 * 增效工具顶级菜单：完全由会话内已加载的清单生成。
 *
 * 这里只负责「把数据变成菜单」，不碰文档、不弹权限框、不执行命令；
 * 所有动作都用显式 onSelect 回传给 EditorShell，避免改生成文件
 * `menuCatalog.data.ts`（那是 PhotoCraft 目录的镜像，不能被插件污染）。
 */
import { zh } from "../i18n";
import type { PluginMenuAction } from "../core/pluginHost";
import { pluginActionId, type LoadedPlugin } from "../core/pluginRegistry";
import type { MenuEntry, MenuGroup } from "./components/AppMenuBar";

export interface PluginMenuHandlers {
  onLoad: () => void;
  onManage: () => void;
  onRun: (plugin: LoadedPlugin, action: PluginMenuAction, label: string) => void;
}

/** 构造一个可插拔的顶级菜单；没有插件时保留入口，但明确禁用，不做假按钮。 */
export function buildPluginMenuGroup(
  plugins: readonly LoadedPlugin[],
  handlers: PluginMenuHandlers,
): MenuGroup {
  const items: MenuEntry[] = [];

  if (plugins.length === 0) {
    items.push({ kind: "item", label: String(zh.plugin.empty), disabled: true });
  } else {
    for (const plugin of plugins) {
      const { manifest, actions } = plugin.parsed;
      const children: MenuEntry[] = actions.map((entry) => ({
        kind: "item",
        id: pluginActionId(plugin, entry.key),
        label: entry.label,
        onSelect: () => {
          for (const action of entry.actions) handlers.onRun(plugin, action, entry.label);
        },
      }));
      items.push({
        kind: "item",
        id: `plugin.${manifest.id}`,
        label: manifest.name,
        hint: manifest.pluginVersion,
        children,
      });
    }
  }

  items.push(
    { kind: "sep" },
    { kind: "item", label: String(zh.plugin.load), onSelect: handlers.onLoad },
    { kind: "item", label: String(zh.plugin.manage), onSelect: handlers.onManage },
  );

  return { key: "plugins", label: String(zh.plugin.menu), items };
}
