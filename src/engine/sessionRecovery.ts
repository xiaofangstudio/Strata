/**
 * 崩溃恢复 / 项目文件防损的前端桥。
 *
 * 恢复稿写在应用私有目录，不碰用户正式工程：Rust 侧 `session_write` 先落
 * tmp 再 rename，正式保存 / 导出走 `write_file_bytes_atomic`，所以任一步崩掉
 * 都只会留下一个可丢弃的 tmp，不会留下半份 `.strata`。
 *
 * 浏览器 dev 环境没有 Tauri 命令：这里统一降级成空操作，不弹错、不写 localStorage。
 */
import type { StrataDoc } from "../core/document";
import { decodeProject, encodeProject } from "./project";

export interface SessionSummary {
  key: string;
  name: string;
  width: number;
  height: number;
  savedAt: number;
  size: number;
  sourcePath?: string | null;
}

const hasTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const api = await import("@tauri-apps/api/core");
  return api.invoke<T>(cmd, args);
}

/** 自动恢复稿的 key：只含安全字符，和 Rust `valid_key` 对得上。 */
export function recoveryKey(doc: StrataDoc): string {
  return `sess-${doc.id}`;
}

/** 把当前文档写一份恢复稿。失败只返回 false，绝不打断绘画。 */
export async function writeRecoverySession(doc: StrataDoc): Promise<boolean> {
  if (!hasTauri()) return false;
  try {
    const bytes = await encodeProject(doc);
    await invoke<void>("session_write", {
      key: recoveryKey(doc),
      data: Array.from(bytes),
      manifest: {
        key: recoveryKey(doc),
        name: doc.name || "未命名",
        width: doc.width,
        height: doc.height,
        sourcePath: doc.sourcePath ?? null,
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** 列出恢复稿；坏条目由 Rust 侧跳过。 */
export async function listRecoverySessions(): Promise<SessionSummary[]> {
  if (!hasTauri()) return [];
  try {
    return await invoke<SessionSummary[]>("session_list", {});
  } catch {
    return [];
  }
}

/** 读回一份恢复稿；解析失败返回 null，不让坏稿把启动流程卡死。 */
export async function readRecoverySession(key: string): Promise<StrataDoc | null> {
  if (!hasTauri()) return null;
  try {
    const data = await invoke<number[]>("session_read", { key });
    return await decodeProject(new Uint8Array(data));
  } catch {
    return null;
  }
}

export async function deleteRecoverySession(key: string): Promise<void> {
  if (!hasTauri()) return;
  try {
    await invoke<void>("session_delete", { key });
  } catch {
    /* 清不掉就留着下次再清，不能影响用户正常操作 */
  }
}

export async function clearRecoverySessions(): Promise<void> {
  if (!hasTauri()) return;
  try {
    await invoke<void>("session_clear", {});
  } catch {
    /* 同上 */
  }
}

/** 正式工程 / 导出文件统一走原子写。 */
export async function writeFileAtomic(path: string, bytes: Uint8Array): Promise<void> {
  if (!hasTauri()) return;
  await invoke<void>("write_file_bytes_atomic", { path, data: Array.from(bytes) });
}
