import { invoke } from "@tauri-apps/api/core";

/** 内核返回的运行环境信息。 */
export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  arch: string;
  locale: string;
}

/** 读取运行环境信息；失败时返回 null，界面走降级展示。 */
export async function loadAppInfo(): Promise<AppInfo | null> {
  try {
    return await invoke<AppInfo>("app_info");
  } catch {
    return null;
  }
}

/** 平台名 → 中文展示名。 */
export function platformLabel(info: AppInfo | null): string {
  if (!info) return "读取中…";
  const os = info.platform === "windows" ? "Windows" : info.platform;
  return `${os} · ${info.arch}`;
}
