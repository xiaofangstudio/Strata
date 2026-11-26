/**
 * 图像 > 图像旋转 > 任意角度：专业旋转画布窗口。
 *
 * 参考 PhotoCraft 的 Rotate Canvas 命令，但把它刻意省掉的插值与预览补上（参数窗
 * 的验收口径）：角度擦洗、方向、插值三档都在窗口里；左边是真实合成预览 + 直方图，
 * 按住可对比原图；右边参数改动都走对话框自己的撤销栈，取消不动文档一个字节。
 *
 * 预览文档按尾随节流生成 —— 连续擦洗角度时持续刷新，停手最后一帧保证画出来，
 * 绝不用防抖（防抖只在松手后算一帧，正是用户抱怨过的「黏黏糊糊」）。
 */
import { useEffect, useRef, useState } from "react";
import type { StrataDoc } from "../../core/document";
import {
  ROTATE_INTERPOLATIONS,
  rotateDocumentArbitrary,
  rotateOutputSize,
  settleRotationAngle,
  signedRotationDegrees,
  type RotateInterpolation,
} from "../../core/transform";
import { zh } from "../../i18n";
import { useBaseComposite, useComposedPreview } from "../hooks/useComposedPreview";
import { useDialogUndo } from "../hooks/useDialogUndo";
import DialogUndoButtons from "./DialogUndoButtons";
import DraggableModal from "./DraggableModal";
import FilterPreview from "./FilterPreview";
import MiniHistogram from "./MiniHistogram";
import NumericField from "./NumericField";
import { SegGroup } from "./controls";
import "./RotateCanvasDialog.css";

interface Props {
  doc: StrataDoc;
  initialAngle: number;
  onApply: (next: StrataDoc, label: string) => void;
  onClose: () => void;
}

interface RotateParams {
  angle: number;
  direction: "cw" | "ccw";
  interpolation: RotateInterpolation;
}

/** 角度 → 工作文档，尾随节流；pending 永远指向最新参数。 */
function useRotatedDoc(base: StrataDoc, p: RotateParams, gapMs = 90): StrataDoc {
  const [doc, setDoc] = useState<StrataDoc>(() =>
    rotateDocumentArbitrary(base, signedRotationDegrees(p.angle, p.direction), p.interpolation),
  );
  const last = useRef(0);
  const timer = useRef<number | null>(null);
  const pending = useRef(p);

  useEffect(() => {
    pending.current = p;
    const run = () => {
      const q = pending.current;
      setDoc(
        rotateDocumentArbitrary(base, signedRotationDegrees(q.angle, q.direction), q.interpolation),
      );
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
  }, [base, p.angle, p.direction, p.interpolation, gapMs]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  return doc;
}

export default function RotateCanvasDialog({ doc: base, initialAngle, onApply, onClose }: Props) {
  const initial = useRef<RotateParams>({
    angle: settleRotationAngle(initialAngle),
    direction: "cw",
    interpolation: "bicubic",
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
  } = useDialogUndo<RotateParams>(initial);

  const work = useRotatedDoc(base, state);
  const { canvas, version } = useComposedPreview(work, 120);
  const baseCanvas = useBaseComposite(base);
  const size = rotateOutputSize(
    base.width,
    base.height,
    signedRotationDegrees(state.angle, state.direction),
  );
  const interpolationLabels: Record<RotateInterpolation, string> = {
    bicubic: zh.dialog.rotateBicubic,
    bilinear: zh.dialog.rotateBilinear,
    nearest: zh.dialog.rotateNearest,
  };

  return (
    <DraggableModal
      id="rotateCanvas"
      title={zh.dialog.rotateCanvas}
      badge={zh.menu.image}
      onClose={onClose}
      width={980}
      height={620}
      minWidth={760}
      minHeight={480}
      footer={
        <>
          <DialogUndoButtons
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
          />
          <span className="rcv-spacer" />
          <button className="btn-ghost" onClick={onClose}>
            {zh.dialog.cancel}
          </button>
          <button
            className="btn-primary"
            onClick={() => onApply(work, zh.dialog.rotateCanvas)}
          >
            {zh.dialog.confirm}
          </button>
        </>
      }
    >
      <div className="rcv-workbench">
        <div className="rcv-preview-pane">
          <div className="rcv-pane-head">{zh.dialog.fpPreview}</div>
          <FilterPreview
            source={canvas}
            compareSource={baseCanvas}
            docW={work.width}
            docH={work.height}
            version={version}
            height="100%"
          />
          <div className="rcv-hist">
            <span className="rcv-hist-label">{zh.dialog.fpHistogram}</span>
            <MiniHistogram source={canvas} version={version} height={52} />
          </div>
        </div>
        <div className="rcv-params-pane">
          <div className="rcv-pane-head">{zh.dialog.fpParams}</div>
          <div className="rcv-params-scroll">
            <NumericField
              label={zh.dialog.rotateAngle}
              value={state.angle}
              min={-359.99}
              max={359.99}
              step={0.01}
              dec={2}
              unit="°"
              onChange={(v) => setState((s) => ({ ...s, angle: settleRotationAngle(v) }))}
              onGestureStart={beginGesture}
              onGestureEnd={endGesture}
            />
            <SegGroup
              label={zh.dialog.rotateDirection}
              value={state.direction}
              options={[
                { value: "cw", label: zh.dialog.rotateCw },
                { value: "ccw", label: zh.dialog.rotateCcw },
              ]}
              onChange={(v) => setState((s) => ({ ...s, direction: v }))}
            />
            <SegGroup
              label={zh.dialog.rotateInterpolation}
              value={state.interpolation}
              options={ROTATE_INTERPOLATIONS.map((k) => ({
                value: k,
                label: interpolationLabels[k],
              }))}
              onChange={(v) => setState((s) => ({ ...s, interpolation: v }))}
            />
            <div className="rcv-size">
              {zh.dialog.rotateOutput}：{size.width} × {size.height} px
            </div>
            <p className="rcv-note">{zh.dialog.rotateHint}</p>
          </div>
        </div>
      </div>
    </DraggableModal>
  );
}
