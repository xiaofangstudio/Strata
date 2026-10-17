import { useState } from "react";
import { zh } from "../../i18n/zh-CN";
import type { Anchor } from "../../core/layerOps";
import Modal from "./Modal";
import "./ImageSizeDialog.css";

/** 九宫格锚点的行序 / 列序，与 PS 的「定位」方块一致。 */
const ANCHOR_ROWS: Anchor[][] = [
  ["nw", "n", "ne"],
  ["w", "c", "e"],
  ["sw", "s", "se"],
];

interface Props {
  /** image = 重定像素（图像大小）；canvas = 只改画布（画布大小） */
  mode: "image" | "canvas";
  width: number;
  height: number;
  onApply: (width: number, height: number, anchor: Anchor) => void;
  onClose: () => void;
}

/**
 * 图像大小 / 画布大小。两者共用一套表单，只差一个「锚点」与提示语：
 * 「图像大小」缩放像素、不需要锚点；「画布大小」不缩放像素、必须选落点。
 */
export default function ImageSizeDialog({ mode, width, height, onApply, onClose }: Props) {
  const [w, setW] = useState(String(width));
  const [h, setH] = useState(String(height));
  const [anchor, setAnchor] = useState<Anchor>("c");
  const [keep, setKeep] = useState(true);
  const [err, setErr] = useState("");

  const ratio = width / Math.max(1, height);
  const isImage = mode === "image";

  /** 改宽度时按原比例带出高度（勾了「保持比例」才联动）。 */
  const onWidth = (v: string) => {
    setW(v);
    if (!keep) return;
    const n = Math.round(Number(v) / ratio);
    if (Number.isFinite(n) && n > 0) setH(String(n));
  };

  const onHeight = (v: string) => {
    setH(v);
    if (!keep) return;
    const n = Math.round(Number(v) * ratio);
    if (Number.isFinite(n) && n > 0) setW(String(n));
  };

  const submit = () => {
    const nw = Math.round(Number(w));
    const nh = Math.round(Number(h));
    if (!Number.isFinite(nw) || !Number.isFinite(nh) || nw < 1 || nh < 1) {
      setErr(zh.dialog.sizeInvalid);
      return;
    }
    if (nw === width && nh === height) {
      setErr(zh.dialog.sizeSame);
      return;
    }
    onApply(nw, nh, anchor);
    onClose();
  };

  const title = isImage ? zh.dialog.imageSizeTitle : zh.dialog.canvasSizeTitle;

  return (
    <Modal
      title={title}
      onClose={onClose}
      width={420}
      footer={
        <>
          <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
            {zh.dialog.cancel}
          </button>
          <button type="button" className="btn-primary btn-sm" onClick={submit}>
            {zh.dialog.confirm}
          </button>
        </>
      }
    >
      <p className="isz-hint">{isImage ? zh.dialog.imageSizeHint : zh.dialog.canvasSizeHint}</p>

      <div className="field-row">
        <label className="field">
          <span className="field-label">{zh.dialog.width}</span>
          <span className="field-input">
            <input
              type="number"
              min={1}
              value={w}
              onChange={(e) => onWidth(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <span className="field-unit">{zh.dialog.px}</span>
          </span>
        </label>
        <span className="field-x">×</span>
        <label className="field">
          <span className="field-label">{zh.dialog.height}</span>
          <span className="field-input">
            <input
              type="number"
              min={1}
              value={h}
              onChange={(e) => onHeight(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <span className="field-unit">{zh.dialog.px}</span>
          </span>
        </label>
      </div>

      {isImage ? (
        <label className="isz-check">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          <span>{zh.dialog.keepRatio}</span>
        </label>
      ) : (
        <div className="isz-anchor">
          <div className="isz-anchor-head">
            <span className="field-label">{zh.dialog.anchor}</span>
            <span className="isz-anchor-hint">{zh.dialog.anchorHint}</span>
          </div>
          <div className="isz-grid">
            {ANCHOR_ROWS.map((row) =>
              row.map((a) => (
                <button
                  key={a}
                  className="isz-cell"
                  data-on={a === anchor}
                  onClick={() => setAnchor(a)}
                  aria-label={a}
                  aria-pressed={a === anchor}
                />
              )),
            )}
          </div>
        </div>
      )}

      {err && <div className="isz-err">{err}</div>}
    </Modal>
  );
}
