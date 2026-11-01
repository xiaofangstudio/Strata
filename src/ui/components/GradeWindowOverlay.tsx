/**
 * 调色范围的手柄覆盖层（达芬奇 Power Window 的交互层）。
 *
 * 为什么单独一层、而不是塞进编辑壳的画布指针逻辑：
 *   · 覆盖层是 SVG，直接放进 `.editor-stage` 就会跟着画布的缩放/平移一起变换，
 *     坐标天然是**文档坐标**，不用每处手算 scale；
 *   · 手柄大小按 1/scale 折算，屏幕上恒定好抓；
 *   · 命中测试、拖动状态都在这里，编辑壳那边只管把几何存下来。
 *
 * 拖动中只更新轮廓（即时跟手），蒙版重算按 100ms 节流 —— 整幅蒙版 + 模糊
 * 在 24MP 文档上是几十毫秒一次，每帧都算会直接卡死。
 */
import { useRef, useState } from "react";
import {
  dragWindow,
  hitHandle,
  windowHandles,
  type GradeWindow,
  type HandleId,
} from "../../core/gradeWindow";
import "./GradeWindowOverlay.css";

interface Props {
  docW: number;
  docH: number;
  /** 当前视图缩放（手柄尺寸按它折算，保证屏幕上恒定） */
  scale: number;
  win: GradeWindow;
  /** 拖动中（节流）与松手时都会调用；commit=false 表示只是预览 */
  onChange: (next: GradeWindow, commit: boolean) => void;
}

export default function GradeWindowOverlay({ docW, docH, scale, win, onChange }: Props) {
  const [live, setLive] = useState<GradeWindow | null>(null);
  const drag = useRef<{
    id: HandleId;
    from: GradeWindow;
    startX: number;
    startY: number;
    lastAt: number;
  } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const cur = live ?? win;
  const hs = windowHandles(cur, scale);
  const knob = 6 / Math.max(0.05, scale);
  const stroke = 1 / Math.max(0.05, scale);

  /** 屏幕坐标 → 文档坐标。 */
  const toDoc = (e: React.PointerEvent): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / Math.max(1, r.width)) * docW,
      y: ((e.clientY - r.top) / Math.max(1, r.height)) * docH,
    };
  };

  const begin = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = toDoc(e);
    const id = hitHandle(cur, p.x, p.y, scale);
    if (!id) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id, from: cur, startX: p.x, startY: p.y, lastAt: 0 };
  };

  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = toDoc(e);
    const next = dragWindow(d.id, d.from, p.x - d.startX, p.y - d.startY);
    setLive(next);
    // 节流：拖动中重算蒙版（羽化要大范围重建，不然会顿）
    const now = performance.now();
    if (now - d.lastAt > 100) {
      d.lastAt = now;
      onChange(next, false);
    }
  };

  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const next = live;
    setLive(null);
    if (next) onChange(next, true);
  };

  const path = (() => {
    if (cur.kind === "poly") {
      if (cur.points.length < 2) return "";
      return cur.points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ") + " Z";
    }
    return "";
  })();

  /** 羽化的参考轮廓：比本体往外扩 feather，虚线画一圈，提示"淡出到这儿"。 */
  const featherShape = (() => {
    const f = Math.max(0, cur.feather);
    if (f <= 0) return null;
    if (cur.kind === "ellipse") {
      return (
        <ellipse
          cx={cur.cx}
          cy={cur.cy}
          rx={cur.rx + f}
          ry={cur.ry + f}
          fill="none"
          strokeWidth={stroke}
          className="gwf-feather-edge"
        />
      );
    }
    if (cur.kind === "rect") {
      return (
        <rect
          x={cur.x - f}
          y={cur.y - f}
          width={cur.w + f * 2}
          height={cur.h + f * 2}
          fill="none"
          strokeWidth={stroke}
          className="gwf-feather-edge"
        />
      );
    }
    return null;
  })();

  return (
    <svg
      ref={svgRef}
      className="gwf"
      viewBox={`0 0 ${docW} ${docH}`}
      preserveAspectRatio="none"
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {featherShape}

      {cur.kind === "ellipse" && (
        <ellipse
          cx={cur.cx}
          cy={cur.cy}
          rx={cur.rx}
          ry={cur.ry}
          fill="none"
          strokeWidth={stroke}
          className="gwf-edge"
        />
      )}
      {cur.kind === "rect" && (
        <rect
          x={cur.x}
          y={cur.y}
          width={cur.w}
          height={cur.h}
          fill="none"
          strokeWidth={stroke}
          className="gwf-edge"
        />
      )}
      {cur.kind === "poly" && (
        <path d={path} fill="none" strokeWidth={stroke} className="gwf-edge" />
      )}

      {hs.map((h) => (
        <circle
          key={h.id}
          cx={h.x}
          cy={h.y}
          r={h.id === "move" ? knob * 0.9 : knob}
          className={h.id === "feather" ? "gwf-knob is-feather" : "gwf-knob"}
          strokeWidth={stroke * 1.4}
        >
          <title>{h.id === "feather" ? "拖动改羽化" : h.id === "move" ? "拖动移动范围" : "拖动改大小"}</title>
        </circle>
      ))}
    </svg>
  );
}
