/**
 * 色彩范围对话框（PS「选择 > 色彩范围」形态）。
 *
 * 原来的菜单命令直接用前景色算一次选区，没有吸管、没有容差预览 —— 等于
 * 「菜单有这一项，但根本没法用」。现在支持：
 *   · 基础吸管：一次取样，重算整张选区；
 *   · Shift 加选 / Alt 减选：多个样本共同决定最终蒙版；
 *   · 窗内实时预览（底层图像 + 半透明选中区域）；
 *   · 确定才把选区落到文档，取消一个字节都不动。
 *
 * 取样从 base 合成图来，不从来回改的预览图来；纯判定在 core/smartSelect.ts。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { colorRangeMaskMulti, type ColorRangeSample } from "../../core/smartSelect";
import type { StrataDoc } from "../../core/document";
import { zh } from "../../i18n";
import { useBaseComposite } from "../hooks/useComposedPreview";
import type { CanvasPickRequest } from "./LevelsEditor";
import DraggableModal from "./DraggableModal";
import RangeInput from "./RangeInput";
import "./ColorRangeDialog.css";

interface Props {
  doc: StrataDoc;
  onRequestPick: CanvasPickRequest;
  onApply: (mask: HTMLCanvasElement) => void;
  onClose: () => void;
}

type PickMode = "base" | "add" | "subtract";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export default function ColorRangeDialog({ doc, onRequestPick, onApply, onClose }: Props) {
  const base = useRef(doc).current;
  const source = useBaseComposite(base);
  const [samples, setSamples] = useState<ColorRangeSample[]>([]);
  const [tolerance, setTolerance] = useState(32);
  const [armed, setArmed] = useState<PickMode | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const closedRef = useRef(false);

  const mask = useMemo(
    () => (source && samples.length ? colorRangeMaskMulti(source, samples, tolerance) : null),
    [source, samples, tolerance],
  );

  useEffect(() => () => onRequestPick(null), [onRequestPick]);

  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onRequestPick(null);
      setArmed(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [armed, onRequestPick]);

  /** 窗内预览：底层图压暗，命中区域盖一层半透明青色。 */
  useEffect(() => {
    const c = previewRef.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = c.clientWidth || 320;
    const H = c.clientHeight || 216;
    c.width = Math.max(1, Math.round(W * dpr));
    c.height = Math.max(1, Math.round(H * dpr));
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgba(128,128,140,0.12)";
    ctx.fillRect(0, 0, W, H);
    if (!source) return;

    const k = Math.min(W / source.width, H / source.height);
    const dw = source.width * k;
    const dh = source.height * k;
    const ox = (W - dw) / 2;
    const oy = (H - dh) / 2;
    ctx.drawImage(source, ox, oy, dw, dh);

    if (mask) {
      const tint = document.createElement("canvas");
      tint.width = mask.width;
      tint.height = mask.height;
      const tc = tint.getContext("2d");
      const mc = mask.getContext("2d");
      if (tc && mc) {
        const src = mc.getImageData(0, 0, mask.width, mask.height);
        const out = tc.createImageData(mask.width, mask.height);
        for (let p = 0; p < mask.width * mask.height; p += 1) {
          if (src.data[p * 4 + 3] < 128) continue;
          out.data[p * 4] = 86;
          out.data[p * 4 + 1] = 178;
          out.data[p * 4 + 2] = 255;
          out.data[p * 4 + 3] = 150;
        }
        tc.putImageData(out, 0, 0);
        ctx.drawImage(tint, ox, oy, dw, dh);
      }
    }
  }, [source, mask]);

  const arm = (mode: PickMode) => {
    onRequestPick((x, y, mods) => {
      let ok = false;
      try {
        const cv = source;
        if (!cv || cv.width < 1 || cv.height < 1) return;
        const sx = clamp(Math.round((x / Math.max(1, doc.width)) * cv.width), 0, cv.width - 1);
        const sy = clamp(Math.round((y / Math.max(1, doc.height)) * cv.height), 0, cv.height - 1);
        const px = cv.getContext("2d")?.getImageData(sx, sy, 1, 1).data;
        if (!px) return;
        // 按钮指定默认语义；画布上按 Shift / Alt 也能当场改变语义
        const op: ColorRangeSample["op"] = mods?.alt
          ? "subtract"
          : mods?.shift
            ? "add"
            : mode === "subtract"
              ? "subtract"
              : "add";
        const rgb: [number, number, number] = [px[0], px[1], px[2]];
        setSamples((prev) => (mode === "base" && !mods ? [{ rgb, op }] : [...prev, { rgb, op }]));
        ok = true;
      } catch {
        // 取样失败就原样退出，不写半份样本
      } finally {
        onRequestPick(null);
        setArmed(null);
        if (!ok) return;
      }
    });
    setArmed(mode);
  };

  const cancel = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    onRequestPick(null);
    onClose();
  };

  const apply = () => {
    if (closedRef.current || !mask) return;
    closedRef.current = true;
    onRequestPick(null);
    onApply(mask);
  };

  return (
    <DraggableModal
      id="colorRange"
      title={zh.dialog.crTitle}
      badge={zh.selection.colorRange}
      onClose={cancel}
      width={720}
      height={520}
      minWidth={620}
      minHeight={440}
      footer={
        <>
          <span className="fg-note">{zh.dialog.crPickTip}</span>
          <span className="fg-foot-spacer" />
          <button type="button" className="btn-ghost" onClick={cancel}>
            {zh.dialog.cancel}
          </button>
          <button type="button" className="btn-primary" onClick={apply} disabled={!mask}>
            {zh.dialog.crSelect}
          </button>
        </>
      }
    >
      <div className="crw">
        <div className="crw-preview">
          <div className="ad-pane-head">{zh.dialog.crPreview}</div>
          <canvas ref={previewRef} className="crw-canvas" />
        </div>
        <div className="crw-side">
          <div className="ad-pane-head">{zh.dialog.crPicker}</div>
          <div className="crw-tools">
            <button
              type="button"
              className={armed === "base" ? "crw-tool is-on" : "crw-tool"}
              onClick={() => arm("base")}
            >
              {zh.dialog.crPicker}
            </button>
            <button
              type="button"
              className={armed === "add" ? "crw-tool is-on" : "crw-tool"}
              onClick={() => arm("add")}
            >
              + {zh.dialog.crAdd}
            </button>
            <button
              type="button"
              className={armed === "subtract" ? "crw-tool is-on" : "crw-tool"}
              onClick={() => arm("subtract")}
            >
              − {zh.dialog.crSubtract}
            </button>
          </div>

          <label className="crw-tol">
            <span>{zh.dialog.crTolerance}</span>
            <RangeInput
              min={0}
              max={200}
              step={1}
              value={tolerance}
              onChange={setTolerance}
              aria-label={zh.dialog.crTolerance}
            />
            <span className="crw-tol-val">{tolerance}</span>
          </label>

          <div className="ad-pane-head crw-samples-head">
            <span>{zh.dialog.crSamples}</span>
            <button
              type="button"
              className="btn-ghost crw-clear"
              disabled={!samples.length}
              onClick={() => setSamples([])}
            >
              {zh.dialog.crClear}
            </button>
          </div>
          {!samples.length && <p className="crw-empty">{zh.dialog.crEmpty}</p>}
          <div className="crw-sample-list">
            {samples.map((s, i) => (
              <div className="crw-sample" key={`${i}-${s.rgb.join("-")}`}>
                <span
                  className="crw-swatch"
                  style={{ background: `rgb(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]})` }}
                />
                <span className="crw-sample-rgb">
                  {s.rgb[0]}, {s.rgb[1]}, {s.rgb[2]}
                </span>
                <span className="crw-sample-op">
                  {s.op === "add" ? "+" : "−"}
                </span>
                <button
                  type="button"
                  className="crw-del"
                  title={zh.dialog.crClear}
                  onClick={() => setSamples((prev) => prev.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </DraggableModal>
  );
}
