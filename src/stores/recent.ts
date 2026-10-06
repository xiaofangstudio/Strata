import { useCallback, useEffect, useState } from "react";
import { baseName } from "../core/document";

/** 最近打开的文件记录。M0 只记路径与名字，用于开始页面回填。 */
export interface RecentEntry {
  path: string;
  name: string;
  /** 打开时间戳（毫秒） */
  openedAt: number;
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

/** 最近文件列表，落 localStorage。 */
export function useRecentFiles() {
  const [items, setItems] = useState<RecentEntry[]>(readStored);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      /* 忽略写入失败 */
    }
  }, [items]);

  const push = useCallback((path: string) => {
    setItems((prev) => {
      const rest = prev.filter((it) => it.path !== path);
      const next: RecentEntry = {
        path,
        name: baseName(path),
        openedAt: Date.now(),
      };
      return [next, ...rest].slice(0, MAX_ITEMS);
    });
  }, []);

  const remove = useCallback((path: string) => {
    setItems((prev) => prev.filter((it) => it.path !== path));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  return { items, push, remove, clear };
}

/** 把时间戳格式化成「刚刚 / N 分钟前 / N 小时前 / 月-日」。 */
export function formatWhen(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const d = new Date(ts);
  const mm = `${d.getMonth() + 1}`.padStart(2, "0");
  const dd = `${d.getDate()}`.padStart(2, "0");
  return `${mm}-${dd}`;
}
