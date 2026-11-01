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
  centroidOf,
  dragWindow,
  hitHandle,
  quadEdgeFeathers,
  windowHandles,
  type GradeWindow,
  type HandleId,
  type Pt,
} from "../../core/gradeWindow";

/** 边的外法线（与内核同一套规则：指向远离质心的一侧）。 */
function outwardNormalOf(a: Pt, b: Pt, center: Pt): Pt {
  let nx = -(b.y - a.y);
  let ny = b.x - a.x;
  const len = Math.hypot(nx, ny) || 1;
  nx /= len;
  ny /= len;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  if ((center.x - mx) * nx + (center.y - my) * ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  return { x: nx, y: ny };
}
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


/** 一个箭头头的路径（尖在 p，方向 dir，长度 size）。 */
function arrowHead(p: { x: number; y: number }, dir: { x: number; y: number }, size: number): string {
  const len = Math.hypot(dir.x, dir.y) || 1;
  const ux = dir.x / len;
  const uy = dir.y / len;
  // 两条回勾：尖点两侧各偏 140°
  const back = (ang: number) => {
    const c = Math.cos(ang);
    const s2 = Math.sin(ang);
    return { x: p.x + (ux * c - uy * s2) * size, y: p.y + (ux * s2 + uy * c) * size };
  };
  const a = back((140 * Math.PI) / 180);
  const b = back((-140 * Math.PI) / 180);
  return `M${a.x} ${a.y} L${p.x} ${p.y} L${b.x} ${b.y}`;
}

/** 双箭头（表示"这条轴可以拉"）。 */
function doubleArrow(c: { x: number; y: number }, dir: { x: number; y: number }, size: number): string {
  const len = Math.hypot(dir.x, dir.y) || 1;
  const ux = dir.x / len;
  const uy = dir.y / len;
  const p1 = { x: c.x + ux * size, y: c.y + uy * size };
  const p2 = { x: c.x - ux * size, y: c.y - uy * size };
  return `${arrowHead(p1, dir, size * 0.7)} ${arrowHead(p2, { x: -ux, y: -uy }, size * 0.7)}`;
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
    if (cur.kind === "quad") {
      // 四条边各自的羽化各画一条偏移线
      const c = centroidOf(cur.points);
      const fe = quadEdgeFeathers(cur);
      return (
        <g>
          {cur.points.map((a, i) => {
            const b = cur.points[(i + 1) % 4];
            const n = outwardNormalOf(a, b, c);
            const f2 = fe[i];
            if (f2 < 0.5) return null;
            return (
              <line
                key={`fe${i}`}
                x1={a.x + n.x * f2}
                y1={a.y + n.y * f2}
                x2={b.x + n.x * f2}
                y2={b.y + n.y * f2}
                strokeWidth={stroke}
                className="gwf-feather-edge"
              />
            );
          })}
        </g>
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
      {cur.kind === "quad" && (
        <path
          d={cur.points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ") + " Z"}
          fill="none"
          strokeWidth={stroke}
          className="gwf-edge"
        />
      )}
      {cur.kind === "poly" && (
        <path d={path} fill="none" strokeWidth={stroke} className="gwf-edge" />
      )}

      {cur.kind === "line" && (
        <g>
          {(() => {
            const dx = cur.x2 - cur.x1;
            const dy = cur.y2 - cur.y1;
            const len = Math.hypot(dx, dy) || 1;
            const ux = dx / len;
            const uy = dy / len;
            // 法线：+n 一侧是"淡出到透明"，-n 一侧是全调
            const nx = -uy;
            const ny = ux;
            const mx = (cur.x1 + cur.x2) / 2;
            const my = (cur.y1 + cur.y2) / 2;
            const f = Math.max(1, cur.feather);
            const unit = 10 / Math.max(0.05, scale);
            const tip = { x: mx - nx * (unit * 2.6), y: my - ny * (unit * 2.6) };
            return (
              <>
                {/* 过渡带边界：淡出到这儿 */}
                <line
                  x1={cur.x1 + nx * f}
                  y1={cur.y1 + ny * f}
                  x2={cur.x2 + nx * f}
                  y2={cur.y2 + ny * f}
                  strokeWidth={stroke}
                  className="gwf-feather-edge"
                />
                <line
                  x1={cur.x1 - nx * f}
                  y1={cur.y1 - ny * f}
                  x2={cur.x2 - nx * f}
                  y2={cur.y2 - ny * f}
                  strokeWidth={stroke}
                  className="gwf-feather-edge"
                />
                {/* 渐变方向箭头：指向"被调色"的那一侧，别人一看就知道哪边受影响 */}
                <path
                  d={arrowHead(tip, { x: -nx, y: -ny }, unit * 1.3)}
                  fill="none"
                  strokeWidth={stroke * 1.4}
                  className="gwf-arrow"
                />
                <line
                  x1={mx}
                  y1={my}
                  x2={tip.x}
                  y2={tip.y}
                  strokeWidth={stroke}
                  className="gwf-arrow"
                />
                {/* 从线的中点拉一条虚线到羽化把手：说明那个浮着的点属于这条线 */}
                <line
                  x1={mx}
                  y1={my}
                  x2={mx + nx * Math.max(12, cur.feather)}
                  y2={my + ny * Math.max(12, cur.feather)}
                  strokeWidth={stroke}
                  className="gwf-leader"
                />
                {/* 端点画成箭头：明确"可以往两边拉" */}
                <path
                  d={arrowHead({ x: cur.x1, y: cur.y1 }, { x: -ux, y: -uy }, unit * 1.2)}
                  fill="none"
                  strokeWidth={stroke * 1.4}
                  className="gwf-arrow"
                />
                <path
                  d={arrowHead({ x: cur.x2, y: cur.y2 }, { x: ux, y: uy }, unit * 1.2)}
                  fill="none"
                  strokeWidth={stroke * 1.4}
                  className="gwf-arrow"
                />
              </>
            );
          })()}
          <line
            x1={cur.x1}
            y1={cur.y1}
            x2={cur.x2}
            y2={cur.y2}
            strokeWidth={stroke * 1.4}
            className="gwf-edge is-line"
          />
        </g>
      )}

      {/* 中心锚点：十字 + 圆点，比单纯一个圆点好认 */}
      {hs
        .filter((h) => h.id === "move")
        .map((h) => (
          <g key="anchor" className="gwf-anchor">
            <circle cx={h.x} cy={h.y} r={knob * 1.25} strokeWidth={stroke * 1.2} />
            <line x1={h.x - knob * 2.2} y1={h.y} x2={h.x + knob * 2.2} y2={h.y} strokeWidth={stroke} />
            <line x1={h.x} y1={h.y - knob * 2.2} x2={h.x} y2={h.y + knob * 2.2} strokeWidth={stroke} />
          </g>
        ))}

      {/* 浮在外面的把手用虚线连回形状 —— 否则看着像随手画上去的一个点 */}
      {(cur.kind === "ellipse" || cur.kind === "quad" || cur.kind === "poly") &&
        (() => {
          const anchorPt =
            cur.kind === "poly" || cur.kind === "quad" ? centroidOf(cur.points) : { x: cur.cx, y: cur.cy };
          const target = hs.find((h) => h.id === "rotate") ?? hs.find((h) => h.id === "feather");
          if (!target) return null;
          return (
            <line
              x1={anchorPt.x}
              y1={anchorPt.y}
              x2={target.x}
              y2={target.y}
              strokeWidth={stroke}
              className="gwf-leader"
            />
          );
        })()}

      {hs.map((h) =>
        // 线性：羽化把手画成双箭头（"拉它改淡出宽度"一眼可读，不再像个误画的点）
        cur.kind === "line" && h.id === "feather" ? (
          <g key={h.id}>
            {/* 箭头本身只有 1px 粗，抓不住 —— 底下垫一个透明的圆当命中区 */}
            <circle
              cx={h.x}
              cy={h.y}
              r={knob * 2.2}
              className="gwf-hit"
              style={{ cursor: "ns-resize" }}
            >
              <title>拖动改羽化（边缘淡出宽度）</title>
            </circle>
            <path
              d={doubleArrow(
                { x: h.x, y: h.y },
                { x: -(cur.y2 - cur.y1), y: cur.x2 - cur.x1 },
                knob * 1.6,
              )}
              fill="none"
              strokeWidth={stroke * 1.5}
              className="gwf-arrow"
            />
          </g>
        ) : (
          <circle
            key={h.id}
            cx={h.x}
            cy={h.y}
            r={h.id === "move" ? knob * 0.9 : knob}
            className={
              h.id === "feather"
                ? "gwf-knob is-feather"
                : h.id === "rotate"
                  ? "gwf-knob is-rotate"
                  : h.id === "move"
                    ? "gwf-knob is-move"
                    : "gwf-knob"
            }
            strokeWidth={stroke * 1.4}
          >
            <title>
              {h.id === "feather"
                ? "拖动改羽化（边缘淡出宽度）"
                : h.id === "rotate"
                  ? "拖动旋转"
                  : h.id === "move"
                    ? "拖动移动范围（这是锚点/中心）"
                    : h.id === "a" || h.id === "b"
                      ? "拖动改线段端点（可拉长、可转向）"
                      : "拖动改大小"}
            </title>
          </circle>
        ),
      )}
    </svg>
  );
}
