/**
 * 导出对话框：选格式 + 调质量，再交给保存框。
 *
 * 为什么单独做一个窗而不是直接弹系统保存框：
 * 系统框只能选文件名和扩展名，选完就定了；而"存 JPG 用什么质量"这种事
 * 必须在编码之前决定 —— 所以在自己的窗里先定参数，确定后才弹系统框。
 */
import { useState } from "react";
import Modal from "./Modal";
import RangeInput from "./RangeInput";
import { EXPORT_FORMATS, formatSpec, type ExportFormat } from "../../engine/exportImage";
import "./ExportDialog.css";

interface Props {
  /** 文档名（用来显示建议文件名） */
  docName: string;
  /** 文档尺寸，显示在摘要里 */
  width: number;
  height: number;
  onCancel: () => void;
  onExport: (format: ExportFormat, quality: number) => void;
}

export default function ExportDialog({
  docName,
  width,
  height,
  onCancel,
  onExport,
}: Props) {
  const [format, setFormat] = useState<ExportFormat>("png");
  const [quality, setQuality] = useState(92);
  const spec = formatSpec(format);

  return (
    <Modal
      title="导出图片"
      onClose={onCancel}
      width={420}
      footer={
        <>
          <button type="button" className="btn-ghost btn-sm" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn-primary btn-sm"
            onClick={() => onExport(format, quality)}
          >
            导出
          </button>
        </>
      }
    >
      <div className="ex">
        <div className="ex-row">
          <span className="u-micro">格式</span>
          <div className="ex-formats" role="tablist" aria-label="导出格式">
            {EXPORT_FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={f.id === format}
                className={`ex-format${f.id === format ? " is-on" : ""}`}
                onClick={() => setFormat(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <p className="ex-note">{spec.note}</p>

        {spec.lossy && (
          <div className="ex-quality">
            <div className="ex-quality-head">
              <span className="u-micro">质量</span>
              <b className="u-num">{quality}</b>
            </div>
            <RangeInput
              className="ex-range"
              min={1}
              max={100}
              value={quality}
              aria-label="导出质量"
              onChange={(v) => setQuality(Math.round(v))}
            />
            <div className="ex-quality-scale">
              <span>更小</span>
              <span>更好</span>
            </div>
          </div>
        )}

        <div className="ex-summary">
          <div className="ex-kv">
            <span>尺寸</span>
            <b className="u-num">
              {width} × {height}
            </b>
          </div>
          <div className="ex-kv">
            <span>文件名</span>
            <b className="ex-name">
              {docName.replace(/\.(png|jpe?g|webp|gif|bmp|tiff?|psd|strata)$/i, "")}.{spec.ext}
            </b>
          </div>
        </div>

        {format === "jpeg" && (
          <p className="ex-warn">
            JPEG 不支持透明，透明区域会自动铺白底。要保留透明请选 PNG 或 WebP。
          </p>
        )}
      </div>
    </Modal>
  );
}
