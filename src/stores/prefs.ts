/**
 * 偏好设置存储。
 *
 * 与主题一样走本地存储，但这里用「模块级 + 订阅」的方式共享，
 * 目的是让工具栏、偏好设置弹窗、画布外壳都能读到同一份状态，
 * 不必层层透传 props。
 */
import { useSyncExternalStore } from "react";
import type { ToolId } from "../tools/catalog";
import type { BrushTexture, BrushTip } from "../engine/paint";

/** 画笔参数（不含颜色，颜色跟随前景色）。 */
export interface BrushPrefs {
  size: number;
  /** 笔尖材质 */
  tip: BrushTip;
  /** 笔迹纹理 */
  texture: BrushTexture;
  /** 纹理缩放 50–400（%） */
  textureScale: number;
  /** 纹理深度 0–100（%） */
  textureDepth: number;
  /** 颜色抖动 0–100（%） */
  hueJitter: number;
  hardness: number;
  opacity: number;
  flow: number;
  spacing: number;
  /** 抖动 / 散布 0–100（%），笔尖沿路径随机偏移的幅度 */
  jitter: number;
  /** 笔尖圆度 10–100（%），100 为正圆 */
  roundness: number;
  /** 笔尖旋转角度 0–360（度） */
  angle: number;
  /** 稳定（平滑）0–100（%）：0 完全跟手，越高越顺滑但墨迹越滞后 */
  smoothing: number;
  /** 拉绳模式：指针要先拉出「稳定」对应的距离，画笔才跟过去 */
  pulledString: boolean;
  /** 指针停住时画笔是否继续追过去 */
  catchUp: boolean;
  /** 抬笔时是否把笔迹末端吸附到最后一个输入点 */
  catchUpOnEnd: boolean;

  /* 形状动态 */
  sizeJitter: number;
  sizeMin: number;
  angleJitter: number;
  roundnessJitter: number;
  roundnessMin: number;
  flipX: boolean;
  flipY: boolean;

  /* 散布 */
  scatterCount: number;
  scatterCountJitter: number;
  scatterBothAxes: boolean;

  /* 颜色动态 */
  saturationJitter: number;
  brightnessJitter: number;

  /* 传递 */
  opacityJitter: number;
  opacityMin: number;
  flowJitter: number;
  flowMin: number;

  /* 纹理 */
  textureInvert: boolean;
  textureBrightness: number;
  textureContrast: number;
}

/** 自定义画笔：参数快照 + 名字，存进偏好设置里长期保留。 */
export interface CustomBrush extends BrushPrefs {
  id: string;
  name: string;
}

export interface Prefs {
  /** 工具栏列数：1 / 2 / 3 列 */
  columns: 1 | 2 | 3;
  /** 被隐藏的工具（从工具栏移除，快捷键仍然生效） */
  hiddenTools: ToolId[];
  /** 上次用过的画笔参数，下次启动沿用 */
  brushDefaults: BrushPrefs;
  /** 用户自己存的画笔 */
  customBrushes: CustomBrush[];
}

export const DEFAULT_PREFS: Prefs = {
  columns: 2,
  hiddenTools: [],
  brushDefaults: {
    size: 32,
    tip: "round",
    texture: "none",
    textureScale: 100,
    textureDepth: 0,
    hueJitter: 0,
    hardness: 80,
    opacity: 100,
    flow: 100,
    spacing: 8,
    jitter: 0,
    roundness: 100,
    angle: 0,
    smoothing: 40,
    pulledString: false,
    catchUp: true,
    catchUpOnEnd: true,

    sizeJitter: 0,
    sizeMin: 0,
    angleJitter: 0,
    roundnessJitter: 0,
    roundnessMin: 10,
    flipX: false,
    flipY: false,

    scatterCount: 1,
    scatterCountJitter: 0,
    scatterBothAxes: true,

    saturationJitter: 0,
    brightnessJitter: 0,

    opacityJitter: 0,
    opacityMin: 0,
    flowJitter: 0,
    flowMin: 0,

    textureInvert: false,
    textureBrightness: 0,
    textureContrast: 0,
  },
  customBrushes: [],
};

const MAX_CUSTOM_BRUSHES = 24;

const STORAGE_KEY = "strata.prefs";

function read(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<Prefs>;
      const columns = v.columns === 1 || v.columns === 2 || v.columns === 3 ? v.columns : 2;
      const hidden = Array.isArray(v.hiddenTools) ? (v.hiddenTools as ToolId[]) : [];
      const d = v.brushDefaults ?? DEFAULT_PREFS.brushDefaults;
      return {
        columns,
        hiddenTools: hidden,
        brushDefaults: normalizeBrush(d),
        customBrushes: readBrushes(v.customBrushes),
      };
    }
  } catch {
    /* 存储不可用或内容损坏时退回默认 */
  }
  return {
    ...DEFAULT_PREFS,
    hiddenTools: [],
    brushDefaults: { ...DEFAULT_PREFS.brushDefaults },
    customBrushes: [],
  };
}

/** 自定义画笔是用户数据，读到一条坏数据就丢掉这一条，不能让整份偏好一起回滚。 */
function readBrushes(raw: unknown): CustomBrush[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomBrush[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const b = item as Partial<CustomBrush>;
    if (typeof b.id !== "string" || typeof b.name !== "string") continue;
    out.push({
      id: b.id,
      name: b.name.slice(0, 24),
      ...normalizeBrush(b),
    });
    if (out.length >= MAX_CUSTOM_BRUSHES) break;
  }
  return out;
}

/** 把任意来源（存档 / 内核 BrushSettings）规整成一份字段齐全的画笔参数。 */
export function normalizeBrush(raw: Partial<BrushPrefs> | null | undefined): BrushPrefs {
  const d = DEFAULT_PREFS.brushDefaults;
  const v = (raw ?? {}) as Record<string, unknown>;
  const out = { ...d };
  out.tip = oneOf(v.tip, TIPS, d.tip);
  out.texture = oneOf(v.texture, TEXTURES, d.texture);
  for (const k of NUMERIC_KEYS) out[k] = num(v[k], d[k]);
  for (const k of BOOLEAN_KEYS) out[k] = bool(v[k], d[k]);
  return out;
}

/** 内核画笔 → 可存档参数（丢掉 color，补齐所有动态字段）。 */
export function toBrushPrefs(b: BrushPrefs): BrushPrefs {
  return normalizeBrush(b);
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** 枚举字段的合法取值：存档里出现未知字符串时退回默认，别把坏值带进内核。 */
const TIPS: readonly BrushTip[] = ["round", "pencil", "chalk", "bristle", "spray"];
const TEXTURES: readonly BrushTexture[] = ["none", "paper", "canvas", "grain", "dots"];

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** 数值 / 布尔字段清单：存档解析与自定义画笔入库共用，避免逐字段抄写漏项。 */
const NUMERIC_KEYS = [
  "size", "textureScale", "textureDepth", "hueJitter", "hardness",
  "opacity", "flow", "spacing", "jitter", "roundness", "angle", "smoothing",
  "sizeJitter", "sizeMin", "angleJitter", "roundnessJitter", "roundnessMin",
  "scatterCount", "scatterCountJitter", "saturationJitter", "brightnessJitter",
  "opacityJitter", "opacityMin", "flowJitter", "flowMin",
  "textureBrightness", "textureContrast",
] as const satisfies readonly (keyof BrushPrefs)[];

const BOOLEAN_KEYS = [
  "pulledString", "catchUp", "catchUpOnEnd",
  "flipX", "flipY", "scatterBothAxes", "textureInvert",
] as const satisfies readonly (keyof BrushPrefs)[];

let current: Prefs = read();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 合并式写入偏好设置。 */
export function setPrefs(patch: Partial<Prefs>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* 忽略写入失败 */
  }
  emit();
}

/** 恢复出厂设置。 */
export function resetPrefs() {
  setPrefs({
    columns: DEFAULT_PREFS.columns,
    hiddenTools: [],
    brushDefaults: { ...DEFAULT_PREFS.brushDefaults },
    customBrushes: [],
  });
}

/** 把当前参数存成一支自定义画笔，返回新的那条记录（同名不重复追加，只覆盖参数）。 */
export function addCustomBrush(name: string, b: BrushPrefs): CustomBrush {
  const trimmed = name.trim().slice(0, 24) || "自定义";
  const existing = current.customBrushes.find((x) => x.name === trimmed);
  const entry: CustomBrush = {
    id: existing?.id ?? `cb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: trimmed,
    ...toBrushPrefs(b),
  };
  const rest = current.customBrushes.filter((x) => x.id !== entry.id);
  setPrefs({ customBrushes: [...rest, entry].slice(-MAX_CUSTOM_BRUSHES) });
  return entry;
}

/** 删掉一支自定义画笔。 */
export function removeCustomBrush(id: string) {
  setPrefs({ customBrushes: current.customBrushes.filter((x) => x.id !== id) });
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
}
