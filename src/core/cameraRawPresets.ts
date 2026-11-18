/**
 * Camera Raw 预设的存读与校验（纯函数，不碰 DOM / localStorage）。
 *
 * 为什么要有这一层：预设来自 localStorage，可能被旧版本、手改、别的扩展写脏。
 * 直接 `JSON.parse` 后塞进参数滑杆，一个 NaN 或字符串就能让整个大窗白屏。
 * 这里做严格的白名单校验——只认 cameraraw 的 18 个参数、数值必须有限、落在定义域内；
 * 任何不合法的字段回退到默认值。内置预设与用户预设走同一条校验路径。
 *
 * 移植/对齐口径：预设概念对应 PhotoCraft 的 .xmp 存读（ui-egui camera_raw_ui），
 * 但这里用 localStorage 存 JSON —— Strata 是 8 位管线，不引入 XMP 依赖，
 * 保留「预设可持久化、可复现」这一核心能力。
 */
import { adjustDef, newAdjustState, type AdjustState } from "./layer";

const DEF = adjustDef("cameraraw");

export interface RawPreset {
  name: string;
  params: Record<string, number>;
  builtin?: boolean;
}

const KEY = "strata.cameraraw.presets";

/** 把任意输入规整成一份合法的 cameraraw 参数表（白名单 + 定义域夹取）。 */
export function sanitizeParams(input: unknown): Record<string, number> {
  const out: Record<string, number> = newAdjustState("cameraraw").params;
  if (!input || typeof input !== "object") return out;
  const src = input as Record<string, unknown>;
  for (const p of DEF.params) {
    const raw = src[p.id];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    // 预设里允许略微越界（老版本范围不同），夹到当前定义域即可，不丢弃用户设置
    out[p.id] = Math.min(p.max, Math.max(p.min, raw));
  }
  return out;
}

/** 内置预设（对应 PS 的常规胶片风格基线），全部走 sanitize 保证合法。 */
export const BUILTIN_PRESETS: RawPreset[] = [
  { name: "原图", params: sanitizeParams({}), builtin: true },
  {
    name: "通透日光",
    builtin: true,
    params: sanitizeParams({ temperature: 12, contrast: 18, highlights: -24, shadows: 20, vibrance: 18, clarity: 10 }),
  },
  {
    name: "暖调人像",
    builtin: true,
    params: sanitizeParams({ temperature: 20, tint: 6, contrast: -8, highlights: -12, shadows: 14, vibrance: 10, texture: -6 }),
  },
  {
    name: "冷调街拍",
    builtin: true,
    params: sanitizeParams({ temperature: -22, contrast: 24, blacks: -18, dehaze: 16, saturation: -8 }),
  },
  {
    name: "胶片柔和生活",
    builtin: true,
    params: sanitizeParams({ contrast: -12, highlights: -16, shadows: 18, curve: 1, vignette: -12, texture: -8 }),
  },
];

/** 从 localStorage 读用户预设。任何异常（不可用 / 脏 JSON / 非数组）都返回空表，绝不抛。 */
export function loadUserPresets(storage?: Pick<Storage, "getItem">): RawPreset[] {
  try {
    const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
    if (!s) return [];
    const raw = s.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: RawPreset[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const p = item as Record<string, unknown>;
      if (typeof p.name !== "string" || !p.name.trim()) continue;
      out.push({
        name: p.name.trim().slice(0, 40),
        params: sanitizeParams(p.params),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** 写用户预设。内置预设不落盘；同名覆盖。返回是否成功（隐私模式下 localStorage 可能抛）。 */
export function saveUserPreset(
  preset: RawPreset,
  existing: RawPreset[],
  storage?: Pick<Storage, "getItem" | "setItem">,
): boolean {
  try {
    const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
    if (!s) return false;
    const name = preset.name.trim().slice(0, 40);
    if (!name) return false;
    const clean: RawPreset = { name, params: sanitizeParams(preset.params) };
    const list = existing.filter((p) => p.name !== name).concat(clean);
    s.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** 删除用户预设（内置预设不可删，直接忽略）。 */
export function deleteUserPreset(
  name: string,
  existing: RawPreset[],
  storage?: Pick<Storage, "getItem" | "setItem">,
): boolean {
  try {
    const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
    if (!s) return false;
    s.setItem(KEY, JSON.stringify(existing.filter((p) => p.name !== name)));
    return true;
  } catch {
    return false;
  }
}

/** 把一份参数包成 cameraraw 调整状态（供 Camera Raw 大窗套用预设）。 */
export function presetToAdjust(params: Record<string, number>): AdjustState {
  return { id: "cameraraw", params: sanitizeParams(params) };
}
