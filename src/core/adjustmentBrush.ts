/**
 * 调整画笔的纯逻辑（移植自 PhotoCraft 的 Adjustment Brush Tool，#12519）。
 *
 * 语义与上游一致：
 *   · 笔落在同类调整层的蒙版上 → 直接改那张蒙版；
 *   · 没有同类调整层 → 在活动层上方新建一层，起始参数不是中性值（不这么做
 *     用户会以为工具坏了），当前选区直接变成蒙版，再叠上这一笔；
 *   · Add = 在黑蒙版上画白，Subtract = 从白蒙版里挖掉；
 *   · 索引颜色模式整笔拒绝，不画半个历史。
 *
 * 这里只做不碰 DOM 的决策与数据构造；画布上的落笔由 EditorShell 用同一套
 * Stroke 引擎完成，像素合成走 composeMaskAlpha 的等价 Canvas 路径。
 */
import type { StrataDoc } from "./document";
import {
  adjustDef,
  createAdjustLayer,
  newAdjustState,
  type AdjustId,
  type AdjustState,
  type StrataLayer,
} from "./layer";

export type AdjustBrushKind =
  | "levels"
  | "curves"
  | "exposure"
  | "hueSaturation"
  | "colorBalance"
  | "blackWhite"
  | "photoFilter"
  | "channelMixer"
  | "colorLookup"
  | "selectiveColor"
  | "invert"
  | "posterize"
  | "threshold"
  | "gradientMap";

export interface AdjustBrushKindEntry {
  kind: AdjustBrushKind;
  adjustId: AdjustId;
  /** i18n 键（zh.options.adjustBrushKinds.<key>） */
  labelKey: string;
  separatorAfter?: boolean;
}

/** 与 PhotoCraft 选项条同序，分隔符也对齐（Grain / Exposure / Selective Color 之后）。 */
export const ADJUST_BRUSH_KINDS: readonly AdjustBrushKindEntry[] = [
  { kind: "levels", adjustId: "levels", labelKey: "levels" },
  { kind: "curves", adjustId: "curves", labelKey: "curves" },
  { kind: "exposure", adjustId: "exposure", labelKey: "exposure", separatorAfter: true },
  { kind: "hueSaturation", adjustId: "hs", labelKey: "hueSaturation" },
  { kind: "colorBalance", adjustId: "colorbalance", labelKey: "colorBalance" },
  { kind: "blackWhite", adjustId: "bw", labelKey: "blackWhite" },
  { kind: "photoFilter", adjustId: "photofilter", labelKey: "photoFilter" },
  { kind: "channelMixer", adjustId: "channelmixer", labelKey: "channelMixer" },
  { kind: "colorLookup", adjustId: "colorlookup", labelKey: "colorLookup" },
  { kind: "selectiveColor", adjustId: "selectivecolor", labelKey: "selectiveColor", separatorAfter: true },
  { kind: "invert", adjustId: "invert", labelKey: "invert" },
  { kind: "posterize", adjustId: "posterize", labelKey: "posterize" },
  { kind: "threshold", adjustId: "threshold", labelKey: "threshold" },
  { kind: "gradientMap", adjustId: "gradientmap", labelKey: "gradientMap" },
];

export const DEFAULT_ADJUST_BRUSH_KIND: AdjustBrushKind = "levels";

/** 选项条状态：画哪种调整、加还是减、画布上是否染色预览蒙版。 */
export interface AdjustBrushSettings {
  kind: AdjustBrushKind;
  subtract: boolean;
  overlay: boolean;
}

export const DEFAULT_ADJUST_BRUSH: AdjustBrushSettings = {
  kind: DEFAULT_ADJUST_BRUSH_KIND,
  subtract: false,
  overlay: false,
};

/** 未知 id 一律退回默认项 —— 偏好文件里塞了旧值也不能让工具变哑。 */
export function adjustBrushEntry(kind: string | null | undefined): AdjustBrushKindEntry {
  return ADJUST_BRUSH_KINDS.find((e) => e.kind === kind) ?? ADJUST_BRUSH_KINDS[0];
}

/** 当前调整层的 adjust.id → 选项条下拉项，选中调整层时下拉跟着走。 */
export function adjustBrushFollowKind(layer: StrataLayer | null | undefined): AdjustBrushKind | null {
  if (layer?.kind !== "adjust" || !layer.adjust) return null;
  return ADJUST_BRUSH_KINDS.find((e) => e.adjustId === layer.adjust?.id)?.kind ?? null;
}

/**
 * 新建调整层的起始参数。
 *
 * PhotoCraft 刻意不用中性的「新建调整图层」默认值（那样画上去看不出变化）；
 * 这里按同一批数值映射到 Strata 的参数名与单位，保证落笔立刻可见。
 */
export function adjustBrushStartingState(kind: AdjustBrushKind): AdjustState {
  const id = adjustBrushEntry(kind).adjustId;
  const state = newAdjustState(id);
  switch (kind) {
    case "levels":
      Object.assign(state.params, { inBlack: 20, inWhite: 220, gamma: 100, outBlack: 0, outWhite: 255 });
      break;
    case "curves":
      state.curve = [
        { x: 0, y: 0 },
        { x: 127 / 255, y: 191 / 255 },
        { x: 1, y: 1 },
      ];
      break;
    case "exposure":
      Object.assign(state.params, { exposure: 1, offset: 0, gamma: 1 });
      break;
    case "hueSaturation":
      Object.assign(state.params, { hue: 0, saturate: 30 });
      break;
    case "colorBalance":
      Object.assign(state.params, { mdcr: 20, mdmg: -15, mdyb: 15 });
      break;
    case "photoFilter":
      Object.assign(state.params, { hue: 40, strength: 25, preserve: 100 });
      break;
    case "channelMixer":
      Object.assign(state.params, { rr: 80, rg: 10, rb: 10, rc: 5 });
      break;
    case "selectiveColor":
      Object.assign(state.params, { redsC: -20, redsM: 100, redsY: -60, redsK: 40 });
      break;
    case "posterize":
      Object.assign(state.params, { levels: 4 });
      break;
    case "threshold":
      Object.assign(state.params, { level: 128 });
      break;
    // invert / bw / gradientMap / colorLookup 的缺省就已经有明显效果
    default:
      break;
  }
  return state;
}

/** 索引颜色模式整笔拒绝（与上游的 INDEXED_ALERT 同一口径）。 */
export function adjustBrushRefused(doc: StrataDoc): boolean {
  return doc.colorMode === "indexed";
}

/**
 * 这一笔要画进哪张蒙版。
 *
 * 先看这一次手势记住的目标层（连续两笔都落在同一层），再看活动层是不是同类
 * 调整层。绝不因为新建层去改 doc.activeLayerId —— 那条老坑会让调色台变脸。
 */
export function adjustBrushTargetLayer(
  doc: StrataDoc,
  kind: AdjustBrushKind,
  preferredId?: string | null,
): StrataLayer | null {
  const id = adjustBrushEntry(kind).adjustId;
  const matches = (l: StrataLayer | undefined): boolean =>
    l?.kind === "adjust" && l.adjust?.id === id && Boolean(l.mask);
  if (preferredId) {
    const preferred = doc.layers.find((l) => l.id === preferredId);
    if (matches(preferred)) return preferred ?? null;
  }
  const active = doc.layers.find((l) => l.id === doc.activeLayerId);
  return matches(active) ? active ?? null : null;
}

export interface AdjustBrushBuild {
  doc: StrataDoc;
  layerId: string;
}

export interface AdjustBrushBuildOptions {
  /** 仅供无 DOM 的单测注入；生产走 createAdjustLayer（1×1 占位 surface） */
  makeLayer?: (name: string, state: AdjustState) => StrataLayer;
}

/**
 * 新建「带全隐藏蒙版」的调整层，插在活动层上方。
 *
 * 位置规则与 layerOps.spliceAbove 完全一致（选中组就落进组内最上层），
 * 唯一区别是**保留 activeLayerId**。selection 由调用方先画进 mask 再清空。
 */
export function buildAdjustBrushDoc(
  doc: StrataDoc,
  kind: AdjustBrushKind,
  mask: HTMLCanvasElement,
  options?: AdjustBrushBuildOptions,
): AdjustBrushBuild {
  const entry = adjustBrushEntry(kind);
  const state = adjustBrushStartingState(kind);
  const layer = options?.makeLayer
    ? options.makeLayer(adjustDef(entry.adjustId).label, state)
    : createAdjustLayer(adjustDef(entry.adjustId).label, state);
  const at = doc.layers.findIndex((l) => l.id === doc.activeLayerId);
  const cur = at >= 0 ? doc.layers[at] : null;
  const parent = cur ? (cur.kind === "group" ? cur.id : (cur.parent ?? null)) : null;
  const placed: StrataLayer = {
    ...layer,
    parent,
    mask,
    maskActive: true,
  };
  const where = cur?.kind === "group" ? at : at < 0 ? doc.layers.length : at + 1;
  const layers = [...doc.layers];
  layers.splice(where, 0, placed);
  return {
    doc: { ...doc, layers, selection: null, dirty: true },
    layerId: placed.id,
  };
}

/**
 * 蒙版 alpha 合成（Add / Subtract）。
 *
 * 蒙版以 alpha 存储：255 = 显示调整，0 = 不显示。Add 是「白笔盖上去」，
 * Subtract 是「从已有 alpha 里挖掉」，都不是简单覆盖 —— 后者多次描同一处
 * 会逐渐减弱而不是一下子到底。
 */
export function composeMaskAlpha(
  base: Uint8Array | Uint8ClampedArray,
  stroke: Uint8Array | Uint8ClampedArray,
  subtract: boolean,
  opacity = 1,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(base.length);
  const a = Math.min(1, Math.max(0, opacity));
  for (let i = 0; i < base.length; i += 4) {
    const src = (stroke[i + 3] / 255) * a;
    const dst = base[i + 3] / 255;
    const alpha = subtract ? dst * (1 - src) : dst + (1 - dst) * src;
    out[i] = 255;
    out[i + 1] = 255;
    out[i + 2] = 255;
    out[i + 3] = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  }
  return out;
}
