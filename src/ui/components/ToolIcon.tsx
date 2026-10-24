/**
 * 工具图标。
 *
 * 全部是 24×24 线性图标，线宽、端点、圆角统一，只用 currentColor 上色 ——
 * 这样选中态只需要改文字色，不必维护两套图形。
 * 不引第三方图标库：图标数量少、形状简单，自己画反而更整齐。
 */
import type { ReactNode } from "react";
import type { ToolId } from "../../tools/catalog";

/** 工具图标之外，界面里偶尔还需要几个通用图标（如「设置」）。 */
export type IconId = ToolId | "gear";

interface Props {
  id: IconId;
  size?: number;
}

/** 统一的外层属性，避免每个图标各写一遍。 */
const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const PATHS: Record<IconId, ReactNode> = {
  // 四向箭头
  move: (
    <g {...stroke}>
      <path d="M12 3v18M3 12h18" />
      <path d="M12 3 9.5 5.8M12 3l2.5 2.8M12 21l-2.5-2.8M12 21l2.5-2.8" />
      <path d="M3 12l2.8-2.5M3 12l2.8 2.5M21 12l-2.8-2.5M21 12l-2.8 2.5" />
    </g>
  ),
  // 矩形选框
  marquee: (
    <g {...stroke} strokeDasharray="3.4 2.6">
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
    </g>
  ),
  // 椭圆选框
  ellipse: (
    <g {...stroke} strokeDasharray="3.4 2.6">
      <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />
    </g>
  ),
  // 套索
  lasso: (
    <g {...stroke}>
      <path d="M12 4.6c-4.6 0-8.3 2.6-8.3 5.9s3.7 5.9 8.3 5.9 8.3-2.6 8.3-5.9S16.6 4.6 12 4.6Z" />
      <path d="M9 16.3c-1 1-1.4 2.3-1 3.4" />
      <path d="M8 19.7c.6.9 2 .9 2.7.2" />
    </g>
  ),
  // 多边形套索：折线闭合 + 顶点圆点
  polyLasso: (
    <g {...stroke} strokeDasharray="3 2.4">
      <path d="M4.5 8 15 4.5l4.5 8.5-6.5 7-8.5-4.5Z" />
    </g>
  ),
  // 单行选框：横贯全宽的一根虚线选区，上下两个小箭头示意可拖
  singleRow: (
    <g {...stroke} strokeDasharray="3 2.4">
      <path d="M3.5 12h17" />
    </g>
  ),
  // 单列选框：纵贯全高
  singleColumn: (
    <g {...stroke} strokeDasharray="3 2.4">
      <path d="M12 3.5v17" />
    </g>
  ),
  // 魔棒
  wand: (
    <g {...stroke}>
      <path d="M5 19.4 15.2 9.2" />
      <path d="M14.6 8.6l1.9-1.9a1.5 1.5 0 0 0-2.1-2.1l-1.9 1.9" />
      <path d="M18.6 3.6v3.2M17 5.2h3.2M19.4 13.6v2.6M18.1 14.9h2.6" />
    </g>
  ),
  // 裁剪
  crop: (
    <g {...stroke}>
      <path d="M7 3.5v13.5h13.5" />
      <path d="M3.5 7H17v13.5" />
    </g>
  ),
  // 取色器（吸管）：细长的滴管 —— 顶端圆胶囊、中段细管、末端一个短尖嘴。
  // 在竖直坐标系里画好再整体斜置 45°，胶囊与管身天然对齐，不会浮空错位。
  // 关键特征是「窄」：最宽处只有胶囊那 5 个单位，与旁边宽扁的画笔轮廓截然不同。
  eyedropper: (
    <g {...stroke} transform="rotate(45 12 12)">
      <rect x="9.5" y="3.4" width="5" height="4.9" rx="2.5" />
      <path d="M10.7 8.3v6.1M13.3 8.3v6.1" />
      <path d="M10.7 14.4 12 20.4 13.3 14.4" />
    </g>
  ),
  // 画笔：宽扁的排笔 —— 细笔杆、宽金属箍、扇形张开的笔毫，收成平齐的软边。
  // 最宽处有 6.4 个单位、是吸管的一倍多，还带一道分毫线，
  // 轮廓上就与「细长带囊」的吸管分得很开，不会再被当成取色器。
  brush: (
    <g {...stroke} transform="rotate(45 12 12)">
      <rect x="10.9" y="2.2" width="2.2" height="5.4" rx="0.6" />
      <rect x="8.8" y="7.6" width="6.4" height="2.6" rx="0.6" />
      <path d="M8.8 10.2h6.4l-1 8.6a1.6 1.6 0 0 1-1.6 1.3h-1.2a1.6 1.6 0 0 1-1.6-1.3Z" />
      <path d="M12 10.2v9.9" />
    </g>
  ),
  // 橡皮
  eraser: (
    <g {...stroke}>
      <path d="M4.7 15.6l6-6a1.7 1.7 0 0 1 2.4 0l4 4a1.7 1.7 0 0 1 0 2.4l-4.2 4.2H9.1l-4.4-4.4a1.7 1.7 0 0 1 0-2.2Z" />
      <path d="M8.5 20.2h11.3" />
    </g>
  ),
  // 魔术橡皮：橡皮 + 魔棒闪光
  magicEraser: (
    <g {...stroke}>
      <path d="M4.2 14.9l5.2-5.2a1.5 1.5 0 0 1 2.1 0l3.5 3.5a1.5 1.5 0 0 1 0 2.1l-3.7 3.7H7.9l-3.7-3.7a1.5 1.5 0 0 1 0-2.1Z" />
      <path d="M8.1 18.7h9.9" />
      <path d="M16.6 3.4v3M15.1 4.9h3M20 9.2v2.4M18.8 10.4h2.4" />
    </g>
  ),
  // 铅笔：斜置的削尖铅笔
  pencil: (
    <g {...stroke} transform="rotate(45 12 12)">
      <path d="M10.6 3.4h2.8v3.4h-2.8z" />
      <path d="M10.6 6.8h2.8v9.6l-1.4 4-1.4-4Z" />
      <path d="M10.6 13h2.8" />
    </g>
  ),
  // 油漆桶
  bucket: (
    <g {...stroke}>
      <path d="M5.2 12.4 11.6 6l6.1 6.1-6.4 6.4a1.6 1.6 0 0 1-2.2 0l-3.9-3.9a1.6 1.6 0 0 1 0-2.2Z" />
      <path d="M9.2 4.4 7.1 6.5" />
      <path d="M19.6 15.2c0 1.1-.9 2-2 2s-2-.9-2-2 2-3.6 2-3.6 2 2.5 2 3.6Z" />
    </g>
  ),
  // 渐变
  gradient: (
    <g {...stroke}>
      <rect x="3.5" y="6.5" width="17" height="11" rx="1.5" />
      <path d="M7 9.5h2.6v5H7z" opacity="0.28" fill="currentColor" stroke="none" />
      <path d="M11 9.5h2.6v5H11z" opacity="0.55" fill="currentColor" stroke="none" />
      <path d="M15 9.5h2.6v5H15z" opacity="0.85" fill="currentColor" stroke="none" />
    </g>
  ),
  // 仿制图章：印章
  clone: (
    <g {...stroke}>
      <rect x="9.4" y="3.4" width="5.2" height="4.6" rx="1.1" />
      <path d="M7.2 8h9.6l2.4 4.4a1 1 0 0 1-.9 1.5H5.7a1 1 0 0 1-.9-1.5L7.2 8Z" />
      <path d="M5 17.6h14" />
    </g>
  ),
  // 修复画笔：创可贴
  heal: (
    <g {...stroke} transform="rotate(-45 12 12)">
      <rect x="3.2" y="8.5" width="17.6" height="7" rx="3.5" />
      <circle cx="12" cy="12" r="1.9" />
    </g>
  ),
  // 模糊：水滴
  blur: (
    <g {...stroke}>
      <path d="M12 3.4c3.3 4 5.4 6.9 5.4 9.4a5.4 5.4 0 0 1-10.8 0c0-2.5 2.1-5.4 5.4-9.4Z" />
      <path d="M9.3 13.1a2.8 2.8 0 0 0 2.7 3.2" />
    </g>
  ),
  // 锐化：尖峰
  sharpen: (
    <g {...stroke}>
      <path d="M12 4.4 20.6 19.4H3.4L12 4.4Z" />
      <path d="M12 11.2v4.4" />
    </g>
  ),
  // 减淡：涂棒
  dodge: (
    <g {...stroke}>
      <circle cx="9.6" cy="9.6" r="5" />
      <path d="M13.3 13.3 20.4 20.4" />
    </g>
  ),
  // 加深：火苗
  burn: (
    <g {...stroke}>
      <path d="M12 3.6c.5 2.8 4.5 4.6 4.5 8.3a4.5 4.5 0 0 1-9 0c0-1.7.9-3.1 2.1-4.4.2 1 .6 1.8 1.4 2.3.3-2.3.7-4.2 1-6.2Z" />
    </g>
  ),
  // 海绵
  sponge: (
    <g {...stroke}>
      <path d="M4.6 9.4a2.4 2.4 0 0 1 2.4-2.4h10a2.4 2.4 0 0 1 2.4 2.4v3.4a4.4 4.4 0 0 1-4.4 4.4H9a4.4 4.4 0 0 1-4.4-4.4V9.4Z" />
      <circle cx="9.4" cy="12" r="1.1" />
      <circle cx="13.4" cy="10.8" r="0.85" />
      <circle cx="12.2" cy="14.6" r="0.85" />
    </g>
  ),

  // 矩形（形状工具）
  shapeRect: (
    <g {...stroke}>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
    </g>
  ),
  // 椭圆（形状工具）
  shapeEllipse: (
    <g {...stroke}>
      <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />
    </g>
  ),
  // 直线（形状工具）
  shapeLine: (
    <g {...stroke}>
      <path d="M4.2 19.8 19.8 4.2" />
      <circle cx="4.2" cy="19.8" r="1.5" />
      <circle cx="19.8" cy="4.2" r="1.5" />
    </g>
  ),

  // 文字：带衬线的「T」，横杠两端与竖笔末端都收一个小横，一眼区别于直线工具
  text: (
    <g {...stroke}>
      <path d="M5.2 5.6h13.6" />
      <path d="M5.2 5.6v2.2M18.8 5.6v2.2" />
      <path d="M12 5.6v12.8" />
      <path d="M9.3 18.4h5.4" />
    </g>
  ),

  // 抓手
  hand: (
    <g {...stroke}>
      <path d="M8.2 12.4V6.6a1.5 1.5 0 0 1 3 0v4.3" />
      <path d="M11.2 10.9V5.4a1.5 1.5 0 0 1 3 0v5.5" />
      <path d="M14.2 11V7.4a1.5 1.5 0 0 1 3 0V15c0 3.4-2.4 6.1-5.7 6.1h-.7c-2.1 0-3.8-1-4.9-2.7l-2.3-3.6a1.6 1.6 0 0 1 2.5-1.9l1 1.2" />
    </g>
  ),
  // 缩放
  zoom: (
    <g {...stroke}>
      <circle cx="11" cy="11" r="6.8" />
      <path d="M20.4 20.4 16 16" />
      <path d="M8.3 11h5.4M11 8.3v5.4" />
    </g>
  ),

  // 齿轮（偏好设置）
  gear: (
    <g {...stroke}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.6v2.2M12 19.2v2.2M21.4 12h-2.2M4.8 12H2.6M18.6 5.4l-1.6 1.6M7 17l-1.6 1.6M18.6 18.6 17 17M7 7 5.4 5.4" />
      <circle cx="12" cy="12" r="7.4" />
    </g>
  ),
};

export default function ToolIcon({ id, size = 20 }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[id]}
    </svg>
  );
}
