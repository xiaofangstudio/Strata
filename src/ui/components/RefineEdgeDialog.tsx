/**
 * 调整边缘（选择并遮住）对话框。
 *
 * PS「选择 > 选择并遮住」：半径 / 移动边缘 / 对比度走 PhotoCraft guided filter
 * 抠图内核，平滑 / 羽化 / 扩展 / 收缩沿用既有 selection 管线；拖动预览每帧推给
 * onPreview（不进历史），确定才落一条记录 —— 与滤镜、通道弹窗同一套模型。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Modal from "./Modal";
import { Slider } from "./controls";
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
    <Modal
      title={zh.dialog.refineEdgeTitle}
      onClose={cancel}
      width={400}
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
    </Modal>
  );
}
