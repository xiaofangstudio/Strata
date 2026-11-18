/**
 * 调整边缘（选择并遮住）对话框。
 *
 * PS「选择 > 选择并遮住」：半径 / 移动边缘 / 对比度走 PhotoCraft guided filter
 * 抠图内核，平滑 / 羽化 / 扩展 / 收缩沿用既有 selection 管线；拖动预览每帧推给
 * onPreview（不进历史），确定才落一条记录 —— 与滤镜、通道弹窗同一套模型。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import DraggableModal from "./DraggableModal";
import { Slider } from "./controls";
import { composeDoc } from "../../engine/compositor";
import { createSurface, mustCtx, readPixels } from "../../engine/surface";
import { zh } from "../../i18n";
import { activeLayer, type StrataDoc } from "../../core/document";
import {
  contractSelection,
  expandSelection,
  featherSelection,
  invertSelection,
  isSelectionEmpty,
  refineSelectionWithImage,
  smoothSelection,
  type SelectionMask,
} from "../../core/selection";
import "./ChannelDialogs.css";

interface Props {
  doc: StrataDoc;
  onPreview: (next: StrataDoc) => void;
  onApply: (next: StrataDoc) => void;
  onClose: () => void;
}

export type EdgePreviewMode = "red" | "mask" | "original";

/**
 * 边缘预览视图（PS「选择并遮住」的查看模式）：
 *  · 红底：选区外盖半透明红，选区内显示原图 —— 看边缘抠得干不干净最直观；
 *  · 黑白：选区白、背景黑 —— 直接看蒙版形状；
 *  · 原图：不做叠加（主画布已在实时预览，这里给用户一个对照）。
 * 缩到 320px 内嵌，成本封顶；只用于观察，不参与落库。
 */
function EdgePreview({
  doc,
  mask,
  mode,
}: {
  doc: StrataDoc;
  mask: HTMLCanvasElement | null;
  mode: EdgePreviewMode;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  // 原图合成只跟 doc 走（参数变化不改画面本身），缓存下来避免每帧全文档合成
  const composedRef = useRef<HTMLCanvasElement | null>(null);
  if (!composedRef.current) composedRef.current = composeDoc(doc, createSurface(1, 1));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const k = Math.min(1, 320 / Math.max(doc.width, doc.height));
    const w = Math.max(1, Math.round(doc.width * k));
    const h = Math.max(1, Math.round(doc.height * k));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (mode === "original" || !mask) {
      const composed = composedRef.current!;
      ctx.drawImage(composed, 0, 0, w, h);
      return;
    }

    // 原图打底
    const composed = composedRef.current!;
    ctx.drawImage(composed, 0, 0, w, h);

    // 蒙版缩到同尺寸，读 alpha 当选区权重
    const smallMask = createSurface(w, h);
    mustCtx(smallMask).drawImage(mask, 0, 0, w, h);
    const a = readPixels(smallMask).data;

    if (mode === "red") {
      // 选区外（alpha 小）盖红：红量 = 1 - alpha
      const img = ctx.getImageData(0, 0, w, h);
      const d = img.data;
      for (let i = 0; i < w * h; i += 1) {
        const cover = 1 - a[i * 4 + 3] / 255;
        if (cover <= 0) continue;
        const o = i * 4;
        d[o] = d[o] * (1 - cover) + 220 * cover;
        d[o + 1] = d[o + 1] * (1 - cover) + 38 * cover;
        d[o + 2] = d[o + 2] * (1 - cover) + 38 * cover;
      }
      ctx.putImageData(img, 0, 0);
    } else {
      // 黑白：选区权重作灰度
      const img = ctx.createImageData(w, h);
      for (let i = 0; i < w * h; i += 1) {
        const v = a[i * 4 + 3];
        const o = i * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
        img.data[o + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    }
  }, [doc, mask, mode]);

  return <canvas ref={ref} className="re-preview-canvas" />;
}

/** 平滑 → 羽化 → 扩展/收缩，一条管线算到底（顺序与 PS 的结算一致）。 */
export function refineSelection(
  mask: SelectionMask,
  smooth: number,
  feather: number,
  grow: number,
): SelectionMask {
  let m = mask;
  if (smooth > 0) m = smoothSelection(m, Math.round(smooth));
  if (feather > 0) m = featherSelection(m, feather);
  if (grow > 0) m = expandSelection(m, Math.round(grow));
  else if (grow < 0) m = contractSelection(m, Math.round(-grow));
  return m;
}

export default function RefineEdgeDialog({ doc, onPreview, onApply, onClose }: Props) {
  const base = useRef(doc).current;
  const hasSel = !!base.selection && !isSelectionEmpty(base.selection);

  const [radius, setRadius] = useState(0);
  const [smooth, setSmooth] = useState(0);
  const [feather, setFeather] = useState(0);
  const [contrast, setContrast] = useState(0);
  const [shiftEdge, setShiftEdge] = useState(0);
  const [grow, setGrow] = useState(0);
  const [invert, setInvert] = useState(false);
  const [viewMode, setViewMode] = useState<EdgePreviewMode>("red");

  const preview = useMemo(() => {
    if (!base.selection) return null;
    let m = base.selection;
    const usesImage = radius > 0 || contrast !== 0 || shiftEdge !== 0;
    const layer = activeLayer(base);
    if (usesImage && layer?.kind === "pixel") {
      m = refineSelectionWithImage(m, layer.surface, {
        radius,
        smooth: 0,
        feather: 0,
        contrast,
        shiftEdge,
      });
    }
    // 图像导引已吃掉 smooth/feather 时不要重复做一遍；grow 仍按 PS 顺序最后结算。
    m = usesImage && layer?.kind === "pixel"
      ? m
      : refineSelection(m, smooth, feather, 0);
    if (grow > 0) m = expandSelection(m, Math.round(grow));
    else if (grow < 0) m = contractSelection(m, Math.round(-grow));
    if (invert) m = invertSelection(m);
    return m;
  }, [base, radius, smooth, feather, contrast, shiftEdge, grow, invert]);

  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  const closedRef = useRef(false);
  useEffect(() => {
    if (closedRef.current) return;
    previewRef.current(hasSel ? { ...base, selection: preview } : base);
  }, [preview, base, hasSel]);

  const cancel = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    previewRef.current(base);
    onClose();
  };
  const apply = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    onApply({ ...base, selection: preview, dirty: true });
  };

  return (
    <DraggableModal
      id="refineEdge"
      title={zh.dialog.refineEdgeTitle}
      badge="选区"
      onClose={cancel}
      width={480}
      height={600}
      minWidth={400}
      minHeight={480}
      footer={
        <>
          <span className="cd-note">{hasSel ? zh.dialog.refineEdgeHint : zh.dialog.refineEdgeEmpty}</span>
          <span className="fg-foot-spacer" />
          <button type="button" className="btn-ghost" onClick={cancel}>
            {zh.dialog.cancel}
          </button>
          <button type="button" className="btn-primary" onClick={apply} disabled={!hasSel}>
            {zh.dialog.confirm}
          </button>
        </>
      }
    >
      <div className="cd">
        <div className="re-view">
          <div className="re-view-head">
            <span className="re-view-title">边缘预览</span>
            <div className="re-view-modes">
              {([["red", "红底"], ["mask", "黑白"], ["original", "原图"]] as const).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  className={`re-view-mode${viewMode === m ? " is-active" : ""}`}
                  onClick={() => setViewMode(m)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="re-view-stage">
            <EdgePreview doc={base} mask={preview} mode={viewMode} />
          </div>
        </div>
        <Slider label={zh.dialog.refineRadius} min={0} max={64} value={radius} onChange={setRadius} suffix=" px" />
        <Slider label={zh.dialog.refineShiftEdge} min={-100} max={100} value={shiftEdge} onChange={setShiftEdge} suffix="%" />
        <Slider label={zh.dialog.refineContrast} min={0} max={100} value={contrast} onChange={setContrast} suffix="%" />
        <Slider label={zh.dialog.refineSmooth} min={0} max={40} value={smooth} onChange={setSmooth} suffix=" px" />
        <Slider label={zh.dialog.refineFeather} min={0} max={100} value={feather} onChange={setFeather} suffix=" px" />
        <Slider label={zh.dialog.refineGrow} min={-40} max={40} value={grow} onChange={setGrow} suffix=" px" />
        <label className="cd-check">
          <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} />
          <span>{zh.dialog.refineInvert}</span>
        </label>
      </div>
    </DraggableModal>
  );
}
