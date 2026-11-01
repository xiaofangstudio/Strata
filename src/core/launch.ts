/**
 * 启动意图判定。
 *
 * 同样是「把 Strata 跑起来」，有两种完全不同的意图，界面必须分开对待：
 *
 * 1. 用户主动打开软件 —— 应当进欢迎页（新建画布 / 最近文件 / 导入）。
 * 2. 用 Strata 打开某个文件（双击图片、.strata 工程，或拖到图标上）——
 *    应当直接进编辑器，连欢迎页都不该露脸。
 *
 * 之前这两条路混在一起：App 先把欢迎页渲染出来，再异步去问内核命令行参数，
 * 于是「双击图片」时用户先看到欢迎页一闪，参数读不到时更是干脆停在欢迎页，
 * 让人以为「Strata 打不开图片」。这里把判定提到渲染之前，判定未出结果前
 * 只显示一个启动占位，不做任何「欢迎页已经出来了」的暗示。
 *
 * 判定顺序：
 *  - `?float=<key>`：应用内浮动窗口交接（同一进程新开 webview，命令行不变）。
 *  - `?open=<path>`：浏览器预览下手动模拟「带文件启动」，便于调试。
 *  - 内核 `launch_intent` 命令：真实桌面端路径，由 Rust 读 argv。
 *  - 都拿不到 → 视为主动启动。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IMAGE_EXTENSIONS, extOf } from "../engine/image";
import { STRATA_EXTENSION } from "../engine/project";

/** 这次启动要干什么。 */
export type LaunchIntent =
  /** 用户主动打开软件：进欢迎页。 */
  | { kind: "home" }
  /** 用本软件打开某个文件：直接进编辑器。 */
  | { kind: "file"; path: string }
  /** 应用内浮动窗口交接：从 localStorage 取回文档。 */
  | { kind: "float"; key: string };

/** Strata 能直接打开的全部扩展名（图片 + 工程）。 */
export const OPENABLE_EXTENSIONS: string[] = [...IMAGE_EXTENSIONS, STRATA_EXTENSION];

/** 内核 `launch_intent` 命令的返回结构。 */
interface LaunchPayload {
  kind?: string;
  path?: string | null;
}

/** 扩展名是否属于「Strata 能直接打开」的范围。 */
export function isOpenablePath(p: string): boolean {
  return OPENABLE_EXTENSIONS.includes(extOf(p));
}

/** 去引号：Windows 传参常带一对双引号，直接当路径用会打不开。 */
export function stripQuotes(raw: string): string {
  const t = raw.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

/**
 * 从命令行参数里挑出「要打开的文件」。
 *
 * 这是非 Tauri 环境（浏览器预览 / 单元测试）下的兜底实现，与 Rust 侧
 * `launch_intent` 的判定口径保持一致：跳过开关参数，取第一个带路径分隔符
 * 且扩展名可打开的参数。
 */
export function pickLaunchPath(args: string[]): string | null {
  for (const raw of args) {
    if (!raw || raw.startsWith("-")) continue;
    const p = stripQuotes(raw);
    // 要求带路径分隔符，避免把裸单词误当成文件名。
    if (!p.includes("\\") && !p.includes("/")) continue;
    if (isOpenablePath(p)) return p;
  }
  return null;
}

/**
 * 读出本次启动的意图。失败一律降级为「主动启动」——
 * 判定出错最多是进欢迎页，不能因此把软件卡死在空白屏。
 */
export async function readLaunchIntent(): Promise<LaunchIntent> {
  const q = new URLSearchParams(window.location.search);
  const floatKey = q.get("float");
  if (floatKey) return { kind: "float", key: floatKey };

  const devOpen = q.get("open");
  if (devOpen) return { kind: "file", path: devOpen };

  try {
    const r = await invoke<LaunchPayload>("launch_intent");
    if (r && r.kind === "file" && r.path) return { kind: "file", path: r.path };
  } catch {
    /* 非 Tauri 环境或命令未注册：按主动启动处理 */
  }
  return { kind: "home" };
}

/** 已运行的实例收到「又要打开一个文件」时用的事件名（单实例插件转发）。 */
const EXTERNAL_OPEN_EVENT = "strata://launch-open";

/**
 * 订阅「外部又要打开一个文件」。
 *
 * 开了单实例之后，第二次双击图片不会再起一个新进程，而是由内核把路径
 * 转发给已经在跑的那个窗口。返回取消订阅函数；非 Tauri 环境返回空函数。
 */
export async function onExternalOpen(cb: (path: string) => void): Promise<() => void> {
  try {
    const unlisten = await listen<string>(EXTERNAL_OPEN_EVENT, (e) => {
      const p = typeof e.payload === "string" ? e.payload : "";
      if (p) cb(p);
    });
    return unlisten;
  } catch {
    return () => {};
  }
}
