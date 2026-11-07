/**
 * 色阶编辑器（替代「色阶 / 通道色阶」调整层的通用滑杆）。
 *
 * 为什么单独写：用户在做真实抠图测试时明确吐槽——之前的色阶面板是「顶部数字 +
 * 底部滑杆」两套控件各管各的，数字不能拖、滑杆又和顶上数字脱节。这里改成 PS 同款：
 *
 *   ① 顶部的黑场 / 灰场 / 白场（输出色阶）数字本身就能直接左右拖；
 *   ② 直方图下方画三根可拖手柄（黑 / 灰 / 白），灰场手柄按伽马系数定位；
 *   ③ 直方图手柄与顶部数字双向联动——拖手柄顶上数字跟着变，拖数字手柄跟着走；
 *   ④ 去掉了原来那套和顶上数字重复的底部黑场滑杆。
 *
 * 所有改动都只走父层给的 setParam / commit：拖动中走 setParam（实时预览，不写历史），
 * 松手才 commit 写进撤销栈，和调整图层其它参数一个套路。
 */
import { useEffect, useRef, useState } from "react";
import { computeHistogram, type HistStats } from "./HistogramPanel";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 灰度系数（%，10–300）⇄ 中间调在输入轴上的位置。 */
function gammaMid(ib: number, iw: number, g: number): number {
  const span = Math.max(1, iw - ib);
  return ib + span * Math.pow(0.5, g / 100);
}
function gammaFromMid(ib: number, iw: number, t: number): number {
  const span = Math.max(1, iw - ib);
  const ratio = clamp((t - ib) / span, 0.02, 0.98);
  const g = (100 * Math.log(0.5)) / Math.log(ratio);
  return clamp(g, 10, 300);
}

type DragKey = "black" | "white" | "gamma" | "outBlack" | "outWhite";

interface LevelsEditorProps {
  id: "levels" | "channellevels";
  params: Record<string, number>;
  source: HTMLCanvasElement | null;
  version: number;
  setParam: (id: string, value: number) => void;
  commit: () => void;
}

const CHANNEL_COLOR: Record<"r" | "g" | "b" | "lum", [number, number, number]> = {
  lum: [111, 192, 255],
  r: [255, 92, 92],
  g: [92, 220, 120],
  b: [110, 170, 255],
};

export default function LevelsEditor({
  id,
  params,
  source,
  version,
  setParam,
  commit,
}: LevelsEditorProps) {
  const isChannel = id === "channellevels";
  const [ch, setCh] = useState<"r" | "g" | "b">("r");

  const blackKey = isChannel ? `${ch}Black` : "inBlack";
  const whiteKey = isChannel ? `${ch}White` : "inWhite";
  const gammaKey = isChannel ? `${ch}Gamma` : "gamma";
  const hasOutput = !isChannel;

  const black = params[blackKey] ?? 0;
  const white = params[whiteKey] ?? 255;
  const gamma = params[gammaKey] ?? 100;
  const outBlack = hasOutput ? params.outBlack ?? 0 : 0;
  const outWhite = hasOutput ? params.outWhite ?? 255 : 255;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const outRef = useRef<HTMLCanvasElement | null>(null);
  const binsRef = useRef<HistStats | null>(null);
  const dragRef = useRef<{ key: DragKey; value: number } | null>(null);
  const [, force] = useState(0);

  // 直方图数据：合成结果变化时重算一次，存 ref，拖动期间不反复统计
  useEffect(() => {
    binsRef.current = source ? computeHistogram(source) : null;
    force((n) => n + 1);
  }, [source, version]);

  // 每次渲染都重画（拖动时靠 force 触发，参数变化也走这里）——画布小，开销可忽略
  useEffect(() => {
    const c = canvasRef.current;
    if (c) {
      drawHistogram(
        c,
        binsRef.current,
        black,
        white,
        gamma,
        isChannel ? ch : "lum",
      );
    }
    if (hasOutput && outRef.current) drawOutput(outRef.current, outBlack, outWhite);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  /** 有效值：拖动中的那一根用手柄的实时量，保证拇指压在指尖下。 */
  const eff = (k: DragKey) =>
    dragRef.current && dragRef.current.key === k ? dragRef.current.value : null;
  const vBlack = eff("black") ?? black;
  const vWhite = eff("white") ?? white;
  const vGamma = eff("gamma") ?? gamma;
  const vOutBlack = eff("outBlack") ?? outBlack;
  const vOutWhite = eff("outWhite") ?? outWhite;

  const apply = (k: DragKey, value: number) => {
    dragRef.current = { key: k, value };
    setParam(
      k === "black" ? blackKey : k === "white" ? whiteKey : k === "gamma" ? gammaKey : k,
      Math.round(value),
    );
    force((n) => n + 1);
  };

  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    commit();
    force((n) => n + 1);
  };

  const onHistDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const W = rect.width || 1;
    const xb = (vBlack / 255) * W;
    const xw = (vWhite / 255) * W;
    const xg = (gammaMid(vBlack, vWhite, vGamma) / 255) * W;
    const cand: [DragKey, number][] = [
      ["black", Math.abs(x - xb)],
      ["white", Math.abs(x - xw)],
      ["gamma", Math.abs(x - xg)],
    ];
    cand.sort((a, b) => a[1] - b[1]);
    if (cand[0][1] > 18) return; // 离三根手柄都远：不当作拖手柄
    const key = cand[0][0];
    c.setPointerCapture(e.pointerId);
    const val =
      key === "black"
        ? clamp((x / W) * 255, 0, vWhite - 1)
        : key === "white"
          ? clamp((x / W) * 255, vBlack + 1, 255)
          : gammaFromMid(vBlack, vWhite, (x / W) * 255);
    apply(key, val);
  };

  const onHistMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    const c = canvasRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const W = rect.width || 1;
    const key = dragRef.current.key;
    const val =
      key === "black"
        ? clamp((x / W) * 255, 0, vWhite - 1)
        : key === "white"
          ? clamp((x / W) * 255, vBlack + 1, 255)
          : gammaFromMid(vBlack, vWhite, (x / W) * 255);
    apply(key, val);
  };

  const onOutDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = outRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const W = rect.width || 1;
    const xb = (vOutBlack / 255) * W;
    const xw = (vOutWhite / 255) * W;
    const cand: [DragKey, number][] = [
      ["outBlack", Math.abs(x - xb)],
      ["outWhite", Math.abs(x - xw)],
    ];
    cand.sort((a, b) => a[1] - b[1]);
    if (cand[0][1] > 18) return;
    const key = cand[0][0];
    c.setPointerCapture(e.pointerId);
    apply(key, clamp((x / W) * 255, 0, key === "outBlack" ? vOutWhite - 1 : 255));
  };

  const onOutMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    const c = outRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const W = rect.width || 1;
    const key = dragRef.current.key;
    const val =
      key === "outBlack"
        ? clamp((x / W) * 255, 0, vOutWhite - 1)
        : clamp((x / W) * 255, vOutBlack + 1, 255);
    apply(key, val);
  };

  return (
    <div className="ly-levels">
      {isChannel && (
        <div className="lv-tabs">
          {(["r", "g", "b"] as const).map((c) => (
            <button
              key={c}
              type="button"
              className={ch === c ? "lv-tab is-on" : "lv-tab"}
              style={ch === c ? ({ "--lv-hue": `rgb(${CHANNEL_COLOR[c].join(",")})` } as React.CSSProperties) : undefined}
              onClick={() => setCh(c)}
            >
              {c === "r" ? "红" : c === "g" ? "绿" : "蓝"}
            </button>
          ))}
        </div>
      )}

      {/* 顶部数字：直接左右拖改值，和直方图手柄双向联动 */}
      <div className="lv-top">
        <DraggableNum label="黑场" value={vBlack} min={0} max={254} onChange={(v) => apply("black", v)} onCommit={endDrag} />
        <DraggableNum label="灰场" value={vGamma} min={10} max={300} suffix="%" onChange={(v) => apply("gamma", v)} onCommit={endDrag} />
        <DraggableNum label="白场" value={vWhite} min={1} max={255} onChange={(v) => apply("white", v)} onCommit={endDrag} />
      </div>

      <canvas
        ref={canvasRef}
        className="lv-hist"
        onPointerDown={onHistDown}
        onPointerMove={onHistMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />

      {hasOutput && (
        <>
          <div className="lv-out-top">
            <DraggableNum label="输出黑" value={vOutBlack} min={0} max={254} onChange={(v) => apply("outBlack", v)} onCommit={endDrag} />
            <DraggableNum label="输出白" value={vOutWhite} min={1} max={255} onChange={(v) => apply("outWhite", v)} onCommit={endDrag} />
          </div>
          <canvas
            ref={outRef}
            className="lv-out"
            onPointerDown={onOutDown}
            onPointerMove={onOutMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
        </>
      )}
    </div>
  );
}

/* ---------------- 顶部可拖数字 ---------------- */

function DraggableNum({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (v: number) => void;
  onCommit: () => void;
}) {
  const [local, setLocal] = useState(value);
  const drag = useRef<{ x: number; v: number } | null>(null);

  // 没在拖时，外部值才是事实来源（撤销回退、切通道、切预设都要跟上）
  useEffect(() => {
    if (!drag.current) setLocal(value);
  }, [value]);

  return (
    <div className="lv-num">
      <span className="lv-num-label">{label}</span>
      <span
        className="lv-num-val"
        title="左右拖动改值"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, v: value };
          (e.target as Element).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const dx = e.clientX - drag.current.x;
          const nv = clamp(drag.current.v + dx, min, max);
          setLocal(nv);
          onChange(nv);
        }}
        onPointerUp={(e) => {
          if (!drag.current) return;
          drag.current = null;
          (e.target as Element).releasePointerCapture?.(e.pointerId);
          onCommit();
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {Math.round(local)}
        {suffix ?? ""}
      </span>
    </div>
  );
}

/* ---------------- 画直方图 + 手柄 ---------------- */

function drawHistogram(
  c: HTMLCanvasElement,
  bins: HistStats | null,
  ib: number,
  iw: number,
  g: number,
  channel: "r" | "g" | "b" | "lum",
) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = c.clientWidth || 240;
  const cssH = c.clientHeight || 110;
  c.width = Math.max(1, Math.round(cssW * dpr));
  c.height = Math.max(1, Math.round(cssH * dpr));
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cssW;
  const H = cssH;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "rgba(128,128,140,0.08)";
  ctx.fillRect(0, 0, W, H);

  if (!bins) {
    ctx.fillStyle = "rgba(140,140,150,0.55)";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("暂无数据", W / 2, H / 2 + 4);
    return;
  }

  const arr = channel === "lum" ? bins.lum : bins[channel];
  const sorted = Array.from(arr).filter((v) => v > 0).sort((a, b) => a - b);
  const p99 = sorted.length ? sorted[Math.floor(sorted.length * 0.99)] : 1;
  const peak = Math.max(1, Math.min(bins.max, p99 || bins.max));

  // 柱体（灰填充）
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let i = 0; i < 256; i += 1) {
    const x = (i / 255) * W;
    const y = H - Math.min(1, arr[i] / peak) * (H - 4);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fillStyle = "rgba(140,140,155,0.42)";
  ctx.fill();

  // 通道色描边
  const col = CHANNEL_COLOR[channel];
  ctx.beginPath();
  for (let i = 0; i < 256; i += 1) {
    const x = (i / 255) * W;
    const y = H - Math.min(1, arr[i] / peak) * (H - 4);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},0.95)`;
  ctx.lineWidth = 1.3;
  ctx.stroke();

  // 黑 / 白场参考线
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(30,30,40,0.55)";
  drawVLine(ctx, (Math.max(0, Math.min(255, ib)) / 255) * W, H);
  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  drawVLine(ctx, (Math.max(0, Math.min(255, iw)) / 255) * W, H);
  ctx.setLineDash([]);

  // 三手柄：黑（下三角）、白（上三角）、灰（菱形）
  const xb = (Math.max(0, Math.min(255, ib)) / 255) * W;
  const xw = (Math.max(0, Math.min(255, iw)) / 255) * W;
  const xg = (Math.max(0, Math.min(255, gammaMid(ib, iw, g))) / 255) * W;
  drawHandle(ctx, xb, H, "black");
  drawHandle(ctx, xw, H, "white");
  drawHandle(ctx, xg, H, "gamma");
}

function drawVLine(ctx: CanvasRenderingContext2D, x: number, H: number) {
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, H);
  ctx.stroke();
}

function drawHandle(
  ctx: CanvasRenderingContext2D,
  x: number,
  H: number,
  kind: "black" | "white" | "gamma",
) {
  const s = 6;
  if (kind === "gamma") {
    ctx.fillStyle = "rgba(111,192,255,1)";
    ctx.strokeStyle = "rgba(20,30,40,0.6)";
    ctx.beginPath();
    ctx.moveTo(x, H - 14 - s);
    ctx.lineTo(x + s, H - 14);
    ctx.lineTo(x, H - 14 + s);
    ctx.lineTo(x - s, H - 14);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    return;
  }
  ctx.fillStyle = kind === "black" ? "rgba(30,30,40,0.95)" : "rgba(255,255,255,0.95)";
  ctx.strokeStyle = "rgba(111,192,255,0.9)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  if (kind === "black") {
    ctx.moveTo(x, H);
    ctx.lineTo(x - s, H - 11);
    ctx.lineTo(x + s, H - 11);
  } else {
    ctx.moveTo(x, H - 11);
    ctx.lineTo(x - s, H);
    ctx.lineTo(x + s, H);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

/* ---------------- 输出色阶小条 ---------------- */

function drawOutput(c: HTMLCanvasElement, ob: number, ow: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = c.clientWidth || 240;
  const cssH = c.clientHeight || 20;
  c.width = Math.max(1, Math.round(cssW * dpr));
  c.height = Math.max(1, Math.round(cssH * dpr));
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cssW;
  const H = cssH;

  ctx.clearRect(0, 0, W, H);
  // 输出斜坡：从输出黑（左）到输出白（右）的灰阶
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, `rgb(${Math.round((ob / 255) * 255)},${Math.round((ob / 255) * 255)},${Math.round((ob / 255) * 255)})`);
  grad.addColorStop(1, `rgb(${Math.round((ow / 255) * 255)},${Math.round((ow / 255) * 255)},${Math.round((ow / 255) * 255)})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H - 2);

  // 两端手柄
  const xb = (Math.max(0, Math.min(255, ob)) / 255) * W;
  const xw = (Math.max(0, Math.min(255, ow)) / 255) * W;
  for (const [x, dark] of [
    [xb, true],
    [xw, false],
  ] as [number, boolean][]) {
    ctx.fillStyle = dark ? "rgba(30,30,40,0.95)" : "rgba(255,255,255,0.95)";
    ctx.strokeStyle = "rgba(111,192,255,0.9)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x, H - 2);
    ctx.lineTo(x - 5, H - 11);
    ctx.lineTo(x + 5, H - 11);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}
