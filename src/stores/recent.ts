import { useCallback, useEffect, useState } from "react";
import { baseName } from "../core/document";

/**
 * 最近打开的文件记录。
 *
 * 立项规划书 §7.5 要求开始页面的最近文件展示「缩略图、文件名、路径、修改时间」。
 * 因此每条记录都带着源文件的修改时间与体积，缩略图在首次成功解码后补齐，
 * 之后跨启动复用，避免每次开页面都重新解码一遍大图。
 */
export interface RecentEntry {
  path: string;
  name: string;
  /** 打开时间戳（毫秒） */
  openedAt: number;
  /** 源文件最后修改时间（Unix 毫秒）；读不到时缺省 */
  mtime?: number;
  /** 源文件体积（字节） */
  size?: number;
  /** 缩略图 data URL；尚未生成时缺省 */
  thumb?: string;
  /** 上次检查时源文件已不存在 */
  missing?: boolean;
}

const STORAGE_KEY = "strata.recent";
const MAX_ITEMS = 12;

function readStored(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (it): it is RecentEntry =>
        !!it &&
        typeof it === "object" &&
        typeof (it as RecentEntry).path === "string" &&
        typeof (it as RecentEntry).name === "string",
    );
  } catch {
    return [];
  }
}

/** 写 localStorage。缩略图是 data URL，超配额时降级为不带缩略图。 */
function writeStored(items: RecentEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    return;
  } catch {
    /* 下面再试一次不带缩略图的版本 */
  }
  try {
    const slim = items.map(({ thumb: _thumb, ...rest }) => rest);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
  } catch {
    /* localStorage 不可用就放弃持久化，不影响本次会话 */
  }
}

/** 清空落盘的最近文件（偏好设置 > 文件处理 / 暂存盘 里的清理按钮）。 */
export function clearStoredRecent(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 存储不可用时无事可做 */
  }
}

/** 最近文件列表，落 localStorage。 */
export function useRecentFiles() {
  const [items, setItems] = useState<RecentEntry[]>(readStored);

  useEffect(() => {
    writeStored(items);
  }, [items]);

  /**
   * 记录一次打开。同一路径会被提到最前，并刷新元信息。
   * `extra` 用于把已经解码好的文件属性与缩略图一并写进去。
   */
  const push = useCallback(
    (path: string, extra?: Partial<Omit<RecentEntry, "path" | "name">>) => {
      setItems((prev) => {
        const old = prev.find((it) => it.path === path);
        const rest = prev.filter((it) => it.path !== path);
        const next: RecentEntry = {
          ...old,
          path,
          name: baseName(path),
          openedAt: Date.now(),
          ...extra,
          missing: false,
        };
        return [next, ...rest].slice(0, MAX_ITEMS);
      });
    },
    [],
  );

  /** 局部更新某条记录（补齐缩略图 / 修改时间 / 体积等）。 */
  const patch = useCallback(
    (path: string, extra: Partial<Omit<RecentEntry, "path">>) => {
      setItems((prev) =>
        prev.map((it) => (it.path === path ? { ...it, ...extra } : it)),
      );
    },
    [],
  );

  const remove = useCallback((path: string) => {
    setItems((prev) => prev.filter((it) => it.path !== path));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  return { items, push, patch, remove, clear };
}

/** 把时间戳格式化成「刚刚 / N 分钟前 / N 小时前 / 3 天前 / 2026-03-08」。 */
export function formatWhen(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day} 天前`;

  const d = new Date(ts);
  const mm = `${d.getMonth() + 1}`.padStart(2, "0");
  const dd = `${d.getDate()}`.padStart(2, "0");
  const yyyy = d.getFullYear();
  const thisYear = new Date().getFullYear();
  return yyyy === thisYear ? `${mm}-${dd}` : `${yyyy}-${mm}-${dd}`;
}

/** 把字节数格式化成「820 B / 1.2 MB」。 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
