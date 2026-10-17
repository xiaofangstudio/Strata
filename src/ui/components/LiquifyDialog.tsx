import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activeLayer, type StrataDoc } from "../../core/document";
import { composeDoc } from "../../engine/compositor";
import {
  DEFAULT_LIQUIFY,
  LiquifyStroke,
  LIQUIFY_MODES,
  createField,
  warpInto,
  type LiquifyField,
  type LiquifyMode,
  type LiquifySettings,
} from "../../engine/liquify";
import { cloneRaster, type Raster, type Rect } from "../../engine/raster";
import { cloneSurface, createSurface, mustCtx, readPixels } from "../../engine/surface";
import { zh } from "../../i18n/zh-CN";
import type { ThemeMode } from "../../stores/theme";
import { capturePointer } from "../pointer";
import Modal from "./Modal";
import "./LiquifyDialog.css";

interface Props {
  doc: StrataDoc;
  themeMode: ThemeMode;
  /** 确定：把形变后的像素写回当前图层，进历史 */
  onApply: (next: StrataDoc) => void;
  onClose: () => void;
}

const MODE_LABEL: Record<LiquifyMode, string> = {
  push: zh.liquify.modePush,
  bloat: zh.liquify.modeBloat,
  pinch: zh.liquify.modePinch,
  twirl: zh.liquify.modeTwirl,
  restore: zh.liquify.modeRestore,
};

type SliderKey = "size" | "hardness" | "strength" | "spacing";

interface Slider {
  key: SliderKey;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}

const SLIDERS: Slider[] = [
  { key: "size", label: zh.liquify.size, min: 5, max: 1000, step: 1, unit: " px" },
  { key: "hardness", label: zh.liquify.hardness, min: 0, max: 100, step: 1, unit: "%" },
  { key: "strength", label: zh.liquify.strength, min: 1, max: 100, step: 1, unit: "%" },
  { key: "spacing", label: zh.liquify.spacing, min: 1, max: 50, step: 1, unit: "%" },
];

/* ------------------------------------------------------------- 小工具 */

let lightTile: HTMLCanvasElement | null = null;
let darkTile: HTMLCanvasElement | null = null;

/** 透明棋盘格。按主题各缓存一张，免得每帧新建画布。 */
function checkerTile(dark: boolean): HTMLCanvasElement {
  if (dark && darkTile) return darkTile;
  if (!dark && lightTile) return lightTile;
  const c = document.createElement("canvas");
  c.width = 16;
  c.height = 16;
  const g = mustCtx(c);
  const a = dark ? "#33333a" : "#e0e0e5";
  const b = dark ? "#3d3d45" : "#cfcfd6";
  g.fillStyle = a;
  g.fillRect(0, 0, 16, 16);
  g.fillStyle = b;
  g.fillRect(0, 0, 8, 8);
  g.fillRect(8, 8, 8, 8);
  if (dark) darkTile = c;
  else lightTile = c;
  return c;
}

/** 把 raster 里的一块矩形写进画布对应位置 —— 只写脏矩形，不整帧重写。 */
function blitRect(canvas: HTMLCanvasElement, view: Raster, rect: Rect): void {
  const { x, y, width, height } = rect;
  if (width <= 0 || height <= 0) return;
  const img = new ImageData(width, height);
  const src = view.data;
  const stride = view.width * 4;
  for (let row = 0; row < height; row += 1) {
    const from = (y + row) * stride + x * 4;
    img.data.set(src.subarray(from, from + width * 4), row * width * 4);
  }
  mustCtx(canvas).putImageData(img, x, y);
}

/* --------------------------------------------------------------- 面板 */

/**
 * 液化面板。
 *
 * 与滤镜库最大的不同：液化不是「换一套参数重算一遍」，而是**一笔一笔涂出来的**，
 * 所以面板自己持有一张位移场，涂抹全程只改这块内存 + 重建笔尖扫过的那一小块，
 * 主画布一个像素都不动 —— 确定才写回图层，取消直接关闭，没有任何回滚成本。
 *
 * 所有重建都从「打开那一刻的原图」出发（`base`），于是来回推十遍和推一遍一样干净。
 */
export default function LiquifyDialog({ doc, themeMode, onApply, onClose }: Props) {
  const act = activeLayer(doc);
  const at = useMemo(
    () => (act ? doc.layers.findIndex((l) => l.id === act.id) : -1),
    [doc.layers, act],
  );
  const usable = Boolean(act && at >= 0 && act.kind === "pixel" && !act.locked);

  /* ---- 打开那一刻的像素与三张工作画布（只建一次） ---- */
  const baseRef = useRef<Raster | null>(null);
  if (baseRef.current === null && usable && act) {
    const img = readPixels(act.surface);
    baseRef.current = { data: img.data, width: img.width, height: img.height };
  }
  const base = baseRef.current;

  const fieldRef = useRef<LiquifyField | null>(null);
  const viewRef = useRef<Raster | null>(null);
  const layerRef = useRef<HTMLCanvasElement | null>(null);
  const bufferRef = useRef<HTMLCanvasElement | null>(null);
  if (base && !fieldRef.current) {
    fieldRef.current = createField(base.width, base.height);
    viewRef.current = cloneRaster(base);
    const layer = createSurface(base.width, base.height);
    blitRect(layer, viewRef.current, { x: 0, y: 0, width: base.width, height: base.height });
    layerRef.current = layer;
    bufferRef.current = createSurface(base.width, base.height);
  }

  /* ---- 参数与视图状态 ---- */
  const [set, setSet] = useState<LiquifySettings>(DEFAULT_LIQUIFY);
  const [backdrop, setBackdrop] = useState(true);
  const [touched, setTouched] = useState(false);

  // 指针回调里要读最新的参数，用 ref 兜住；否则 settings 一变就得重绑事件。
  const setRef = useRef(set);
  setRef.current = set;

  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const strokeRef = useRef<LiquifyStroke | null>(null);
  /** 画布 → 文档坐标的变换（每帧重算） */
  const fitRef = useRef({ s: 1, ox: 0, oy: 0 });
  /** 上一次指针在画布内的位置（改笔尖大小后重摆光圈用） */
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef(0);

  /** 关掉背景时把别的图层藏起来 —— 只留当前层，形变边缘更好看清。 */
  const onlyLayerDoc = useMemo<StrataDoc>(() => {
    if (!usable || !act) return doc;
    return {
      ...doc,
      layers: doc.layers.map((l) => (l.id === act.id ? l : { ...l, visible: false })),
    };
  }, [doc, act, usable]);

  /* ------------------------------------------------------------ 绘制 */

  const draw = useCallback(() => {
    const stage = stageRef.current;
    const cv = canvasRef.current;
    const src = baseRef.current;
    const view = viewRef.current;
    const layer = layerRef.current;
    const buffer = bufferRef.current;
    if (!stage || !cv || !src || !view || !layer || !buffer) return;
    if (!usable || !act || at < 0) return;

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

    const s = Math.min(w / src.width, h / src.height);
    const dw = src.width * s;
    const dh = src.height * s;
    const ox = Math.round((w - dw) / 2);
    const oy = Math.round((h - dh) / 2);
    fitRef.current = { s, ox, oy };

    // 画布底：透明棋盘，能一眼看出哪块被推空了
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, dw, dh);
    ctx.clip();
    const pattern = ctx.createPattern(checkerTile(themeMode === "dark"), "repeat");
    ctx.fillStyle = pattern ?? (themeMode === "dark" ? "#33333a" : "#e0e0e5");
    ctx.fillRect(ox, oy, dw, dh);
    ctx.restore();

    // 合成预览：把当前层换成「形变后的像素」再整档合成，
    // 混合模式 / 不透明度 / 蒙版 / 图层样式因此与最终结果完全一致。
    composeDoc(backdrop ? doc : onlyLayerDoc, buffer, {
      index: at,
      layer: { ...act, surface: layer },
    });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(buffer, ox, oy, dw, dh);

    // 画布描边，给图像一个边界
    ctx.strokeStyle = themeMode === "dark" ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.2)";
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + 0.5, oy + 0.5, dw - 1, dh - 1);
  }, [act, at, backdrop, doc, onlyLayerDoc, themeMode, usable]);

  const scheduleDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      draw();
    });
  }, [draw]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(stage);
    return () => ro.disconnect();
  }, [draw]);

  /* ---------------------------------------------------------- 笔尖光圈 */

  const placeRing = useCallback((cx: number, cy: number) => {
    const ring = ringRef.current;
    if (!ring) return;
    const d = Math.max(6, setRef.current.size * fitRef.current.s);
    ring.style.width = `${d}px`;
    ring.style.height = `${d}px`;
    ring.style.transform = `translate(${cx - d / 2}px, ${cy - d / 2}px)`;
    ring.style.opacity = "1";
  }, []);

  // 改「大小」时立刻重摆光圈，不必等下一次移动
  useEffect(() => {
    const p = hoverRef.current;
    if (p) placeRing(p.x, p.y);
  }, [set.size, placeRing]);

  /* ------------------------------------------------------------ 涂抹 */

  const localPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const toDoc = (p: { x: number; y: number }) => {
    const { s, ox, oy } = fitRef.current;
    return { x: (p.x - ox) / s, y: (p.y - oy) / s };
  };

  /** 把这一轮新落的笔尖作用到位移场，并只重建脏矩形那一块。 */
  const step = useCallback((stroke: LiquifyStroke) => {
    const src = baseRef.current;
    const view = viewRef.current;
    const layer = layerRef.current;
    const field = fieldRef.current;
    if (!src || !view || !layer || !field) return;
    const rect = stroke.pull();
    if (!rect) {
      scheduleDraw();
      return;
    }
    warpInto(src, field, view, rect);
    blitRect(layer, view, rect);
    scheduleDraw();
  }, [scheduleDraw]);

  const pressureOf = (e: React.PointerEvent) => (e.pressure > 0 ? e.pressure : 0.5);

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!usable || !baseRef.current || !fieldRef.current) return;
    e.preventDefault();
    capturePointer(e.currentTarget, e.pointerId);
    const lp = localPoint(e);
    hoverRef.current = lp;
    placeRing(lp.x, lp.y);
    const p = toDoc(lp);
    // 位移场由外部传入：本次会话里连续拖的每一笔都接着上一笔累积。
    const stroke = new LiquifyStroke(baseRef.current, setRef.current, {
      field: fieldRef.current,
    });
    stroke.begin(p.x, p.y, pressureOf(e), performance.now());
    strokeRef.current = stroke;
    step(stroke);
  };

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const lp = localPoint(e);
    hoverRef.current = lp;
    placeRing(lp.x, lp.y);
    const stroke = strokeRef.current;
    if (!stroke) return;
    const p = toDoc(lp);
    stroke.extend(p.x, p.y, pressureOf(e), performance.now());
    step(stroke);
  };

  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = strokeRef.current;
    if (!stroke) return;
    strokeRef.current = null;
    stroke.finish();
    step(stroke);
    if (stroke.touched) setTouched(true);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 指针已经不在了，忽略 */
    }
  };

  const leave = () => {
    hoverRef.current = null;
    if (ringRef.current) ringRef.current.style.opacity = "0";
  };

  /* ---------------------------------------------------------- 面板操作 */

  const setValue = (key: SliderKey, value: number) => {
    setSet((prev) => {
      const next: LiquifySettings = { ...prev };
      next[key] = value;
      return next;
    });
  };

  const resetAll = () => {
    const field = fieldRef.current;
    const src = baseRef.current;
    const view = viewRef.current;
    const layer = layerRef.current;
    if (!field || !src || !view || !layer) return;
    field.dx.fill(0);
    field.dy.fill(0);
    view.data.set(src.data);
    blitRect(layer, view, { x: 0, y: 0, width: src.width, height: src.height });
    setTouched(false);
    scheduleDraw();
  };

  const apply = () => {
    if (!usable || !act || !layerRef.current) return;
    const out = cloneSurface(layerRef.current);
    const layers = doc.layers.map((l) => (l.id === act.id ? { ...l, surface: out } : l));
    onApply({ ...doc, layers, dirty: true });
  };

  const note = !usable ? zh.liquify.noPixel : touched ? MODE_LABEL[set.mode] : zh.liquify.empty;

  return (
    <Modal
      title={zh.liquify.title}
      onClose={onClose}
      width={880}
      footer={
        <>
          <span className="lq-note">{note}</span>
          <span className="lq-foot-spacer" />
          <button className="btn-ghost" onClick={onClose}>
            {zh.dialog.cancel}
          </button>
          <button className="btn-primary" onClick={apply} disabled={!usable || !touched}>
            {zh.dialog.confirm}
          </button>
        </>
      }
    >
      <div className="lq">
        <div className="lq-stage" ref={stageRef}>
          <canvas
            ref={canvasRef}
            className="lq-canvas"
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onPointerLeave={leave}
          />
          <div className="lq-ring" ref={ringRef} aria-hidden="true" />
          {!usable && <div className="lq-block">{zh.liquify.noPixel}</div>}
        </div>

        <div className="lq-side">
          <p className="lq-hint">{zh.liquify.hint}</p>

          <div className="lq-legend">{zh.liquify.mode}</div>
          <div className="lq-modes" role="radiogroup" aria-label={zh.liquify.mode}>
            {LIQUIFY_MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={set.mode === m}
                className={set.mode === m ? "lq-mode is-on" : "lq-mode"}
                onClick={() => setSet((prev) => ({ ...prev, mode: m }))}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>

          <div className="lq-legend">{zh.liquify.brush}</div>
          {SLIDERS.map((d) => (
            <label className="lq-field" key={d.key}>
              <span className="lq-field-head">
                <span className="lq-field-label">{d.label}</span>
                <span className="lq-field-value">
                  {Math.round(set[d.key])}
                  {d.unit}
                </span>
              </span>
              <input
                className="lq-range"
                type="range"
                min={d.min}
                max={d.max}
                step={d.step}
                value={set[d.key]}
                onChange={(e) => setValue(d.key, Number(e.target.value))}
              />
            </label>
          ))}

          <label className="lq-check">
            <input
              type="checkbox"
              checked={backdrop}
              onChange={(e) => setBackdrop(e.target.checked)}
            />
            <span>{zh.liquify.backdrop}</span>
          </label>
          <p className="lq-sub">{zh.liquify.backdropHint}</p>

          <button className="btn-ghost lq-reset" type="button" onClick={resetAll} disabled={!touched}>
            {zh.liquify.resetAll}
          </button>
        </div>
      </div>
    </Modal>
  );
}
