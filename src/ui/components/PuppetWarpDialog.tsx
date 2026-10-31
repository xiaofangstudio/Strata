/**
 * 木偶变形 / 透视钉点变形对话框。
 *
 * 交互与 PS 的 Puppet Warp 对齐：
 * - 画布上单击空白处放置图钉（原始位置 = 当前位置）；
 * - 拖动图钉 → MLS 网格实时变形预览；
 * - 选中图钉后 Delete 删除，或用「删除图钉」按钮；
 * - 确定：在全分辨率上跑一次 MLS 写回活动图层（含蒙版），进历史。
 *
 * 性能策略与液化一致：交互全程只在「最长边 ≤ 640px」的预览缓冲上算
 * MLS，主画布一个像素不动；确定才全分辨率跑一次。
 *
 * 编辑 > 木偶变形 默认「刚性」模式（只旋转不平铺）；编辑 > 透视变形 /
 * 智能对象下的两个入口默认「仿射」模式，对话框内可随时切换。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activeLayer, type StrataDoc } from "../../core/document";
import { meshWarpActiveLayer } from "../../core/layerOps";
import { mlsWarp, type MlsMode, type WarpPin } from "../../engine/meshWarp";
import { cloneSurface, createSurface, mustCtx } from "../../engine/surface";
import { zh } from "../../i18n/zh-CN";
import type { ThemeMode } from "../../stores/theme";
import { capturePointer } from "../pointer";
import Modal from "./Modal";
import "./LiquifyDialog.css";

interface Props {
  doc: StrataDoc;
  themeMode: ThemeMode;
  /** 入口默认模式：木偶 = 刚性（相似变换），透视 = 仿射 */
  defaultMode: MlsMode;
  /** 确定：把形变后的像素写回当前图层，进历史 */
  onApply: (next: StrataDoc) => void;
  onClose: () => void;
  /** 是否绘制网格参考（视图 > 显示 > 网格） */
  showMesh?: boolean;
  /** 是否绘制钉子（视图 > 显示 > 编辑钉） */
  showPins?: boolean;
}

/** 预览缓冲最长边。 */
const PREVIEW_MAX = 640;
/** 命中图钉的判定半径（画布像素）。 */
const HIT_R = 10;

export default function PuppetWarpDialog({
  doc,
  themeMode,
  defaultMode,
  onApply,
  onClose,
  showMesh = true,
  showPins = true,
}: Props) {
  const act = activeLayer(doc);
  const at = useMemo(
    () => (act ? doc.layers.findIndex((l) => l.id === act.id) : -1),
    [doc.layers, act],
  );
  const usable = Boolean(act && at >= 0 && act.kind === "pixel" && !act.locked);

  /* ---- 打开那一刻的像素（只建一次） ---- */
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  if (baseRef.current === null && usable && act) {
    baseRef.current = cloneSurface(act.surface);
  }

  const [mode, setMode] = useState<MlsMode>(defaultMode);
  const [pins, setPins] = useState<WarpPin[]>([]);
  const [selected, setSelected] = useState(-1);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<number>(-1);
  const rafRef = useRef(0);
  /** 文档 → 画布 的拟合变换 */
  const fitRef = useRef({ s: 1, ox: 0, oy: 0 });
  /** 预览用的工作画布（缓存，避免每帧建） */
  const workRef = useRef<HTMLCanvasElement | null>(null);
  const backdropRef = useRef<HTMLCanvasElement | null>(null);
  if (workRef.current === null && usable) {
    const k = Math.min(1, PREVIEW_MAX / Math.max(doc.width, doc.height));
    workRef.current = createSurface(
      Math.max(1, Math.round(doc.width * k)),
      Math.max(1, Math.round(doc.height * k)),
    );
    // 背景 = 其他可见图层合成的结果（不参与变形）
    const bd = createSurface(doc.width, doc.height);
    const bdCtx = mustCtx(bd);
    for (const l of doc.layers) {
      if (l.id === act?.id || !l.visible || l.kind !== "pixel") continue;
      bdCtx.globalAlpha = l.opacity / 100;
      bdCtx.drawImage(l.surface, 0, 0);
      bdCtx.globalAlpha = 1;
    }
    backdropRef.current = bd;
  }

  const minPins = mode === "affine" ? 3 : 2;

  /* ------------------------------------------------------------ 绘制 */

  const draw = useCallback(() => {
    const stage = stageRef.current;
    const cv = canvasRef.current;
    const base = baseRef.current;
    const work = workRef.current;
    const bd = backdropRef.current;
    if (!stage || !cv || !base || !work) return;

    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (w <= 0 || h <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw;
      cv.height = bh;
    }
    const ctx = mustCtx(cv);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const s = Math.min(w / doc.width, h / doc.height);
    const dw = doc.width * s;
    const dh = doc.height * s;
    const ox = Math.round((w - dw) / 2);
    const oy = Math.round((h - dh) / 2);
    fitRef.current = { s, ox, oy };

    // 透明棋盘
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, dw, dh);
    ctx.clip();
    ctx.fillStyle = themeMode === "dark" ? "#2a2a30" : "#e6e6ea";
    ctx.fillRect(ox, oy, dw, dh);
    ctx.restore();

    // 背景（其他图层，静态）
    if (bd) ctx.drawImage(bd, ox, oy, dw, dh);

    // 变形预览：把当前层缩到预览缓冲 → MLS → 贴回
    const k = work.width / doc.width;
    const wctx = mustCtx(work);
    wctx.setTransform(1, 0, 0, 1, 0, 0);
    wctx.clearRect(0, 0, work.width, work.height);
    wctx.imageSmoothingQuality = "high";
    wctx.drawImage(base, 0, 0, work.width, work.height);
    const img = wctx.getImageData(0, 0, work.width, work.height);
    const previewPins: WarpPin[] =
      pins.length >= minPins
        ? pins.map((p) => ({ ox: p.ox * k, oy: p.oy * k, x: p.x * k, y: p.y * k }))
        : [];
    const warped = mlsWarp(
      { data: img.data, width: img.width, height: img.height },
      previewPins,
      mode,
    );
    wctx.putImageData(new ImageData(new Uint8ClampedArray(warped.data), work.width, work.height), 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(work, ox, oy, dw, dh);

    // 画布描边
    ctx.strokeStyle = themeMode === "dark" ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.2)";
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + 0.5, oy + 0.5, dw - 1, dh - 1);

    // 网格参考：把画面切成 6×6，变形时看得清拉伸方向（视图 > 显示 > 网格）
    if (showMesh) {
      ctx.strokeStyle = themeMode === "dark" ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.12)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 6; i += 1) {
        const gx = ox + (dw * i) / 6;
        const gy = oy + (dh * i) / 6;
        ctx.beginPath();
        ctx.moveTo(gx, oy);
        ctx.lineTo(gx, oy + dh);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(ox, gy);
        ctx.lineTo(ox + dw, gy);
        ctx.stroke();
      }
    }

    // 图钉：原始位置细线 + 当前位置圆点（视图 > 显示 > 编辑钉）
    for (let i = 0; i < pins.length && showPins; i += 1) {
      const p = pins[i];
      const px = ox + p.x * s;
      const py = oy + p.y * s;
      const pox = ox + p.ox * s;
      const poy = oy + p.oy * s;
      ctx.strokeStyle = "rgba(120,170,255,0.8)";
      ctx.beginPath();
      ctx.moveTo(pox, poy);
      ctx.lineTo(px, py);
      ctx.stroke();
      ctx.fillStyle = i === selected ? "#ffd166" : "#78aaff";
      ctx.beginPath();
      ctx.arc(px, py, i === selected ? 5 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = themeMode === "dark" ? "#111318" : "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }, [act, doc.width, doc.height, minPins, mode, pins, selected, themeMode, usable, showMesh, showPins]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  /* ------------------------------------------------------------ 交互 */

  const toDoc = useCallback((e: PointerEvent | React.PointerEvent): { x: number; y: number } | null => {
    const stage = stageRef.current;
    const cv = canvasRef.current;
    if (!stage || !cv) return null;
    const rect = cv.getBoundingClientRect();
    const { s, ox, oy } = fitRef.current;
    const x = ((e.clientX - rect.left) - ox) / s;
    const y = ((e.clientY - rect.top) - oy) / s;
    if (x < 0 || y < 0 || x > doc.width || y > doc.height) return null;
    return { x, y };
  }, [doc.width, doc.height]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!usable || e.button !== 0) return;
      const pos = toDoc(e);
      if (!pos) return;
      const cv = canvasRef.current;
      if (!cv) return;
      const { s } = fitRef.current;
      // 先看是否命中已有图钉
      let hit = -1;
      let hitD = HIT_R / s;
      for (let i = 0; i < pins.length; i += 1) {
        const d = Math.hypot(pins[i].x - pos.x, pins[i].y - pos.y);
        if (d < hitD) {
          hit = i;
          hitD = d;
        }
      }
      capturePointer(cv, e.pointerId);
      if (hit >= 0) {
        dragRef.current = hit;
        setSelected(hit);
        return;
      }
      // 空白处：放一个新钉
      const pin: WarpPin = { ox: pos.x, oy: pos.y, x: pos.x, y: pos.y };
      setPins((prev) => {
        setSelected(prev.length);
        return [...prev, pin];
      });
    },
    [pins, toDoc, usable],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const i = dragRef.current;
      if (i < 0) return;
      const pos = toDoc(e);
      if (!pos) return;
      setPins((prev) => {
        if (i >= prev.length) return prev;
        const next = prev.slice();
        next[i] = { ...next[i], x: pos.x, y: pos.y };
        return next;
      });
    },
    [toDoc],
  );

  const onPointerUp = useCallback(() => {
    dragRef.current = -1;
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (selected < 0) return;
      e.preventDefault();
      setPins((prev) => prev.filter((_, i) => i !== selected));
      setSelected(-1);
    },
    [selected],
  );

  const removeSelected = useCallback(() => {
    setPins((prev) => prev.filter((_, i) => i !== selected));
    setSelected(-1);
  }, [selected]);

  /* ------------------------------------------------------------ 提交 */

  const apply = useCallback(() => {
    if (!usable) return;
    if (pins.length < minPins) {
      setToastText(minPins === 3 ? "仿射模式至少需要 3 个图钉" : "至少需要 2 个图钉");
      return;
    }
    onApply(meshWarpActiveLayer(doc, pins, mode));
  }, [doc, minPins, mode, onApply, pins, usable]);

  // setToastText 由 EditorShell 的 toast 提供不进来 —— 就地用窗口内提示
  const [toastText, setToastText] = useState("");

  return (
    <Modal
      title={mode === "affine" ? zh.puppet.titleAffine : zh.puppet.titlePuppet}
      onClose={onClose}
      width={880}
      footer={
        <>
          <span className="lq-note">
            {toastText ||
              (pins.length < minPins
                ? `在画面上放至少 ${minPins} 个图钉（当前 ${pins.length}）`
                : "拖动图钉变形；Delete 删除选中图钉")}
          </span>
          <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
            {zh.dialog.cancel}
          </button>
          <button type="button" className="btn-ghost btn-sm" disabled={selected < 0} onClick={removeSelected}>
            删除图钉
          </button>
          <button type="button" className="btn-primary btn-sm" onClick={apply}>
            {zh.dialog.confirm}
          </button>
        </>
      }
    >
      <div className="lq-block">
        <div
          className="lq-stage"
          ref={stageRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          style={{ height: 460 }}
        >
          <canvas
            ref={canvasRef}
            className="lq-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          />
        </div>
      </div>
      <div className="lq-side" style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
        <span className="lq-field-label">变形方式</span>
        <label className="lq-mode">
          <input
            type="radio"
            name="puppet-mode"
            checked={mode === "similarity"}
            onChange={() => setMode("similarity")}
          />
          刚性（旋转 / 缩放）
        </label>
        <label className="lq-mode">
          <input
            type="radio"
            name="puppet-mode"
            checked={mode === "affine"}
            onChange={() => setMode("affine")}
          />
          仿射（斜切 / 拉伸）
        </label>
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={() => {
            setPins([]);
            setSelected(-1);
          }}
        >
          清空图钉
        </button>
      </div>
      <p className="lq-hint">
        单击空白处加图钉，拖动图钉变形；离图钉越近的像素跟随越强。确定后按当前图钉在全分辨率上
        重新计算一次。变形作用于当前图层（含蒙版）。
      </p>
    </Modal>
  );
}
