/**
 * 图像 > 计算（PhotoCraft `image.calculations` 的 Strata 版）。
 *
 * 与旧的「两个 Alpha 通道相加」不同：两个来源都可以选任意像素层的 R/G/B/灰度/透明度，
 * 或已存 Alpha 通道；窗口左侧显示的就是运算出来的**整幅灰度结果**（参考软件同款），
 * 右侧参数用尾随节流实时刷新，确定后存成新 Alpha 通道或替换选区。
 *
 * 预览、遮罩、落库三处共用 `computeCalculation` 的同一份像素，不出现「看的一个样、
 * 落库另一个样」；Cancel 不碰文档。
 */
import { useEffect, useRef, useState } from "react";
import type { StrataDoc } from "../../core/document";
import { alphaChannelsOf } from "../../core/channelOps";
import {
  CALC_BLENDS,
  DEFAULT_CALC_PARAMS,
  type CalcBlend,
  type CalcChannel,
  type CalcParams,
} from "../../core/calculations";
import { computeCalculationAsync, applyCalculation, type CalculationResult } from "../../engine/calculations";
import { zh } from "../../i18n";
import { useBaseComposite } from "../hooks/useComposedPreview";
import { useDialogUndo } from "../hooks/useDialogUndo";
import DialogUndoButtons from "./DialogUndoButtons";
import DraggableModal from "./DraggableModal";
import FilterPreview from "./FilterPreview";
import MiniHistogram from "./MiniHistogram";
import NumericField from "./NumericField";
import { Check, Slider } from "./controls";
import "./CalculationsDialog.css";

const BLEND_LABELS: Record<CalcBlend, string> = {
  normal: zh.dialog.calcBlendNormal,
  add: zh.dialog.calcBlendAdd,
  subtract: zh.dialog.calcBlendSubtract,
  multiply: zh.dialog.calcBlendMultiply,
  screen: zh.dialog.calcBlendScreen,
  difference: zh.dialog.calcBlendDifference,
};

interface Props {
  doc: StrataDoc;
  onApply: (next: StrataDoc, label: string) => void;
  onClose: () => void;
}

interface DialogState {
  params: CalcParams;
  result: "channel" | "selection";
  name: string;
}

/** 参数 → 结果画布，尾随节流；ICC 异步转换也按 token 丢弃旧结果。 */
function useCalculation(base: StrataDoc, params: CalcParams, gapMs = 120) {
  const [value, setValue] = useState<CalculationResult | null>(null);
  const [version, setVersion] = useState(0);
  const last = useRef(0);
  const timer = useRef<number | null>(null);
  const pending = useRef(params);
  const token = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    pending.current = params;
    const run = () => {
      const current = ++token.current;
      void computeCalculationAsync(base, pending.current).then((result) => {
        if (!alive.current || current !== token.current) return;
        setValue(result);
        setVersion((v) => v + 1);
      });
    };
    const elapsed = Date.now() - last.current;
    if (elapsed >= gapMs) {
      last.current = Date.now();
      run();
      return;
    }
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      last.current = Date.now();
      run();
    }, gapMs - elapsed);
  }, [base, params, gapMs]);
  return { value, version };
}

export default function CalculationsDialog({ doc, onApply, onClose }: Props) {
  const initial = useRef<DialogState>({
    params: { ...DEFAULT_CALC_PARAMS },
    result: "channel",
    name: `Alpha ${alphaChannelsOf(doc).length + 1}`,
  }).current;
  const {
    state,
    setState,
    beginGesture,
    endGesture,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useDialogUndo<DialogState>(initial);
  const { value, version } = useCalculation(doc, state.params);
  const baseCanvas = useBaseComposite(doc);
  const [previewOn, setPreviewOn] = useState(true);

  const layers = [
    { id: "merged", name: zh.dialog.calcMerged },
    ...doc.layers
      .filter((l) => l.kind === "pixel")
      .map((l) => ({ id: l.id, name: l.name })),
  ];
  const channels: { id: CalcChannel; name: string }[] = [
    { id: "gray", name: zh.dialog.calcGray },
    { id: "red", name: zh.dialog.calcRed },
    { id: "green", name: zh.dialog.calcGreen },
    { id: "blue", name: zh.dialog.calcBlue },
    { id: "alpha", name: zh.dialog.calcAlpha },
    ...alphaChannelsOf(doc).map((c) => ({ id: `alpha:${c.id}` as CalcChannel, name: c.name })),
  ];
  const patch = (p: Partial<CalcParams>) =>
    setState((s) => ({ ...s, params: { ...s.params, ...p } }));
  const patchSource = (which: 1 | 2, p: Partial<CalcParams["source1"]>) =>
    setState((s) => ({
      ...s,
      params: {
        ...s.params,
        [which === 1 ? "source1" : "source2"]: {
          ...s.params[which === 1 ? "source1" : "source2"],
          ...p,
        },
      },
    }));

  return (
    <DraggableModal
      id="calculations"
      title={zh.dialog.calculationsTitle}
      badge={zh.menu.image}
      onClose={onClose}
      width={980}
      height={620}
      minWidth={760}
      minHeight={480}
      footer={
        <>
          <DialogUndoButtons canUndo={canUndo} canRedo={canRedo} onUndo={undo} onRedo={redo} />
          <span className="calc-spacer" />
          <button className="btn-ghost" onClick={onClose}>
            {zh.dialog.cancel}
          </button>
          <button
            className="btn-primary"
            disabled={!value}
            onClick={() =>
              value && onApply(applyCalculation(doc, value.mask, state.result, state.name), zh.dialog.calculationsTitle)
            }
          >
            {zh.dialog.confirm}
          </button>
        </>
      }
    >
      <div className="calc-workbench">
        <div className="calc-preview-pane">
          <div className="calc-pane-head">{zh.dialog.calcPreview}</div>
          <FilterPreview
            source={previewOn ? value?.image ?? null : baseCanvas}
            compareSource={baseCanvas}
            docW={doc.width}
            docH={doc.height}
            version={version}
            height="100%"
          />
          <div className="calc-hist">
            <MiniHistogram source={value?.image ?? null} version={version} height={52} />
          </div>
        </div>
        <div className="calc-params-pane">
          <div className="calc-pane-head">{zh.dialog.calcSource1}</div>
          <div className="calc-params-scroll">
            {([1, 2] as const).map((which) => {
              const src = which === 1 ? state.params.source1 : state.params.source2;
              return (
                <div className="calc-source" key={which}>
                  <label className="calc-field">
                    <span>{which === 1 ? zh.dialog.calcSource1 : zh.dialog.calcSource2}</span>
                    <select
                      className="calc-select"
                      value={src.layerId}
                      onChange={(e) => patchSource(which, { layerId: e.target.value })}
                    >
                      {layers.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="calc-field">
                    <span>{zh.dialog.calcChannel}</span>
                    <select
                      className="calc-select"
                      value={src.channel}
                      onChange={(e) => patchSource(which, { channel: e.target.value as CalcChannel })}
                    >
                      {channels.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Check
                    label={which === 1 ? zh.dialog.calcInvert1 : zh.dialog.calcInvert2}
                    on={which === 1 ? state.params.invert1 : state.params.invert2}
                    onChange={(v) => patch(which === 1 ? { invert1: v } : { invert2: v })}
                  />
                </div>
              );
            })}
            <label className="calc-field">
              <span>{zh.dialog.calcBlend}</span>
              <select
                className="calc-select"
                value={state.params.blend}
                onChange={(e) => patch({ blend: e.target.value as CalcBlend })}
              >
                {CALC_BLENDS.map((b) => (
                  <option key={b} value={b}>
                    {BLEND_LABELS[b]}
                  </option>
                ))}
              </select>
            </label>
            <Slider
              label={zh.dialog.calcOpacity}
              min={0}
              max={100}
              value={state.params.opacity}
              onChange={(v) => patch({ opacity: v })}
              suffix="%"
            />
            <NumericField
              label={zh.dialog.calcScale}
              value={state.params.scale}
              min={1}
              max={2}
              step={0.01}
              dec={2}
              onChange={(v) => patch({ scale: v })}
              onGestureStart={beginGesture}
              onGestureEnd={endGesture}
            />
            <NumericField
              label={zh.dialog.calcOffset}
              value={state.params.offset}
              min={-255}
              max={255}
              step={1}
              dec={0}
              onChange={(v) => patch({ offset: Math.round(v) })}
              onGestureStart={beginGesture}
              onGestureEnd={endGesture}
            />
            <Check
              label={zh.dialog.calcInvertResult}
              on={state.params.invertResult}
              onChange={(v) => patch({ invertResult: v })}
            />
            <Check label={zh.dialog.calcPreview} on={previewOn} onChange={setPreviewOn} />
            <label className="calc-field">
              <span>{zh.dialog.calcResult}</span>
              <select
                className="calc-select"
                value={state.result}
                onChange={(e) => setState((s) => ({ ...s, result: e.target.value as DialogState["result"] }))}
              >
                <option value="channel">{zh.dialog.calcResultChannel}</option>
                <option value="selection">{zh.dialog.calcResultSelection}</option>
              </select>
            </label>
            {state.result === "channel" && (
              <label className="calc-field">
                <span>{zh.dialog.calcName}</span>
                <input
                  className="calc-input"
                  value={state.name}
                  spellCheck={false}
                  maxLength={40}
                  onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
                />
              </label>
            )}
            <p className="calc-note">{zh.dialog.calcHint}</p>
            {value?.iccGray && <p className="calc-note">{zh.dialog.calcIccGray}</p>}
            {!value && <p className="calc-error">{zh.dialog.calcInvalid}</p>}
          </div>
        </div>
      </div>
    </DraggableModal>
  );
}
