/**
 * 画笔设置面板（F5）。
 *
 * 布局对齐 PhotoCraft 的 Brush Settings：顶部一条真实笔画预览，左侧分组，
 * 右侧两列参数。预览不是示意图 —— 它走的就是画布那条 `Stroke` 内核，
 * 所以改任何一项都会立刻在预览里体现，不存在「面板里好看、落笔不一样」。
 */
import { useEffect, useRef, useState } from "react";
import { zh } from "../../i18n/zh-CN";
import {
  Stroke,
  type BrushSettings,
  type BrushTexture,
  type BrushTip,
} from "../../engine/paint";
import Modal from "./Modal";
import { Check, SegGroup, Slider, resetBrush } from "./controls";
import "./BrushSettingsPanel.css";

const bp = zh.options.brushPanel;

/* ---------------- 字段表 ---------------- */

type NumericKey = {
  [K in keyof BrushSettings]: BrushSettings[K] extends number ? K : never;
}[keyof BrushSettings];

type BoolKey = {
  [K in keyof BrushSettings]: BrushSettings[K] extends boolean ? K : never;
}[keyof BrushSettings];

interface NumField {
  key: NumericKey;
  label: string;
  hint?: string;
  min: number;
  max: number;
  suffix?: string;
}

interface BoolField {
  key: BoolKey;
  label: string;
  hint?: string;
}

const TIP_FIELDS: NumField[] = [
  { key: "size", label: zh.options.size, min: 1, max: 500, suffix: "px" },
  { key: "hardness", label: zh.options.hardness, min: 0, max: 100, suffix: "%" },
  { key: "spacing", label: zh.options.spacing, min: 1, max: 50, suffix: "%" },
  { key: "opacity", label: zh.options.opacity, min: 1, max: 100, suffix: "%" },
  { key: "roundness", label: zh.options.roundness, min: 10, max: 100, suffix: "%" },
  { key: "angle", label: zh.options.brushAngle, min: 0, max: 360, suffix: "°" },
];

const SHAPE_FIELDS: NumField[] = [
  { key: "sizeJitter", label: bp.sizeJitter, hint: bp.sizeJitterHint, min: 0, max: 100, suffix: "%" },
  { key: "sizeMin", label: bp.sizeMin, hint: bp.sizeMinHint, min: 0, max: 100, suffix: "%" },
  { key: "angleJitter", label: bp.angleJitter, hint: bp.angleJitterHint, min: 0, max: 100, suffix: "%" },
  { key: "roundnessJitter", label: bp.roundnessJitter, hint: bp.roundnessJitterHint, min: 0, max: 100, suffix: "%" },
  { key: "roundnessMin", label: bp.roundnessMin, hint: bp.roundnessMinHint, min: 10, max: 100, suffix: "%" },
];

const SHAPE_TOGGLES: BoolField[] = [
  { key: "flipX", label: bp.flipX, hint: bp.flipXHint },
  { key: "flipY", label: bp.flipY, hint: bp.flipYHint },
];

const SCATTER_FIELDS: NumField[] = [
  { key: "jitter", label: bp.scatter, hint: bp.scatterHint, min: 0, max: 100, suffix: "%" },
  { key: "scatterCount", label: bp.scatterCount, hint: bp.scatterCountHint, min: 1, max: 16 },
  { key: "scatterCountJitter", label: bp.scatterCountJitter, hint: bp.scatterCountJitterHint, min: 0, max: 100, suffix: "%" },
];

const SCATTER_TOGGLES: BoolField[] = [
  { key: "scatterBothAxes", label: bp.scatterBothAxes, hint: bp.scatterBothAxesHint },
];

const TEXTURE_FIELDS: NumField[] = [
  { key: "textureScale", label: zh.options.textureScale, hint: zh.options.textureScaleHint, min: 50, max: 400, suffix: "%" },
  { key: "textureDepth", label: zh.options.textureDepth, hint: zh.options.textureDepthHint, min: 0, max: 100, suffix: "%" },
  { key: "textureBrightness", label: bp.textureBrightness, hint: bp.textureBrightnessHint, min: -100, max: 100 },
  { key: "textureContrast", label: bp.textureContrast, hint: bp.textureContrastHint, min: -100, max: 100 },
];

const TEXTURE_TOGGLES: BoolField[] = [
  { key: "textureInvert", label: bp.textureInvert, hint: bp.textureInvertHint },
];

const COLOR_FIELDS: NumField[] = [
  { key: "hueJitter", label: zh.options.hueJitter, hint: zh.options.hueJitterHint, min: 0, max: 100, suffix: "%" },
  { key: "saturationJitter", label: bp.saturationJitter, hint: bp.saturationJitterHint, min: 0, max: 100, suffix: "%" },
  { key: "brightnessJitter", label: bp.brightnessJitter, hint: bp.brightnessJitterHint, min: 0, max: 100, suffix: "%" },
];

const TRANSFER_FIELDS: NumField[] = [
  { key: "flow", label: zh.options.flow, hint: bp.flowHint, min: 1, max: 100, suffix: "%" },
  { key: "opacityJitter", label: bp.opacityJitter, hint: bp.opacityJitterHint, min: 0, max: 100, suffix: "%" },
  { key: "opacityMin", label: bp.opacityMin, hint: bp.opacityMinHint, min: 0, max: 100, suffix: "%" },
  { key: "flowJitter", label: bp.flowJitter, hint: bp.flowJitterHint, min: 0, max: 100, suffix: "%" },
  { key: "flowMin", label: bp.flowMin, hint: bp.flowMinHint, min: 0, max: 100, suffix: "%" },
];

const SMOOTH_FIELDS: NumField[] = [
  { key: "smoothing", label: zh.options.smoothing, hint: zh.options.smoothingHint, min: 0, max: 100, suffix: "%" },
];

const SMOOTH_TOGGLES: BoolField[] = [
  { key: "pulledString", label: zh.options.pulledString, hint: zh.options.pulledStringHint },
  { key: "catchUp", label: zh.options.catchUp, hint: zh.options.catchUpHint },
  { key: "catchUpOnEnd", label: zh.options.catchUpOnEnd, hint: zh.options.catchUpOnEndHint },
];

const TIP_OPTIONS: { value: BrushTip; label: string }[] = [
  { value: "round", label: zh.options.tipRound },
  { value: "pencil", label: zh.options.tipPencil },
  { value: "chalk", label: zh.options.tipChalk },
  { value: "bristle", label: zh.options.tipBristle },
  { value: "spray", label: zh.options.tipSpray },
];

const TEXTURE_OPTIONS: { value: BrushTexture; label: string }[] = [
  { value: "none", label: zh.options.textureNone },
  { value: "paper", label: zh.options.texturePaper },
  { value: "canvas", label: zh.options.textureCanvas },
  { value: "grain", label: zh.options.textureGrain },
  { value: "dots", label: zh.options.textureDots },
];

type TabId = "tip" | "shape" | "scatter" | "texture" | "color" | "transfer" | "smoothing";

const TABS: { id: TabId; label: string }[] = [
  { id: "tip", label: bp.sectionTip },
  { id: "shape", label: bp.sectionShape },
  { id: "scatter", label: bp.sectionScatter },
  { id: "texture", label: bp.sectionTexture },
  { id: "color", label: bp.sectionColor },
  { id: "transfer", label: bp.sectionTransfer },
  { id: "smoothing", label: bp.sectionSmoothing },
];

/* ---------------- 字段渲染 ---------------- */

function NumFields({
  fields,
  brush,
  onBrush,
}: {
  fields: NumField[];
  brush: BrushSettings;
  onBrush: (patch: Partial<BrushSettings>) => void;
}) {
  return (
    <>
      {fields.map((f) => (
        <Slider
          key={f.key}
          label={f.label}
          hint={f.hint}
          min={f.min}
          max={f.max}
          suffix={f.suffix}
          value={brush[f.key]}
          onChange={(v) => onBrush({ [f.key]: v } as Partial<BrushSettings>)}
        />
      ))}
    </>
  );
}

function BoolFields({
  fields,
  brush,
  onBrush,
}: {
  fields: BoolField[];
  brush: BrushSettings;
  onBrush: (patch: Partial<BrushSettings>) => void;
}) {
  return (
    <>
      {fields.map((f) => (
        <Check
          key={f.key}
          label={f.label}
          hint={f.hint}
          on={brush[f.key]}
          onChange={(v) => onBrush({ [f.key]: v } as Partial<BrushSettings>)}
        />
      ))}
    </>
  );
}

/* ---------------- 真实笔画预览 ---------------- */

function StrokePreview({ brush, isEraser }: { brush: BrushSettings; isEraser: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const W = 560;
    const H = 98;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const off = document.createElement("canvas");
    off.width = canvas.width;
    off.height = canvas.height;
    const offCtx = off.getContext("2d");
    if (!offCtx) return;
    if (isEraser) {
      // 橡皮要有一块「颜料」才看得出擦除轨迹
      offCtx.fillStyle = "#3b4048";
      offCtx.fillRect(0, 0, off.width, off.height);
    }

    const sample: BrushSettings = {
      ...brush,
      size: Math.max(2, Math.min(brush.size, 120)) * dpr,
      color: isEraser ? "#8e96a0" : brush.color,
    };

    const stroke = new Stroke(off.width, off.height, sample, isEraser);
    const x0 = 48 * dpr;
    const x1 = (W - 48) * dpr;
    const midY = (H * dpr) / 2;
    const amp = 22 * dpr * Math.sin((Math.min(brush.size, 120) / 120) * Math.PI * 0.5 + 0.4);
    const steps = 96;
    const t0 = 1000;

    stroke.begin(x0, midY, 1, t0);
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const x = x0 + (x1 - x0) * t;
      const y = midY + Math.sin(t * Math.PI * 3) * amp * Math.sin(t * Math.PI);
      stroke.extend(x, y, 1, t0 + i * 8);
    }
    stroke.finish(off);

    ctx.drawImage(off, 0, 0, W, H);
  }, [brush, isEraser]);

  return <canvas ref={ref} className="bsp-preview-canvas" width={560} height={98} />;
}

/* ---------------- 面板 ---------------- */

interface BrushSettingsPanelProps {
  brush: BrushSettings;
  isEraser: boolean;
  onBrush: (patch: Partial<BrushSettings>) => void;
  onClose: () => void;
}

export default function BrushSettingsPanel({
  brush,
  isEraser,
  onBrush,
  onClose,
}: BrushSettingsPanelProps) {
  const [tab, setTab] = useState<TabId>("tip");
  const textureOff = brush.texture === "none" || brush.textureDepth === 0;

  return (
    <Modal
      title={bp.title}
      width={640}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-ghost btn-sm" onClick={() => onBrush(resetBrush(brush))}>
            {zh.options.reset}
          </button>
          <button type="button" className="btn-primary btn-sm" onClick={onClose}>
            {zh.dialog.close}
          </button>
        </>
      }
    >
      <div className="bsp">
        <div className="bsp-preview">
          <div className="bsp-preview-head">
            <span className="bsp-preview-title">{bp.preview}</span>
            <span className="bsp-preview-hint">{bp.previewHint}</span>
          </div>
          <StrokePreview brush={brush} isEraser={isEraser} />
        </div>

        <div className="bsp-main">
          <div className="bsp-tabs" role="tablist" aria-label={bp.title}>
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? "bsp-tab is-on" : "bsp-tab"}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="bsp-pane" role="tabpanel">
            {tab === "tip" && (
              <div className="bsp-fields">
                <div className="bsp-wide">
                  <SegGroup
                    label={zh.options.tip}
                    value={brush.tip}
                    onChange={(tip) => onBrush({ tip })}
                    options={TIP_OPTIONS}
                  />
                </div>
                <NumFields fields={TIP_FIELDS} brush={brush} onBrush={onBrush} />
                <p className="bsp-note">{zh.options.tipHint}</p>
                <p className="bsp-note">{zh.options.spacingHint}</p>
              </div>
            )}

            {tab === "shape" && (
              <div className="bsp-fields">
                <NumFields fields={SHAPE_FIELDS} brush={brush} onBrush={onBrush} />
                <BoolFields fields={SHAPE_TOGGLES} brush={brush} onBrush={onBrush} />
              </div>
            )}

            {tab === "scatter" && (
              <div className="bsp-fields">
                <NumFields fields={SCATTER_FIELDS} brush={brush} onBrush={onBrush} />
                <BoolFields fields={SCATTER_TOGGLES} brush={brush} onBrush={onBrush} />
              </div>
            )}

            {tab === "texture" && (
              <div className="bsp-fields">
                <div className="bsp-wide">
                  <SegGroup
                    label={zh.options.texture}
                    value={brush.texture}
                    onChange={(texture) => onBrush({ texture })}
                    options={TEXTURE_OPTIONS}
                  />
                </div>
                <NumFields fields={TEXTURE_FIELDS} brush={brush} onBrush={onBrush} />
                <BoolFields fields={TEXTURE_TOGGLES} brush={brush} onBrush={onBrush} />
                {textureOff && <p className="bsp-note bsp-note-warn">{bp.textureOffHint}</p>}
              </div>
            )}

            {tab === "color" && (
              <div className="bsp-fields">
                <NumFields fields={COLOR_FIELDS} brush={brush} onBrush={onBrush} />
              </div>
            )}

            {tab === "transfer" && (
              <div className="bsp-fields">
                <NumFields fields={TRANSFER_FIELDS} brush={brush} onBrush={onBrush} />
                <p className="bsp-note">{bp.flowHint}</p>
              </div>
            )}

            {tab === "smoothing" && (
              <div className="bsp-fields">
                <NumFields fields={SMOOTH_FIELDS} brush={brush} onBrush={onBrush} />
                <BoolFields fields={SMOOTH_TOGGLES} brush={brush} onBrush={onBrush} />
                <p className="bsp-note">{zh.options.smoothingHint}</p>
              </div>
            )}
          </div>
        </div>

        <p className="bsp-foot-note">{bp.note}</p>
      </div>
    </Modal>
  );
}
