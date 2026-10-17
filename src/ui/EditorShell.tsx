/**
 * 编辑壳（M1）。
 *
 * 四区布局：左侧工具轨（工具直接可见）、中间「选项栏 + 画布视口」、
 * 右侧单列面板（图层 / 通道 / 路径）、底部状态栏；顶部为多文档标签页。
 * 命令面板（Ctrl+K）覆盖全部工具与菜单命令。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { zh } from "../i18n/zh-CN";
import {
  IMAGE_EXTENSIONS,
  encodePng,
  loadImage,
  readFileBytes,
  writeFileBytes,
} from "../engine/image";
import { quitApp, type AppInfo } from "../core/appInfo";
import {
  activeLayer,
  baseName,
  docFromBitmap,
  docFromBlank,
  type StrataDoc,
} from "../core/document";
import { DEFAULT_DPI, PRESETS } from "../core/presets";
import {
  addAdjustLayer,
  addLayer,
  applyAdjustToLayer,
  canShiftLayer,
  clipHasContent,
  clipSize,
  copyToClipboard,
  cropDocument,
  cutSelection,
  deleteSelection,
  duplicateLayer,
  fillSelection,
  flattenImage,
  groupLayers,
  mergeDown,
  moveLayer,
  pasteFromClipboard,
  placeRaster,
  removeLayer,
  resizeCanvas,
  resizeDocument,
  setSelection,
  translateLayer,
  trimToSelection,
  ungroupLayers,
} from "../core/layerOps";
import {
  applyFreeTransform,
  flipDocument,
  flipLayer,
  freeTransformSurface,
  initialFreeTransform,
  rotateDocument,
  rotateLayerHalf,
  transformCorners,
  type FreeTransform,
} from "../core/transform";
import { ADJUST_DEFS, adjustDef, newAdjustState, type AdjustId, type AdjustState } from "../core/layer";
import {
  combineSelection,
  contractSelection,
  ellipseMask,
  expandSelection,
  featherSelection,
  invertSelection,
  isSelectionEmpty,
  lassoMask,
  rectMask,
  selectAllMask,
  selectionBounds,
  wandMask,
  type Point,
  type SelectionMode,
} from "../core/selection";
import {
  DEFAULT_CHANNEL_VIS,
  applyChannelView,
  type ChannelId,
  type ChannelVis,
} from "../core/channels";
import { autoOn } from "../engine/auto";
import { composeDoc } from "../engine/compositor";
import { inpaint } from "../engine/inpaint";
import { asRaster, createRaster } from "../engine/raster";
import { cloneSurface, createSurface, mustCtx, readPixels, writePixels } from "../engine/surface";
import {
  DEFAULT_BRUSH,
  Stroke,
  floodFill,
  gradientFill,
  pickColor,
  type BrushSettings,
  type GradientStyle,
} from "../engine/paint";
import {
  DEFAULT_RETOUCH,
  RetouchStroke,
  needsSample,
  type RetouchMode,
  type RetouchSettings,
} from "../engine/retouch";
import {
  DEFAULT_SHAPE,
  constrainEnd,
  drawShape,
  shapeBounds,
  type ShapeKind,
  type ShapePaint,
  type ShapeSettings,
} from "../engine/shapes";
import {
  DEFAULT_TEXT,
  fontString,
  rasterizeText,
  type TextSettings,
} from "../engine/text";
import {
  TOOL_GROUPS,
  isRetouchTool,
  isSelectionTool,
  isShapeTool,
  isTextTool,
  toolByShortcut,
  toolsInGroup,
  usesBrush,
  type ToolGroupId,
  type ToolId,
} from "../tools/catalog";
import type { ThemeMode } from "../stores/theme";
import { setPrefs, toBrushPrefs, usePrefs } from "../stores/prefs";
import AppMenuBar, { type MenuGroup } from "./components/AppMenuBar";
import BrandMark from "./components/BrandMark";
import CommandPalette, { type Command } from "./components/CommandPalette";
import FilterGallery from "./components/FilterGallery";
import InfoModals, { type InfoModalKind } from "./components/InfoModals";
import ImageSizeDialog from "./components/ImageSizeDialog";
import ColorPanel from "./components/ColorPanel";
import LiquifyDialog from "./components/LiquifyDialog";
import LayersPanel from "./components/LayersPanel";
import OptionsBar from "./components/OptionsBar";
import BrushSettingsPanel from "./components/BrushSettingsPanel";
import Preferences from "./components/Preferences";
import StatusBar from "./components/StatusBar";
import ToolFlyout from "./components/ToolFlyout";
import ToolRail from "./components/ToolRail";
import { capturePointer } from "./pointer";
import "./EditorShell.css";

/* ------------------------------------------------------ 自由变换的手柄几何 */

/**
 * 八个手柄在单位矩形里的位置：0-3 是四角，4-7 是四边中点。
 * 前四项顺序与 transformCorners 一致（左上 → 右上 → 右下 → 左下）。
 */
const FREE_HANDLE_LOCALS: readonly [number, number][] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** 八个手柄的文档坐标（跟着旋转角走）。 */
function freeHandles(t: FreeTransform): Point[] {
  const hw = t.w / 2;
  const hh = t.h / 2;
  const c = Math.cos(t.angle);
  const s = Math.sin(t.angle);
  return FREE_HANDLE_LOCALS.map(([lx, ly]) => ({
    x: t.cx + lx * hw * c - ly * hh * s,
    y: t.cy + lx * hw * s + ly * hh * c,
  }));
}

/** 旋转手柄的文档坐标：顶边中点沿法线朝外推固定屏幕距离。 */
function freeRotateHandle(t: FreeTransform, scale: number): Point {
  const cs = transformCorners(t);
  const midTop = { x: (cs[0].x + cs[1].x) / 2, y: (cs[0].y + cs[1].y) / 2 };
  const gap = FREE_ROTATE_GAP / scale;
  return {
    x: midTop.x + Math.sin(t.angle) * gap,
    y: midTop.y - Math.cos(t.angle) * gap,
  };
}

/** 把文档坐标换算到「以中心为原点、未旋转」的局部坐标。 */
function freeLocal(t: FreeTransform, p: Point): Point {
  const dx = p.x - t.cx;
  const dy = p.y - t.cy;
  const c = Math.cos(t.angle);
  const s = Math.sin(t.angle);
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

/** 把局部坐标换算回文档坐标。 */
function freeWorld(t: FreeTransform, l: Point): Point {
  const c = Math.cos(t.angle);
  const s = Math.sin(t.angle);
  return { x: t.cx + l.x * c - l.y * s, y: t.cy + l.x * s + l.y * c };
}

/** 旋转手柄相对顶边中点的屏幕距离（像素） */
const FREE_ROTATE_GAP = 28;
/** 手柄的抓取半径与绘制边长（屏幕像素） */
const FREE_HANDLE_HIT = 12;
const FREE_HANDLE_SIZE = 7;

interface Props {
  /** 全部打开的文档，用于顶部标签页 */
  docs: StrataDoc[];
  /** 当前文档 */
  doc: StrataDoc;
  info: AppInfo | null;
  themeMode: ThemeMode;
  /** 由偏好设置切换主题 */
  onSetTheme: (m: ThemeMode) => void;
  onSelectDoc: (id: string) => void;
  onCloseDoc: (id: string) => void;
  /** 一次关掉全部分档标签（关闭全部文档） */
  onCloseAll: () => void;
  /** 打开一份新文档（打开图片 / 打开工程都走这里） */
  onOpenDoc: (doc: StrataDoc) => void;
  /** 落一步可撤销的改动 */
  onCommit: (next: StrataDoc, label: string) => void;
  /** 只改画面、不入栈 */
  onPreview: (next: StrataDoc) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** 历史面板要列的步骤名（从最早到最新，下标与撤销栈一一对应） */
  historyLabels: string[];
  /** 当前停在第几步；-1 表示栈还没建起来 */
  historyIndex: number;
  /** 历史面板点击某一步：直接跳到那一刻 */
  onHistoryJump: (index: number) => void;
  /** 撤销栈变更计数，仅用于驱动重渲染 */
  revision: number;
}

type WorkspaceId = "photo" | "paint";

const PAD = 56;
const MIN_SCALE = 0.02;
const MAX_SCALE = 16;
const ZOOM_STEP = 1.25;
const MAX_BRUSH = 500;
/** 裁剪框最小边长（像素）；比这更小当作误触，不裁 */
const CROP_MIN = 4;

const GROUP_LABEL: Record<ToolGroupId, string> = {
  transform: zh.tools.groupTransform,
  select: zh.tools.groupSelect,
  shape: zh.tools.groupShape,
  text: zh.tools.groupText,
  paint: zh.tools.groupPaint,
  retouch: zh.tools.groupRetouch,
  sample: zh.tools.groupSample,
  crop: zh.tools.groupCrop,
  nav: zh.tools.groupNav,
};

/** 形状工具 id → 绘制种类。 */
const SHAPE_KIND: Record<string, ShapeKind> = {
  shapeRect: "rect",
  shapeEllipse: "ellipse",
  shapeLine: "line",
};

/** 调整类型的族别顺序，与图层面板底部「fx」菜单保持一致。 */
const ADJUST_FAMILY_ORDER = ["tone", "color", "effect"] as const;

/** 指针压感：笔用真实压力，鼠标/触摸退回 0.5，保证笔触粗细稳定。 */
function pressureOf(pressure: number, pointerType: string): number {
  if (pointerType === "pen" && pressure > 0) return Math.min(1, pressure);
  if (pressure > 0 && pressure !== 0.5) return Math.min(1, pressure);
  return 0.5;
}

/** 修饰键临时接管选区组合方式（松开就回到选项条里选的那一档）。 */
function modeWithMods(shift: boolean, alt: boolean, fallback: SelectionMode): SelectionMode {
  if (shift && alt) return "intersect";
  if (shift) return "add";
  if (alt) return "subtract";
  return fallback;
}

function cursorOf(tool: ToolId, panning: boolean): string {
  if (panning) return "grab";
  switch (tool) {
    case "hand":
      return "grab";
    case "zoom":
      return "zoom-in";
    case "move":
      return "move";
    case "text":
      return "text";
    default:
      return "crosshair";
  }
}

/* ------------------------------------------------------- 一键调整（图像菜单） */

/** 按调整类型生成一份状态，params 用于覆盖默认值。 */
function preset(id: AdjustId, params: Record<string, number> = {}): AdjustState {
  const s = newAdjustState(id);
  return { ...s, params: { ...s.params, ...params } };
}

/**
 * 「图像 > 调整」的一键项。
 *
 * 与调整图层互补：那边是非破坏、可反复改参数；这边按一下当场改像素，
 * 对齐 PS 同名菜单。所以只挑「一眼能看出效果」的几种，不做参数对话框。
 */
const ADJUST_PRESETS: { label: string; state: AdjustState }[] = [
  { label: zh.menu.adjustBright, state: preset("bc", { brightness: 15 }) },
  { label: zh.menu.adjustContrast, state: preset("bc", { contrast: 25 }) },
  { label: zh.menu.adjustSaturate, state: preset("hs", { saturate: 25 }) },
  { label: zh.menu.adjustGray, state: preset("bw") },
  { label: zh.menu.adjustInvert, state: preset("invert") },
  { label: zh.menu.adjustThreshold, state: preset("threshold") },
  { label: zh.menu.adjustPosterize, state: preset("posterize") },
];

/**
 * 「图像 > 滤镜」的一键项：同样当场改像素。
 *
 * 只挑效果族里那几种「按一下就知道结果」的；名字直接取调整定义里的中文，
 * 不再另抄一份文案，免得两处对不上。
 */
const FILTER_PRESETS: { label: string; state: AdjustState }[] = (
  ["blur", "motionblur", "sharpen", "grain", "noise"] as const
).map((id) => ({ label: adjustDef(id).label, state: preset(id) }));

export default function EditorShell({
  docs,
  doc,
  info,
  themeMode,
  onSetTheme,
  onSelectDoc,
  onCloseDoc,
  onCloseAll,
  onOpenDoc,
  onCommit,
  onPreview,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  historyLabels,
  historyIndex,
  onHistoryJump,
}: Props) {
  const prefs = usePrefs();
  const [tool, setTool] = useState<ToolId>("move");
  const [workspace, setWorkspace] = useState<WorkspaceId>("photo");
  const [fg, setFg] = useState("#17171c");
  const [bg, setBg] = useState("#ffffff");
  /** 渐变类型：线性 / 径向 / 角度 / 对称 / 菱形 */
  const [gradientStyle, setGradientStyle] = useState<GradientStyle>("linear");
  /** 渐变反向：把起点色与终点色对调（不动全局前景 / 背景色） */
  const [gradientReverse, setGradientReverse] = useState(false);
  // 画笔参数沿用上次的取值（记在偏好设置里），颜色永远跟随前景色
  const [brush, setBrush] = useState<BrushSettings>(() => ({
    ...DEFAULT_BRUSH,
    ...prefs.brushDefaults,
  }));
  /** 修饰工具参数（仿制 / 修复 / 模糊 / 锐化 / 减淡 / 加深 / 海绵共用一套） */
  const [retouch, setRetouch] = useState<RetouchSettings>(DEFAULT_RETOUCH);
  /** 形状工具参数（填充 / 描边 / 线宽），矩形 / 椭圆 / 直线共用一套 */
  const [shape, setShape] = useState<ShapeSettings>(DEFAULT_SHAPE);
  /** 仿制 / 修复的取样点（Alt + 单击设定），null 表示还没取样 */
  const [anchor, setAnchor] = useState<Point | null>(null);
  const [tolerance, setTolerance] = useState(32);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [palette, setPalette] = useState(false);
  const [modal, setModal] = useState<InfoModalKind>(null);
  const [sizeDialog, setSizeDialog] = useState<"image" | "canvas" | null>(null);
  /** 滤镜库：左侧选滤镜、右侧拖参数，实时预览，确定才落盘进历史 */
  const [gallery, setGallery] = useState(false);
  /** 液化：面板内自己拖着涂，确定才把形变后的像素写回图层 */
  const [liquify, setLiquify] = useState(false);
  /** 视图 > 网格：纯装饰浮层，不影响像素，也不进历史 */
  const [showGrid, setShowGrid] = useState(false);
  /** 视图 > 标尺：同上，只是刻度条 */
  const [showRulers, setShowRulers] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  /** 画笔设置面板（F5）：一个面板里容纳 PhotoCraft 的全部笔刷 section */
  const [brushPanelOpen, setBrushPanelOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [spaceDown, setSpaceDown] = useState(false);
  /** 是否正在编辑蒙版（画笔落在蒙版上而不是图层像素上） */
  const [maskEdit, setMaskEdit] = useState(false);
  /**
   * 通道视图：哪些原色参与合成 + 当前单独查看哪个通道。
   * 与蒙版编辑态一样属于「看」而不是「改」—— 一个像素都不动、不进历史，
   * 切文档时一并复位，免得换一份图还停在偏色的画面上。
   */
  const [channelVis, setChannelVis] = useState<ChannelVis>(DEFAULT_CHANNEL_VIS);
  const [activeChannel, setActiveChannel] = useState<ChannelId>("rgb");
  /** 选区组合方式（选项条的四态：新建 / 添加 / 减去 / 交叉） */
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("new");
  /** 羽化半径（像素），矩形 / 椭圆 / 套索用 */
  const [feather, setFeather] = useState(0);
  /** 魔棒是否只取与落点相连的一片 */
  const [contiguous, setContiguous] = useState(true);
  /** 是否正在拉选区 / 裁剪框（驱动蚂蚁线浮层的动画只在拖动时开动） */
  const [selDragging, setSelDragging] = useState(false);
  /** 是否正在拖绘形状（驱动形状浮层的动画只在拖动时开动） */
  const [shapeDragging, setShapeDragging] = useState(false);
  /** 文字工具参数（字体 / 字号 / 行距 / 对齐 / 加粗斜体） */
  const [textSet, setTextSet] = useState<TextSettings>(DEFAULT_TEXT);
  /**
   * 正在输入的文本框：落点在文档坐标，value 是当前输入的内容。
   * 文字不改图层模型 —— 确认的一瞬间整段栅格化成像素，之后与画笔画的没两样，
   * 混合模式 / 图层样式 / 蒙版 / 选区全都照旧生效。
   */
  const [textEdit, setTextEdit] = useState<{ x: number; y: number; value: string } | null>(
    null,
  );
  /** 是否处于自由变换态（浮层画手柄框、Enter 应用 / Esc 取消） */
  const [freeActive, setFreeActive] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** 1:1 的合成结果（文档原生分辨率）。屏幕呈递与取色都读它，不读显示画布。 */
  const compRef = useRef<HTMLCanvasElement | null>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  /** 正在进行的笔画；抬笔前只做回显，不进图层 */
  const strokeRef = useRef<Stroke | null>(null);
  /** 正在进行的修饰笔画（仿制 / 修复 / 模糊 / 锐化 / 减淡 / 加深 / 海绵），同样是抬笔才落库 */
  const retouchRef = useRef<RetouchStroke | null>(null);
  /** 拖拽起点（文档坐标） */
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  /** 平移起点（屏幕坐标） */
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const gradRef = useRef<{
    from: { x: number; y: number };
    to: { x: number; y: number };
  } | null>(null);
  const moveRef = useRef({ dx: 0, dy: 0 });
  /** 正在拖的选区框 / 裁剪框；抬笔前只画浮层，不动文档 */
  const selRef = useRef<{
    tool: "marquee" | "ellipse" | "lasso" | "crop";
    a: Point;
    b: Point;
    points: Point[];
    /** 落笔那一刻定下的组合方式（抬笔时修饰键可能已经松了） */
    mode: SelectionMode;
  } | null>(null);
  /** 正在拖绘的形状；抬笔前只画浮层，不动文档 */
  const shapeRef = useRef<ShapePaint | null>(null);
  /**
   * 当前自由变换的参数；null 表示没在变换。
   * 拖动时只改这个 ref 并 scheduleRender()，不进 React 状态 ——
   * 与笔画 / 选区同一套「拖动不重渲染」的做法，手柄才跟得住手。
   */
  const freeTRef = useRef<FreeTransform | null>(null);
  /** 正在拖的自由变换：哪个手柄、按下时的起始参数与抓取点 */
  const freeDragRef = useRef<{
    mode: "move" | "scale" | "rotate";
    /** scale 用：手柄序号 0-7 */
    handle: number;
    start: FreeTransform;
    grab: Point;
  } | null>(null);
  /** 蚂蚁线与裁剪框的浮层画布 */
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  /** 跟随光标（笔尖圆圈 / 吸管取样环）：纯 DOM，直接改样式，不走 React 状态 */
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const cursorRingRef = useRef<HTMLDivElement | null>(null);
  const cursorSwatchRef = useRef<HTMLSpanElement | null>(null);
  const cursorHexRef = useRef<HTMLSpanElement | null>(null);
  /** 吸管是否按住不放（按住时连续取色，像 PS 一样拖着扫） */
  const pickingRef = useRef(false);
  /** 每份文档各自的缩放与平移，切标签页时还原 */
  const views = useRef(new Map<string, { scale: number; pan: { x: number; y: number } }>());

  const docId = doc.id;
  const docW = doc.width;
  const docH = doc.height;

  /* ---------------------------------------------------------------- 视图 */

  const fit = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const k = Math.min(
      (vp.clientWidth - PAD) / docW,
      (vp.clientHeight - PAD) / docH,
    );
    setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, k)));
    setPan({ x: 0, y: 0 });
  }, [docW, docH]);

  const zoom = useCallback((next: number) => {
    setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, next)));
  }, []);

  // 切换文档时还原它自己的视图；首次打开则适应窗口
  useEffect(() => {
    const saved = views.current.get(docId);
    if (saved) {
      setScale(saved.scale);
      setPan(saved.pan);
    } else {
      fit();
    }
  }, [docId, fit]);

  useEffect(() => {
    views.current.set(docId, { scale, pan });
  }, [docId, scale, pan]);

  // 活动图层没有蒙版、或切到别的文档时，退出蒙版编辑态
  useEffect(() => {
    if (!activeLayer(doc)?.mask) setMaskEdit(false);
  }, [doc]);

  // 切文档时退出蒙版编辑态，通道视图也回到完整彩色（视图态跟着文档走）
  useEffect(() => {
    setMaskEdit(false);
    setChannelVis(DEFAULT_CHANNEL_VIS);
    setActiveChannel("rgb");
  }, [docId]);

  /** 通道页回调：只改视图状态，不碰文档、不入历史。 */
  const pickChannel = useCallback((vis: ChannelVis, active: ChannelId) => {
    setChannelVis(vis);
    setActiveChannel(active);
  }, []);

  /* -------------------------------------------------------------- 画面渲染 */

  const render = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;

    const act = activeLayer(doc);
    const stroke = strokeRef.current;
    const rt = retouchRef.current;
    const moving = moveRef.current;
    const offset = moving.dx !== 0 || moving.dy !== 0;

    // 合成一律先落在「文档原生分辨率」的离屏画布上：图层样式、蒙版、调整
    // 滤镜都在同一套 1:1 像素语义下结算，屏幕与导出因此逐像素同源。
    let slot = compRef.current;
    if (!slot || slot.width !== docW || slot.height !== docH) {
      slot = createSurface(docW, docH);
      compRef.current = slot;
    }
    const comp = slot;

    /**
     * 呈递一帧到屏幕。
     *
     * 显示画布的 backing store 必须等于「设备像素数」：在高 DPI（Windows
     * 常见的 125% / 150%）或任何非整数缩放下，若把 1:1 的合成结果直接交给
     * 浏览器用 CSS 缩放去凑，细线与斜边会被双线性重采样出台阶状锯齿。
     * 这里按「缩放 × devicePixelRatio」整体重采样一次，并用 high 质量 ——
     * 缩得越小，越接近正确的区域平均，而不是漏采。
     *
     * 通道视图只是在最外层叠的一道「显示滤镜」：合成照旧，呈递完再按通道
     * 开关或单通道灰度改写屏幕像素。默认态直接返回，零开销。
     */
    const present = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(docW * scale * dpr));
      const h = Math.max(1, Math.round(docH * scale * dpr));
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
      const cx = mustCtx(c);
      cx.setTransform(1, 0, 0, 1, 0, 0);
      cx.globalAlpha = 1;
      cx.globalCompositeOperation = "source-over";
      cx.filter = "none";
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = "high";
      cx.clearRect(0, 0, w, h);
      cx.drawImage(comp, 0, 0, docW, docH, 0, 0, w, h);
      applyChannelView(c, channelVis, activeChannel);
    };

    // 自由变换进行中：把被变换的那一层换成「变换后的像素」再整档合成 ——
    // 浮层只画手柄框，屏幕上的画面就是按下 Enter 之后会得到的结果。
    const ft = freeTRef.current;
    if (ft) {
      const fi = doc.layers.findIndex((l) => l.id === ft.layerId);
      if (fi >= 0) {
        const base = doc.layers[fi];
        composeDoc(doc, comp, {
          index: fi,
          layer: { ...base, surface: freeTransformSurface(doc, ft) },
        });
        present();
        return;
      }
    }

    // 没有进行中的编辑：直接走与导出完全相同的合成路径（含蒙版与调整图层）。
    if (!act || (!stroke && !rt && !offset)) {
      composeDoc(doc, comp);
      present();
      return;
    }

    const at = doc.layers.findIndex((l) => l.id === act.id);

    // 修饰回显：结果画布本身就是「原图 + 已扫过的效果」的整层像素，
    // 覆盖率与选区都已在笔画面内结算完毕，直接换掉本层表面即可，无需再叠 globalAlpha。
    if (rt) {
      composeDoc(doc, comp, { index: at, layer: { ...act, surface: rt.result } });
      present();
      return;
    }

    // 在蒙版上画：把这一笔/这次位移叠到「本层蒙版的一张副本」上，
    // 再整层交给合成器，回显路径与最终结果完全一致。
    if (maskEdit && act.mask) {
      const mask = cloneSurface(act.mask);
      if (stroke) {
        const mctx = mustCtx(mask);
        mctx.save();
        mctx.globalAlpha = brush.opacity / 100;
        mctx.globalCompositeOperation =
          tool === "eraser" ? "destination-out" : "source-over";
        mctx.drawImage(stroke.buffer, 0, 0);
        mctx.restore();
      }
      composeDoc(doc, comp, { index: at, layer: { ...act, mask } });
      present();
      return;
    }

    // 在像素上画：先单独合到暂存画布，这样橡皮的 destination-out 只作用于本层，
    // 不会啃掉下面的图层。
    let scratch = scratchRef.current;
    if (!scratch || scratch.width !== docW || scratch.height !== docH) {
      scratch = createSurface(docW, docH);
      scratchRef.current = scratch;
    }
    const sctx = mustCtx(scratch);
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalAlpha = 1;
    sctx.globalCompositeOperation = "source-over";
    sctx.filter = "none";
    sctx.clearRect(0, 0, scratch.width, scratch.height);
    sctx.drawImage(act.surface, offset ? moving.dx : 0, offset ? moving.dy : 0);
    if (stroke) {
      sctx.save();
      sctx.globalAlpha = brush.opacity / 100;
      sctx.globalCompositeOperation =
        tool === "eraser" ? "destination-out" : "source-over";
      sctx.drawImage(stroke.buffer, 0, 0);
      sctx.restore();
    }
    composeDoc(doc, comp, { index: at, layer: { ...act, surface: scratch } });
    present();
  }, [doc, docW, docH, brush.opacity, tool, maskEdit, channelVis, activeChannel, scale]);

  useEffect(() => {
    render();
  }, [render]);

  /**
   * 把高频的重绘合并到每一帧一次（跟手优化）。
   *
   * 指针移动事件在高刷屏 / 高回报率鼠标下可能一秒来一百多次，
   * 每次都整档 composeDoc 一遍纯属浪费 —— 而屏幕一帧只显示一次。
   * 攒到下一帧统一画，既省掉多余合成，又让笔迹跟手不掉帧。
   */
  const renderRafRef = useRef(0);
  const scheduleRender = useCallback(() => {
    if (renderRafRef.current) return;
    renderRafRef.current = requestAnimationFrame(() => {
      renderRafRef.current = 0;
      render();
    });
  }, [render]);

  useEffect(
    () => () => {
      if (renderRafRef.current) cancelAnimationFrame(renderRafRef.current);
    },
    [],
  );

  /* ------------------------------------------------------------- 指针交互 */

  const docXY = useCallback(
    (clientX: number, clientY: number) => {
      const c = canvasRef.current;
      if (!c) return { x: 0, y: 0 };
      const r = c.getBoundingClientRect();
      return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
    },
    [scale],
  );

  const docPoint = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => docXY(e.clientX, e.clientY),
    [docXY],
  );

  const resetGesture = useCallback(() => {
    strokeRef.current = null;
    retouchRef.current = null;
    dragRef.current = null;
    gradRef.current = null;
    moveRef.current = { dx: 0, dy: 0 };
    selRef.current = null;
    shapeRef.current = null;
    setSelDragging(false);
    setShapeDragging(false);
  }, []);

  /**
   * 跟随光标。
   *
   * 画笔 / 橡皮 / 修饰工具显示一个与笔尖等大的圆圈 —— 落笔前就知道这一笔有多粗，
   * 这是绘画软件的手感底线；吸管则显示取样环：外圈是当下指到的颜色、中间填色块、
   * 下面挂十六进制值，边扫边看，松手即成前景色。
   * 全程只改 DOM 样式，不经过 React，鼠标移动一次重渲染都不产生。
   */
  const syncCursor = useCallback(
    (clientX: number, clientY: number) => {
      const el = cursorRef.current;
      const stage = el?.parentElement;
      if (!el || !stage) return;
      const box = stage.getBoundingClientRect();
      el.style.transform = `translate(${clientX - box.left}px, ${clientY - box.top}px)`;

      // 正在落笔时不画圆圈：笔迹本身就是反馈，再套个圈反而挡视线
      if (strokeRef.current || retouchRef.current) {
        el.dataset.mode = "none";
        return;
      }

      const ring = cursorRingRef.current;
      if (usesBrush(tool) || isRetouchTool(tool)) {
        const d = Math.max(8, (usesBrush(tool) ? brush.size : retouch.size) * scale);
        el.dataset.mode = "brush";
        if (ring) {
          ring.style.width = `${d}px`;
          ring.style.height = `${d}px`;
        }
        return;
      }
      if (tool !== "eyedropper") {
        el.dataset.mode = "none";
        return;
      }
      el.dataset.mode = "pick";
      const act = activeLayer(doc);
      const src = act && act.kind === "pixel" ? act.surface : compRef.current;
      if (!src) return;
      const p = docXY(clientX, clientY);
      const hex = pickColor(src, p.x, p.y);
      if (!hex) return;
      if (cursorHexRef.current) cursorHexRef.current.textContent = hex.toUpperCase();
      if (cursorSwatchRef.current) cursorSwatchRef.current.style.background = hex;
    },
    [brush.size, doc, docXY, retouch.size, scale, tool],
  );

  /** 鼠标移出画布：把跟随光标收起来。 */
  const hideCursor = useCallback(() => {
    const el = cursorRef.current;
    if (el) el.dataset.mode = "none";
    pickingRef.current = false;
  }, []);

  /* ---------------------------------------------------------------- 选区 */

  const docSize = `${docW} × ${docH}`;

  // 选区是否真的选中了东西（空遮罩等同于「没有选区」）。
  // 判定要扫全图，所以按 doc.selection 缓存，别每次渲染都算。
  const hasSelection = useMemo(
    () => !!doc.selection && !isSelectionEmpty(doc.selection),
    [doc.selection],
  );

  // 剪贴板是 core 里的模块级缓冲，React 看不见它的变化。用这个计数器当「版本号」：
  // 拷贝 / 剪切后 +1，菜单里「粘贴」的可用状态才会跟着刷新。
  const [clipTick, setClipTick] = useState(0);
  const canPaste = useMemo(() => clipTick >= 0 && clipHasContent(), [clipTick]);

  /** 把新算出来的选区落库；一片都没选中时等同取消选区（对齐 PS）。 */
  const commitSelection = useCallback(
    (next: HTMLCanvasElement) => {
      if (isSelectionEmpty(next)) {
        onCommit(setSelection(doc, null), zh.selection.none);
        return;
      }
      onCommit(setSelection(doc, next), zh.selection.made);
    },
    [doc, onCommit],
  );

  /**
   * 确认文本框：整段文字一次性栅格化成像素，落进当前（或新建的）图层。
   *
   * 与画笔抬笔走同一条路 —— 结果交给 onCommit，撤销栈、混合模式、图层样式、
   * 蒙版、剪贴蒙版全部照常生效；文字不为渲染另开一条通路。
   */
  const commitText = useCallback(() => {
    if (!textEdit) return;
    const content = textEdit.value;
    const { x, y } = textEdit;
    setTextEdit(null);
    if (content.trim().length === 0) {
      setToast(zh.options.textEmpty);
      return;
    }
    const ink = rasterizeText(docW, docH, content, textSet, x, y, fg, doc.selection);
    onCommit(placeRaster(doc, zh.tools.text, ink), zh.options.textPlaced);
    setToast(doc.selection ? zh.options.textInSelection : zh.options.textPlaced);
  }, [textEdit, docW, docH, textSet, fg, doc, onCommit]);

  // 切走文字工具：还没确认的文本框随手收掉，不留半截浮层在画布上
  useEffect(() => {
    if (!isTextTool(tool)) setTextEdit(null);
  }, [tool]);

  /**
   * 从选区遮罩抽出边界折线（文档坐标）。
   *
   * 逐像素找出「选中 / 未选中」的相邻分界，并把同一方向上的连续边合并成
   * 一整段 —— 一个矩形选区最终只有 4 段，比逐像素描边省下好几个数量级。
   * 折线存成 Path2D，缩放 / 平移时不必重算，直接描边即可。
   */
  const antsPath = useMemo(() => {
    const mask = doc.selection;
    if (!mask || !hasSelection) return null;
    const w = mask.width;
    const h = mask.height;
    // 边界只可能落在被选中像素的包围盒里，圈外一律略过 ——
    // 大画布上小选区不必扫满全图。
    const box = selectionBounds(mask);
    if (!box) return null;
    const rx = box.x;
    const ry = box.y;
    const rx1 = box.x + box.width;
    const ry1 = box.y + box.height;
    const d = mustCtx(mask).getImageData(0, 0, w, h).data;
    // 用 128 作阈值：羽化过的边缘取「一半选中」的那条等值线，与 PS 一致
    const on = (x: number, y: number) => d[(y * w + x) * 4 + 3] >= 128;
    const path = new Path2D();

    // 水平边：第 y 行与 y-1 行之间的分界
    for (let y = ry; y <= ry1; y += 1) {
      let run = -1;
      for (let x = rx; x <= rx1; x += 1) {
        const cur = x < w && y < h && on(x, y);
        const up = x < w && y > 0 && y - 1 < h && on(x, y - 1);
        const edge = x < w && cur !== up;
        if (edge && run < 0) run = x;
        if (!edge && run >= 0) {
          path.moveTo(run, y);
          path.lineTo(x, y);
          run = -1;
        }
      }
    }
    // 垂直边：第 x 列与 x-1 列之间的分界
    for (let x = rx; x <= rx1; x += 1) {
      let run = -1;
      for (let y = ry; y <= ry1; y += 1) {
        const cur = x < w && y < h && on(x, y);
        const left = x > 0 && y < h && on(x - 1, y);
        const edge = y < h && cur !== left;
        if (edge && run < 0) run = y;
        if (!edge && run >= 0) {
          path.moveTo(x, run);
          path.lineTo(x, y);
          run = -1;
        }
      }
    }
    return path;
  }, [doc.selection, hasSelection]);

  /**
   * 蚂蚁线浮层。
   *
   * 黑白交错的两遍虚线叠在同一条折线上，无论底图是深是浅都看得见；
   * 每帧把虚线相位推一点，就是 Photoshop 那条会爬的蚂蚁线。
   * 拖动中的框还没进文档，从 ref 里现读现画 —— 所以整个拖拽过程不触发
   * 一次 React 重渲染。
   */
  useEffect(() => {
    const c = overlayRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(docW * scale * dpr));
    c.height = Math.max(1, Math.round(docH * scale * dpr));
    const ctx = mustCtx(c);
    let painted = false;
    let raf = 0;

    // 取样点标记：只有「需要取样」的修饰工具（仿制 / 修复）且已取样时才画
    const anchorPt =
      anchor && isRetouchTool(tool) && needsSample(tool as RetouchMode) ? anchor : null;
    // 标记色取自主题的品牌蓝（canvas 读不到 CSS 变量，取值一次即可）
    const accent =
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() ||
      "#6fc0ff";

    // 既没有选区、没在拖框、没在拖形状、没在变换、也没有取样点：清一次就收工
    if (!antsPath && !selDragging && !shapeDragging && !anchorPt && !freeActive) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      return;
    }

    const paint = (t: number) => {
      const live = selRef.current;
      const sp = shapeRef.current;
      let path: Path2D | null = null;
      let box: { x: number; y: number; w: number; h: number } | null = null;

      if (live) {
        const x = Math.min(live.a.x, live.b.x);
        const y = Math.min(live.a.y, live.b.y);
        const w = Math.abs(live.a.x - live.b.x);
        const h = Math.abs(live.a.y - live.b.y);
        box = { x, y, w, h };
        path = new Path2D();
        if (live.tool === "ellipse") {
          path.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        } else if (live.tool === "lasso") {
          const pts = live.points;
          if (pts.length > 1) {
            path.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i += 1) path.lineTo(pts[i].x, pts[i].y);
            path.closePath();
          } else {
            path = null;
          }
        } else {
          path.rect(x, y, w, h);
        }
      } else if (antsPath) {
        path = antsPath;
      }

      // 形状回显：直接按真实颜色画一遍，所见即所得（含 Shift 约束后的端点）
      if (sp) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, c.width, c.height);
        const k = dpr * scale;
        ctx.setTransform(k, 0, 0, k, 0, 0);
        drawShape(c, sp);
        painted = true;
        raf = requestAnimationFrame(paint);
        return;
      }

      const ft = freeTRef.current;

      if (ft || path || anchorPt || painted) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, c.width, c.height);
        const k = dpr * scale;
        ctx.setTransform(k, 0, 0, k, 0, 0);

        // 裁剪时把框外压暗，一眼看清会丢掉哪些像素
        if (live && live.tool === "crop" && box) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, docW, docH);
          ctx.rect(box.x, box.y, box.w, box.h);
          ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
          ctx.fill("evenodd");
          ctx.restore();
        }

        if (path) {
          const u = 1 / scale; // 1 个屏幕像素折算到文档坐标
          const dash = 4 * u;
          ctx.lineWidth = u;
          ctx.setLineDash([dash, dash]);
          ctx.lineDashOffset = -((t / 60) % (dash * 2));
          ctx.strokeStyle = "#000000";
          ctx.stroke(path);
          ctx.lineDashOffset -= dash;
          ctx.strokeStyle = "#ffffff";
          ctx.stroke(path);
          ctx.setLineDash([]);
        }

        // 取样点：三层同心环 + 十字，保证在任何底图上都看得见
        if (anchorPt) {
          const u = 1 / scale;
          const r = 6 * u;
          const arm = 10 * u;
          ctx.save();
          ctx.lineWidth = 2.5 * u;
          ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
          ctx.beginPath();
          ctx.arc(anchorPt.x, anchorPt.y, r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(anchorPt.x - arm, anchorPt.y);
          ctx.lineTo(anchorPt.x + arm, anchorPt.y);
          ctx.moveTo(anchorPt.x, anchorPt.y - arm);
          ctx.lineTo(anchorPt.x, anchorPt.y + arm);
          ctx.stroke();
          ctx.lineWidth = 1.2 * u;
          ctx.strokeStyle = accent;
          ctx.beginPath();
          ctx.arc(anchorPt.x, anchorPt.y, r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(anchorPt.x - arm, anchorPt.y);
          ctx.lineTo(anchorPt.x + arm, anchorPt.y);
          ctx.moveTo(anchorPt.x, anchorPt.y - arm);
          ctx.lineTo(anchorPt.x, anchorPt.y + arm);
          ctx.stroke();
          ctx.restore();
        }

        // 自由变换框：外框 + 八手柄 + 顶部旋转圆点，全部按屏幕像素恒定大小画
        if (ft) {
          const u = 1 / scale;
          const cs = transformCorners(ft);
          ctx.save();
          ctx.strokeStyle = accent;
          ctx.fillStyle = "#ffffff";
          ctx.lineWidth = 1.5 * u;

          // 外框
          ctx.beginPath();
          ctx.moveTo(cs[0].x, cs[0].y);
          for (let i = 1; i < 4; i += 1) ctx.lineTo(cs[i].x, cs[i].y);
          ctx.closePath();
          ctx.stroke();

          // 旋转手柄：从顶边中点牵一条引线到圆点
          const rot = freeRotateHandle(ft, scale);
          const midTop = { x: (cs[0].x + cs[1].x) / 2, y: (cs[0].y + cs[1].y) / 2 };
          ctx.beginPath();
          ctx.moveTo(midTop.x, midTop.y);
          ctx.lineTo(rot.x, rot.y);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(rot.x, rot.y, (FREE_HANDLE_SIZE / 2) * u, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();

          // 八个缩放手柄
          const hs = freeHandles(ft);
          const half = (FREE_HANDLE_SIZE / 2) * u;
          for (const h of hs) {
            ctx.beginPath();
            ctx.rect(h.x - half, h.y - half, half * 2, half * 2);
            ctx.fill();
            ctx.stroke();
          }
          ctx.restore();
        }
        painted = !!(path || anchorPt || ft);
      }
      raf = requestAnimationFrame(paint);
    };

    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [docW, docH, scale, antsPath, selDragging, shapeDragging, anchor, tool, freeActive]);

  const onDown = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      const act = activeLayer(doc);
      if (e.button === 1 || spaceDown || tool === "hand") {
        panRef.current = { x: e.clientX, y: e.clientY };
        capturePointer(e.currentTarget, e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      const p = docPoint(e);

      // 自由变换进行中：画布上的一切指针动作都归这八个手柄 + 旋转圆点 + 框内平移管。
      // 命中判定按「屏幕像素」折算回文档坐标，所以放大缩小都不影响手感。
      const tf0 = freeTRef.current;
      if (tf0) {
        capturePointer(e.currentTarget, e.pointerId);
        const hitR = FREE_HANDLE_HIT / scale;
        const rot = freeRotateHandle(tf0, scale);
        const hs = freeHandles(tf0);
        let mode: "move" | "scale" | "rotate" = "move";
        let handle = -1;
        if (Math.hypot(p.x - rot.x, p.y - rot.y) <= hitR) {
          mode = "rotate";
        } else {
          for (let i = 0; i < hs.length; i += 1) {
            if (Math.hypot(p.x - hs[i].x, p.y - hs[i].y) <= hitR) {
              mode = "scale";
              handle = i;
              break;
            }
          }
        }
        freeDragRef.current = { mode, handle, start: tf0, grab: p };
        return;
      }

      // 选区与裁剪作用于整份文档：不受图层锁定影响，没有活动图层也能用
      if (isSelectionTool(tool) || tool === "crop") {
        capturePointer(e.currentTarget, e.pointerId);
        setError("");
        if (tool === "wand") {
          const src = act && act.kind === "pixel" ? act.surface : compRef.current;
          const shape = src ? wandMask(src, p, tolerance, contiguous) : null;
          if (shape) {
            commitSelection(
              combineSelection(doc.selection, shape, modeWithMods(e.shiftKey, e.altKey, selectionMode)),
            );
          }
          return;
        }
        if (tool === "crop") {
          selRef.current = { tool: "crop", a: p, b: p, points: [p], mode: "new" };
          setSelDragging(true);
        } else if (tool === "marquee" || tool === "ellipse" || tool === "lasso") {
          selRef.current = {
            tool,
            a: p,
            b: p,
            points: [p],
            mode: modeWithMods(e.shiftKey, e.altKey, selectionMode),
          };
          setSelDragging(true);
        }
        return;
      }

      // 文字：单击落一个文本框，输入确认后整段栅格化成像素。
      // 不受图层锁定影响 —— 确认时若当前层锁着，会自动在它上面另开一层。
      if (isTextTool(tool)) {
        setError("");
        setTextEdit({ x: p.x, y: p.y, value: "" });
        return;
      }

      if (!act) return;
      if (tool === "zoom") {
        zoom(scale * (e.altKey ? 1 / ZOOM_STEP : ZOOM_STEP));
        return;
      }
      if (tool === "eyedropper") {
        // 按住不放就是连续取色：拖动扫过哪片就取哪片的颜色，松手停
        pickingRef.current = true;
        capturePointer(e.currentTarget, e.pointerId);
        const hex = pickColor(act.surface, p.x, p.y);
        if (hex) {
          setFg(hex);
          setToast(`${zh.hint.picked} ${hex.toUpperCase()}`);
        }
        return;
      }
      // Alt + 单击：画笔 / 形状工具临时变吸管（PS 老习惯），取完色直接接着画
      // 修饰工具不在此列 —— 它们的 Alt 是「定取样点」，各归各的。
      if (e.altKey && (usesBrush(tool) || isShapeTool(tool))) {
        const hex = pickColor(act.surface, p.x, p.y);
        if (hex) {
          setFg(hex);
          setToast(`${zh.hint.picked} ${hex.toUpperCase()}`);
        }
        return;
      }
      if (act.locked) {
        setError(zh.hint.layerLocked);
        return;
      }
      // 调整层与组都没有自己的像素（surface 只是 1×1 占位），画笔落上去只会
      // 把占位面画花，画面上什么也看不见 —— 直接拦下来说清楚。
      // 例外是移动工具：拖动一个组在画面上就是把它整棵子树一起搬走。
      if (act.kind === "group" && tool !== "move") {
        setError(zh.hint.layerGroupDenied);
        return;
      }
      if (act.kind === "adjust") {
        setError(zh.hint.layerAdjustDenied);
        return;
      }
      setError("");
      capturePointer(e.currentTarget, e.pointerId);

      if (isShapeTool(tool)) {
        shapeRef.current = {
          kind: SHAPE_KIND[tool],
          a: p,
          b: p,
          fill: shape.fill,
          stroke: shape.stroke,
          strokeWidth: shape.strokeWidth,
          fillColor: fg,
          strokeColor: bg,
        };
        setShapeDragging(true);
        return;
      }
      if (usesBrush(tool)) {
        const s = new Stroke(
          docW,
          docH,
          { ...brush, color: fg },
          tool === "eraser",
        );
        s.begin(p.x, p.y, pressureOf(e.pressure, e.pointerType), e.timeStamp);
        strokeRef.current = s;
        scheduleRender();
        return;
      }
      if (isRetouchTool(tool)) {
        const mode = tool as RetouchMode;
        // Alt + 单击：仿制 / 修复在这里定取样点，本身不落笔
        if (e.altKey && needsSample(mode)) {
          setAnchor(p);
          setToast(zh.options.cloneSampled);
          return;
        }
        if (needsSample(mode) && !anchor) {
          setError(zh.options.cloneNeedSample);
          return;
        }
        const rt = new RetouchStroke(act.surface, { ...retouch, mode }, {
          anchor: needsSample(mode) ? anchor : null,
          mask: doc.selection ?? null,
        });
        rt.begin(p.x, p.y, pressureOf(e.pressure, e.pointerType), e.timeStamp);
        rt.pull();
        retouchRef.current = rt;
        scheduleRender();
        return;
      }
      if (tool === "bucket") {
        if (floodFill(act.surface, p.x, p.y, fg, tolerance, doc.selection)) {
          onCommit({ ...doc, dirty: true }, zh.tools.bucket);
        }
        return;
      }
      if (tool === "gradient") {
        gradRef.current = { from: p, to: p };
        return;
      }
      if (tool === "move") {
        dragRef.current = p;
        moveRef.current = { dx: 0, dy: 0 };
      }
    },
    [
      doc,
      docPoint,
      brush,
      retouch,
      shape,
      anchor,
      fg,
      bg,
      scheduleRender,
      scale,
      spaceDown,
      tolerance,
      contiguous,
      selectionMode,
      commitSelection,
      tool,
      zoom,
      onCommit,
      docW,
      docH,
    ],
  );

  const onMove = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      syncCursor(e.clientX, e.clientY);
      const from = panRef.current;
      if (from) {
        setPan((p) => ({
          x: p.x + (e.clientX - from.x),
          y: p.y + (e.clientY - from.y),
        }));
        panRef.current = { x: e.clientX, y: e.clientY };
        return;
      }
      // 自由变换拖动：只改 ref，浮层那支 rAF 每帧现读现画，拖拽全程零重渲染
      const fd = freeDragRef.current;
      const ft = freeTRef.current;
      if (fd && ft) {
        const s = fd.start;
        const q = docPoint(e);
        if (fd.mode === "move") {
          freeTRef.current = {
            ...s,
            cx: s.cx + (q.x - fd.grab.x),
            cy: s.cy + (q.y - fd.grab.y),
          };
        } else if (fd.mode === "rotate") {
          const a0 = Math.atan2(fd.grab.y - s.cy, fd.grab.x - s.cx);
          const a1 = Math.atan2(q.y - s.cy, q.x - s.cx);
          let angle = s.angle + (a1 - a0);
          if (e.shiftKey) {
            const step = Math.PI / 12; // 按住 Shift 吸附到 15 度
            angle = Math.round(angle / step) * step;
          }
          freeTRef.current = { ...s, angle };
        } else {
          // 缩放：把指针挪到「手柄自身的局部坐标系」里量，对侧那条边/那个角当锚点钉死。
          // 这样旋转过的框拖起来也符合直觉 —— 手柄跟着指针走，对面不动。
          const [lx, ly] = FREE_HANDLE_LOCALS[fd.handle];
          const hw0 = s.w / 2;
          const hh0 = s.h / 2;
          const ax = lx !== 0 ? -lx * hw0 : 0;
          const ay = ly !== 0 ? -ly * hh0 : 0;
          const l = freeLocal(s, q);
          let w = s.w;
          let h = s.h;
          let clx = 0;
          let cly = 0;
          if (lx !== 0) {
            w = Math.max(1, Math.abs(l.x - ax));
            clx = (ax + l.x) / 2;
          }
          if (ly !== 0) {
            h = Math.max(1, Math.abs(l.y - ay));
            cly = (ay + l.y) / 2;
          }
          const cc = freeWorld(s, { x: clx, y: cly });
          freeTRef.current = { ...s, w, h, cx: cc.x, cy: cc.y };
        }
        scheduleRender();
        return;
      }
      // 吸管按住拖动：连续取色，只有颜色真的变了才写状态，免得一路重渲染
      if (pickingRef.current && tool === "eyedropper") {
        const act = activeLayer(doc);
        const src = act && act.kind === "pixel" ? act.surface : compRef.current;
        const q = docXY(e.clientX, e.clientY);
        const hex = src ? pickColor(src, q.x, q.y) : null;
        if (hex && hex.toLowerCase() !== fg.toLowerCase()) setFg(hex);
        return;
      }
      // 选区 / 裁剪框：只更新 ref，由浮层那支 rAF 现读现画，不进历史也不重渲染
      const sel = selRef.current;
      if (sel) {
        const p = docPoint(e);
        if (sel.tool === "lasso") sel.points.push(p);
        sel.b = p;
        return;
      }
      // 形状：同样只更新 ref；按住 Shift 时端点被约束成正方 / 45°
      const sp = shapeRef.current;
      if (sp) {
        const q = docPoint(e);
        shapeRef.current = { ...sp, b: constrainEnd({ ...sp, b: q }, e.shiftKey) };
        return;
      }
      const s = strokeRef.current;
      if (s) {
        // 指下的移动事件往往被合并成低频的大跨度折线，直接用会画成折角；
        // getCoalescedEvents 能拿回浏览器攒下的全部中间点，配合压感一起喂给样条。
        const native = e.nativeEvent;
        const batch =
          typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
        if (batch.length > 1) {
          for (const ev of batch) {
            const q = docXY(ev.clientX, ev.clientY);
            s.extend(q.x, q.y, pressureOf(ev.pressure, ev.pointerType), ev.timeStamp);
          }
        } else {
          const p = docXY(native.clientX, native.clientY);
          s.extend(p.x, p.y, pressureOf(native.pressure, native.pointerType), native.timeStamp);
        }
        scheduleRender();
        return;
      }
      const rt = retouchRef.current;
      if (rt) {
        // 与画笔同一处理：把合并事件里的中间点全部喂进去，避免快拖成折角
        const native = e.nativeEvent;
        const batch =
          typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
        if (batch.length > 1) {
          for (const ev of batch) {
            const q = docXY(ev.clientX, ev.clientY);
            rt.extend(q.x, q.y, pressureOf(ev.pressure, ev.pointerType), ev.timeStamp);
          }
        } else {
          const q = docXY(native.clientX, native.clientY);
          rt.extend(q.x, q.y, pressureOf(native.pressure, native.pointerType), native.timeStamp);
        }
        rt.pull();
        scheduleRender();
        return;
      }
      const g = gradRef.current;
      if (g) {
        gradRef.current = { from: g.from, to: docPoint(e) };
        return;
      }
      const start = dragRef.current;
      if (start && tool === "move") {
        const p = docPoint(e);
        moveRef.current = { dx: Math.round(p.x - start.x), dy: Math.round(p.y - start.y) };
        scheduleRender();
      }
    },
    [docPoint, docXY, doc, fg, scheduleRender, syncCursor, tool],
  );

  const onUp = useCallback(() => {
    pickingRef.current = false;
    if (panRef.current) {
      panRef.current = null;
      return;
    }
    // 自由变换：松手只是结束这一次拖拽，变换本身还挂在浮层上，等 Enter 才落库
    if (freeDragRef.current) {
      freeDragRef.current = null;
      return;
    }

    // 选区 / 裁剪：抬笔才真正落库（拖动过程全在浮层上）
    const sel = selRef.current;
    if (sel) {
      resetGesture();
      if (sel.tool === "crop") {
        const x = Math.min(sel.a.x, sel.b.x);
        const y = Math.min(sel.a.y, sel.b.y);
        const width = Math.abs(sel.a.x - sel.b.x);
        const height = Math.abs(sel.a.y - sel.b.y);
        if (width < CROP_MIN || height < CROP_MIN) {
          setError(zh.selection.cropTooSmall);
          return;
        }
        const next = cropDocument(doc, { x, y, width, height });
        if (next !== doc) onCommit(next, zh.selection.cropped);
        return;
      }
      const shape =
        sel.tool === "marquee"
          ? rectMask(docW, docH, sel.a, sel.b, feather)
          : sel.tool === "ellipse"
            ? ellipseMask(docW, docH, sel.a, sel.b, feather)
            : lassoMask(docW, docH, sel.points, feather);
      commitSelection(combineSelection(doc.selection, shape, sel.mode));
      return;
    }

    const act = activeLayer(doc);
    if (!act) return;

    // 形状：抬笔才真正落库（拖动过程全在浮层上）
    const sp = shapeRef.current;
    if (sp) {
      resetGesture();
      const b = shapeBounds(sp);
      const tooSmall =
        sp.kind === "line"
          ? Math.hypot(sp.b.x - sp.a.x, sp.b.y - sp.a.y) < 2
          : b.width < 2 || b.height < 2;
      if (tooSmall) {
        render();
        return;
      }
      // 先画在临时画布上，有选区就用遮罩裁一次，再整体盖到图层表面，一步可撤销
      const ink = createSurface(docW, docH);
      if (!drawShape(ink, sp)) {
        setError(zh.options.shapeNoPaint);
        return;
      }
      if (doc.selection) {
        const ictx = mustCtx(ink);
        ictx.save();
        ictx.globalCompositeOperation = "destination-in";
        ictx.drawImage(doc.selection, 0, 0);
        ictx.restore();
      }
      const next = cloneSurface(act.surface);
      mustCtx(next).drawImage(ink, 0, 0);
      const layers = doc.layers.map((l) => (l.id === act.id ? { ...l, surface: next } : l));
      onCommit({ ...doc, layers, dirty: true }, zh.tools[tool]);
      return;
    }

    const s = strokeRef.current;
    if (s) {
      // 蒙版涂抹只认蒙版，其余笔画被当前选区限制范围
      s.finish(
        maskEdit && act.mask ? act.mask : act.surface,
        maskEdit ? null : doc.selection,
      );
      resetGesture();
      onCommit({ ...doc, dirty: true }, zh.tools[tool]);
      return;
    }

    const rt = retouchRef.current;
    if (rt) {
      rt.finish();
      rt.pull();
      const touched = rt.touched;
      const result = rt.result;
      resetGesture();
      if (!touched) {
        // 一笔扫了个空（或者在选区外）—— 不进历史，静静收场
        render();
        return;
      }
      // 结果画布已含整层像素（含选区裁切），直接换掉本层表面
      const layers = doc.layers.map((l) =>
        l.id === act.id ? { ...l, surface: result } : l,
      );
      onCommit({ ...doc, layers, dirty: true }, zh.tools[tool]);
      return;
    }

    const g = gradRef.current;
    if (g) {
      const [a, b] = gradientReverse ? [bg, fg] : [fg, bg];
      gradientFill(act.surface, g.from, g.to, a, b, gradientStyle, doc.selection);
      resetGesture();
      onCommit({ ...doc, dirty: true }, zh.tools.gradient);
      return;
    }

    if (dragRef.current && tool === "move") {
      const { dx, dy } = moveRef.current;
      resetGesture();
      if (dx !== 0 || dy !== 0) {
        // 选中组时整棵子树一起搬（layerOps 里判断），普通层就是它自己
        onCommit(translateLayer(doc, dx, dy), zh.tools.move);
        return;
      }
      render();
    }
  }, [bg, doc, docH, docW, fg, gradientReverse, gradientStyle, onCommit, render, resetGesture, tool, maskEdit, feather, commitSelection]);

  /* -------------------------------------------------------------- 自由变换 */

  /**
   * 进入自由变换（Ctrl+T）。
   *
   * 只把当前像素层「浮」起来交给浮层，文档一动不动 —— 拖动过程全部现算现画，
   * 按 Enter 才 applyFreeTransform 落成一步可撤销的历史，按 Esc 就当没发生过。
   */
  const beginFreeTransform = useCallback(() => {
    const t = initialFreeTransform(doc);
    if (!t) {
      setError(zh.hint.transformNoLayer);
      setToast(zh.hint.transformNoLayer);
      return;
    }
    freeTRef.current = t;
    freeDragRef.current = null;
    setError("");
    setFreeActive(true);
    // 单选框锁死，省得拖手柄时还去点别的工具；变换没结束前只认 Enter / Esc
    setToast(zh.hint.transformHint);
    render();
  }, [doc, render]);

  /** 把当前自由变换烘进图层，落一步历史。返回是否真的应用了。 */
  const commitFreeTransform = useCallback(() => {
    const t = freeTRef.current;
    if (!t) return false;
    freeTRef.current = null;
    freeDragRef.current = null;
    setFreeActive(false);
    const next = applyFreeTransform(doc, t);
    if (next !== doc) onCommit(next, zh.hint.transformed);
    setToast(zh.hint.transformApplied);
    return true;
  }, [doc, onCommit]);

  /** 放弃自由变换，画面回到变换前的样子。返回是否真的取消了。 */
  const cancelFreeTransform = useCallback(() => {
    if (!freeTRef.current) return false;
    freeTRef.current = null;
    freeDragRef.current = null;
    setFreeActive(false);
    setToast(zh.hint.transformCanceled);
    render();
    return true;
  }, [render]);

  // 滚轮：Ctrl 缩放，其余平移。放在原生监听里是为了能阻止 WebView 的页面缩放
  const wheelZoomRef = useRef<(dir: number) => void>(() => {});
  wheelZoomRef.current = (dir: number) => zoom(scale * (dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP));

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        wheelZoomRef.current(e.deltaY < 0 ? 1 : -1);
        return;
      }
      setPan((p) => ({
        x: p.x - (e.shiftKey ? e.deltaY : e.deltaX),
        y: p.y - (e.shiftKey ? 0 : e.deltaY),
      }));
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, []);

  /* ---------------------------------------------------------------- 命令 */

  const pickTool = useCallback((id: ToolId) => {
    setTool(id);
    setError("");
    resetGesture();
  }, [resetGesture]);

  const pickWorkspace = useCallback((id: WorkspaceId) => {
    setWorkspace(id);
    pickTool(id === "photo" ? "move" : "brush");
  }, [pickTool]);

  const swapColors = useCallback(() => {
    setFg(bg);
    setBg(fg);
  }, [bg, fg]);

  /** 一键回到「前景黑 / 背景白」——与 PS 的默认色一致。 */
  const resetColors = useCallback(() => {
    setFg("#000000");
    setBg("#ffffff");
  }, []);

  useEffect(() => {
    setBrush((b) => (b.color === fg ? b : { ...b, color: fg }));
  }, [fg]);

  // 画笔参数回写偏好设置，下次打开还是这套手感（颜色不存，跟着前景色走）
  useEffect(() => {
    setPrefs({ brushDefaults: toBrushPrefs(brush) });
  }, [brush]);

  const exportPng = useCallback(async () => {
    try {
      const target = await save({
        title: zh.dialog.saveTitle,
        defaultPath: `${doc.name}.png`,
        filters: [{ name: "PNG 图片", extensions: ["png"] }],
      });
      if (typeof target !== "string") return;
      // 导出永远走「干净的合成」：屏幕上可能正开着通道视图（偏色 / 单通道灰度），
      // 那是给眼睛看的，不能跟着文件一起存下去，所以这里另起一张画布重新合成。
      const canvas = createSurface(docW, docH);
      composeDoc(doc, canvas);
      const bytes = await encodePng(canvas);
      await writeFileBytes(target, bytes);
      setToast(zh.editor.exported);
    } catch (e) {
      setError(`${zh.error.exportFailed}：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc, docW, docH]);

  /** 打开一张图片（从编辑壳内，无需回开始页面）。 */
  const openImage = useCallback(async () => {
    try {
      const picked = await open({
        title: zh.dialog.openTitle,
        multiple: false,
        directory: false,
        filters: [{ name: "图片", extensions: [...IMAGE_EXTENSIONS] }],
      });
      if (typeof picked !== "string") return;
      const bitmap = await loadImage(picked);
      onOpenDoc(docFromBitmap(bitmap, baseName(picked), picked));
    } catch (e) {
      setError(`${zh.error.openFailed}：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [onOpenDoc]);

  /**
   * 新建画布：编辑器内 Ctrl+N / 文件菜单直接开一张空白档。
   * 尺寸取 core/presets 的首档（全高清），与开始页共用同一份数字，
   * 不在两处各写一套。
   */
  const newCanvas = useCallback(() => {
    try {
      const p = PRESETS[0];
      const dpi = p.dpi ?? Number(DEFAULT_DPI);
      onOpenDoc(docFromBlank(p.w, p.h, zh.editor.untitled, "white", dpi));
      setToast(zh.menu.newCanvasNow);
    } catch (e) {
      setError(`${zh.error.openFailed}：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [onOpenDoc]);

  /** 关闭全部文档：走 App 层的统一出口，避免这里逐份 delete 撤销栈。 */
  const closeAll = useCallback(() => onCloseAll(), [onCloseAll]);

  /** 打开一份 .strata 工程（图层 / 蒙版 / 调整图层全部还原）。 */
  const openProject = useCallback(async () => {
    try {
      // 工程编解码器按需加载：只有真的开/存 .strata 时才拉进来。
      const { STRATA_EXTENSION, decodeProject } = await import("../engine/project");
      const picked = await open({
        title: zh.dialog.openProjectTitle,
        multiple: false,
        directory: false,
        filters: [{ name: "Strata 工程", extensions: [STRATA_EXTENSION] }],
      });
      if (typeof picked !== "string") return;
      const bytes = await readFileBytes(picked);
      const next = await decodeProject(bytes);
      next.sourcePath = picked;
      onOpenDoc(next);
      setToast(zh.editor.projectOpened);
    } catch (e) {
      setError(`${zh.error.openFailed}：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [onOpenDoc]);

  /** 保存工程：整份文档（含蒙版与调整图层）写成一个 .strata 文件。 */
  const saveProject = useCallback(async () => {
    try {
      const { STRATA_EXTENSION, encodeProject, isStrataPath } = await import(
        "../engine/project"
      );
      const target = await save({
        title: zh.dialog.saveProjectTitle,
        defaultPath: isStrataPath(doc.name)
          ? doc.name
          : `${doc.name}.${STRATA_EXTENSION}`,
        filters: [{ name: "Strata 工程", extensions: [STRATA_EXTENSION] }],
      });
      if (typeof target !== "string") return;
      const bytes = await encodeProject(doc);
      await writeFileBytes(target, bytes);
      onPreview({ ...doc, sourcePath: target, dirty: false });
      setToast(zh.editor.projectSaved);
    } catch (e) {
      setError(`${zh.error.saveFailed}：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc, onPreview]);

  const onQuit = useCallback(() => {
    void quitApp().catch(() => setError("退出失败，请直接关闭窗口"));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(""), 2400);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(""), 4000);
    return () => window.clearTimeout(t);
  }, [error]);

  /* ---------------------------------------------------------------- 选区命令 */

  /** 全选：一圈把整块画布套住（PS 的 Ctrl+A）。 */
  const doSelectAll = useCallback(
    () => onCommit(setSelection(doc, selectAllMask(docW, docH)), zh.selection.all),
    [doc, docW, docH, onCommit],
  );

  /** 取消选择：选区直接丢掉，回到「不限制范围」。 */
  const doDeselect = useCallback(() => {
    if (!doc.selection) return;
    onCommit(setSelection(doc, null), zh.selection.none);
  }, [doc, onCommit]);

  /** 反选：没选区时反选等于全选（对齐 PS）。 */
  const doInvert = useCallback(() => {
    if (!doc.selection) {
      onCommit(setSelection(doc, selectAllMask(docW, docH)), zh.selection.all);
      return;
    }
    onCommit(setSelection(doc, invertSelection(doc.selection)), zh.selection.inverted);
  }, [doc, docW, docH, onCommit]);

  /* ---------------------------------------------- 选区修改（PS 的选择 > 修改） */

  /**
   * 修改半径沿用选项条上的「羽化」数值 —— 一个旋钮管三件事，
   * 菜单里把当前半径印出来，避免用户不知道会改多少。
   */
  const selRadius = feather;

  const doFeather = useCallback(() => {
    if (!doc.selection || !hasSelection) return;
    if (selRadius <= 0) {
      setError(zh.selection.radiusZero);
      return;
    }
    onCommit(
      setSelection(doc, featherSelection(doc.selection, selRadius)),
      zh.selection.feathered,
    );
  }, [doc, hasSelection, onCommit, selRadius]);

  const doExpand = useCallback(() => {
    if (!doc.selection || !hasSelection) return;
    if (selRadius <= 0) {
      setError(zh.selection.radiusZero);
      return;
    }
    onCommit(setSelection(doc, expandSelection(doc.selection, selRadius)), zh.selection.expanded);
  }, [doc, hasSelection, onCommit, selRadius]);

  const doContract = useCallback(() => {
    if (!doc.selection || !hasSelection) return;
    if (selRadius <= 0) {
      setError(zh.selection.radiusZero);
      return;
    }
    const next = contractSelection(doc.selection, selRadius);
    if (isSelectionEmpty(next)) {
      setError(zh.selection.radiusTooBig);
      return;
    }
    onCommit(setSelection(doc, next), zh.selection.contracted);
  }, [doc, hasSelection, onCommit, selRadius]);

  /** 在选区内填色；没有像素图层时只提示、不改文档。 */
  const doFill = useCallback(
    (color: string) => {
      const next = fillSelection(doc, color);
      if (next === doc) {
        setError(zh.selection.noPixelLayer);
        return;
      }
      onCommit(next, zh.selection.filled);
    },
    [doc, onCommit],
  );

  const doDeletePixels = useCallback(() => {
    const next = deleteSelection(doc);
    if (next === doc) {
      setError(zh.selection.noPixelLayer);
      return;
    }
    onCommit(next, zh.selection.deleted);
  }, [doc, onCommit]);

  /**
   * 内容识别填充：把选区里的东西抹掉，再用图里别处的纹理补回来。
   *
   * 只在「选区包围盒外扩一圈」的区域里跑 PatchMatch —— 整张图跑一遍在大图上
   * 会有明显卡顿，而外扩那圈正是借纹理要用的样本；选区之外一个像素都不动。
   * 内核只改掩膜为真的像素、其余原样抄回，所以整块贴回去等价于「只改选区」。
   */
  const doInpaint = useCallback(() => {
    const act = activeLayer(doc);
    if (!act || act.kind !== "pixel" || act.locked) {
      setError(zh.selection.noPixelLayer);
      return;
    }
    const mask = doc.selection;
    const box = mask && hasSelection ? selectionBounds(mask) : null;
    if (!mask || !box) {
      setError(zh.inpaint.needSelection);
      return;
    }
    const full = readPixels(act.surface);
    const fw = full.width;
    const fh = full.height;
    // 羽化边取「一半选中」的等值线：与蚂蚁线、反选等处的判定保持一致。
    const sel = mustCtx(mask).getImageData(0, 0, fw, fh).data;
    // 外扩 24px 留出可借的纹理，再夹回画布内。
    const pad = 24;
    const x0 = Math.max(0, Math.floor(box.x) - pad);
    const y0 = Math.max(0, Math.floor(box.y) - pad);
    const x1 = Math.min(fw, Math.ceil(box.x + box.width) + pad);
    const y1 = Math.min(fh, Math.ceil(box.y + box.height) + pad);
    const rw = x1 - x0;
    const rh = y1 - y0;
    if (rw <= 2 || rh <= 2) {
      setError(zh.selection.empty);
      return;
    }

    // 把「要处理的这一块」从图层里抠出来，连同掩膜一起交给内核。
    const sub = createRaster(rw, rh);
    const subMask = new Uint8Array(rw * rh);
    let holes = 0;
    for (let y = 0; y < rh; y += 1) {
      const row = (y0 + y) * fw + x0;
      sub.data.set(full.data.subarray(row * 4, (row + rw) * 4), y * rw * 4);
      for (let x = 0; x < rw; x += 1) {
        if (sel[(row + x) * 4 + 3] >= 128) {
          subMask[y * rw + x] = 1;
          holes += 1;
        }
      }
    }
    if (holes >= rw * rh) {
      setError(zh.inpaint.noSource);
      return;
    }

    // 大区域少迭代几轮：PatchMatch 的收益随轮数递减，先保住不卡。
    const area = rw * rh;
    const filled = inpaint(sub, subMask, {
      iterations: area > 1_500_000 ? 2 : 4,
      search: area > 1_500_000 ? 32 : 64,
    });

    // 整块贴回图层：内核保证掩膜之外的像素原样不动。
    const next = cloneSurface(act.surface);
    const nctx = mustCtx(next);
    const patch = nctx.createImageData(rw, rh);
    patch.data.set(filled.data);
    nctx.putImageData(patch, x0, y0);
    const layers = doc.layers.map((l) => (l.id === act.id ? { ...l, surface: next } : l));
    onCommit({ ...doc, layers, dirty: true }, zh.menu.inpaint);
    setToast(zh.inpaint.done);
  }, [doc, hasSelection, onCommit]);

  const doTrim = useCallback(() => {
    const next = trimToSelection(doc);
    if (next === doc) {
      setError(zh.selection.empty);
      return;
    }
    onCommit(next, zh.selection.trimmed);
  }, [doc, onCommit]);

  /* ---------------------------------------------------- 剪切 / 复制 / 粘贴 */

  /** 剪切：先拷进剪贴板，再抹掉选区内的像素。 */
  const doCut = useCallback(() => {
    const next = cutSelection(doc);
    if (next === doc) {
      setError(zh.selection.noPixelLayer);
      return;
    }
    setClipTick((v) => v + 1);
    onCommit(next, zh.hint.cutDone);
  }, [doc, onCommit]);

  /** 复制；merged = true 时连可见图层一起合成（PS 的「复制合并」）。 */
  const doCopy = useCallback(
    (merged: boolean) => {
      if (!copyToClipboard(doc, merged)) {
        setError(zh.selection.noPixelLayer);
        return;
      }
      setClipTick((v) => v + 1);
      const s = clipSize();
      const base = merged ? zh.hint.copied : zh.hint.copiedLayer;
      setToast(s ? `${base}（${s.width} × ${s.height}）` : base);
    },
    [doc],
  );

  /** 粘贴：内容落在新图层上并自动选中它，原位贴合（详见 core/layerOps）。 */
  const doPaste = useCallback(() => {
    if (!canPaste) {
      setError(zh.hint.clipEmpty);
      return;
    }
    onCommit(pasteFromClipboard(doc), zh.hint.pasted);
  }, [canPaste, doc, onCommit]);

      /* -------------------------------------------------- 图像 > 调整（一键） */

      /**
       * 把一条调整当场烙进当前图层的像素。
       *
       * 返回同一引用 = 内核判定「没得改」（没选中图层、图层被锁、或参数恰好中性），
       * 这时给一句提示，别让用户以为点了没反应。
       */
      const doAdjust = useCallback(
        (label: string, state: AdjustState) => {
          const next = applyAdjustToLayer(doc, state);
          if (next === doc) {
            setError(zh.hint.selectLayerFirst);
            return;
          }
          onCommit(next, label);
        },
        [doc, onCommit],
      );

      /**
       * 图像 > 自动色调 / 自动对比度 / 自动颜色。
       *
       * 三者都是「量直方图再拉色阶」，差别只在统计口径（详见 engine/auto.ts）：
       * 自动对比度把三通道合量成一张直方图、共用一组 lo/hi（保住色相）；
       * 自动色调每通道各量各拉（顺带中和偏色）；自动颜色先做克制的灰世界
       * 白平衡再走自动对比度。内核是就地改写像素的，所以先读一份副本交给
       * autoOn，再把结果整层写回 —— 原画布一动不动，撤销才有依据。
       *
       * 图本来就铺满全色域时内核会回一句「没得改」，这时不落历史（免得塞一条
       * 空步骤），只给提示。
       */
      const doAuto = useCallback(
        (kind: "contrast" | "tone" | "color", label: string) => {
          const act = activeLayer(doc);
          if (!act || act.kind !== "pixel" || act.locked) {
            setError(zh.selection.noPixelLayer);
            return;
          }
          const out = readPixels(act.surface);
          const { raster, report } = autoOn(asRaster(out), kind);
          if (!report.changed) {
            setToast(zh.hint.autoBalanced);
            return;
          }
          out.data.set(raster.data);
          const next = cloneSurface(act.surface);
          writePixels(next, out);
          const layers = doc.layers.map((l) => (l.id === act.id ? { ...l, surface: next } : l));
          onCommit({ ...doc, layers, dirty: true }, label);
        },
        [doc, onCommit],
      );

  /* ------------------------------------------------------------ 菜单与面板 */

  const at = doc.layers.findIndex((l) => l.id === doc.activeLayerId);

  /**
   * 向下合并的可用态。
   *
   * 判据与 layerOps.mergeDown 的守卫一一对应：底下得有东西、自己不是组、下层得
   * 是像素层、还得是同层级（不能把组里的层并到组外去）。用数组下标判断会漏掉
   * 「组内最底层」这种情形。
   */
  const mergeOk =
    at > 0 &&
    doc.layers[at].kind !== "group" &&
    doc.layers[at - 1].kind === "pixel" &&
    (doc.layers[at].parent ?? null) === (doc.layers[at - 1].parent ?? null);

  /** 能不能做「图层级」的变换：得选中一个没被锁的像素层。 */
  const canTransform = at >= 0 && doc.layers[at].kind === "pixel" && !doc.layers[at].locked;

  const menuGroups = useMemo<MenuGroup[]>(
    () => [
      {
        key: "file",
        label: zh.menu.file,
        items: [
          { label: zh.menu.newCanvasNow, hint: "Ctrl+N", onSelect: newCanvas },
          { label: zh.menu.openImage, hint: "Ctrl+O", onSelect: () => void openImage() },
          { label: zh.menu.openProject, onSelect: () => void openProject() },
          { kind: "sep" },
          { label: zh.menu.saveProject, hint: "Ctrl+S", onSelect: () => void saveProject() },
          { label: zh.menu.exportPng, hint: "Ctrl+Shift+S", onSelect: () => void exportPng() },
          { kind: "sep" },
          { label: zh.editor.closeDoc, hint: "Ctrl+W", onSelect: () => onCloseDoc(doc.id) },
          { label: zh.menu.closeAll, hint: "Ctrl+Alt+W", onSelect: closeAll },
          { kind: "sep" },
          { label: zh.menu.quit, onSelect: onQuit },
        ],
      },
      {
        key: "edit",
        label: zh.menu.edit,
        items: [
          { label: zh.menu.undo, hint: "Ctrl+Z", disabled: !canUndo, onSelect: onUndo },
          { label: zh.menu.redo, hint: "Ctrl+Shift+Z", disabled: !canRedo, onSelect: onRedo },
          { kind: "sep" },
          { label: zh.menu.cut, hint: "Ctrl+X", disabled: !hasSelection, onSelect: doCut },
          { label: zh.menu.copy, hint: "Ctrl+C", onSelect: () => doCopy(false) },
          { label: zh.menu.copyMerged, hint: "Ctrl+Shift+C", onSelect: () => doCopy(true) },
          { label: zh.menu.paste, hint: "Ctrl+V", disabled: !canPaste, onSelect: doPaste },
          { kind: "sep" },
          { label: zh.menu.fillFg, hint: "Alt+Backspace", onSelect: () => doFill(fg) },
          { label: zh.menu.fillBg, hint: "Ctrl+Backspace", onSelect: () => doFill(bg) },
          {
            label: zh.menu.deleteSelection,
            hint: "Delete",
            disabled: !hasSelection,
            onSelect: doDeletePixels,
          },
          // 内容识别填充：与 PS 的「编辑 > 填充 > 内容识别」同源，用选区圈出要抹掉
          // 的东西，按下就用周围纹理补上。没有选区时置灰（不给假按钮）。
          { label: zh.menu.inpaint, disabled: !hasSelection, onSelect: doInpaint },
          { kind: "sep" },
          // 编辑 > 变换：与 PS 同构 —— 自由变换（Ctrl+T）加三个一步到位的翻转 / 旋转。
          // 正在变换时这一栏换成「应用 / 取消」，配合 Enter、Esc，不留死路。
          ...(freeActive
            ? [
                { label: zh.menu.transformApply, hint: "Enter", onSelect: commitFreeTransform },
                { label: zh.menu.transformCancel, hint: "Esc", onSelect: cancelFreeTransform },
              ]
            : [
                {
                  label: zh.menu.transformFree,
                  hint: "Ctrl+T",
                  disabled: !canTransform,
                  onSelect: beginFreeTransform,
                },
                {
                  label: zh.menu.flipH,
                  disabled: !canTransform,
                  onSelect: () => onCommit(flipLayer(doc, "h"), zh.menu.flipH),
                },
                {
                  label: zh.menu.flipV,
                  disabled: !canTransform,
                  onSelect: () => onCommit(flipLayer(doc, "v"), zh.menu.flipV),
                },
                {
                  label: zh.menu.rotateHalf,
                  disabled: !canTransform,
                  onSelect: () => onCommit(rotateLayerHalf(doc), zh.menu.rotateHalf),
                },
              ]),
          { kind: "sep" },
          { label: zh.preferences.title, hint: "P", onSelect: () => setPrefsOpen(true) },
        ],
      },
      {
        key: "select",
        label: zh.menu.select,
        items: [
          { label: zh.menu.selectAll, hint: "Ctrl+A", onSelect: doSelectAll },
          {
            label: zh.menu.deselect,
            hint: "Ctrl+D",
            disabled: !hasSelection,
            onSelect: doDeselect,
          },
          { label: zh.menu.invertSelection, hint: "Ctrl+Shift+I", onSelect: doInvert },
          { kind: "sep" },
          // 选择 > 修改：半径沿用选项条上的「羽化」，在 hint 里印出来
          {
            label: zh.menu.featherSelection,
            hint: `${selRadius} px`,
            disabled: !hasSelection,
            onSelect: doFeather,
          },
          {
            label: zh.menu.expandSelection,
            hint: `+${selRadius} px`,
            disabled: !hasSelection,
            onSelect: doExpand,
          },
          {
            label: zh.menu.contractSelection,
            hint: `-${selRadius} px`,
            disabled: !hasSelection,
            onSelect: doContract,
          },
        ],
      },
      {
        key: "image",
        label: zh.menu.image,
        items: [
          { label: zh.menu.imageSize, hint: "Ctrl+Alt+I", onSelect: () => setSizeDialog("image") },
          { label: zh.menu.canvasSize, hint: "Ctrl+Alt+C", onSelect: () => setSizeDialog("canvas") },
          { label: zh.menu.trimToSelection, onSelect: doTrim },
          { kind: "sep" },
          // 图像旋转 / 翻转画布：连画布一起转，90 度整倍时宽高互换 ——
          // 这就是「不改像素数的前提下把横图变竖图」的正规做法。
          {
            label: zh.menu.rotateDocCw,
            onSelect: () => onCommit(rotateDocument(doc, 90), zh.menu.rotateDocCw),
          },
          {
            label: zh.menu.rotateDocCcw,
            onSelect: () => onCommit(rotateDocument(doc, 270), zh.menu.rotateDocCcw),
          },
          {
            label: zh.menu.flipCanvasH,
            onSelect: () => onCommit(flipDocument(doc, "h"), zh.menu.flipCanvasH),
          },
          {
            label: zh.menu.flipCanvasV,
            onSelect: () => onCommit(flipDocument(doc, "v"), zh.menu.flipCanvasV),
          },
          { kind: "sep" },
          { label: zh.menu.flatten, onSelect: () => onCommit(flattenImage(doc), zh.menu.flatten) },
          { kind: "sep" },
          // 自动色调三项：一键把直方图拉满，与 PS「图像 > 自动色调 / 自动对比度 /
          // 自动颜色」同构。图本来就到位时内核会给「没得改」，界面上不落空历史。
          {
            label: zh.menu.autoTone,
            onSelect: () => doAuto("tone", zh.menu.autoTone),
          },
          {
            label: zh.menu.autoContrast,
            onSelect: () => doAuto("contrast", zh.menu.autoContrast),
          },
          {
            label: zh.menu.autoColor,
            onSelect: () => doAuto("color", zh.menu.autoColor),
          },
          { kind: "sep" },
          ...ADJUST_PRESETS.map((p) => ({
            label: p.label,
            onSelect: () => doAdjust(p.label, p.state),
          })),
        ],
      },
      {
        // 滤镜单独成一栏，与 PS 同构：图像栏管「尺寸 / 拼合 / 调色」，
        // 滤镜栏才是「一次性改变像素观感」的那批效果，两栏不再混着堆。
        key: "filter",
        label: zh.menu.filter,
        items: [
          // 滤镜库：带实时预览的调参面板，比下面的一键预设更适合「慢慢调」。
          { label: zh.menu.filterGallery, onSelect: () => setGallery(true) },
          // 液化：在面板里直接拖着涂，位移场累积，确定才把像素写回图层。
          { label: zh.menu.liquify, onSelect: () => setLiquify(true) },
          { kind: "sep" },
          ...FILTER_PRESETS.map((p) => ({
            label: p.label,
            onSelect: () => doAdjust(p.label, p.state),
          })),
        ],
      },
      {
        // 全部调整都走「新建调整图层」，与 PS 的「图像 > 调整」同源：
        // 参数随时可回改、可删，配合不透明度还能当局部调色用。
        key: "adjust",
        label: zh.menu.adjust,
        items: ADJUST_FAMILY_ORDER.flatMap((fam, fi) => {
          const list = ADJUST_DEFS.filter((d) => d.family === fam);
          if (list.length === 0) return [];
          const head = fi === 0 ? [] : [{ kind: "sep" as const }];
          return [
            ...head,
            ...list.map((d) => ({
              label: d.label,
              onSelect: () =>
                onCommit(addAdjustLayer(doc, newAdjustState(d.id)), zh.layers.adjustAdd),
            })),
          ];
        }),
      },
      {
        key: "layer",
        label: zh.menu.layer,
        items: [
          { label: zh.menu.newLayer, hint: "Ctrl+Shift+N", onSelect: () => onCommit(addLayer(doc), zh.menu.newLayer) },
          { label: zh.menu.duplicateLayer, hint: "Ctrl+J", onSelect: () => onCommit(duplicateLayer(doc), zh.menu.duplicateLayer) },
          { label: zh.menu.deleteLayer, onSelect: () => onCommit(removeLayer(doc), zh.menu.deleteLayer) },
          { kind: "sep" },
          { label: zh.menu.group, hint: "Ctrl+G", onSelect: () => onCommit(groupLayers(doc), zh.menu.group) },
          {
            label: zh.menu.ungroup,
            hint: "Ctrl+Shift+G",
            disabled: doc.layers[at]?.kind !== "group",
            onSelect: () => onCommit(ungroupLayers(doc), zh.menu.ungroup),
          },
          { kind: "sep" },
          { label: zh.menu.mergeDown, hint: "Ctrl+E", disabled: !mergeOk, onSelect: () => onCommit(mergeDown(doc), zh.menu.mergeDown) },
          { label: zh.menu.moveLayerUp, disabled: !canShiftLayer(doc, 1), onSelect: () => onCommit(moveLayer(doc, 1), zh.menu.moveLayerUp) },
          { label: zh.menu.moveLayerDown, disabled: !canShiftLayer(doc, -1), onSelect: () => onCommit(moveLayer(doc, -1), zh.menu.moveLayerDown) },
        ],
      },
      {
        key: "view",
        label: zh.menu.view,
        items: [
          { label: zh.menu.resetView, hint: "Ctrl+0", onSelect: fit },
          { label: zh.menu.actualSize, hint: "Ctrl+1", onSelect: () => zoom(1) },
          { kind: "sep" },
          { label: zh.menu.zoomIn, hint: "Ctrl++", onSelect: () => zoom(scale * ZOOM_STEP) },
          { label: zh.menu.zoomOut, hint: "Ctrl+-", onSelect: () => zoom(scale / ZOOM_STEP) },
          { kind: "sep" },
          { label: zh.menu.toggleRulers, hint: "Ctrl+R", onSelect: () => setShowRulers((v) => !v) },
          { label: zh.menu.toggleGrid, hint: "Ctrl+'", onSelect: () => setShowGrid((v) => !v) },
        ],
      },
      {
        key: "help",
        label: zh.menu.help,
        items: [
          { label: zh.menu.shortcuts, onSelect: () => setModal("shortcuts") },
          { label: zh.menu.palette, hint: "Ctrl+K", onSelect: () => setPalette(true) },
          { kind: "sep" },
          { label: zh.menu.about, onSelect: () => setModal("about") },
        ],
      },
    ],
    [
      at,
      bg,
      beginFreeTransform,
      canPaste,
      canRedo,
      canTransform,
      canUndo,
      cancelFreeTransform,
      commitFreeTransform,
      doAdjust,
      doContract,
      doCopy,
      doCut,
      doDeletePixels,
      doDeselect,
      doExpand,
      doFeather,
      doFill,
      doInvert,
      doPaste,
      doSelectAll,
      doTrim,
      closeAll,
      doc,
      exportPng,
      fg,
      fit,
      hasSelection,
      freeActive,
      mergeOk,
      newCanvas,
      onCloseDoc,
      onCommit,
      onQuit,
      onRedo,
      onUndo,
      openImage,
      openProject,
      saveProject,
      scale,
      selRadius,
      zoom,
    ],
  );

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    for (const g of TOOL_GROUPS) {
      for (const t of toolsInGroup(g)) {
        list.push({
          id: `tool.${t.id}`,
          label: zh.tools[t.id],
          hint: t.shortcut,
          group: GROUP_LABEL[g],
          run: () => pickTool(t.id),
        });
      }
    }
    for (const mg of menuGroups) {
      for (const it of mg.items) {
        if (it.kind === "sep" || it.disabled || !it.onSelect) continue;
        list.push({
          id: `menu.${mg.key}.${it.label}`,
          label: it.label,
          hint: it.hint,
          group: mg.label,
          run: it.onSelect,
        });
      }
    }
    return list;
  }, [menuGroups, pickTool]);

  /* ---------------------------------------------------------------- 快捷键 */

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (e.key === " ") {
      const el = e.target as HTMLElement | null;
      const typing =
        el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable;
      if (!typing && !spaceDown) setSpaceDown(true);
      return;
    }
    if (e.key === "Escape") {
      // 变换进行中：Esc 优先放弃变换（PS 的老规矩）
      if (cancelFreeTransform()) return;
      if (strokeRef.current) {
        resetGesture();
        render();
      }
      return;
    }
    const el = e.target as HTMLElement | null;
    if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable) return;

    // Enter：把进行中的自由变换落库（放在输入框早退之后，打字时不受影响）
    if (e.key === "Enter" && commitFreeTransform()) {
      e.preventDefault();
      return;
    }

    const mod = e.ctrlKey || e.metaKey;
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setPalette((v) => !v);
        return;
      }
      if (k === "z") {
        e.preventDefault();
        if (e.shiftKey) onRedo();
        else onUndo();
        return;
      }
      if (k === "y") {
        e.preventDefault();
        onRedo();
        return;
      }
      if (k === "0") {
        e.preventDefault();
        fit();
        return;
      }
      if (k === "1" || k === "=" || k === "+") {
        e.preventDefault();
        zoom(1);
        return;
      }
      if (k === "-") {
        e.preventDefault();
        zoom(scale / ZOOM_STEP);
        return;
      }
      if (k === "w" && e.altKey) {
        e.preventDefault();
        closeAll();
        return;
      }
      if (k === "w") {
        e.preventDefault();
        onCloseDoc(doc.id);
        return;
      }
      // Ctrl+T：自由变换（PS 的老习惯）
      if (k === "t") {
        e.preventDefault();
        beginFreeTransform();
        return;
      }
      // Ctrl+N 新建画布；Ctrl+Shift+N 是新建图层，两者得分开，否则后者被前者吃掉
      if (k === "n" && !e.shiftKey) {
        e.preventDefault();
        newCanvas();
        return;
      }
      if (k === "s" && e.shiftKey) {
        e.preventDefault();
        void exportPng();
        return;
      }
      if (k === "s") {
        e.preventDefault();
        void saveProject();
        return;
      }
      if (k === "o") {
        e.preventDefault();
        void openImage();
        return;
      }
      if (k === "e" && e.altKey) {
        e.preventDefault();
        void exportPng();
        return;
      }
      if (k === "a") {
        e.preventDefault();
        doSelectAll();
        return;
      }
      if (k === "d") {
        e.preventDefault();
        doDeselect();
        return;
      }
      if (k === "i" && e.shiftKey) {
        e.preventDefault();
        doInvert();
        return;
      }
      // 图像大小 / 画布大小
      if (k === "i" && e.altKey) {
        e.preventDefault();
        setSizeDialog("image");
        return;
      }
      if (k === "c" && e.altKey) {
        e.preventDefault();
        setSizeDialog("canvas");
        return;
      }
      // 视图 > 网格（Ctrl+'，跟 PS 一致）
      if (k === "'") {
        e.preventDefault();
        setShowGrid((v) => !v);
        return;
      }
      // 视图 > 标尺（Ctrl+R）
      if (k === "r" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setShowRulers((v) => !v);
        return;
      }
      // 剪切 / 复制 / 复制合并 / 粘贴（PS 的老习惯）
      if (k === "x") {
        e.preventDefault();
        if (hasSelection) doCut();
        return;
      }
      if (k === "c") {
        e.preventDefault();
        doCopy(e.shiftKey);
        return;
      }
      if (k === "v") {
        e.preventDefault();
        doPaste();
        return;
      }
      // 图层三连：菜单里既然印了快捷键，按下就得有反应
      if (k === "n" && e.shiftKey) {
        e.preventDefault();
        onCommit(addLayer(doc), zh.menu.newLayer);
        return;
      }
      if (k === "j") {
        e.preventDefault();
        onCommit(duplicateLayer(doc), zh.menu.duplicateLayer);
        return;
      }
      // Ctrl+G 编组 / Ctrl+Shift+G 取消编组（跟 PS 一致）
      if (k === "g") {
        e.preventDefault();
        if (e.shiftKey) onCommit(ungroupLayers(doc), zh.menu.ungroup);
        else onCommit(groupLayers(doc), zh.menu.group);
        return;
      }
      if (k === "e") {
        e.preventDefault();
        if (mergeOk) onCommit(mergeDown(doc), zh.menu.mergeDown);
        return;
      }
      if (k === "backspace") {
        e.preventDefault();
        doFill(bg);
        return;
      }
      return;
    }

    // Alt+Backspace：用前景色填充选区（PS 的老习惯，落在 alt 早退之前）
    if (e.altKey && e.key === "Backspace") {
      e.preventDefault();
      doFill(fg);
      return;
    }
    if (e.key === "Delete") {
      e.preventDefault();
      doDeletePixels();
      return;
    }
    if (e.altKey) return;
    // P：随时呼出偏好设置（不占 ctrl 组合，PS 的老习惯）
    if (e.key.toLowerCase() === "p" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setPrefsOpen((v) => !v);
      return;
    }
    // F5：画笔设置面板（PS 的 F5 同义）
    if (e.key === "F5" && usesBrush(tool)) {
      e.preventDefault();
      setBrushPanelOpen((v) => !v);
      return;
    }
    // Shift + [ / ]：调硬度（PS 的老习惯），画笔与修饰工具共用同一套按键
    if (
      e.shiftKey &&
      (e.key === "[" || e.key === "]") &&
      (usesBrush(tool) || isRetouchTool(tool))
    ) {
      e.preventDefault();
      const d = e.key === "[" ? -10 : 10;
      if (usesBrush(tool)) {
        setBrush((b) => ({ ...b, hardness: Math.min(100, Math.max(0, b.hardness + d)) }));
      } else {
        setRetouch((r) => ({ ...r, hardness: Math.min(100, Math.max(0, r.hardness + d)) }));
      }
      return;
    }
    if (e.key === "[") {
      setBrush((b) => ({ ...b, size: Math.max(1, b.size - 4) }));
      return;
    }
    if (e.key === "]") {
      setBrush((b) => ({ ...b, size: Math.min(MAX_BRUSH, b.size + 4) }));
      return;
    }
    if (e.key.toLowerCase() === "x") {
      swapColors();
      return;
    }
    const id = toolByShortcut(e.key);
    if (id) pickTool(id);
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => keyRef.current(e);
    const up = (e: KeyboardEvent) => {
      if (e.key === " ") setSpaceDown(false);
    };
    const blur = () => setSpaceDown(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  /* ------------------------------------------------------------------ 渲染 */

  const panning = spaceDown || tool === "hand";

  // 文本框贴着落点走：宽到画布右沿为止，字号与行距都跟着缩放，
  // 所见即所得 —— 输入框里看到的行宽与确认后落在画布上的像素一一对应。
  const textBoxWidth = textEdit
    ? Math.max(200, docW * scale - textEdit.x * scale - 8)
    : 0;
  const textBoxFont = textEdit ? fontString({ ...textSet, size: textSet.size * scale }) : "";
  const textBoxLine = textEdit
    ? Math.max(1, Math.round(textSet.size * textSet.lineHeight)) * scale
    : 0;
  const textBoxRows = textEdit ? Math.max(1, textEdit.value.split("\n").length) : 1;

  return (
    <div className="editor">
      <header className="editor-top">
        <BrandMark size={22} />
        <AppMenuBar groups={menuGroups} />
        <div className="editor-ws" role="group" aria-label={zh.editor.workspace} title={zh.editor.workspaceHint}>
          <button
            type="button"
            className={workspace === "photo" ? "ws-btn is-on" : "ws-btn"}
            onClick={() => pickWorkspace("photo")}
          >
            {zh.editor.workspacePhoto}
          </button>
          <button
            type="button"
            className={workspace === "paint" ? "ws-btn is-on" : "ws-btn"}
            onClick={() => pickWorkspace("paint")}
          >
            {zh.editor.workspacePaint}
          </button>
        </div>
        <span className="editor-gap" />
        <div className="editor-top-actions">
          <span className="zoom-label">{Math.round(scale * 100)}%</span>
          <button type="button" className="btn-ghost btn-sm" onClick={fit} title={zh.editor.fit}>
            {zh.editor.fit}
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => zoom(1)} title={zh.editor.zoom100}>
            {zh.editor.zoom100}
          </button>
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => setPalette(true)}
            title={zh.palette.open}
          >
            Ctrl+K
          </button>
          <span className="top-divider" />
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => setPrefsOpen(true)}
            title={`${zh.preferences.title}（P）`}
          >
            {zh.preferences.title}
          </button>
          <button type="button" className="btn-primary btn-sm" onClick={() => void exportPng()}>
            {zh.editor.exportPng}
          </button>
        </div>
      </header>

      <div className="editor-tabs" role="tablist" aria-label={zh.editor.tabs}>
        {docs.map((d) => (
          <div
            key={d.id}
            role="tab"
            aria-selected={d.id === doc.id}
            className={d.id === doc.id ? "tab is-on" : "tab"}
            onClick={() => onSelectDoc(d.id)}
          >
            <span className="tab-name" title={d.name}>
              {d.name}
            </span>
            {d.dirty && <span className="tab-dot" aria-hidden="true" />}
            <button
              type="button"
              className="tab-x"
              aria-label={zh.editor.closeTab}
              onClick={(e) => {
                e.stopPropagation();
                onCloseDoc(d.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="editor-main">
        <ToolRail
          tool={tool}
          onSelect={pickTool}
          fg={fg}
          bg={bg}
          onFg={setFg}
          onBg={setBg}
          onSwap={swapColors}
          onOpenPrefs={() => setPrefsOpen(true)}
          flyout={(id) => (
            <ToolFlyout
              tool={id}
              brush={brush}
              onBrush={(patch) => setBrush((b) => ({ ...b, ...patch }))}
              fg={fg}
              bg={bg}
              onFg={setFg}
              onBg={setBg}
              onSwap={swapColors}
              onResetColors={resetColors}
              onFit={fit}
              onActual={() => zoom(1)}
            />
          )}
        />
        <div className="editor-center">
          <OptionsBar
            tool={tool}
            brush={brush}
            onBrush={(patch) => setBrush((b) => ({ ...b, ...patch }))}
            retouch={retouch}
            onRetouch={(patch) => setRetouch((r) => ({ ...r, ...patch }))}
            shape={shape}
            onShape={(patch) => setShape((s2) => ({ ...s2, ...patch }))}
            text={textSet}
            onText={(patch) => setTextSet((t) => ({ ...t, ...patch }))}
            fg={fg}
            bg={bg}
            onFg={setFg}
            onBg={setBg}
            onSwap={swapColors}
            onResetColors={resetColors}
            gradientStyle={gradientStyle}
            onGradientStyle={setGradientStyle}
            gradientReverse={gradientReverse}
            onGradientReverse={setGradientReverse}
            tolerance={tolerance}
            onTolerance={setTolerance}
            selectionMode={selectionMode}
            onSelectionMode={setSelectionMode}
            feather={feather}
            onFeather={setFeather}
            contiguous={contiguous}
            onContiguous={setContiguous}
            docSize={docSize}
            onOpenBrushPanel={() => setBrushPanelOpen(true)}
          />
          <div className="editor-viewport" ref={viewportRef}>
            <div
              className="editor-stage"
              style={{
                width: docW * scale,
                height: docH * scale,
                transform: `translate(${pan.x}px, ${pan.y}px)`,
              }}
            >
              <canvas
                ref={canvasRef}
                className="editor-canvas"
                style={{ cursor: cursorOf(tool, panning) }}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                onPointerLeave={hideCursor}
                onContextMenu={(e) => e.preventDefault()}
              />
              {/* 蚂蚁线 / 裁剪遮罩浮层：只负责画，不接事件 */}
              <canvas ref={overlayRef} className="editor-overlay" aria-hidden="true" />
              {/* 网格：跟随缩放的重复线，只作视觉参考 */}
              {showGrid && (
                <div
                  className="editor-grid"
                  aria-hidden="true"
                  style={{ backgroundSize: `${64 * scale}px ${64 * scale}px` }}
                />
              )}
              {/* 标尺：贴着画布上沿 / 左沿的刻度条，随缩放和对齐画布原点 */}
              {showRulers && (
                <>
                  <div
                    className="editor-ruler editor-ruler-h"
                    aria-hidden="true"
                    style={{ backgroundSize: `${100 * scale}px 100%, ${10 * scale}px 100%` }}
                  />
                  <div
                    className="editor-ruler editor-ruler-v"
                    aria-hidden="true"
                    style={{ backgroundSize: `100% ${100 * scale}px, 100% ${10 * scale}px` }}
                  />
                </>
              )}
              {/* 跟随光标：笔尖圆圈 / 吸管取样环，纯展示，不接事件 */}
              <div className="editor-cursor" ref={cursorRef} data-mode="none" aria-hidden="true">
                <div className="editor-cursor-ring" ref={cursorRingRef} />
                <div className="editor-cursor-dot" />
                <div className="editor-cursor-pick">
                  <span className="editor-cursor-swatch" ref={cursorSwatchRef} />
                  <span className="editor-cursor-hex" ref={cursorHexRef}>#000000</span>
                </div>
              </div>
              {/* 文字输入：贴在落点上的输入框，字号 / 行距 / 对齐与最终像素一致。
                  确认后整段栅格化成像素，之后与画笔画的没有任何区别。 */}
              {textEdit && (
                <div
                  className="editor-textbox"
                  style={{ left: textEdit.x * scale, top: textEdit.y * scale }}
                >
                  <textarea
                    className="editor-textarea"
                    autoFocus
                    wrap="off"
                    spellCheck={false}
                    rows={textBoxRows}
                    value={textEdit.value}
                    placeholder={zh.options.textPlaceholder}
                    aria-label={zh.tools.text}
                    onChange={(e) =>
                      setTextEdit((v) => (v ? { ...v, value: e.target.value } : v))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setTextEdit(null);
                        return;
                      }
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        commitText();
                      }
                    }}
                    style={{
                      width: `${textBoxWidth}px`,
                      font: textBoxFont,
                      lineHeight: `${textBoxLine}px`,
                      color: fg,
                      textAlign: textSet.align,
                    }}
                  />
                  <div className="editor-textbox-bar">
                    <button type="button" className="btn-primary btn-sm" onClick={commitText}>
                      {zh.dialog.confirm}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-sm"
                      onClick={() => setTextEdit(null)}
                    >
                      {zh.dialog.cancel}
                    </button>
                    <span className="editor-textbox-hint">{zh.options.textCommitHint}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="editor-right">
          <ColorPanel
            fg={fg}
            bg={bg}
            onFg={setFg}
            onBg={setBg}
            onSwap={swapColors}
            onReset={resetColors}
            onPickTool={pickTool}
          />
          <LayersPanel
            doc={doc}
            onChange={onCommit}
            onPreview={onPreview}
            maskEdit={maskEdit}
            onMaskEdit={setMaskEdit}
            historyLabels={historyLabels}
            historyIndex={historyIndex}
            onHistoryJump={onHistoryJump}
            channelVis={channelVis}
            activeChannel={activeChannel}
            onChannel={pickChannel}
          />
        </div>
      </div>

      <StatusBar doc={doc} scale={scale} tool={tool} />

      {palette && (
        <CommandPalette commands={commands} onClose={() => setPalette(false)} />
      )}
      {modal !== null && (
        <InfoModals which={modal} info={info} onClose={() => setModal(null)} />
      )}
      {sizeDialog !== null && (
        <ImageSizeDialog
          mode={sizeDialog}
          width={doc.width}
          height={doc.height}
          onApply={(w, h, anchor) =>
            onCommit(
              sizeDialog === "image"
                ? resizeDocument(doc, w, h)
                : resizeCanvas(doc, w, h, anchor),
              sizeDialog === "image" ? zh.dialog.imageSizeTitle : zh.dialog.canvasSizeTitle,
            )
          }
          onClose={() => setSizeDialog(null)}
        />
      )}
      {gallery && (
        <FilterGallery
          doc={doc}
          onPreview={onPreview}
          onApply={(next) => {
            setGallery(false);
            onCommit(next, zh.dialog.filterTitle);
          }}
          onClose={() => setGallery(false)}
        />
      )}
      {liquify && (
        <LiquifyDialog
          doc={doc}
          themeMode={themeMode}
          onApply={(next) => {
            setLiquify(false);
            onCommit(next, zh.liquify.title);
          }}
          onClose={() => setLiquify(false)}
        />
      )}
      {brushPanelOpen && usesBrush(tool) && (
        <BrushSettingsPanel
          brush={brush}
          isEraser={tool === "eraser"}
          onBrush={(patch) => setBrush((b) => ({ ...b, ...patch }))}
          onClose={() => setBrushPanelOpen(false)}
        />
      )}
      {prefsOpen && (
        <Preferences
          onClose={() => setPrefsOpen(false)}
          themeMode={themeMode}
          onSetTheme={onSetTheme}
          brush={brush}
          onBrush={(patch) => setBrush((b) => ({ ...b, ...patch }))}
        />
      )}
      {error && <div className="editor-errorbar">{error}</div>}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
