/**
 * 模糊画廊的画布钉点覆盖层（PhotoCraft blur_pins.rs 的交互层）。
 *
 * 为什么单独一层、和 GradeWindowOverlay 同构：
 *  · SVG 放进 .editor-stage，坐标天然是文档坐标，跟着画布缩放/平移；
 *  · 手柄半径按 1/scale 折算，屏幕上恒定好抓；
 *  · 只负责画和转发指针，几何/命中/参数映射全在 core/blurPins.ts 纯函数里。
 *
 * 交互：拖中心圆点移动钉点；选中有环的滤镜（Iris/Spin）后，拖右侧方形手柄
 * 调清晰区半径；点空白处新增钉点（Field/Iris 多钉）；Delete 删选中钉。
 * 拖动中只更新本地 live 状态（即时跟手），松手才把最终钉点交给外壳落库。
 */
import { useRef, useState } from "react";
import {
  fromDoc,
  hitPin,
  shortSide,
  toDoc,
  type BlurPin,
  type Bounds,
  type Pt2,
} from "../../core/blurPins";
import "./BlurGalleryOverlay.css";

interface Props {
  docW: number;
  docH: number;
  scale: number;
  pins: BlurPin[];
  selected: number;
  /** 是否显示「清晰区半径」环手柄（Iris/Spin） */
  showRing: boolean;
  /** 拖动中（live=true）与松手都回调；外壳据此预览/落库 */
  onChange: (pins: BlurPin[], selected: number, commit: boolean) => void;
}

export default function BlurGalleryOverlay({
  docW,
  docH,
  scale,
  pins,
  selected,
  showRing,
  onChange,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [live, setLive] = useState<BlurPin[] | null>(null);
  const drag = useRef<{
    idx: number;
    kind: "center" | "radius";
    start: BlurPin;
  } | null>(null);
  const cur = live ?? pins;
  const bounds: Bounds = [0, 0, docW, docH];
  const knob = 7 / Math.max(0.05, scale);
  const stroke = 1.5 / Math.max(0.05, scale);

  /** 屏幕事件 → 文档坐标（SVG 与画布同变换，用 boundingRect 换算即可）。 */
  const toDocPt = (e: React.PointerEvent): Pt2 => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / Math.max(1, r.width)) * docW,
      y: ((e.clientY - r.top) / Math.max(1, r.height)) * docH,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const at = toDocPt(e);
    // 优先命中已选中钉点的手柄（环 > 中心）
    let grabbed: { idx: number; kind: "center" | "radius" } | null = null;
    if (selected >= 0 && selected < cur.length) {
      const k = hitPin(bounds, cur[selected], at, scale, true);
      if (k === "radius") grabbed = { idx: selected, kind: "radius" };
      else if (k === "center") grabbed = { idx: selected, kind: "center" };
    }
    if (!grabbed) {
      // 再试其它钉点
      for (let i = 0; i < cur.length; i += 1) {
        const k = hitPin(bounds, cur[i], at, scale, false);
        if (k === "center") { grabbed = { idx: i, kind: "center" }; break; }
      }
    }
    if (!grabbed) {
      // 点空白：新增钉点（受外壳 maxPins 限制由外壳裁剪）
      const np = fromDoc(bounds, at);
      const fresh: BlurPin = { ...cur[0], x: np.x, y: np.y };
      const next = [...cur, fresh];
      setLive(next);
      onChange(next, next.length - 1, false);
      drag.current = { idx: next.length - 1, kind: "center", start: fresh };
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    drag.current = { ...grabbed, start: cur[grabbed.idx] };
    onChange(cur, grabbed.idx, false); // 通知外壳更新选中项
    (e.target as Element).setPointerCapture?.(e.pointerId);
    e.stopPropagation();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const at = toDocPt(e);
    const next = [...(live ?? cur)];
    const p = { ...d.start };
    if (d.kind === "center") {
      const np = fromDoc(bounds, at);
      p.x = np.x;
      p.y = np.y;
    } else {
      // 环手柄：到中心的距离 / 短边 = 新半径
      const c = toDoc(bounds, d.start);
      const dist = Math.hypot(at.x - c.x, at.y - c.y);
      p.radius = Math.max(0.02, Math.min(1, dist / shortSide(bounds)));
    }
    next[d.idx] = p;
    setLive(next);
    onChange(next, d.idx, false);
    e.stopPropagation();
  };

  const onPointerUp = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const final = live ?? cur;
    setLive(null);
    onChange(final, d.idx, true);
  };

  return (
    <svg
      ref={svgRef}
      className="bgo"
      viewBox={`0 0 ${docW} ${docH}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {cur.map((p, i) => {
        const c = toDoc(bounds, p);
        const r = p.radius * shortSide(bounds);
        const isSel = i === selected;
        return (
          <g key={i} className={isSel ? "bgo-pin is-sel" : "bgo-pin"}>
            {showRing && isSel && (
              <>
                <circle cx={c.x} cy={c.y} r={r} className="bgo-ring" strokeWidth={stroke} />
                <rect
                  x={c.x + r - knob} y={c.y - knob}
                  width={knob * 2} height={knob * 2}
                  className="bgo-handle"
                />
              </>
            )}
            <circle cx={c.x} cy={c.y} r={knob} className="bgo-dot" strokeWidth={stroke} />
            <text x={c.x + knob * 1.8} y={c.y - knob * 1.2} className="bgo-label" fontSize={knob * 2}>
              {i + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
