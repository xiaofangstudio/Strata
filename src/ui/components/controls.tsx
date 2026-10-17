/**
 * 共享控件。
 *
 * 选项条（顶栏）与工具轨二级面板（再次点击工具弹出）用的是同一套零件：
 * 滑杆、分段选择、复选、选区四态、**可编辑颜色**。
 *
 * 这里没有只读装饰件：每一个色块都能点开改颜色 —— 点开是浮层，里面有取色器、
 * 十六进制输入与一排常用色，三样任选其一都能立刻改到当前工具。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { zh } from "../../i18n/zh-CN";
import type { SelectionMode } from "../../core/selection";
import { DEFAULT_BRUSH, drawBrushTipSample, type BrushSettings } from "../../engine/paint";
import {
  DEFAULT_PREFS,
  addCustomBrush,
  removeCustomBrush,
  toBrushPrefs,
  usePrefs,
  type BrushPrefs,
} from "../../stores/prefs";
import ColorPicker from "./ColorPicker";
import "./picker.css";

/** 颜色工具的对外出口，保持既有引用可用。 */
export { COLOR_PRESETS, normalizeHex } from "../color-utils";

/* ---------------- 滑杆 ---------------- */

export interface SliderProps {
  label: string;
  min: number;
  max: number;
  value: number;
  suffix?: string;
  /** 悬停提示，挂在整行上 */
  hint?: string;
  onChange: (v: number) => void;
}

export function Slider({ label, min, max, value, suffix, hint, onChange }: SliderProps) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v)));
  return (
    <label className="opt" title={hint}>
      <span className="opt-label">{label}</span>
      <input
        type="range"
        className="opt-range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
      />
      <input
        type="number"
        className="opt-num"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
      />
      {suffix && <span className="opt-suffix">{suffix}</span>}
    </label>
  );
}

/* ---------------- 分段选择 ---------------- */

export interface SegOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** 通用分段选择（画笔预设 / 海绵模式 / 渐变类型 / 减淡范围）。 */
export function SegGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: SegOption<T>[];
  onChange: (v: T) => void;
}) {
  return (
    <span className="opt">
      <span className="opt-label">{label}</span>
      <span className="opt-modes" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            className={value === o.value ? "opt-mode is-on" : "opt-mode"}
            title={o.hint}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </span>
    </span>
  );
}

/* ---------------- 复选 ---------------- */

export function Check({
  label,
  on,
  onChange,
  hint,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="opt opt-check" title={hint}>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="opt-label">{label}</span>
    </label>
  );
}

/* ---------------- 选区四态 ---------------- */

const MODE_ORDER: SelectionMode[] = ["new", "add", "subtract", "intersect"];

const MODE_TEXT: Record<SelectionMode, { short: string; full: string; hint: string }> = {
  new: { short: "新建", full: zh.selection.new, hint: zh.selection.newHint },
  add: { short: "添加", full: zh.selection.add, hint: zh.selection.addHint },
  subtract: { short: "减去", full: zh.selection.subtract, hint: zh.selection.subtractHint },
  intersect: { short: "交叉", full: zh.selection.intersect, hint: zh.selection.intersectHint },
};

/** 选区工具的四态模式：与 PS 一致，永远是「新建 / 添加 / 减去 / 交叉」。 */
export function ModeGroup({
  value,
  onChange,
}: {
  value: SelectionMode;
  onChange: (m: SelectionMode) => void;
}) {
  return (
    <span className="opt">
      <span className="opt-label">{zh.options.mode}</span>
      <span className="opt-modes" role="radiogroup" aria-label={zh.options.mode}>
        {MODE_ORDER.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={value === m}
            className={value === m ? "opt-mode is-on" : "opt-mode"}
            title={`${MODE_TEXT[m].full}：${MODE_TEXT[m].hint}`}
            onClick={() => onChange(m)}
          >
            {MODE_TEXT[m].short}
          </button>
        ))}
      </span>
    </span>
  );
}

/* ---------------- 颜色 ---------------- */

export interface ColorFieldProps {
  label: string;
  hex: string;
  onChange: (hex: string) => void;
  /** 只显示色块，不显示十六进制文字（顶栏空间紧时用） */
  compact?: boolean;
  hint?: string;
  /** 额外挂在浮层底部的一行内容（如「交换」「默认黑白」） */
  footer?: ReactNode;
}

/**
 * 可编辑颜色字段。
 *
 * 外观与原来那个只读色块一模一样（标签 + 色块 + 十六进制），但**整块可点**：
 * 点开浮层即可用取色器 / 十六进制 / 常用色三种方式改色。点外面或按 Esc 收起。
 */
export function ColorField({
  label,
  hex,
  onChange,
  compact,
  hint,
  footer,
}: ColorFieldProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }

    // 浮层挂到 body 上（portal），位置按色块的屏幕坐标算。
    // 这样无论外面是「选项条那条 42px 高、overflow:hidden 的横杠」还是
    // 「overflow-y:auto 的二级面板」，浮层都不会被裁掉 —— 不会出现点了没反应的假按钮。
    const place = () => {
      const el = btnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const W = 236;
      const H = 322; // 拾色器 + 色相条 + 十六进制 + 两行常用色 + 底栏的估高
      const left = Math.max(8, Math.min(Math.round(r.left), window.innerWidth - W - 8));
      let top = Math.round(r.bottom + 8);
      if (top + H > window.innerHeight - 8) top = Math.max(8, Math.round(r.top - 8 - H));
      setPos({ left, top });
    };
    place();

    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const close = () => setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return (
    <span className="opt opt-color" ref={rootRef}>
      <span className="opt-label">{label}</span>
      <button
        ref={btnRef}
        type="button"
        className="opt-chip-btn"
        style={{ background: hex }}
        aria-label={`${label}，当前 ${hex.toUpperCase()}，点击修改`}
        aria-expanded={open}
        title={hint ?? `${label} ${hex.toUpperCase()}`}
        onClick={() => setOpen((v) => !v)}
      />
      {!compact && <span className="opt-hex">{hex.toUpperCase()}</span>}

      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className="color-pop"
            role="dialog"
            aria-label={label}
            style={{ position: "fixed", left: pos.left, top: pos.top }}
          >
            <ColorPicker hex={hex} onChange={onChange} />
            {footer && <div className="color-pop-foot">{footer}</div>}
          </div>,
          document.body,
        )}
    </span>
  );
}

/* ---------------- 画笔预设 ---------------- */

export type BrushPresetId =
  | "hard"
  | "soft"
  | "pencil"
  | "charcoal"
  | "chalk"
  | "ink"
  | "airbrush"
  | "marker"
  | "watercolor"
  | "crayon"
  | "calligraphy"
  | "pixel"
  | "spray"
  | "grain"
  | "flat"
  | "oil";
export type BrushPresetKey = BrushPresetId | "custom";

/**
 * 画笔预设：一键把全部材质参数同时调到位。
 * 只覆盖参数，颜色沿用当前前景色 —— 换预设不该把用户选的颜色也换掉。
 */
export const BRUSH_PRESETS: {
  id: BrushPresetId;
  label: string;
  hint: string;
  patch: Partial<BrushSettings>;
}[] = [
  {
    id: "hard",
    label: zh.options.presetHard,
    hint: zh.options.presetHardHint,
    patch: { size: 24, hardness: 96, opacity: 100, flow: 100, spacing: 6, jitter: 0, roundness: 100, angle: 0, tip: "round", texture: "none", textureScale: 100, textureDepth: 0, hueJitter: 0 },
  },
  {
    id: "soft",
    label: zh.options.presetSoft,
    hint: zh.options.presetSoftHint,
    patch: { size: 64, hardness: 24, opacity: 100, flow: 45, spacing: 6, jitter: 0, roundness: 100, angle: 0, tip: "round", texture: "none", textureScale: 100, textureDepth: 0, hueJitter: 0 },
  },
  {
    id: "pencil",
    label: zh.options.presetPencil,
    hint: zh.options.presetPencilHint,
    patch: { size: 4, hardness: 92, opacity: 80, flow: 100, spacing: 4, jitter: 0, roundness: 96, angle: 0, tip: "pencil", texture: "paper", textureScale: 130, textureDepth: 45, hueJitter: 0 },
  },
  {
    id: "charcoal",
    label: zh.options.presetCharcoal,
    hint: zh.options.presetCharcoalHint,
    patch: { size: 30, hardness: 55, opacity: 88, flow: 55, spacing: 8, jitter: 12, roundness: 80, angle: 15, tip: "chalk", texture: "paper", textureScale: 160, textureDepth: 55, hueJitter: 0 },
  },
  {
    id: "chalk",
    label: zh.options.presetChalk,
    hint: zh.options.presetChalkHint,
    patch: { size: 22, hardness: 70, opacity: 85, flow: 50, spacing: 10, jitter: 8, roundness: 100, angle: 0, tip: "chalk", texture: "grain", textureScale: 120, textureDepth: 60, hueJitter: 0 },
  },
  {
    id: "ink",
    label: zh.options.presetInk,
    hint: zh.options.presetInkHint,
    patch: { size: 6, hardness: 100, opacity: 100, flow: 100, spacing: 3, jitter: 0, roundness: 100, angle: 0, tip: "round", texture: "none", textureScale: 100, textureDepth: 0, hueJitter: 0 },
  },
  {
    id: "airbrush",
    label: zh.options.presetAirbrush,
    hint: zh.options.presetAirbrushHint,
    patch: { size: 120, hardness: 0, opacity: 55, flow: 16, spacing: 5, jitter: 8, roundness: 100, angle: 0, tip: "spray", texture: "none", textureScale: 100, textureDepth: 0, hueJitter: 0 },
  },
  {
    id: "marker",
    label: zh.options.presetMarker,
    hint: zh.options.presetMarkerHint,
    patch: { size: 40, hardness: 72, opacity: 62, flow: 100, spacing: 5, jitter: 0, roundness: 100, angle: 0, tip: "round", texture: "paper", textureScale: 100, textureDepth: 18, hueJitter: 0 },
  },
  {
    id: "watercolor",
    label: zh.options.presetWatercolor,
    hint: zh.options.presetWatercolorHint,
    patch: { size: 90, hardness: 10, opacity: 90, flow: 10, spacing: 8, jitter: 12, roundness: 100, angle: 0, tip: "round", texture: "paper", textureScale: 180, textureDepth: 45, hueJitter: 0 },
  },
  {
    id: "crayon",
    label: zh.options.presetCrayon,
    hint: zh.options.presetCrayonHint,
    patch: { size: 18, hardness: 88, opacity: 70, flow: 38, spacing: 14, jitter: 30, roundness: 92, angle: 0, tip: "chalk", texture: "grain", textureScale: 140, textureDepth: 55, hueJitter: 0 },
  },
  {
    id: "calligraphy",
    label: zh.options.presetCalligraphy,
    hint: zh.options.presetCalligraphyHint,
    patch: { size: 26, hardness: 100, opacity: 100, flow: 100, spacing: 20, jitter: 0, roundness: 32, angle: 45, tip: "round", texture: "none", textureScale: 100, textureDepth: 0, hueJitter: 0 },
  },
  {
    id: "pixel",
    label: zh.options.presetPixel,
    hint: zh.options.presetPixelHint,
    patch: { size: 2, hardness: 100, opacity: 100, flow: 100, spacing: 2, jitter: 0, roundness: 100, angle: 0, tip: "round", texture: "none", textureScale: 100, textureDepth: 0, hueJitter: 0 },
  },
  {
    id: "spray",
    label: zh.options.presetSpray,
    hint: zh.options.presetSprayHint,
    patch: { size: 70, hardness: 0, opacity: 60, flow: 22, spacing: 4, jitter: 70, roundness: 100, angle: 0, tip: "spray", texture: "grain", textureScale: 100, textureDepth: 30, hueJitter: 0 },
  },
  {
    id: "grain",
    label: zh.options.presetGrain,
    hint: zh.options.presetGrainHint,
    patch: { size: 36, hardness: 40, opacity: 70, flow: 35, spacing: 6, jitter: 35, roundness: 100, angle: 0, tip: "spray", texture: "grain", textureScale: 90, textureDepth: 45, hueJitter: 25 },
  },
  {
    id: "flat",
    label: zh.options.presetFlat,
    hint: zh.options.presetFlatHint,
    patch: { size: 40, hardness: 92, opacity: 100, flow: 100, spacing: 6, jitter: 0, roundness: 28, angle: 45, tip: "round", texture: "none", textureScale: 100, textureDepth: 0, hueJitter: 0 },
  },
  {
    id: "oil",
    label: zh.options.presetOil,
    hint: zh.options.presetOilHint,
    patch: { size: 54, hardness: 70, opacity: 82, flow: 42, spacing: 10, jitter: 26, roundness: 86, angle: 20, tip: "bristle", texture: "canvas", textureScale: 160, textureDepth: 40, hueJitter: 0 },
  },
];

/** 与预设高亮相关的参数键（颜色与平滑不算，它们不随预设切换）。 */
const PRESET_KEYS = [
  "size",
  "hardness",
  "opacity",
  "flow",
  "spacing",
  "jitter",
  "roundness",
  "angle",
  "tip",
  "texture",
  "textureScale",
  "textureDepth",
  "hueJitter",
] as const;

/** 预设不覆盖的动态参数键：切预设时必须先把它们拉回默认，否则上一支笔的抖动会带过来。 */
export const DYNAMIC_KEYS = [
  "sizeJitter",
  "sizeMin",
  "angleJitter",
  "roundnessJitter",
  "roundnessMin",
  "flipX",
  "flipY",
  "scatterCount",
  "scatterCountJitter",
  "scatterBothAxes",
  "saturationJitter",
  "brightnessJitter",
  "opacityJitter",
  "opacityMin",
  "flowJitter",
  "flowMin",
  "textureInvert",
  "textureBrightness",
  "textureContrast",
] as const;

export const BRUSH_DYNAMIC_DEFAULTS: Pick<BrushSettings, (typeof DYNAMIC_KEYS)[number]> = {
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
};

/** 参数与某个预设完全一致时高亮它，否则落在「自定义」。 */
export function matchPreset(b: BrushSettings): BrushPresetKey {
  const hit = BRUSH_PRESETS.find(
    (r) =>
      PRESET_KEYS.every((k) => (r.patch[k] as unknown) === (b[k] as unknown)) &&
      DYNAMIC_KEYS.every(
        (k) => (BRUSH_DYNAMIC_DEFAULTS[k] as unknown) === (b[k] as unknown),
      ),
  );
  return hit ? hit.id : "custom";
}

/**
 * 可换行的预设笔尖戳：每个预设渲染一枚真实笔尖小样（形状 / 羽化 / 抖动 / 扁锋
 * 都按内核同源逻辑画出来），一眼能认出「这是铅笔、那是喷枪」，不再靠文字猜。
 * 当前命中的那枚高亮；参数被手动改走后落在「自定义」。
 */
export function BrushPresetGroup({
  brush,
  onPatch,
}: {
  brush: BrushSettings;
  onPatch: (patch: Partial<BrushSettings>) => void;
}) {
  const cur = matchPreset(brush);
  return (
    <div className="brp" role="radiogroup" aria-label={zh.options.preset}>
      {BRUSH_PRESETS.map((r) => (
        <button
          key={r.id}
          type="button"
          role="radio"
          aria-checked={cur === r.id}
          className={cur === r.id ? "brp-stamp is-on" : "brp-stamp"}
          title={`${r.label} · ${r.hint}`}
          onClick={() => onPatch({ ...BRUSH_DYNAMIC_DEFAULTS, ...r.patch, color: brush.color })}
        >
          <BrushTipPreview
            brush={{ ...DEFAULT_BRUSH, ...r.patch, color: brush.color }}
            isEraser={false}
            size={26}
          />
        </button>
      ))}
      <span className={cur === "custom" ? "brp-item is-on is-static" : "brp-item is-static"}>
        {zh.options.presetCustom}
      </span>
    </div>
  );
}

/* ---------------- 画笔库（自定义画笔） ---------------- */

/**
 * 画笔库：把当前五个参数存成一支自己的画笔，点一下就切回去，右键/长按删除。
 * 参数会写进偏好设置里，重启依然在。
 */
export function BrushLibrary({
  brush,
  onPatch,
}: {
  brush: BrushSettings;
  onPatch: (patch: Partial<BrushSettings>) => void;
}) {
  const { customBrushes } = usePrefs();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const save = () => {
    addCustomBrush(name || zh.options.presetCustom, toBrushPrefs(brush));
    setNaming(false);
    setName("");
  };

  return (
    <div className="brl">
      <div className="brl-grid">
        {customBrushes.map((b) => {
          const on = (Object.keys(DEFAULT_PREFS.brushDefaults) as (keyof BrushPrefs)[]).every(
            (k) => b[k] === brush[k],
          );
          return (
            <div key={b.id} className="brl-cell">
              <button
                type="button"
                className={on ? "brl-item is-on is-custom" : "brl-item is-custom"}
                title={`${b.name} · ${b.size}px · 硬度 ${b.hardness} · 不透明 ${b.opacity}% · 流量 ${b.flow}% · 间距 ${b.spacing}% · 抖动 ${b.jitter}% · 圆度 ${b.roundness}% · 角度 ${b.angle}°`}
                onClick={() => onPatch({ ...toBrushPrefs(b), color: brush.color })}
              >
                {b.name}
              </button>
              <button
                type="button"
                className="brl-del"
                title={zh.options.brushLibDelete}
                aria-label={`${zh.options.brushLibDelete}：${b.name}`}
                onClick={() => removeCustomBrush(b.id)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {naming ? (
        <span className="brl-saverow">
          <input
            className="brl-name"
            value={name}
            autoFocus
            maxLength={24}
            spellCheck={false}
            placeholder={zh.options.brushLibName}
            aria-label={zh.options.brushLibName}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") {
                setNaming(false);
                setName("");
              }
            }}
          />
          <button type="button" className="brl-save is-on" onClick={save}>
            {zh.options.brushLibSave}
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="brl-save"
          title={zh.options.brushLibSaveHint}
          onClick={() => setNaming(true)}
        >
          ＋ {zh.options.brushLibSave}
        </button>
      )}
    </div>
  );
}

/** 参数一键回默认（保留当前颜色）。 */
export function resetBrush(brush: BrushSettings): Partial<BrushSettings> {
  return { ...DEFAULT_BRUSH, color: brush.color };
}

/**
 * 笔尖预览：一张 30×30 的小样，随着大小 / 硬度 / 不透明度 / 颜色实时变化。
 * 直径按对数映射 —— 1px 的铅笔与 500px 的大刷子在同一张预览里都看得见。
 */
export function BrushTipPreview({
  brush,
  isEraser,
  size = 30,
}: {
  brush: BrushSettings;
  isEraser: boolean;
  size?: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const box = size;
    canvas.width = Math.round(box * dpr);
    canvas.height = Math.round(box * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box, box);

    // 与落笔同源：形状、颗粒、颜色抖动、纹理都由内核渲染，预览不会「看着像、画着不像」
    drawBrushTipSample(ctx, box, brush, isEraser, dpr);
  }, [
    brush.size,
    brush.hardness,
    brush.opacity,
    brush.color,
    brush.jitter,
    brush.roundness,
    brush.angle,
    brush.tip,
    brush.texture,
    brush.textureScale,
    brush.textureDepth,
    brush.textureInvert,
    brush.textureBrightness,
    brush.textureContrast,
    brush.hueJitter,
    isEraser,
    size,
  ]);

  return (
    <canvas
      ref={ref}
      className="opt-tip"
      width={size}
      height={size}
      style={size === 30 ? undefined : { width: size, height: size }}
    />
  );
}
