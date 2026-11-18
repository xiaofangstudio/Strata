/**
 * 模糊画廊工作窗（P1-3）：DraggableModal 参数面板 + 画布钉点覆盖层。
 *
 * 5 个 blurGallery 滤镜的底层算法都是真的（iterativeVariableBlur / fieldBlur /
 * irisBlur / tiltShift / pathBlur / spinBlur），缺口只在交互——以前只能填 cx/cy/center
 * 这类百分比滑块，看不到钉在哪。这里让用户在画布上直接拖中心圆点与半径环，
 * 参数由 core/blurPins 纯函数双向映射，钉点与滑块保持同一真值。
 *
 * 预览/落库范式与 FilterFxDialog 完全一致：预览走降采样近似（复用 previewFilter），
 * 确定走全分辨率 applyFilterToLayer —— 绝不把近似结果落库。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyFilterToLayer } from "../../core/filterOps";
import {
  cleanPin,
  isBlurGallery,
  paramsToPin,
  pinToParams,
  usesRing,
  type BlurPin,
} from "../../core/blurPins";
import {
  filterDef,
  filterParams,
  type FilterDef,
} from "../../engine/filters/defs";
import type { StrataDoc } from "../../core/document";
import { zh } from "../../i18n";
import DraggableModal from "./DraggableModal";
import { previewFilter } from "./FilterFxDialog";
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

/** 当前滤镜需要暴露在参数面板里的「主模糊量」滑杆（其余参数靠钉点调）。 */
function blurParamKey(id: string): string {
  if (id === "filter.blurGallery.irisBlur") return "radius";
  if (id === "filter.blurGallery.tiltShift") return "radius";
  if (id === "filter.blurGallery.spinBlur") return "angle";
  if (id === "filter.blurGallery.fieldBlur") return "amount";
  if (id === "filter.blurGallery.pathBlur") return "distance";
  return "amount";
}

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
  const [params, setParams] = useState<Record<string, number>>(() => filterParams(def));
  const [pins, setPins] = useState<BlurPin[]>(() => [paramsToPin(def.id, filterParams(def))]);
  const [selected, setSelected] = useState(0);
  const closedRef = useRef(false);

  const preview = useMemo(() => previewFilter(base, def, params), [base, def, params]);
  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  useEffect(() => { previewRef.current(preview); }, [preview]);

  /** 钉点变化：更新 pins + 把选中钉映射回 params → 触发预览。 */
  const handlePinsChange = useCallback((next: BlurPin[], sel: number, commit: boolean) => {
    setPins(next.slice(0, 6)); // MAX_PINS 对齐 PhotoCraft
    setSelected(sel);
    const mapped = pinToParams(def.id, next[sel] ?? next[0]);
    setParams((old) => {
      const merged = { ...old, ...mapped };
      return commit || JSON.stringify(old) !== JSON.stringify(merged) ? merged : old;
    });
  }, [def.id]);

  /** 回调只注册一次（稳定），几何随 pins/selected/scale 推 —— 避免拖动时覆盖层重挂打断捕获。 */
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
    previewRef.current(base);
    onClose();
  }, [base, onClose]);

  const apply = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    const full = applyFilterToLayer(base, def, params);
    onApply(full === base ? base : full);
  }, [base, def, params, onApply]);

  const key = blurParamKey(def.id);
  const pInfo = def.params.find((p) => p.id === key);
  const syncSlider = (v: number) => {
    setParams((old) => ({ ...old, [key]: v }));
    // 滑块改模糊量也要反向同步到钉点
    setPins((old) => {
      const next = [...old];
      const cur = next[selected] ?? next[0];
      if (!cur) return old;
      next[selected] = def.id === "filter.blurGallery.spinBlur"
        ? cleanPin({ ...cur, blur: v / 18 })
        : cleanPin({ ...cur, blur: v });
      return next;
    });
  };

  return (
    <DraggableModal
      id="blurGallery"
      title={`${def.label} · 画布钉点`}
      badge="模糊画廊"
      onClose={cancel}
      width={420}
      height={540}
      minWidth={360}
      minHeight={420}
      footer={
        <>
          <span className="bg-note">画布上拖圆点移动 · 拖方框调半径 · 点空白加钉</span>
          <span className="bg-spacer" />
          <button className="btn-ghost" onClick={cancel}>{zh.dialog.cancel}</button>
          <button className="btn-primary" onClick={apply}>{zh.dialog.confirm}</button>
        </>
      }
    >
      <div className="bg">
        <p className="bg-hint">
          现在直接在画布上拖钉点调整：选中钉点后，拖中心圆点移动位置{usesRing(def.id) ? "，拖右侧方框调清晰区半径" : ""}。
          参数与画布双向同步。
        </p>

        {pInfo && (
          <div className="bg-param">
            <div className="bg-param-head">
              <span className="bg-param-label">{pInfo.label}</span>
              <span className="bg-param-value">
                {Math.round(params[key] ?? pInfo.def)}{pInfo.unit ?? ""}
              </span>
            </div>
            <RangeInput
              value={params[key] ?? pInfo.def}
              min={pInfo.min}
              max={pInfo.max}
              step={pInfo.step}
              onChange={syncSlider}
            />
          </div>
        )}

        <div className="bg-pins-head">钉点（{pins.length}）</div>
        <div className="bg-pins">
          {pins.map((p, i) => (
            <button
              key={i}
              className={`bg-pin${i === selected ? " is-sel" : ""}`}
              onClick={() => setSelected(i)}
            >
              <span className="bg-pin-id">{i + 1}</span>
              <span className="bg-pin-coord">{Math.round(p.x * 100)}%, {Math.round(p.y * 100)}%</span>
              {pins.length > 1 && (
                <span
                  className="bg-pin-del"
                  title="删除钉点"
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = pins.filter((_, j) => j !== i);
                    setPins(next);
                    setSelected(Math.max(0, Math.min(i, next.length - 1)));
                  }}
                >
                  ×
                </span>
              )}
            </button>
          ))}
        </div>
        <p className="bg-tip">提示：选中钉点后按 Delete 键可删除（保留至少一个）。</p>
      </div>
    </DraggableModal>
  );
}
