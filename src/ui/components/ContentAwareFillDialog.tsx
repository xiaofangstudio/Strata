/**
 * 编辑 > 内容识别填充…（PhotoCraft `ContentAwareFillWorkspace` 的 Strata 版）。
 *
 * 以前这个菜单点下去直接用选区周围的纹理补，用户没法指定「从哪儿借」。
 * 这里把 PhotoCraft 的三张平面做成真工作区：红色是选区（要抹掉），绿色是取样区
 * （可借纹理），笔刷 Add / Subtract 直接在图上改绿色；每次笔画和参数变化都用
 * 尾随节流重算代理预览，确定时用同一份取样平面在全分辨率重算后落库。
 *
 * 类名独占 `.caf-`，不碰别的窗口样式。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import type { StrataDoc } from "../../core/document";
import {
  countMask,
  paintSamplingStrokes,
  type SamplingStroke,
} from "../../core/contentAwareSampling";
import {
  applyCaf,
  autoSamplingMask,
  cafPreviewCanvas,
  computeCaf,
  DEFAULT_CAF_PARAMS,
  planCaf,
  selectionToHole,
  type CafParams,
  type CafPlan,
} from "../../engine/contentAwareFill";
import { mustCtx } from "../../engine/surface";
import { zh } from "../../i18n";
import { useBaseComposite } from "../hooks/useComposedPreview";
import { useDialogUndo } from "../hooks/useDialogUndo";
import DialogUndoButtons from "./DialogUndoButtons";
import DraggableModal from "./DraggableModal";
import FilterPreview from "./FilterPreview";
import MiniHistogram from "./MiniHistogram";
import NumericField from "./NumericField";
import "./ContentAwareFillDialog.css";

interface Props {
  doc: StrataDoc;
  onApply: (next: StrataDoc, label: string) => void;
  onClose: () => void;
}

interface CafState {
  strokes: SamplingStroke[];
  params: CafParams;
}

interface Fit {
  k: number;
  left: number;
  top: number;
}

/** 绿 = 可借纹理，红 = 要抹掉的选区。 */
function buildOverlay(
  doc: StrataDoc,
  base: HTMLCanvasElement,
  sample: Uint8Array,
  hole: Uint8Array,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = doc.width;
  canvas.height = doc.height;
  const ctx = mustCtx(canvas);
  ctx.drawImage(base, 0, 0);
  const image = ctx.getImageData(0, 0, doc.width, doc.height);
  for (let i = 0; i < hole.length; i += 1) {
    const o = i * 4;
    if (hole[i]) {
      image.data[o] = image.data[o] * 0.6 + 255 * 0.4;
      image.data[o + 1] = image.data[o + 1] * 0.6 + 60 * 0.4;
      image.data[o + 2] = image.data[o + 2] * 0.6 + 60 * 0.4;
    } else if (sample[i]) {
      image.data[o] = image.data[o] * 0.75 + 40 * 0.25;
      image.data[o + 1] = image.data[o + 1] * 0.75 + 230 * 0.25;
      image.data[o + 2] = image.data[o + 2] * 0.75 + 110 * 0.25;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function cropCanvas(src: HTMLCanvasElement, x: number, y: number, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  mustCtx(canvas).drawImage(src, x, y, w, h, 0, 0, w, h);
  return canvas;
}

/** 参数 / 笔画变化后的尾随节流预览：拖动中持续算，停手最后一帧保证推到画面。 */
function useCafPreview(plan: CafPlan | null, params: CafParams, gapMs = 160) {
  const [filled, setFilled] = useState<ReturnType<typeof computeCaf> | null>(() =>
    plan ? computeCaf(plan, params) : null,
  );
  const [version, setVersion] = useState(0);
  const last = useRef(0);
  const timer = useRef<number | null>(null);
  const pending = useRef({ plan, params });
  pending.current = { plan, params };

  useEffect(() => {
    const run = () => {
      const { plan: p, params: q } = pending.current;
      setFilled(p ? computeCaf(p, q) : null);
      setVersion((v) => v + 1);
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
  }, [plan, params, gapMs]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  return { filled, version };
}

export default function ContentAwareFillDialog({ doc, onApply, onClose }: Props) {
  const initial = useRef<CafState>({ strokes: [], params: { ...DEFAULT_CAF_PARAMS } }).current;
  const {
    state,
    setState,
    beginGesture,
    endGesture,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useDialogUndo<CafState>(initial);
  const [add, setAdd] = useState(true);
  const [brushSize, setBrushSize] = useState(80);
  /** 正在拖的这一笔：不进撤销栈，但立刻参与预览，避免「松手才渲染」。 */
  const [liveStroke, setLiveStroke] = useState<SamplingStroke | null>(null);

  const picked = useMemo(() => selectionToHole(doc), [doc]);
  const baseSample = useMemo(
    () => (picked ? autoSamplingMask(doc, picked.hole, state.params.padding) : null),
    [doc, picked, state.params.padding],
  );
  const committedSample = useMemo(
    () =>
      baseSample
        ? paintSamplingStrokes(baseSample, doc.width, doc.height, state.strokes)
        : null,
    [baseSample, doc.width, doc.height, state.strokes],
  );
  const sample = useMemo(
    () =>
      committedSample && liveStroke
        ? paintSamplingStrokes(committedSample, doc.width, doc.height, [liveStroke])
        : committedSample,
    [committedSample, liveStroke, doc.width, doc.height],
  );
  const baseCanvas = useBaseComposite(doc);
  const overlay = useMemo(
    () =>
      committedSample && picked && baseCanvas
        ? buildOverlay(doc, baseCanvas, committedSample, picked.hole)
        : null,
    [doc, baseCanvas, committedSample, picked],
  );
  const sampleCount = useMemo(() => (sample ? countMask(sample) : 0), [sample]);

  const previewPlan = useMemo(
    () => (sample ? planCaf(doc, sample, 640) : null),
    [doc, sample],
  );
  const { filled, version } = useCafPreview(previewPlan, state.params);
  const resultCanvas = useMemo(
    () => (filled && previewPlan ? cafPreviewCanvas(filled) : null),
    [filled, previewPlan, version],
  );
  const compareCanvas = useMemo(
    () =>
      previewPlan && baseCanvas
        ? cropCanvas(baseCanvas, previewPlan.x0, previewPlan.y0, previewPlan.rw, previewPlan.rh)
        : null,
    [baseCanvas, previewPlan],
  );

  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fitRef = useRef<Fit>({ k: 1, left: 0, top: 0 });
  const drawingRef = useRef<Array<[number, number]> | null>(null);

  const repaint = useCallback(() => {
    const host = hostRef.current;
    const el = canvasRef.current;
    if (!host || !el || !overlay) return;
    const boxW = Math.max(1, host.clientWidth);
    const boxH = Math.max(1, host.clientHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(boxW * dpr);
    const ph = Math.round(boxH * dpr);
    if (el.width !== pw) el.width = pw;
    if (el.height !== ph) el.height = ph;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    const k = Math.min(boxW / Math.max(1, doc.width), boxH / Math.max(1, doc.height)) * 0.96;
    const left = (boxW - doc.width * k) / 2;
    const top = (boxH - doc.height * k) / 2;
    fitRef.current = { k, left, top };
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(overlay, left * dpr, top * dpr, doc.width * k * dpr, doc.height * k * dpr);

    const points = drawingRef.current;
    if (points?.length) {
      ctx.strokeStyle = add ? "#5cff9d" : "#ff8a63";
      ctx.lineWidth = Math.max(1, brushSize * k * dpr);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = 0.62;
      ctx.beginPath();
      points.forEach(([x, y], i) => {
        const px = (left + x * k) * dpr;
        const py = (top + y * k) * dpr;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      if (points.length === 1) ctx.lineTo(points[0][0] * k * dpr + left * dpr + 0.01, points[0][1] * k * dpr + top * dpr);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }, [overlay, doc.width, doc.height, add, brushSize]);

  useEffect(() => { repaint(); }, [repaint]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(repaint) : null;
    ro?.observe(host);
    return () => ro?.disconnect();
  }, [repaint]);

  const toDoc = useCallback((e: RPointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    const { k, left, top } = fitRef.current;
    return [(e.clientX - rect.left - left) / k, (e.clientY - rect.top - top) / k];
  }, []);

  const onDown = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !overlay) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    beginGesture();
    drawingRef.current = [toDoc(e)];
    repaint();
  };
  const onMove = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    drawingRef.current.push(toDoc(e));
    // 每一帧都把当前笔刷送进取样平面，预览尾随节流跟着算，抬笔前一整段都在更新。
    setLiveStroke({ add, size: brushSize, points: [...drawingRef.current] });
    repaint();
  };
  const onUp = () => {
    const points = drawingRef.current;
    drawingRef.current = null;
    setLiveStroke(null);
    if (points?.length) {
      setState((s) => ({
        ...s,
        strokes: [...s.strokes, { add, size: brushSize, points }],
      }));
    }
    endGesture();
    repaint();
  };

  const patch = (p: Partial<CafParams>) =>
    setState((s) => ({ ...s, params: { ...s.params, ...p } }));

  const confirm = () => {
    if (!sample) return;
    const fullPlan = planCaf(doc, sample);
    if (!fullPlan) return;
    const result = computeCaf(fullPlan, state.params);
    const next = applyCaf(doc, fullPlan, result);
    if (next !== doc) onApply(next, zh.inpaint.workspaceTitle);
  };

  return (
    <DraggableModal
      id="content-aware-fill"
      title={zh.inpaint.workspaceTitle}
      badge={zh.menu.edit}
      onClose={onClose}
      width={1080}
      height={660}
      minWidth={860}
      minHeight={520}
      footer={
        <>
          <DialogUndoButtons canUndo={canUndo} canRedo={canRedo} onUndo={undo} onRedo={redo} />
          <button className="btn-ghost" onClick={() => setState((s) => ({ ...s, strokes: [] }))}>
            {zh.inpaint.reset}
          </button>
          <span className="caf-spacer" />
          <button className="btn-ghost" onClick={onClose}>
            {zh.dialog.cancel}
          </button>
          <button className="btn-primary" disabled={!sampleCount || !resultCanvas} onClick={confirm}>
            {zh.dialog.confirm}
          </button>
        </>
      }
    >
      <div className="caf-workbench">
        <div className="caf-canvas-pane">
          <div className="caf-pane-head">
            <span>{zh.inpaint.sampling}</span>
            <span className="caf-legend">
              <i className="caf-dot caf-dot-sample" />
              {zh.inpaint.sampling}
              <i className="caf-dot caf-dot-hole" />
              {zh.inpaint.fillArea}
            </span>
          </div>
          <div className="caf-stage" ref={hostRef}>
            <canvas
              ref={canvasRef}
              className="caf-stage-canvas"
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            />
          </div>
          <div className="caf-hint">{zh.inpaint.hint}</div>
        </div>

        <div className="caf-params-pane">
          <div className="caf-pane-head">{zh.inpaint.result}</div>
          <div className="caf-result">
            <FilterPreview
              source={resultCanvas}
              compareSource={compareCanvas}
              docW={previewPlan?.rw ?? doc.width}
              docH={previewPlan?.rh ?? doc.height}
              version={version}
              height={210}
            />
            <MiniHistogram source={resultCanvas} version={version} height={46} />
          </div>
          <div className="caf-params-scroll">
            <div className="caf-section-title">{zh.inpaint.brush}</div>
            <div className="caf-segment">
              <button className={add ? "is-active" : ""} onClick={() => setAdd(true)}>
                {zh.inpaint.add}
              </button>
              <button className={!add ? "is-active" : ""} onClick={() => setAdd(false)}>
                {zh.inpaint.subtract}
              </button>
            </div>
            <NumericField
              label={zh.inpaint.brushSize}
              value={brushSize}
              min={2}
              max={600}
              step={1}
              onChange={setBrushSize}
            />
            <div className="caf-count">
              {zh.inpaint.sampleCount}：{sampleCount.toLocaleString()}
            </div>
            {!sampleCount && <div className="caf-warn">{zh.inpaint.noSample}</div>}

            <div className="caf-section-title">{zh.inpaint.settings}</div>
            <NumericField
              label={zh.inpaint.padding}
              value={state.params.padding}
              min={0}
              max={512}
              step={8}
              onChange={(v) => patch({ padding: Math.round(v) })}
              onGestureStart={beginGesture}
              onGestureEnd={endGesture}
            />
            <NumericField
              label={zh.inpaint.seed}
              value={state.params.seed}
              min={0}
              max={99999}
              onChange={(v) => patch({ seed: Math.round(v) })}
              onGestureStart={beginGesture}
              onGestureEnd={endGesture}
            />
            <NumericField
              label={zh.inpaint.patch}
              value={state.params.patch}
              min={1}
              max={16}
              onChange={(v) => patch({ patch: Math.round(v) })}
              onGestureStart={beginGesture}
              onGestureEnd={endGesture}
            />
            <NumericField
              label={zh.inpaint.iterations}
              value={state.params.iterations}
              min={0}
              max={12}
              onChange={(v) => patch({ iterations: Math.round(v) })}
              onGestureStart={beginGesture}
              onGestureEnd={endGesture}
            />
            <NumericField
              label={zh.inpaint.search}
              value={state.params.search}
              min={4}
              max={256}
              step={4}
              onChange={(v) => patch({ search: Math.round(v) })}
              onGestureStart={beginGesture}
              onGestureEnd={endGesture}
            />
          </div>
        </div>
      </div>
    </DraggableModal>
  );
}
