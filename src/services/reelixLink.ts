import { invoke } from "@tauri-apps/api/core";
import { encodePng } from "../engine/image";
import { flattenDoc } from "../engine/compositor";
import type { StrataDoc } from "../core/document";

/**
 * Reelix 联动：把当前画作（PNG）送进 Reelix 素材箱。
 *
 * 机制（投递箱，无需 Reelix 开着）：
 * - 检测：`%LOCALAPPDATA%\Reelix\dropbox` 存在 = 装了 Reelix；
 *   `%LOCALAPPDATA%\Reelix\heartbeat.json` 10 秒内更新过 = Reelix 正开着。
 * - 送去：PNG 写进 dropbox，文件名 `strata-<毫秒>.png`。
 *   Reelix 开着 → 3 秒内自动导入素材箱；没开 → 留着，下次开自动补。
 */

export type ReelixLinkState = "absent" | "installed" | "running";

async function reelixDir(): Promise<string | null> {
  try {
    const home = await invoke<string>("local_app_data");
    return home ? `${home}\\Reelix` : null;
  } catch {
    return null;
  }
}

/** 探测 Reelix：未安装 / 装着没开 / 正开着。 */
export async function probeReelix(): Promise<ReelixLinkState> {
  const base = await reelixDir();
  if (!base) return "absent";
  const dropbox = await invoke<{ exists: boolean }>("files_stat", {
    path: `${base}\\dropbox`,
  }).catch(() => ({ exists: false }));
  if (!dropbox.exists) return "absent";
  const hb = await invoke<number[]>("read_file_bytes", {
    path: `${base}\\heartbeat.json`,
  }).catch(() => null);
  if (hb && hb.length > 0) {
    try {
      const text = new TextDecoder().decode(new Uint8Array(hb));
      const ts = Number(JSON.parse(text).ts ?? 0);
      if (Date.now() - ts < 10_000) return "running";
    } catch {
      /* 解析失败按没开处理 */
    }
  }
  return "installed";
}

/** 把当前画作导出 PNG 送进 Reelix 投递箱。 */
export async function sendToReelix(doc: StrataDoc): Promise<boolean> {
  const base = await reelixDir();
  if (!base) return false;
  const dropbox = await invoke<{ exists: boolean }>("files_stat", {
    path: `${base}\\dropbox`,
  }).catch(() => ({ exists: false }));
  if (!dropbox.exists) return false;
  const canvas = flattenDoc(doc);
  const png = await encodePng(canvas);
  const name = `strata-${Date.now()}.png`;
  await invoke("write_file_bytes", {
    path: `${base}\\dropbox\\${name}`,
    data: Array.from(png),
  });
  return true;
}
