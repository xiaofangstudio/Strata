/**
 * 模糊画廊工作窗（P1-3，本轮升级）：画布钉点 + 每钉独立模糊量 + 分布可视化。
 *
 * 手感修复（用户指出的「黏糊糊」）：以前预览在 useMemo 里同步算全图模糊，
 * 拖滑块每帧都算，大图直接把主线程堵到松手才渲染。现在控件状态即时更新
 * （RangeInput 本地值跟手），重计算走 120ms 防抖 + 640px 降采样，拖动时
 * 永远是「数值先动、画面跟上」，不阻塞输入。
 *
 * 内容修复（「窗口就一个滑块」）：对齐 PhotoCraft 的画廊窗——
 *  · 每颗钉有自己独立的模糊量（Pin.blur per pin），钉点列表里逐钉滑块；
 *  · 「模糊分布」热力图：逐像素强度图的可视化，一眼看出哪里糊哪里清；
 *  · 其余参数（Tilt 的清晰带/羽化、Spin 的角度等）按滤镜分区展示。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  cleanPin,
  isBlurGallery,
  paramsToPin,
  pinAmountField,
  usesAmountField,
  usesRing,
  type BlurPin,
} from "../../core/blurPins";
import { applyGalleryPins, galleryPinsUsable } from "../../core/galleryApply";
import { filterDef, filterParams, type FilterDef } from "../../engine/filters/defs";
import type { StrataDoc } from "../../core/document";
import { zh } from "../../i18n";
import DraggableModal from "./DraggableModal";
import RangeInput from "./RangeInput";
import "./BlurGalleryDialog.css";

interface Props {
  doc: StrataDoc;
  filterId: string;
  onPreview: (next: StrataDoc) => void;
  onApply: (next: StrataDoc) => void;
  onClose: () => void;
  /** 把画布钉点几何挂到 stage；回调由 onCb 单独提供，避免几何更新触发重挂 */
  onPinsChange: (state: {
    pins: BlurPin[];
    selected: number;
    showRing: boolean;
    scale: number;
  } | null) => void;
  onCb: (cb: ((pins: BlurPin[], selected: number, commit: boolean) => void) | null) => void;
  scale: number;
}

/** 各滤镜需要保留在面板里的「钉点管不到」的参数（主模糊量已由每钉滑块接管）。 */
function extraParamIds(id: string): string[] {
  switch (id) {
    case "filter.blurGallery.tiltShift":
      return ["keep", "feather"];
    case "filter.blurGallery.irisBlur":
      return ["feather"];
    case "filter.blurGallery.spinBlur":
      return ["angle"];
    case "filter.blurGallery.pathBlur":
      return ["angle", "curvature", "taper"];
    default:
      return [];
  }
}

/** 每钉模糊量的取值范围（与主参数定义一致）。 */
const BLUR_RANGE = { min: 0, max: 200, step: 1 };

export default function BlurGalleryDialog({
  doc,
  filterId,
  onPreview,
  onApply,
  onClose,
  onPinsChange,
  onCb,
  scale,
}: Props) {
  const base = useRef(doc).current;
  const def: FilterDef = filterDef(filterId) ?? filterDef("filter.blurGallery.irisBlur")!;
  const [pins, setPins] = useState<BlurPin[]>(() => [paramsToPin(def.id, filterParams(def))]);
  const [selected, setSelected] = useState(0);
  const [extra, setExtra] = useState<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    const all = filterParams(def);
    for (const k of extraParamIds(def.id)) out[k] = all[k] ?? 0;
    return out;
  });
  const closedRef = useRef(false);
  const previewTimer = useRef<number | null>(null);
  const lastCompute = useRef(0);
  const pending = useRef<(() => void) | null>(null);

  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  const closedPreviewRef = useRef(false);

  /** 尾随节流预览：控件即时跟手；计算每 120ms 强制跑一帧最新值（640px 工作面），
   *  拖动中画面持续刷新，停手后最后一帧也保证算 —— 不像防抖那样「等停下来才算」。 */
  const schedulePreview = useCallback((nextPins: BlurPin[], nextExtra: Record<string, number>) => {
    pending.current = () => {
      if (closedPreviewRef.current) return;
      const out = applyGalleryPins(base, def.id, nextPins, 640, nextExtra);
      previewRef.current(out);
    };
    const elapsed = Date.now() - lastCompute.current;
    if (elapsed >= 120) {
      // 距上次计算已够久：立即算一帧
      lastCompute.current = Date.now();
      pending.current();
      return;
    }
    if (previewTimer.current !== null) return; // 已有排定的帧，它算的是最新 pending
    previewTimer.current = window.setTimeout(() => {
      previewTimer.current = null;
      lastCompute.current = Date.now();
      pending.current?.();
    }, 120 - elapsed);
  }, [base, def.id]);

  useEffect(() => {
    schedulePreview(pins, extra);
  }, [pins, extra, schedulePreview]);

  /** 卸载时清掉排定的帧。 */
  useEffect(() => () => {
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
  }, []);

  /** 钉点变化：更新 pins；tilt/spin/path 的标量参数由 schedulePreview 里映射。 */
  const handlePinsChange = useCallback((next: BlurPin[], sel: number, _commit: boolean) => {
    setPins(next.slice(0, 6)); // MAX_PINS 对齐 PhotoCraft
    setSelected(sel);
  }, []);

  /** 回调只注册一次（稳定），几何随 pins/selected/scale 推 —— 避免覆盖层重挂打断捕获。 */
  const handlePinsRef = useRef(handlePinsChange);
  handlePinsRef.current = handlePinsChange;
  useEffect(() => {
    if (!isBlurGallery(def.id)) return;
    onCb((pins, sel, commit) => handlePinsRef.current(pins, sel, commit));
    return () => onCb(null);
  }, [def.id, onCb]);

  useEffect(() => {
    if (!isBlurGallery(def.id)) return;
    onPinsChange({ pins, selected, showRing: usesRing(def.id), scale });
  }, [def.id, pins, selected, scale, onPinsChange]);
  useEffect(() => () => onPinsChange(null), [onPinsChange]);

  /** Delete 键删选中钉点（至少一个）。注意别在输入框里触发。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (pins.length <= 1) return;
      e.preventDefault();
      const next = pins.filter((_, j) => j !== selected);
      setPins(next);
      setSelected(Math.max(0, Math.min(selected, next.length - 1)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pins, selected]);

  const cancel = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    closedPreviewRef.current = true;
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    previewRef.current(base);
    onClose();
  }, [base, onClose]);

  const apply = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    closedPreviewRef.current = true;
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    const full = applyGalleryPins(base, def.id, pins, undefined, extra);
    onApply(full === base ? base : full);
  }, [base, def.id, pins, extra, onApply]);

  /** 改某颗钉的模糊量（钉点列表 / 画布共用）。 */
  const setPinBlur = useCallback((idx: number, v: number) => {
    setPins((old) => {
      const next = [...old];
      const cur = next[idx];
      if (!cur) return old;
      next[idx] = cleanPin({ ...cur, blur: v });
      return next;
    });
  }, []);

  const setExtraParam = useCallback((k: string, v: number) => {
    setExtra((old) => ({ ...old, [k]: v }));
  }, []);

  /** 模糊分布热力图：pinAmountField 的可视化（灰度 = 模糊强度）。 */
  const heatRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = heatRef.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const W = 96;
    const H = Math.max(1, Math.round((96 * base.height) / Math.max(1, base.width)));
    el.width = W;
    el.height = H;
    const img = ctx.createImageData(W, H);
    if (usesAmountField(def.id)) {
      const field = pinAmountField(def.id, pins, W, H);
      if (field) {
        for (let i = 0; i < W * H; i += 1) {
          const v = Math.round(field.map[i] * 255);
          img.data[i * 4] = v;
          img.data[i * 4 + 1] = v;
          img.data[i * 4 + 2] = v;
          img.data[i * 4 + 3] = 255;
        }
      }
    } else {
      // 单钉滤镜：画钉位 + 简单径向示意（仅示意分布，不代表精确场）
      for (let i = 0; i < W * H; i += 1) {
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 24;
        img.data[i * 4 + 3] = 255;
      }
      for (const p of pins) {
        const cx = Math.round(p.x * (W - 1));
        const cy = Math.round(p.y * (H - 1));
        for (let y = cy - 5; y <= cy + 5; y += 1) {
          for (let x = cx - 5; x <= cx + 5; x += 1) {
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            const d = Math.hypot(x - cx, y - cy);
            if (d > 5) continue;
            const v = Math.round(255 * (1 - d / 5));
            const i = y * W + x;
            img.data[i * 4] = v;
            img.data[i * 4 + 1] = v;
            img.data[i * 4 + 2] = v;
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [base, def.id, pins]);

  const usable = galleryPinsUsable(pins);
  const extras = extraParamIds(def.id);
  const isFieldLike = usesAmountField(def.id);

  return (
    <DraggableModal
      id="blurGallery"
      title={def.label}
      badge={zh.dialog.bgBadge}
      onClose={cancel}
      width={430}
      height={620}
      minWidth={380}
      minHeight={480}
      footer={
        <>
          <span className="bg-note">{zh.dialog.bgFootNote}</span>
          <span className="bg-spacer" />
          <button className="btn-ghost" onClick={cancel}>{zh.dialog.cancel}</button>
          <button className="btn-primary" onClick={apply} disabled={!usable}>
            {zh.dialog.confirm}
          </button>
        </>
      }
    >
      <div className="bg">
        <p className="bg-hint">
          {isFieldLike
            ? zh.dialog.bgHintField
            : zh.dialog.bgHintSimple}
        </p>

        {/* 钉点列表：每钉独立模糊量（PhotoCraft 的 Pin.blur per pin） */}
        <div className="bg-section">
          <span className="bg-section-title">{zh.dialog.bgPinTitle.replace("{n}", String(pins.length))}</span>
          <div className="bg-pins">
            {pins.map((p, i) => (
              <div
                key={i}
                className={`bg-pin${i === selected ? " is-sel" : ""}`}
                onClick={() => setSelected(i)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") setSelected(i); }}
              >
                <div className="bg-pin-row">
                  <span className="bg-pin-id">{i + 1}</span>
                  <span className="bg-pin-coord">{Math.round(p.x * 100)}%, {Math.round(p.y * 100)}%</span>
                  {pins.length > 1 && (
                    <button
                      type="button"
                      className="bg-pin-del"
                      title={zh.dialog.bgDelPin}
                      onClick={(e) => {
                        e.stopPropagation();
                        const next = pins.filter((_, j) => j !== i);
                        setPins(next);
                        setSelected(Math.max(0, Math.min(i, next.length - 1)));
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
                <div className="bg-pin-blur">
                  <span className="bg-pin-blur-label">{def.id === "filter.blurGallery.spinBlur" ? zh.dialog.bgAngle : zh.dialog.bgBlur}</span>
                  <RangeInput
                    value={p.blur}
                    min={BLUR_RANGE.min}
                    max={BLUR_RANGE.max}
                    step={BLUR_RANGE.step}
                    onChange={(v) => setPinBlur(i, v)}
                  />
                  <span className="bg-pin-blur-val">
                    {def.id === "filter.blurGallery.spinBlur" ? `${Math.round(p.blur * 18)}°` : `${Math.round(p.blur)} px`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 模糊分布热力图（field/iris 是精确场；单钉滤镜画钉位示意） */}
        <div className="bg-section">
          <span className="bg-section-title">{zh.dialog.bgDistTitle}</span>
          <div className="bg-heat-wrap">
            <canvas ref={heatRef} className="bg-heat" />
          </div>
          <p className="bg-heat-legend">
            {isFieldLike ? zh.dialog.bgDistField : zh.dialog.bgDistPins}
          </p>
        </div>

        {/* 滤镜其余参数（钉点管不到的部分） */}
        {extras.length > 0 && (
          <div className="bg-section">
            <span className="bg-section-title">{zh.dialog.bgParamsTitle}</span>
            {extras.map((k) => {
              const info = def.params.find((p) => p.id === k);
              if (!info) return null;
              const v = extra[k] ?? info.def;
              return (
                <div className="bg-param" key={k}>
                  <div className="bg-param-head">
                    <span className="bg-param-label">{info.label}</span>
                    <span className="bg-param-value">{Math.round(v)}{info.unit ?? ""}</span>
                  </div>
                  <RangeInput
                    value={v}
                    min={info.min}
                    max={info.max}
                    step={info.step}
                    onChange={(nv) => setExtraParam(k, nv)}
                  />
                </div>
              );
            })}
          </div>
        )}

        {!usable && (
          <p className="bg-tip">{zh.dialog.bgZeroTip}</p>
        )}
      </div>
    </DraggableModal>
  );
}
