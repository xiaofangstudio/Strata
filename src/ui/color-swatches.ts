/**
 * 色板存储：我的色板 + 最近使用。
 *
 * 与偏好设置一样走「模块级 + 订阅」，让常驻调色面板、色块浮层读到同一份数据。
 * 只存颜色字符串，读到坏数据就丢掉那一条，不能因为一条坏色把整份色板清空。
 */
import { useSyncExternalStore } from "react";
import { normalizeHex } from "./color-utils";

export interface ColorSwatches {
  saved: string[];
  recent: string[];
}

const STORAGE_KEY = "strata.color.swatches.v1";
const MAX_SAVED = 48;
const MAX_RECENT = 18;

/** 去重、规范化、截断，任意来源都能安全落进状态。 */
function sanitize(list: unknown, max: number): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const hex = normalizeHex(item);
    if (!hex || out.includes(hex)) continue;
    out.push(hex);
    if (out.length >= max) break;
  }
  return out;
}

function read(): ColorSwatches {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<ColorSwatches>;
      return {
        saved: sanitize(v.saved, MAX_SAVED),
        recent: sanitize(v.recent, MAX_RECENT),
      };
    }
  } catch {
    /* 存储不可用或内容损坏时退回空色板 */
  }
  return { saved: [], recent: [] };
}

let current: ColorSwatches = read();
const listeners = new Set<() => void>();

function emit(next: ColorSwatches) {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* 存储不可用时只在内存里生效 */
  }
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useColorSwatches(): ColorSwatches {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
}

/** 保存一个颜色：已存在就挪到最前面，超出上限丢最旧的。 */
export function addSavedColor(hex: string) {
  const ok = normalizeHex(hex);
  if (!ok) return;
  emit({
    ...current,
    saved: [ok, ...current.saved.filter((c) => c !== ok)].slice(0, MAX_SAVED),
  });
}

export function removeSavedColor(hex: string) {
  const ok = normalizeHex(hex);
  if (!ok) return;
  emit({ ...current, saved: current.saved.filter((c) => c !== ok) });
}

/** 记录最近使用：同一个色不重复堆叠，最新的排最前。 */
export function touchRecentColor(hex: string) {
  const ok = normalizeHex(hex);
  if (!ok) return;
  if (current.recent[0] === ok) return;
  emit({
    ...current,
    recent: [ok, ...current.recent.filter((c) => c !== ok)].slice(0, MAX_RECENT),
  });
}
