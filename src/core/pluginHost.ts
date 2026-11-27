/**
 * 插件宿主内核 v0（声明式清单，见 docs/插件接口设计-2026-11-27.md）。
 *
 * v0 刻意不执行任何第三方代码：插件 = JSON manifest，动作序列走宿主白名单，
 * 权限逐条校验。校验全部是纯函数，坏清单整体拒绝并给中文错误，
 * 不做静默修正 —— 在 JS 沙箱（v1）建好之前，绝不提供能跑任意脚本的假接口。
 *
 * 命令白名单与文档层现有能力同源（缩放 / 调整层 / 翻转旋转 / 导出），
 * 宿主执行动作时直接调用引擎函数，不走字符串 eval。
 */

export interface PluginMenuAction {
  command: string;
  params?: Record<string, unknown>;
}

export interface PluginMenuEntry {
  id: string;
  label: string;
  actions: PluginMenuAction[];
}

export interface PluginManifest {
  id: string;
  name: string;
  author: string;
  pluginVersion: string;
  permissions: string[];
  menus: PluginMenuEntry[];
}

export const PLUGIN_PERMISSIONS = ["document.read", "document.modify", "file.write"] as const;

/** v0 命令白名单：与文档层现有引擎能力一一对应，执行侧按 command 分派。 */
export const PLUGIN_COMMANDS = {
  "document.info": { permission: "document.read", note: "读文档元信息" },
  "document.scale": { permission: "document.modify", note: "缩放画布（百分比）" },
  "document.addAdjustment": { permission: "document.modify", note: "新建调整层" },
  "document.rotateHalf": { permission: "document.modify", note: "整倍旋转 180°" },
  "document.flip": { permission: "document.modify", note: "翻转（h/v）" },
  "document.rasterizeSmart": { permission: "document.modify", note: "栅格化活动智能对象" },
  "file.exportPng": { permission: "file.write", note: "导出 PNG（经系统保存框）" },
} as const;

export type PluginCommand = keyof typeof PLUGIN_COMMANDS;

export const PLUGIN_ID_RE = /^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9-]*)+$/;
export const PLUGIN_VERSION_RE = /^\d+\.\d+\.\d+$/;

export interface ParsedPlugin {
  manifest: PluginManifest;
  /** 会话内唯一的菜单动作全名：`<pluginId>:<menuId>`。 */
  actions: Array<{ key: string; label: string; actions: PluginMenuAction[] }>;
}

export class PluginManifestError extends Error {}

/**
 * 解析并校验 manifest。输入是 JSON.parse 的产物，坏清单抛 PluginManifestError，
 * message 是可直接展示给用户的中文。
 */
export function parseManifest(raw: unknown): ParsedPlugin {
  if (typeof raw !== "object" || raw === null) {
    throw new PluginManifestError("插件清单不是 JSON 对象");
  }
  const r = raw as Record<string, unknown>;
  if (r.manifest !== "strata-plugin") {
    throw new PluginManifestError(`manifest 字段必须是 "strata-plugin"`);
  }
  if (r.version !== 1) {
    throw new PluginManifestError(`不支持的清单版本：${String(r.version)}（当前只支持 1）`);
  }
  const id = r.id;
  if (typeof id !== "string" || !PLUGIN_ID_RE.test(id)) {
    throw new PluginManifestError(`插件 id 必须是反向域名（如 com.example.thumb）`);
  }
  const name = r.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new PluginManifestError("插件缺少 name");
  }
  if (typeof r.pluginVersion !== "string" || !PLUGIN_VERSION_RE.test(r.pluginVersion)) {
    throw new PluginManifestError(`pluginVersion 必须是 x.y.z 形式`);
  }
  const perms = r.permissions;
  if (!Array.isArray(perms)) {
    throw new PluginManifestError("permissions 必须是数组");
  }
  for (const p of perms) {
    if (typeof p !== "string" || !(PLUGIN_PERMISSIONS as readonly string[]).includes(p)) {
      throw new PluginManifestError(`未知权限：${String(p)}（允许：${PLUGIN_PERMISSIONS.join(", ")}）`);
    }
  }
  const menusRaw = r.menus;
  if (!Array.isArray(menusRaw) || menusRaw.length === 0) {
    throw new PluginManifestError("menus 必须是非空数组");
  }
  const menus: PluginMenuEntry[] = [];
  const seenMenu = new Set<string>();
  for (const m of menusRaw) {
    if (typeof m !== "object" || m === null) {
      throw new PluginManifestError("menus 里有非对象条目");
    }
    const menu = m as Record<string, unknown>;
    const menuId = menu.id;
    if (typeof menuId !== "string" || !/^[a-z][a-z0-9-]*$/.test(menuId)) {
      throw new PluginManifestError(`菜单 id 必须是小写字母/数字/连字符：${String(menuId)}`);
    }
    if (seenMenu.has(menuId)) {
      throw new PluginManifestError(`菜单 id 重复：${menuId}`);
    }
    seenMenu.add(menuId);
    const label = menu.label;
    if (typeof label !== "string" || label.trim().length === 0) {
      throw new PluginManifestError(`菜单 ${menuId} 缺少 label`);
    }
    const actionsRaw = menu.actions;
    if (!Array.isArray(actionsRaw) || actionsRaw.length === 0) {
      throw new PluginManifestError(`菜单 ${menuId} 的 actions 必须是非空数组`);
    }
    const actions: PluginMenuAction[] = actionsRaw.map((a) => {
      if (typeof a !== "object" || a === null) {
        throw new PluginManifestError(`菜单 ${menuId} 的动作不是对象`);
      }
      const action = a as Record<string, unknown>;
      const command = action.command;
      if (typeof command !== "string" || !(command in PLUGIN_COMMANDS)) {
        throw new PluginManifestError(
          `菜单 ${menuId} 用了未知命令：${String(command)}（白名单：${Object.keys(PLUGIN_COMMANDS).join(", ")}）`,
        );
      }
      const perm = PLUGIN_COMMANDS[command as PluginCommand].permission;
      if (!perms.includes(perm)) {
        throw new PluginManifestError(
          `菜单 ${menuId} 的命令 ${command} 需要权限 ${perm}，但清单没有声明`,
        );
      }
      const params = action.params;
      if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
        throw new PluginManifestError(`菜单 ${menuId} 的命令 ${command} 的 params 必须是对象`);
      }
      return { command, params: (params ?? {}) as Record<string, unknown> };
    });
    menus.push({ id: menuId, label, actions });
  }
  return {
    manifest: {
      id,
      name,
      author: typeof r.author === "string" ? r.author : "未知作者",
      pluginVersion: r.pluginVersion,
      permissions: perms as string[],
      menus,
    },
    actions: menus.map((m) => ({ key: `${id}:${m.id}`, label: m.label, actions: m.actions })),
  };
}

/** 动作执行前逐条检查权限（宿主分派器用；v0 由 UI 侧调用引擎函数）。 */
export function checkActionPermission(action: PluginMenuAction, permissions: readonly string[]): void {
  const spec = PLUGIN_COMMANDS[action.command as PluginCommand];
  if (!spec) throw new PluginManifestError(`未知命令：${action.command}`);
  if (!permissions.includes(spec.permission)) {
    throw new PluginManifestError(`命令 ${action.command} 需要权限 ${spec.permission}，插件未声明`);
  }
}
