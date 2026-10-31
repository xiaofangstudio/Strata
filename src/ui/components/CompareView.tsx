/**
 * 多文档对比视图（窗口 > 排列）。
 *
 * Strata 的编辑器是「单画布 + 标签页」，没有 MDI 子窗口。所以这里用**平铺预览**实现
 * 同一件事：把打开的每份文档合成成一张画布，按指定版式铺开，点哪块就切到哪份文档。
 *
 * 与 PS 的差别说清楚：PS 的平铺是活窗口，可以直接在每一格里画；这里每一格是
 * 「合成结果的实时快照」—— 改动会在提交后立即反映，但绘制仍然只发生在当前文档。
 * 对「并排比较几张图」这个主要用途来说足够，也不会为了多视图把整个编辑管线复制一遍。
 */
import { useEffect, useMemo, useRef } from "react";
import { composeDoc } from "../../engine/compositor";
import { createSurface } from "../../engine/surface";
import type { StrataDoc } from "../../core/document";
import { zh } from "../../i18n/zh-CN";
import "./CompareView.css";

export type CompareLayout =
  | "tileAllVertically"
  | "tileAllHorizontally"
  | "twoUpVertical"
  | "twoUpHorizontal"
  | "threeUpVertical"
  | "threeUpHorizontal"
  | "threeUpStacked"
  | "fourUp"
  | "sixUp"
  | "cascade";

interface Props {
  layout: CompareLayout;
  docs: StrataDoc[];
  activeId: string;
  /** 合成每前进一次就 +1，驱动重绘 */
  version: number;
  onActivate: (id: string) => void;
  onClose: () => void;
}

/** 版式 → 网格列数与最多显示几份。 */
function gridOf(layout: CompareLayout): { cols: number; max: number } {
  switch (layout) {
    case "tileAllVertically":
      return { cols: 1, max: 6 };
    case "tileAllHorizontally":
    case "twoUpHorizontal":
      return { cols: 2, max: 2 };
    case "twoUpVertical":
      return { cols: 1, max: 2 };
    case "threeUpVertical":
      return { cols: 3, max: 3 };
    case "threeUpHorizontal":
      return { cols: 1, max: 3 };
    case "threeUpStacked":
      return { cols: 2, max: 3 };
    case "fourUp":
      return { cols: 2, max: 4 };
    case "sixUp":
      return { cols: 3, max: 6 };
    case "cascade":
    default:
      return { cols: 1, max: 4 };
  }
}

const TITLE: Record<CompareLayout, string> = {
  tileAllVertically: "全部垂直拼贴",
  tileAllHorizontally: "全部水平拼贴",
  twoUpVertical: "双联垂直",
  twoUpHorizontal: "双联水平",
  threeUpVertical: "三联垂直",
  threeUpHorizontal: "三联水平",
  threeUpStacked: "三联堆叠",
  fourUp: "四联",
  sixUp: "六联",
  cascade: "层叠",
};

export default function CompareView({
  layout,
  docs,
  activeId,
  version,
  onActivate,
  onClose,
}: Props) {
  const { cols, max } = useMemo(() => gridOf(layout), [layout]);
  const shown = docs.slice(0, max);

  return (
    <div className="compare" role="dialog" aria-label={TITLE[layout]}>
      <header className="compare-head">
        <span className="compare-title">
          {TITLE[layout]} · {shown.length} 份文档
        </span>
        <span className="compare-hint">点任意一格切到那份文档 · Esc 退出对比</span>
        <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
          {zh.preferences.done}
        </button>
      </header>
      <div
        className={`compare-grid cols-${cols}${layout === "cascade" ? " is-cascade" : ""}`}
        style={layout === "cascade" ? undefined : undefined}
      >
        {shown.map((d, i) => (
          <ComparePane
            key={d.id}
            doc={d}
            active={d.id === activeId}
            version={version}
            offset={layout === "cascade" ? i * 28 : 0}
            onActivate={() => onActivate(d.id)}
          />
        ))}
        {docs.length > max && (
          <div className="compare-more">
            还有 {docs.length - max} 份没有显示（这个版式最多 {max} 份）
          </div>
        )}
      </div>
    </div>
  );
}

/** 单格：把一份文档合成成静态画布，按比例塞进格子。 */
function ComparePane({
  doc,
  active,
  version,
  offset,
  onActivate,
}: {
  doc: StrataDoc;
  active: boolean;
  version: number;
  offset: number;
  onActivate: () => void;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const surface = createSurface(doc.width, doc.height);
    composeDoc(doc, surface);
    canvas.width = doc.width;
    canvas.height = doc.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, doc.width, doc.height);
    ctx.drawImage(surface, 0, 0);
  }, [doc, version]);

  return (
    <button
      type="button"
      className={active ? "compare-pane is-active" : "compare-pane"}
      style={offset ? { marginTop: offset, marginLeft: offset } : undefined}
      onClick={onActivate}
      title={`${doc.name} · ${doc.width}×${doc.height}`}
    >
      <span className="compare-label">
        {doc.name}
        <span className="compare-size">
          {doc.width}×{doc.height}
        </span>
      </span>
      <span className="compare-canvas-wrap">
        <canvas ref={ref} className="compare-canvas" />
      </span>
    </button>
  );
}
