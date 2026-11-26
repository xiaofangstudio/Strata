/**
 * 新建文档对话框的设置库（最近使用 + 自定义预设）。
 *
 * PhotoCraft `new_doc_ui` 的对应物：每次成功新建把设置推入 recent（去重、
 * 上限 8 条），用户也可以把当前设置存成命名预设。两份列表都落 localStorage
 * （会话间保留），这里只放纯数据变换 —— 排序、去重、封顶 —— 不碰 DOM，
 * 便于单测钉死语义。localStorage 的读写由对话框层自己做。
 */

export interface NewDocSettings {
  w: number;
  h: number;
  dpi: number;
  /** "white" | "transparent" | "black" | 任意 #rrggbb */
  bg: string;
}

export interface NamedDocPreset extends NewDocSettings {
  name: string;
}

export interface RecentDocEntry extends NewDocSettings {
  /** 创建时间戳（ms），新的排前面。 */
  at: number;
}

export const RECENT_LIMIT = 8;
export const PRESET_LIMIT = 24;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const BG_ENUM = new Set(["white", "transparent", "black"]);

/** 解析并夹取一份设置；非法输入返回 null，不猜。 */
export function normalizeSettings(raw: unknown): NewDocSettings | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const w = Math.round(Number(r.w));
  const h = Math.round(Number(r.h));
  const dpi = Math.round(Number(r.dpi));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1 || w > 16384 || h > 16384) {
    return null;
  }
  if (!Number.isFinite(dpi) || dpi < 1 || dpi > 2400) return null;
  const bg = r.bg;
  if (typeof bg === "string" && (BG_ENUM.has(bg) || HEX_RE.test(bg))) {
    return { w, h, dpi, bg };
  }
  return null;
}

/** 推入 recent：与已有设置完全相同的条目先移除，新条目置顶，封顶 RECENT_LIMIT。 */
export function pushRecent(list: RecentDocEntry[], settings: NewDocSettings, at: number): RecentDocEntry[] {
  const rest = list.filter(
    (e) => !(e.w === settings.w && e.h === settings.h && e.dpi === settings.dpi && e.bg === settings.bg),
  );
  return [{ ...settings, at }, ...rest].slice(0, RECENT_LIMIT);
}

/** 保存命名预设：同名覆盖（保留原位置），封顶 PRESET_LIMIT。 */
export function upsertPreset(list: NamedDocPreset[], preset: NamedDocPreset): NamedDocPreset[] {
  const name = preset.name.trim();
  if (!name) return list;
  const normalized = normalizeSettings(preset);
  if (!normalized) return list;
  const rest = list.filter((p) => p.name !== name);
  return [...rest.slice(0, PRESET_LIMIT - 1), { ...normalized, name }];
}

/** 解析 localStorage 里的 JSON 数组，逐条过 normalize，坏数据整条丢弃而不是整体作废。 */
export function parseList<T>(raw: string | null, pick: (entry: Record<string, unknown>) => T | null): T[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((e) => {
    if (typeof e !== "object" || e === null) return [];
    const got = pick(e as Record<string, unknown>);
    return got ? [got] : [];
  });
}

export function pickRecent(e: Record<string, unknown>): RecentDocEntry | null {
  const base = normalizeSettings(e);
  if (!base) return null;
  const at = Number(e.at);
  return { ...base, at: Number.isFinite(at) && at > 0 ? at : 0 };
}

export function pickPreset(e: Record<string, unknown>): NamedDocPreset | null {
  const base = normalizeSettings(e);
  if (!base) return null;
  const name = typeof e.name === "string" ? e.name.trim() : "";
  return name ? { ...base, name } : null;
}
