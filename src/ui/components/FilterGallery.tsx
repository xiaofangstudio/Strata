import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ADJUST_DEFS,
  adjustDef,
  newAdjustState,
  type AdjustId,
  type AdjustState,
} from "../../core/layer";
import { applyAdjustToLayer } from "../../core/layerOps";
import type { StrataDoc } from "../../core/document";
import { zh } from "../../i18n/zh-CN";
import Modal from "./Modal";
import "./FilterGallery.css";
import RangeInput from "./RangeInput";

interface Props {
  doc: StrataDoc;
  /** 拖动参数时的即时预览（不进历史） */
  onPreview: (next: StrataDoc) => void;
  /** 确定：把结果写进当前图层，进历史 */
  onApply: (next: StrataDoc) => void;
  onClose: () => void;
}

/** 滤镜库只收「效果」族的调整 —— 它们最像 PS 的滤镜，参数也都能一眼看出效果。 */
const FILTERS = ADJUST_DEFS.filter((d) => d.family === "effect");

export default function FilterGallery({ doc, onPreview, onApply, onClose }: Props) {
  /**
   * 打开面板那一刻的文档。预览每次都从它重算，而不是在上一次预览上叠加 ——
   * 否则来回拖滑块会把效果越叠越重，最后没法还原。
   */
  const base = useRef(doc).current;

  const [id, setId] = useState<AdjustId>(FILTERS[0]?.id ?? "blur");
  const [params, setParams] = useState<Record<string, number>>(
    () => newAdjustState(FILTERS[0]?.id ?? "blur").params,
  );

  const state: AdjustState = useMemo(() => ({ id, params }), [id, params]);
  const def = adjustDef(id);

  /**
   * 预览结果。若当前图层不是像素层（调整层 / 被锁），applyAdjustToLayer 会原样
   * 返回同一引用，据此判定「这一下没得改」，确定按钮随之禁用。
   */
  const preview = useMemo(() => applyAdjustToLayer(base, state), [base, state]);
  const usable = preview !== base;

  // onPreview / onClose 都是内联回调，用 ref 兜住，免得它们一变就重放预览。
  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  const closedRef = useRef(false);

  useEffect(() => {
    previewRef.current(preview);
  }, [preview]);

  const cancel = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    // 取消 = 把预览撤回到打开时的样子。这里不走 onClose，只还原画面。
    previewRef.current(base);
    onClose();
  }, [base, onClose]);

  const apply = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onApply(preview);
  }, [onApply, preview]);

  const pick = (next: AdjustId) => {
    setId(next);
    setParams(newAdjustState(next).params);
  };

  return (
    <Modal
      title={zh.dialog.filterTitle}
      onClose={cancel}
      width={600}
      footer={
        <>
          <span className="fg-note">{usable ? def.label : zh.dialog.filterNoPixel}</span>
          <span className="fg-foot-spacer" />
          <button className="btn-ghost" onClick={cancel}>
            {zh.dialog.cancel}
          </button>
          <button className="btn-primary" onClick={apply} disabled={!usable}>
            {zh.dialog.confirm}
          </button>
        </>
      }
    >
      <div className="fg">
        <div className="fg-list" role="listbox" aria-label={zh.dialog.filterTitle}>
          {FILTERS.map((d) => {
            const on = d.id === id;
            return (
              <button
                key={d.id}
                type="button"
                role="option"
                aria-selected={on}
                className={on ? "fg-item is-on" : "fg-item"}
                onClick={() => pick(d.id)}
              >
                <span className="fg-item-name">{d.label}</span>
                <span className="fg-item-sub">
                  {d.params.length} {zh.dialog.filterParamsUnit}
                </span>
              </button>
            );
          })}
        </div>

        <div className="fg-body">
          <p className="fg-hint">{zh.dialog.filterHint}</p>
          {def.params.map((p) => {
            const v = params[p.id] ?? p.def;
            return (
              <label className="fg-field" key={p.id}>
                <span className="fg-field-head">
                  <span className="fg-field-label">{p.label}</span>
                  <span className="fg-field-value">
                    {p.dec ? v.toFixed(p.dec) : Math.round(v)}
                    {p.unit ?? ""}
                  </span>
                </span>
                <RangeInput
                  className="fg-range"
                  min={p.min}
                  max={p.max}
                  step={p.step}
                  value={v}
                  aria-label={p.label}
                  onChange={(nv) => setParams((prev) => ({ ...prev, [p.id]: nv }))}
                />
              </label>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
