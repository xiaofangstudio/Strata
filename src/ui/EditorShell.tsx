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
  cloneDoc,
  docFromBitmap,
  docFromBlank,
  nextDocId,
  type StrataDoc,
} from "../core/document";
import { DEFAULT_DPI, PRESETS } from "../core/presets";
import {
  addAdjustLayer,
  addFillLayer,
  addLayer,
  addLayerStyle,
  addMaskFromSelection,
  addMaskFromTransparency,
  addMask,
  applyAdjustToLayer,
  applyMask,
  canShiftLayer,
  clearLayerStyle,
  clipHasContent,
  clipSize,
  copyLayerStyle,
  copyToClipboard,
  cropDocument,
  cutSelection,
  deleteHiddenLayers,
  deleteSelection,
  duplicateLayer,
  fillSelection,
  flattenImage,
  grayscaleDocument,
  groupLayers,
  hasStyle,
  invertMask,
  layerViaCopy,
  layerViaCut,
  mergeDown,
  mergeVisible,
  moveLayer,
  pasteFromClipboard,
  pasteLayerStyle,
  placeRaster,
  removeLayer,
  removeMask,
  renameLayer,
  resizeCanvas,
  resizeDocument,
  reverseLayerOrder,
  setSelection,
  strokeSelection,
  toggleClip,
  toggleMaskActive,
  translateLayer,
  trimToSelection,
  ungroupLayers,
  updateLayer,
  type StrokePosition,
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
import { adjustDef, newAdjustState, type AdjustId, type AdjustState, type StyleId } from "../core/layer";
import {
  borderSelection,
  cloneSelection,
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
  smoothSelection,
  wandMask,
  type Point,
  type SelectionMask,
  type SelectionMode,
} from "../core/selection";
import {
  DEFAULT_CHANNEL_VIS,
  applyChannelView,
  applyAlphaChannelView,
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
import { useRecentFiles } from "../stores/recent";
import { openUrl } from "@tauri-apps/plugin-opener";
import AppMenuBar, { type MenuEntry, type MenuGroup } from "./components/AppMenuBar";
import ContextMenu, { type ContextMenuState } from "./components/ContextMenu";
import {
  appendToGroup,
  buildMenuGroups,
  insertAfterId,
  type MenuResolver,
  type MenuState,
} from "./components/menuCatalog";
import {
  probeReelix,
  sendToReelix,
  type ReelixLinkState,
} from "../services/reelixLink";
import BrandMark from "./components/BrandMark";
import CommandPalette, { type Command } from "./components/CommandPalette";
import FilterGallery from "./components/FilterGallery";
import FilterFxDialog from "./components/FilterFxDialog";
import {
  ChannelCalcDialog,
  LoadSelectionDialog,
  SaveSelectionDialog,
} from "./components/ChannelDialogs";
import RefineEdgeDialog from "./components/RefineEdgeDialog";
import { filterDef } from "../engine/filters/defs";
import { alphaChannelsOf } from "../core/channelOps";
import InfoModals, { type InfoModalKind } from "./components/InfoModals";
import ImageSizeDialog from "./components/ImageSizeDialog";
import Modal from "./components/Modal";
import ColorChip from "./components/ColorChip";
import { Check } from "./components/controls";
import ColorPanel from "./components/ColorPanel";
import LiquifyDialog from "./components/LiquifyDialog";
import LayersPanel from "./components/LayersPanel";
import HistoryPanel from "./components/HistoryPanel";
import HistogramPanel from "./components/HistogramPanel";
import ScopesPanel from "./components/ScopesPanel";
import NavigatorPanel from "./components/NavigatorPanel";
import PropertiesPanel from "./components/PropertiesPanel";
import RightDock, { type GroupId as DockGroupId } from "./components/RightDock";
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
/** 网格间距（文档像素），与 .editor-grid 的 background-size 一致 */
const GRID_STEP = 64;

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

/**
 * 菜单里的对话框式命令重定向到「新建调整图层」：
 * 与 PS 的「图像 > 调整」同源 —— 参数随时可回改、可删。
 */
function preset(id: AdjustId, params: Record<string, number> = {}): AdjustState {
  const s = newAdjustState(id);
  return { ...s, params: { ...s.params, ...params } };
}

/** 项目主页与问题反馈地址（帮助菜单用真实链接，不摆假入口）。 */
const REPO_URL = "https://github.com/xiaofangstudio/Strata";
const ISSUES_URL = `${REPO_URL}/issues`;

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
  /** 魔棒「对所有图层取样」：开着时按合成结果取色，而不是只看当前层 */
  const [sampleAllLayers, setSampleAllLayers] = useState(false);
  /** 通用右键菜单（画布 / 图层面板共用一个浮层） */
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [palette, setPalette] = useState(false);
  const [modal, setModal] = useState<InfoModalKind>(null);
  const [sizeDialog, setSizeDialog] = useState<"image" | "canvas" | null>(null);
  /** 滤镜库：左侧选滤镜、右侧拖参数，实时预览，确定才落盘进历史 */
  const [gallery, setGallery] = useState(false);
  /** 滤镜参数弹窗：值为滤镜菜单 id（filter.blur.gaussianBlur 等），null 关闭 */
  const [filterFx, setFilterFx] = useState<string | null>(null);
  /** 液化：面板内自己拖着涂，确定才把形变后的像素写回图层 */
  const [liquify, setLiquify] = useState(false);
  /** 视图 > 网格：纯装饰浮层，不影响像素，也不进历史 */
  const [showGrid, setShowGrid] = useState(false);
  /** 视图 > 标尺：同上，只是刻度条 */
  const [showRulers, setShowRulers] = useState(false);
  /** 视图 > 参考线：标尺里拖出来的对齐线，与网格同属「看」的浮层 */
  const [showGuides, setShowGuides] = useState(true);
  /** 视图 > 锁定参考线：锁定后参考线不可拖动 / 删除 */
  const [guidesLocked, setGuidesLocked] = useState(false);
  /** 参考线本体（文档坐标，像素）：x 是竖线、y 是横线 */
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  /** 视图 > 额外内容（Ctrl+H）：总开关，关掉时网格与参考线一并隐藏 */
  const [extras, setExtras] = useState(true);
  /** 视图 > 像素网格：高倍缩放时的逐像素格子 */
  const [showPixelGrid, setShowPixelGrid] = useState(false);
  /** 视图 > 对齐（吸附）：拖动选区 / 裁剪时贴着参考线与画布边 */
  const [snapOn, setSnapOn] = useState(true);
  const [snapGuides, setSnapGuides] = useState(true);
  const [snapBounds, setSnapBounds] = useState(true);
  /** 对齐到网格（视图 > 对齐到 > 网格） */
  const [snapGrid, setSnapGrid] = useState(false);
  /** 新建参考线对话框；pos 以字符串保存，方便输入中间态 */
  const [guideDialog, setGuideDialog] = useState<{ axis: "x" | "y"; pos: string } | null>(null);
  /** 描边对话框：宽度 / 颜色 / 位置 / 不透明度，数字字段用字符串保存输入中间态 */
  const [strokeDialog, setStrokeDialog] = useState<{
    width: string;
    color: string;
    position: StrokePosition;
    opacity: string;
  } | null>(null);
  /** 重命名图层对话框：id 锁定目标图层，name 保存输入中间态 */
  const [renameDialog, setRenameDialog] = useState<{ id: string; name: string } | null>(null);
  /** 新建参考线版面：按行列自动铺线，字段用字符串保存输入中间态 */
  const [layoutDialog, setLayoutDialog] = useState<{
    cols: string;
    rows: string;
    colGutter: string;
    rowGutter: string;
    margin: string;
    clear: boolean;
  } | null>(null);
  /** 智能参考线：拖动时贴出尺寸标注，并与画布中线 / 参考线拉出对齐提示 */
  const [smartGuides, setSmartGuides] = useState(true);
  /** Tab 沉浸模式：收起工具轨 / 选项栏 / 面板坞 / 状态栏，只留画布 */
  const [hidePanels, setHidePanels] = useState(false);
  /** 视口尺寸（导航器面板要拿它画视口框），由 ResizeObserver 跟踪 */
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 });
  /** 直方图 / 导航器的帧号：合成每前进一次（节流 250ms）就 +1 */
  const [panelTick, setPanelTick] = useState(0);
  const [prefsOpen, setPrefsOpen] = useState(false);
  /** 画笔设置面板（F5）：一个面板里容纳 PhotoCraft 的全部笔刷 section */
  const [brushPanelOpen, setBrushPanelOpen] = useState(false);
  /** 右侧面板坞的开关：由「窗口 > 颜色 / 属性 / 图层 / 历史」直接控制。 */
  const [dockOpen, setDockOpen] = useState<Record<DockGroupId, boolean>>({
    props: true,
    color: true,
    layers: true,
    history: false,
    navigator: false,
    histogram: false,
    scopes: false,
  });
  const { items: recentItems, push: pushRecent, clear: clearRecent } = useRecentFiles();
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [spaceDown, setSpaceDown] = useState(false);
  /** 是否正在编辑蒙版（画笔落在蒙版上而不是图层像素上） */
  const [maskEdit, setMaskEdit] = useState(false);
  /** 快速蒙版：开着时红宝石膜盖在画面上，画笔直接改临时蒙版（Q 切换） */
  const [quickMask, setQuickMask] = useState(false);
  const qmRef = useRef<HTMLCanvasElement | null>(null);
  const qmTintRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * 通道视图：哪些原色参与合成 + 当前单独查看哪个通道。
   * 与蒙版编辑态一样属于「看」而不是「改」—— 一个像素都不动、不进历史，
   * 切文档时一并复位，免得换一份图还停在偏色的画面上。
   */
  const [channelVis, setChannelVis] = useState<ChannelVis>(DEFAULT_CHANNEL_VIS);
  const [activeChannel, setActiveChannel] = useState<ChannelId>("rgb");
  /** 正在灰度查看的 Alpha 通道 id（null = 没在看）；与上面同一套「只看不改」逻辑 */
  const [viewAlpha, setViewAlpha] = useState<string | null>(null);
  /** 通道对话框：存储选区 / 载入选区 / 通道运算，null = 关闭 */
  const [saveSelOpen, setSaveSelOpen] = useState(false);
  const [loadSelOpen, setLoadSelOpen] = useState(false);
  const [calcOpen, setCalcOpen] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  /** 选区组合方式（选项条的四态：新建 / 添加 / 减去 / 交叉） */
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("new");
  /** 羽化半径（像素），矩形 / 椭圆 / 套索用 */
  const [feather, setFeather] = useState(0);
  /** 魔棒是否只取与落点相连的一片 */
  const [contiguous, setContiguous] = useState(true);
  /** 是否正在拉选区 / 裁剪框（驱动蚂蚁线浮层的动画只在拖动时开动） */
  const [selDragging, setSelDragging] = useState(false);
  /** 多边形套索：已落的顶点（文档坐标）；null 表示还没开始画 */
  const [polyPts, setPolyPts] = useState<{ x: number; y: number }[] | null>(null);
  const polyModeRef = useRef<SelectionMode>("new");
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
  /** 正在拖动的参考线：axis 是线的方向（"x" 竖线 / "y" 横线），from 是被拖那条的下标 */
  const guideDragRef = useRef<{ axis: "x" | "y"; index: number; pos: number } | null>(null);
  /** 从标尺往画布里拉新参考线的进行态 */
  const rulerDragRef = useRef<{ axis: "x" | "y" } | null>(null);
  /** 标尺拖线时指针是否已经进入画布（没进就松手 = 不创建） */
  const rulerInsideRef = useRef(false);
  /** 面板帧节流：直方图 / 导航器最多 250ms 刷新一次 */
  const lastPanelRef = useRef(0);
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
    setViewAlpha(null);
    // 参考线属于视图状态：换文档时一并清空，免得 A 图的参考线跑到 B 图上
    setGuides({ x: [], y: [] });
  }, [docId]);

  /** 视口尺寸跟踪：导航器画视口框要用（缩放窗口 / 开关面板时都会变） */
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewportSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setViewportSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  /** 通道页回调：只改视图状态，不碰文档、不入历史。 */
  const pickChannel = useCallback((vis: ChannelVis, active: ChannelId) => {
    setChannelVis(vis);
    setActiveChannel(active);
    // 切到颜色通道视图时，顺手退出 Alpha 通道灰度查看（两者互斥）
    setViewAlpha(null);
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
      // Alpha 通道灰度查看：在合成与颜色通道视图之上再叠一道显示滤镜
      if (viewAlpha) {
        const ch = alphaChannelsOf(doc).find((x) => x.id === viewAlpha);
        if (ch) applyAlphaChannelView(c, ch.mask);
      }
      // 直方图 / 导航器读的就是这张 comp：节流 250ms 推一帧，画笔连扫时不拖后腿
      const now = performance.now();
      if (now - lastPanelRef.current > 250) {
        lastPanelRef.current = now;
        setPanelTick((t) => t + 1);
      }
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

    // 快速蒙版：合成照旧，画笔这一笔直接叠进临时蒙版；屏幕上再蒙一层红色
    // 宝石膜（涂到的地方 = 退出时会取消选中的地方），与 PS 的行为一致。
    if (quickMask && qmRef.current) {
      const qm = qmRef.current;
      let eff = qm;
      if (stroke) {
        eff = cloneSurface(qm);
        const mctx = mustCtx(eff);
        mctx.save();
        mctx.globalAlpha = brush.opacity / 100;
        mctx.globalCompositeOperation =
          tool === "eraser" ? "destination-out" : "source-over";
        mctx.drawImage(stroke.buffer, 0, 0);
        mctx.restore();
      }
      composeDoc(doc, comp);
      present();
      // 宝石膜：蒙版 alpha 染红、半透明盖上（Tint 缓存画布，尺寸不符再重建）
      let tint = qmTintRef.current;
      if (!tint || tint.width !== docW || tint.height !== docH) {
        tint = createSurface(docW, docH);
        qmTintRef.current = tint;
      }
      const tctx = mustCtx(tint);
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.globalAlpha = 1;
      tctx.globalCompositeOperation = "source-over";
      tctx.filter = "none";
      tctx.clearRect(0, 0, docW, docH);
      tctx.drawImage(eff, 0, 0);
      tctx.globalCompositeOperation = "source-in";
      tctx.fillStyle = "#ff2d55";
      tctx.fillRect(0, 0, docW, docH);
      tctx.globalCompositeOperation = "source-over";
      const vc = mustCtx(c);
      vc.save();
      vc.globalAlpha = 0.5;
      vc.drawImage(tint, 0, 0, docW, docH, 0, 0, c.width, c.height);
      vc.restore();
      return;
    }

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
  }, [doc, docW, docH, brush.opacity, tool, maskEdit, quickMask, channelVis, activeChannel, viewAlpha, scale]);

  /**
   * 文档变了就重画 —— 但攒到下一帧统一画一次。
   *
   * 之前这里直接同步 `render()`：一次拖动里浏览器会送来几十次输入，
   * 每一次都各自触发一次整档合成（大图上几百毫秒），任务排着队累积，
   * 表现就是「松手才跳过去、之后还要追好几秒」。改成按帧合并后，
   * 一帧内再多次变更也只合成一次，且用的是这一帧的最新值。
   */
  const renderRef = useRef(render);
  renderRef.current = render;
  const docRafRef = useRef(0);
  useEffect(() => {
    if (docRafRef.current) return;
    docRafRef.current = requestAnimationFrame(() => {
      docRafRef.current = 0;
      renderRef.current();
    });
  }, [render]);
  useEffect(
    () => () => {
      if (docRafRef.current) cancelAnimationFrame(docRafRef.current);
    },
    [],
  );

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

  /**
   * 吸附：把落点吸到最近的参考线 / 画布边。
   * 阈值按 6 个屏幕像素折算回文档坐标，所以放大时手感不会变松。
   */
  const snapPoint = useCallback(
    (x: number, y: number, thr = 6 / scale) => {
      if (!snapOn) return { x, y };
      let sx = x;
      let sy = y;
      if (snapGuides) {
        for (const gx of guides.x) {
          if (Math.abs(x - gx) <= thr) {
            sx = gx;
            break;
          }
        }
        for (const gy of guides.y) {
          if (Math.abs(y - gy) <= thr) {
            sy = gy;
            break;
          }
        }
      }
      if (snapGrid) {
        const gx = Math.round(sx / GRID_STEP) * GRID_STEP;
        const gy = Math.round(sy / GRID_STEP) * GRID_STEP;
        if (Math.abs(sx - gx) <= thr) sx = gx;
        if (Math.abs(sy - gy) <= thr) sy = gy;
      }
      if (snapBounds) {
        if (Math.abs(sx) <= thr) sx = 0;
        else if (Math.abs(sx - docW) <= thr) sx = docW;
        if (Math.abs(sy) <= thr) sy = 0;
        else if (Math.abs(sy - docH) <= thr) sy = docH;
      }
      return { x: sx, y: sy };
    },
    [snapOn, snapGuides, snapGrid, snapBounds, guides, docW, docH, scale],
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

  /** 多边形套索收尾：顶点闭合成选区（走与自由套索同一条遮罩路）。 */
  const commitPoly = useCallback(
    (pts: { x: number; y: number }[]) => {
      setPolyPts(null);
      const shape = lassoMask(docW, docH, pts, feather);
      commitSelection(combineSelection(doc.selection, shape, polyModeRef.current));
    },
    [doc, docW, docH, feather, commitSelection],
  );

  /**
   * 快速蒙版切换（Q）。
   * 进入：选区取反成「红色保护区」蒙版 —— 红的地方就是没选中的地方；
   * 退出：蒙版再取反回选区，一笔历史进账（蒙版内的涂抹本身不进历史）。
   */
  const toggleQuickMask = useCallback(() => {
    if (!quickMask) {
      qmRef.current = doc.selection
        ? invertSelection(cloneSelection(doc.selection))
        : createSurface(docW, docH);
      setQuickMask(true);
      setToast(zh.editor.quickMaskOn);
    } else {
      const m = qmRef.current;
      qmRef.current = null;
      setQuickMask(false);
      if (m) {
        const inv = invertSelection(m);
        if (isSelectionEmpty(inv)) {
          // 全涂掉了 = 没有选区，直接把选区清空
          onCommit(setSelection(doc, null), zh.editor.quickMaskOff);
        } else {
          commitSelection(inv);
        }
      }
      setToast(zh.editor.quickMaskOff);
    }
  }, [quickMask, doc, docW, commitSelection, onCommit]);
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

  // 切走多边形套索：没闭合的折线一并收掉
  useEffect(() => {
    if (tool !== "polyLasso") setPolyPts(null);
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

    /**
     * 智能参考线：框与画布中线 / 已有参考线对齐时拉一条品红线，
     * 右下角再贴一个「宽 × 高」徽标。全部画在浮层上，不碰像素。
     */
    const drawSmart = (bx: number, by: number, bw: number, bh: number) => {
      const u = 1 / scale;
      const tol = 1.5 * u;
      const vLines: number[] = [];
      const hLines: number[] = [];
      if (Math.abs(bx + bw / 2 - docW / 2) <= tol) vLines.push(docW / 2);
      if (Math.abs(by + bh / 2 - docH / 2) <= tol) hLines.push(docH / 2);
      for (const gx of guides.x) {
        if (Math.abs(bx - gx) <= tol || Math.abs(bx + bw - gx) <= tol) vLines.push(gx);
      }
      for (const gy of guides.y) {
        if (Math.abs(by - gy) <= tol || Math.abs(by + bh - gy) <= tol) hLines.push(gy);
      }
      if (vLines.length > 0 || hLines.length > 0) {
        ctx.save();
        ctx.strokeStyle = "#ff2d95";
        ctx.lineWidth = u;
        ctx.beginPath();
        for (const gx of vLines) {
          ctx.moveTo(gx, 0);
          ctx.lineTo(gx, docH);
        }
        for (const gy of hLines) {
          ctx.moveTo(0, gy);
          ctx.lineTo(docW, gy);
        }
        ctx.stroke();
        ctx.restore();
      }
      const label = `${Math.round(bw)} × ${Math.round(bh)}`;
      const fs = 11 * u;
      ctx.save();
      ctx.font = `${fs}px "Segoe UI", system-ui, sans-serif`;
      const tw = ctx.measureText(label).width;
      const pad = 6 * u;
      const bwid = tw + pad * 2;
      const bhei = 18 * u;
      const bxx = Math.min(docW - bwid - 4 * u, Math.max(4 * u, bx + bw + 8 * u));
      const byy = Math.min(docH - bhei - 4 * u, Math.max(4 * u, by + bh + 8 * u));
      const r = 4 * u;
      ctx.beginPath();
      ctx.moveTo(bxx + r, byy);
      ctx.arcTo(bxx + bwid, byy, bxx + bwid, byy + bhei, r);
      ctx.arcTo(bxx + bwid, byy + bhei, bxx, byy + bhei, r);
      ctx.arcTo(bxx, byy + bhei, bxx, byy, r);
      ctx.arcTo(bxx, byy, bxx + bwid, byy, r);
      ctx.closePath();
      ctx.fillStyle = "rgba(18, 18, 24, 0.88)";
      ctx.fill();
      ctx.fillStyle = "#f4f5f8";
      ctx.textBaseline = "middle";
      ctx.fillText(label, bxx + pad, byy + bhei / 2 + 0.5 * u);
      ctx.restore();
    };

    // 既没有选区、没在拖框、没在拖形状、没在变换、没有取样点、也没有多边形折线：清一次就收工
    if (!antsPath && !selDragging && !shapeDragging && !anchorPt && !freeActive && !polyPts) {
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
      } else if (polyPts && polyPts.length > 0) {
        // 多边形套索：已落的顶点连成折线（不闭合，闭合线等真正落选区）
        path = new Path2D();
        path.moveTo(polyPts[0].x, polyPts[0].y);
        for (let i = 1; i < polyPts.length; i += 1) path.lineTo(polyPts[i].x, polyPts[i].y);
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

        // 智能参考线：选区 / 裁剪框的尺寸徽标与中线对齐提示
        if (smartGuides) {
          if (live && box && box.w > 0 && box.h > 0) {
            drawSmart(box.x, box.y, box.w, box.h);
          } else if (ft) {
            drawSmart(ft.cx - ft.w / 2, ft.cy - ft.h / 2, ft.w, ft.h);
          }
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
  }, [docW, docH, scale, antsPath, selDragging, shapeDragging, anchor, tool, freeActive, smartGuides, guides, polyPts]);

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

      // 参考线优先于工具：指针贴近某条未锁定的参考线时，按住即拖动它，
      // 拖出画布松手即删除 —— 与 PS 的手感一致。
      if (extras && showGuides && !guidesLocked) {
        const hitR = 4 / scale;
        let axis: "x" | "y" | null = null;
        let index = -1;
        for (let i = 0; i < guides.x.length; i += 1) {
          if (Math.abs(p.x - guides.x[i]) <= hitR) {
            axis = "x";
            index = i;
            break;
          }
        }
        if (axis === null) {
          for (let i = 0; i < guides.y.length; i += 1) {
            if (Math.abs(p.y - guides.y[i]) <= hitR) {
              axis = "y";
              index = i;
              break;
            }
          }
        }
        if (axis && index >= 0) {
          guideDragRef.current = { axis, index, pos: 0 };
          capturePointer(e.currentTarget, e.pointerId);
          return;
        }
      }

      // 选区与裁剪作用于整份文档：不受图层锁定影响，没有活动图层也能用
      if (isSelectionTool(tool) || tool === "crop") {
        capturePointer(e.currentTarget, e.pointerId);
        setError("");
        if (tool === "wand") {
          // 「对所有图层取样」时按合成结果取色；否则只看当前像素层
          const src =
            sampleAllLayers || !act || act.kind !== "pixel"
              ? compRef.current
              : act.surface;
          const shape = src ? wandMask(src, p, tolerance, contiguous) : null;
          if (shape) {
            commitSelection(
              combineSelection(doc.selection, shape, modeWithMods(e.shiftKey, e.altKey, selectionMode)),
            );
          }
          return;
        }
        if (tool === "polyLasso") {
          if (!polyPts) {
            polyModeRef.current = modeWithMods(e.shiftKey, e.altKey, selectionMode);
            setPolyPts([p]);
          } else {
            const first = polyPts[0];
            const last = polyPts[polyPts.length - 1];
            const hitR = 10 / scale;
            if (polyPts.length >= 3 && Math.hypot(p.x - last.x, p.y - last.y) <= 1) {
              // 双击：两下 pointerdown 落在同一点，第二下闭合
              commitPoly(polyPts);
            } else if (
              polyPts.length >= 3 &&
              Math.hypot(p.x - first.x, p.y - first.y) <= hitR
            ) {
              // 点回起点附近：闭合
              commitPoly(polyPts);
            } else if (Math.hypot(p.x - last.x, p.y - last.y) > 1) {
              setPolyPts([...polyPts, p]);
            }
          }
          return;
        }
        if (tool === "singleRow" || tool === "singleColumn") {
          const x = Math.round(p.x);
          const y = Math.round(p.y);
          const shape =
            tool === "singleRow"
              ? rectMask(docW, docH, { x: 0, y }, { x: docW, y: y + 1 })
              : rectMask(docW, docH, { x, y: 0 }, { x: x + 1, y: docH });
          commitSelection(
            combineSelection(doc.selection, shape, modeWithMods(e.shiftKey, e.altKey, selectionMode)),
          );
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

      if (tool === "magicEraser") {
        // 与魔棒同一套容差判定，只是「选中」变成「擦成透明」；一笔一步可撤销
        const src = sampleAllLayers ? compRef.current : act.surface;
        const shape = src ? wandMask(src, p, tolerance, contiguous) : null;
        if (!shape) return;
        const next = cloneSurface(act.surface);
        const nctx = mustCtx(next);
        nctx.save();
        nctx.globalCompositeOperation = "destination-out";
        nctx.drawImage(shape, 0, 0);
        nctx.restore();
        const layers = doc.layers.map((l) => (l.id === act.id ? { ...l, surface: next } : l));
        onCommit({ ...doc, layers, dirty: true }, zh.tools.magicEraser);
        return;
      }
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
        // 铅笔：硬边、全流量、无抖动、无平滑 —— 只换参数，走同一条笔画管线
        const settings =
          tool === "pencil"
            ? {
                ...brush,
                color: fg,
                hardness: 100,
                flow: 100,
                opacity: 100,
                spacing: 4,
                jitter: 0,
                sizeJitter: 0,
                opacityJitter: 0,
                flowJitter: 0,
                scatterCount: 1,
                scatterCountJitter: 0,
                smoothing: 0,
                texture: "none" as const,
                tip: "round" as const,
              }
            : { ...brush, color: fg };
        const s = new Stroke(
          docW,
          docH,
          settings,
          tool === "eraser",
          doc.selection ?? null,
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
      sampleAllLayers,
      scale,
      spaceDown,
      tolerance,
      contiguous,
      selectionMode,
      commitSelection,
      commitPoly,
      polyPts,
      tool,
      zoom,
      onCommit,
      guides,
      showGuides,
      guidesLocked,
      extras,
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
      // 正在拖参考线：直接改那条线；拖出画布即删除（与 PS 一致）
      const gd = guideDragRef.current;
      if (gd) {
        const q = docPoint(e);
        const pos = Math.round(gd.axis === "x" ? q.x : q.y);
        const out = pos < 0 || (gd.axis === "x" ? pos > docW : pos > docH);
        setGuides((gv) => {
          if (out) {
            return gd.axis === "x"
              ? { ...gv, x: gv.x.filter((_, i) => i !== gd.index) }
              : { ...gv, y: gv.y.filter((_, i) => i !== gd.index) };
          }
          return gd.axis === "x"
            ? { ...gv, x: gv.x.map((v, i) => (i === gd.index ? pos : v)) }
            : { ...gv, y: gv.y.map((v, i) => (i === gd.index ? pos : v)) };
        });
        if (out) guideDragRef.current = null; // 删掉之后这根线已不存在，结束拖动
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
        const raw = docPoint(e);
        // 套索要的是连续笔迹，不吸附；矩形 / 椭圆 / 裁剪的收尾点贴参考线与画布边
        const p = sel.tool === "lasso" ? raw : snapPoint(raw.x, raw.y);
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
    [docPoint, docXY, doc, fg, scheduleRender, snapPoint, syncCursor, tool],
  );

  const onUp = useCallback(() => {
    pickingRef.current = false;
    guideDragRef.current = null;
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
      // 快速蒙版：这一笔落在临时蒙版画布上（不进文档、不进历史）
      if (quickMask && qmRef.current) {
        s.finish(qmRef.current, null);
        resetGesture();
        render();
        return;
      }
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
  }, [bg, doc, docH, docW, fg, gradientReverse, gradientStyle, onCommit, render, resetGesture, tool, maskEdit, quickMask, feather, commitSelection]);

  /* ------------------------------------------------------------ 标尺拖参考线 */

  /**
   * 从标尺往画布里拉一条新参考线。
   *
   * 按下就先落一条线（贴在画布边缘），指针进画布后跟着走；
   * 松手时若指针始终没进画布，就把这条线删掉 —— 与 PS 的手感一致。
   */
  const onRulerDown = useCallback(
    (axis: "x" | "y") => (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const q = docXY(e.clientX, e.clientY);
      const limit = axis === "x" ? docW : docH;
      const raw = axis === "x" ? q.x : q.y;
      const pos = Math.round(Math.min(limit, Math.max(0, raw)));
      setGuides((gv) =>
        axis === "x" ? { ...gv, x: [...gv.x, pos] } : { ...gv, y: [...gv.y, pos] },
      );
      rulerInsideRef.current =
        q.x >= 0 && q.x <= docW && q.y >= 0 && q.y <= docH;
      rulerDragRef.current = { axis };
      setShowGuides(true);
      setExtras(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [docW, docH, docXY],
  );

  const onRulerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const rd = rulerDragRef.current;
      if (!rd) return;
      const q = docXY(e.clientX, e.clientY);
      const limit = rd.axis === "x" ? docW : docH;
      rulerInsideRef.current =
        q.x >= 0 && q.x <= docW && q.y >= 0 && q.y <= docH;
      const raw = Math.round(rd.axis === "x" ? q.x : q.y);
      const pos = Math.min(limit, Math.max(0, raw));
      setGuides((gv) => {
        const arr = rd.axis === "x" ? gv.x : gv.y;
        if (!arr.length) return gv;
        const next = arr.slice();
        next[next.length - 1] = pos;
        return rd.axis === "x" ? { ...gv, x: next } : { ...gv, y: next };
      });
    },
    [docW, docH, docXY],
  );

  const onRulerUp = useCallback(() => {
    const rd = rulerDragRef.current;
    if (!rd) return;
    rulerDragRef.current = null;
    if (rulerInsideRef.current) return;
    // 指针没进画布就松手：这条线不算数
    setGuides((gv) =>
      rd.axis === "x" ? { ...gv, x: gv.x.slice(0, -1) } : { ...gv, y: gv.y.slice(0, -1) },
    );
  }, []);

  /** 「新建参考线…」对话框：校验落点后追加一条线。 */
  const submitGuide = useCallback(() => {
    if (!guideDialog) return;
    const limit = guideDialog.axis === "x" ? docW : docH;
    const n = Math.round(Number(guideDialog.pos));
    if (!Number.isFinite(n) || n < 0 || n > limit) {
      setToast(zh.dialog.guideInvalid);
      return;
    }
    setGuides((gv) =>
      guideDialog.axis === "x" ? { ...gv, x: [...gv.x, n] } : { ...gv, y: [...gv.y, n] },
    );
    setExtras(true);
    setShowGuides(true);
    setGuideDialog(null);
  }, [guideDialog, docW, docH]);

  /** 「新建参考线版面…」：按列 / 行铺线，列宽与行高自动均分剩余空间。 */
  const submitLayout = useCallback(() => {
    if (!layoutDialog) return;
    const num = (v: string) => Math.max(0, Math.round(Number(v) || 0));
    const cols = Math.min(100, num(layoutDialog.cols));
    const rows = Math.min(100, num(layoutDialog.rows));
    const cg = num(layoutDialog.colGutter);
    const rg = num(layoutDialog.rowGutter);
    const m = num(layoutDialog.margin);
    if (cols + rows === 0 || m * 2 >= Math.min(docW, docH)) {
      setToast(zh.dialog.layoutInvalid);
      return;
    }
    // 每列的两条边界各生成一条参考线，列与列之间的间距自然留空
    const edges = (total: number, count: number, gutter: number) => {
      if (count <= 0) return [] as number[];
      const span = (total - 2 * m - gutter * (count - 1)) / count;
      if (span <= 0) return [] as number[];
      const out: number[] = [];
      for (let i = 0; i < count; i += 1) {
        const a = m + i * (span + gutter);
        out.push(Math.round(a), Math.round(a + span));
      }
      return out;
    };
    const xs = edges(docW, cols, cg);
    const ys = edges(docH, rows, rg);
    if (xs.length === 0 && ys.length === 0) {
      setToast(zh.dialog.layoutInvalid);
      return;
    }
    const uniq = (a: number[]) => Array.from(new Set(a)).sort((p, q) => p - q);
    setGuides((gv) => ({
      x: uniq(layoutDialog.clear ? xs : [...gv.x, ...xs]),
      y: uniq(layoutDialog.clear ? ys : [...gv.y, ...ys]),
    }));
    setExtras(true);
    setShowGuides(true);
    setLayoutDialog(null);
    setToast(zh.dialog.layoutDone);
  }, [layoutDialog, docW, docH]);

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

  /** 打开指定路径：图片按位图解码，.strata 工程走工程解码。 */
  const openFileAt = useCallback(
    async (path: string) => {
      try {
        // 工程编解码器按需加载：只有真的开 / 存 .strata / .psd 时才拉进来。
        const { decodeProject, isStrataPath } = await import("../engine/project");
        if (isStrataPath(path)) {
          const bytes = await readFileBytes(path);
          const next = await decodeProject(bytes);
          next.sourcePath = path;
          onOpenDoc(next);
          setToast(zh.editor.projectOpened);
        } else {
          // PSD：ag-psd 按需加载，重建图层栈
          const { isPsdPath, decodePsdToDoc } = await import("../engine/psd");
          if (isPsdPath(path)) {
            const bytes = await readFileBytes(path);
            const next = decodePsdToDoc(bytes, baseName(path), path);
            onOpenDoc(next);
            setToast(zh.editor.projectOpened);
          } else {
            const bitmap = await loadImage(path);
            onOpenDoc(docFromBitmap(bitmap, baseName(path), path));
          }
        }
        pushRecent(path);
      } catch (e) {
        setError(`${zh.error.openFailed}：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [onOpenDoc, pushRecent],
  );

  /** 文件 > 打开 / 打开为：图片与 .strata 工程共用同一个对话框。 */
  const openImage = useCallback(async () => {
    try {
      const { STRATA_EXTENSION } = await import("../engine/project");
      const picked = await open({
        title: zh.dialog.openTitle,
        multiple: false,
        directory: false,
        filters: [
          {
            name: "图片 / 工程 / PSD",
            extensions: [...IMAGE_EXTENSIONS, STRATA_EXTENSION, "psd"],
          },
        ],
      });
      if (typeof picked !== "string") return;
      await openFileAt(picked);
    } catch (e) {
      setError(`${zh.error.openFailed}：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [openFileAt]);

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

  /**
   * 图像 > 复制：为当前文档做一份深拷贝并新开一个标签页。
   *
   * 图层像素与选区都克隆过（cloneDoc），两份文档之后互不影响；路径清空，
   * 免得「保存」直接覆盖原文件。
   */
  const duplicateImage = useCallback(() => {
    const copy = cloneDoc(doc);
    copy.id = nextDocId();
    copy.name = `${doc.name} ${zh.editor.copySuffix}`;
    copy.sourcePath = undefined;
    copy.dirty = true;
    onOpenDoc(copy);
    setToast(zh.menu.imageDuplicated);
  }, [doc, onOpenDoc]);

  /** 关闭除当前文档之外的所有文档。 */
  const closeOthers = useCallback(() => {
    for (const d of docs) {
      if (d.id !== doc.id) onCloseDoc(d.id);
    }
  }, [doc.id, docs, onCloseDoc]);

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

  /**
   * 导出 PSD：像素图层逐层交给 ag-psd 编码（先读后写同一套桥）。
   * 与保存工程不同，这里是单向导出，不改 sourcePath / dirty。
   */
  const exportPsd = useCallback(async () => {
    try {
      const { encodeDocToPsd, PSD_EXTENSION } = await import("../engine/psd");
      const target = await save({
        title: zh.dialog.exportPsdTitle,
        defaultPath: `${baseName(doc.name) || doc.name}.${PSD_EXTENSION}`,
        filters: [{ name: "Photoshop PSD", extensions: [PSD_EXTENSION] }],
      });
      if (typeof target !== "string") return;
      const bytes = await encodeDocToPsd(doc);
      await writeFileBytes(target, bytes);
      setToast(zh.editor.psdExported);
    } catch (e) {
      setError(`${zh.error.exportFailed}：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc]);

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

  /** 边界：只留选区边缘一圈，宽度沿用「羽化」半径（PS 的选择 > 修改 > 边界）。 */
  const doBorder = useCallback(() => {
    if (!doc.selection || !hasSelection) return;
    if (selRadius <= 0) {
      setError(zh.selection.radiusZero);
      return;
    }
    onCommit(setSelection(doc, borderSelection(doc.selection, selRadius)), zh.selection.bordered);
  }, [doc, hasSelection, onCommit, selRadius]);

  /** 平滑：把选区边缘的毛刺磨圆，半径沿用「羽化」的设置。 */
  const doSmooth = useCallback(() => {
    if (!doc.selection || !hasSelection) return;
    if (selRadius <= 0) {
      setError(zh.selection.radiusZero);
      return;
    }
    const next = smoothSelection(doc.selection, selRadius);
    if (isSelectionEmpty(next)) {
      setError(zh.selection.radiusTooBig);
      return;
    }
    onCommit(setSelection(doc, next), zh.selection.smoothed);
  }, [doc, hasSelection, onCommit, selRadius]);

  /**
   * 选取相似：以当前选区包围盒的中心为样本色，按魔棒容差在全图找同色像素
   * （contiguous = false，不要求与样本点相连）。没有样本点可用时不可用。
   */
  const doSimilar = useCallback(() => {
    if (!doc.selection || !hasSelection) return;
    const act = activeLayer(doc);
    const box = selectionBounds(doc.selection);
    if (!act || act.kind !== "pixel" || !box) {
      setError(zh.selection.noPixelLayer);
      return;
    }
    const seed = {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
    };
    const next = wandMask(act.surface, seed, tolerance, false);
    if (isSelectionEmpty(next)) {
      setError(zh.selection.similarEmpty);
      return;
    }
    onCommit(setSelection(doc, next), zh.selection.similar);
  }, [doc, hasSelection, onCommit, tolerance]);

  /** 编辑 > 描边：确认对话框后沿选区边界刷一圈实色。 */
  const submitStroke = useCallback(() => {
    if (!strokeDialog) return;
    const width = Math.round(Number(strokeDialog.width));
    if (!Number.isFinite(width) || width <= 0) {
      setError(zh.dialog.strokeInvalid);
      return;
    }
    const opacity = Math.max(0, Math.min(100, Number(strokeDialog.opacity) || 0));
    const next = strokeSelection(doc, {
      color: strokeDialog.color,
      width,
      position: strokeDialog.position,
      opacity,
    });
    if (next === doc) {
      setError(zh.selection.noPixelLayer);
      return;
    }
    onCommit(next, zh.dialog.strokeDone);
    setStrokeDialog(null);
  }, [doc, onCommit, strokeDialog]);

  /** 图层 > 重命名图层：确认后改名字，空名字保持原样。 */
  const submitRename = useCallback(() => {
    if (!renameDialog) return;
    const name = renameDialog.name.trim();
    if (name) onCommit(renameLayer(doc, renameDialog.id, name), zh.menu.renameDone);
    setRenameDialog(null);
  }, [doc, onCommit, renameDialog]);

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

  /** 把当前图层一路移到最顶 / 最底（对应「图层 > 排列」的置为顶层 / 置为底层）。 */
  const moveLayerToEdge = useCallback(
    (dir: 1 | -1) => {
      let next = doc;
      while (canShiftLayer(next, dir)) next = moveLayer(next, dir);
      if (next !== doc) onCommit(next, dir === 1 ? "置为顶层" : "置为底层");
    },
    [doc, onCommit],
  );

  /** 「窗口 > 面板」开关：右侧坞由菜单直接控制。 */
  const toggleDock = useCallback((id: DockGroupId) => {
    setDockOpen((v) => ({ ...v, [id]: !v[id] }));
  }, []);

  /* ---------------------------------------------- 右键菜单（对照 PhotoCraft） */

  /**
   * 命令解析器转发：真正的 resolve 在下方 menuGroups 的 useMemo 里定义，
   * 这里用 ref 转发，让右键菜单与顶部菜单共用同一份命令表。
   */
  const resolveRef = useRef<
    ((id: string) => { run?: () => void; hint?: string; checked?: boolean } | undefined) | null
  >(null);

  /** 最近一次的非空选区：Reselect（重新选择）的依据。 */
  const lastSelectionRef = useRef<SelectionMask | null>(null);
  useEffect(() => {
    if (doc.selection) lastSelectionRef.current = doc.selection;
  }, [doc.selection]);

  /** 「铺满屏幕」：缩放到画布恰好盖住视口（允许超出，与「适合屏幕」相对）。 */
  const fillScreen = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp || !docW || !docH) return;
    const k = Math.max(vp.clientWidth / docW, vp.clientHeight / docH);
    zoom(k);
  }, [docW, docH, zoom]);

  /** 快速导出单个图层为 PNG（Quick Export As PNG）：只画该层自己的像素。 */
  const doExportLayerPng = useCallback(async () => {
    const cur = activeLayer(doc);
    if (!cur || cur.kind !== "pixel") return;
    try {
      const target = await save({
        title: "快速导出为 PNG",
        defaultPath: `${cur.name}.png`,
        filters: [{ name: "PNG 图片", extensions: ["png"] }],
      });
      if (typeof target !== "string") return;
      const canvas = createSurface(docW, docH);
      const c = mustCtx(canvas);
      c.globalAlpha = cur.opacity / 100;
      c.drawImage(cur.surface, 0, 0);
      c.globalAlpha = 1;
      await writeFileBytes(target, await encodePng(canvas));
      setToast(zh.editor.exported);
    } catch (e) {
      setError(`${zh.error.exportFailed}：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc, docW, docH]);

  /** 行数组 → 菜单条目：resolve 给不出命令的行照常显示但置灰，不做假可用。 */
  const entriesFromRows = useCallback(
    (rows: readonly (readonly [string, string] | null)[]): MenuEntry[] => {
      const entries: MenuEntry[] = [];
      for (const row of rows) {
        if (!row) {
          entries.push({ kind: "sep" });
          continue;
        }
        const [label, id] = row;
        const st = resolveRef.current?.(id);
        entries.push(
          st?.run
            ? { label, id, hint: st.hint, checked: st.checked, onSelect: st.run }
            : { label, id, disabled: true },
        );
      }
      return entries;
    },
    [],
  );

  /** 一行 = 「文案 + 命令 id」；null = 分隔线。 */
  type MenuRow = readonly (readonly [string, string] | null)[];

  /**
   * 画布右键：按当前工具 / 状态分流，分支与 PhotoCraft 的 rows() 一一对应。
   */
  const openCanvasMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setCtxMenu(null);

      // 参考线优先：右击贴到某条未锁定的线身上，弹的是参考线菜单，
      // 而不是当前工具的画布菜单 —— 与 PS 一致。
      if (extras && showGuides) {
        const q = docXY(e.clientX, e.clientY);
        const hitR = 4 / scale;
        let axis: "x" | "y" | null = null;
        let index = -1;
        for (let i = 0; i < guides.x.length; i += 1) {
          if (Math.abs(q.x - guides.x[i]) <= hitR) {
            axis = "x";
            index = i;
            break;
          }
        }
        if (axis === null) {
          for (let i = 0; i < guides.y.length; i += 1) {
            if (Math.abs(q.y - guides.y[i]) <= hitR) {
              axis = "y";
              index = i;
              break;
            }
          }
        }
        if (axis !== null && index >= 0) {
          const ax = axis;
          const idx = index;
          const del = () =>
            setGuides((gv) =>
              ax === "x"
                ? { ...gv, x: gv.x.filter((_, i) => i !== idx) }
                : { ...gv, y: gv.y.filter((_, i) => i !== idx) },
            );
          const entries: MenuEntry[] = [
            { label: zh.guide.delete, id: "guide.delete", disabled: guidesLocked, onSelect: del },
            {
              label: zh.guide.clearAll,
              id: "view.clearGuides",
              disabled: guidesLocked,
              onSelect: () => setGuides({ x: [], y: [] }),
            },
            { kind: "sep" },
            {
              label: guidesLocked ? zh.guide.unlock : zh.guide.lock,
              id: "view.lockGuides",
              checked: guidesLocked,
              onSelect: () => setGuidesLocked((v) => !v),
            },
          ];
          setCtxMenu({ x: e.clientX, y: e.clientY, entries });
          return;
        }
      }

      const rows: MenuRow | null = (() => {
        if (freeActive) {
          return [
            ["自由变换", "edit.freeTransform"],
            ["缩放", "edit.transform.scale"],
            ["旋转", "edit.transform.rotate"],
            ["斜切", "edit.transform.skew"],
            ["扭曲", "edit.transform.distort"],
            ["透视", "edit.transform.perspective"],
            ["变形", "edit.transform.warp"],
            null,
            ["内容识别缩放", "edit.contentAwareScale"],
            ["操控变形", "edit.puppetWarp"],
            null,
            ["旋转 180°", "edit.transform.rotate180"],
            ["顺时针旋转 90°", "edit.transform.rotate90Cw"],
            ["逆时针旋转 90°", "edit.transform.rotate90Ccw"],
            null,
            ["水平翻转", "edit.transform.flipHorizontal"],
            ["垂直翻转", "edit.transform.flipVertical"],
          ] as MenuRow;
        }
        if (tool === "zoom" || tool === "hand") {
          return [
            ["放大", "view.zoomIn"],
            ["缩小", "view.zoomOut"],
            null,
            ["适合屏幕", "view.fitOnScreen"],
            ["铺满屏幕", "view.fillScreen"],
            null,
            ["100%", "view.actualPixels"],
            ["200%", "view.twoHundredPercent"],
          ] as MenuRow;
        }
        if (isSelectionTool(tool)) {
          return hasSelection
            ? ([
                ["取消选择", "select.deselect"],
                ["反选", "select.inverse"],
                ["羽化…", "select.modify.feather"],
                ["选择并遮住…", "select.selectAndMask"],
                null,
                ["存储选区…", "select.saveSelection"],
                null,
                ["通过拷贝的图层", "layer.new.layerViaCopy"],
                ["通过剪切的图层", "layer.new.layerViaCut"],
                ["新建图层…", "layer.new.layer"],
                null,
                ["自由变换", "edit.freeTransform"],
                ["变换选区", "select.transformSelection"],
                ["扭曲", "edit.transform.distort"],
                ["透视", "edit.transform.perspective"],
                null,
                ["删除并填充选区", "edit.clear"],
                ["填充…", "edit.fill"],
                ["内容识别填充…", "edit.contentAwareFill"],
              ] as MenuRow)
            : ([
                ["全选", "select.all"],
                ["重新选择", "select.reselect"],
                null,
                ["色彩范围…", "select.colorRange"],
              ] as MenuRow);
        }
        // 其余工具：PhotoCraft 对画笔等工具不弹画布菜单
        return null;
      })();
      if (!rows) return;
      setCtxMenu({ x: e.clientX, y: e.clientY, entries: entriesFromRows(rows) });
    },
    [tool, hasSelection, freeActive, entriesFromRows, docXY, scale, extras, showGuides, guides, guidesLocked],
  );

  /**
   * 图层行右键：条目与顺序照抄 PhotoCraft 的 layer_menu_ui.rs（PS 2026 顺序）。
   * 智能对象 / 画板 / 链接 / 栅格化等暂无内核能力的行保留占位并置灰。
   */
  const openLayerMenu = useCallback(
    (e: React.MouseEvent, layerId: string) => {
      e.preventDefault();
      e.stopPropagation();
      const layer = doc.layers.find((l) => l.id === layerId);
      if (!layer) return;
      const isPixel = layer.kind === "pixel";
      const rows: readonly (readonly [string, string] | null)[] = [
        ["混合选项…", "layer.layerStyle.blendingOptions"],
        null,
        ["复制图层…", "layer.duplicate"],
        ["删除图层", "layer.delete"],
        ["从图层建立组…", "layer.groupLayers"],
        null,
        ["快速导出为 PNG", "layer.quickExportAsPng"],
        ["导出为…", "layer.exportAs"],
        null,
        ["转换为智能对象", "layer.smartObject.convert"],
        isPixel || layer.kind === "group" ? null : ["栅格化图层", "layer.rasterize"],
        null,
        layer.mask
          ? [
              layer.maskActive ? "停用图层蒙版" : "启用图层蒙版",
              "layer.layerMask.toggle",
            ]
          : null,
        layer.mask ? ["应用图层蒙版", "layer.layerMask.apply"] : null,
        layer.mask ? ["删除图层蒙版", "layer.layerMask.delete"] : null,
        !layer.mask && isPixel ? ["添加图层蒙版", "layer.layerMask.addReveal"] : null,
        !layer.mask && isPixel && hasSelection
          ? ["添加图层蒙版（显示选区）", "layer.layerMask.addSelection"]
          : null,
        ["创建 / 释放剪贴蒙版", "layer.clipping.toggle"],
        null,
        ["拷贝图层样式", "layer.layerStyle.copy"],
        ["粘贴图层样式", "layer.layerStyle.paste"],
        ["清除图层样式", "layer.layerStyle.clear"],
        null,
        layer.kind === "group" ? ["合并组", "layer.mergeLayers"] : ["向下合并", "layer.mergeLayers"],
        ["合并可见图层", "layer.mergeVisible"],
        ["拼合图像", "layer.flattenImage"],
      ];
      setCtxMenu({ x: e.clientX, y: e.clientY, entries: entriesFromRows(rows) });
    },
    [doc, hasSelection, entriesFromRows],
  );

  /**
   * 蒙版缩略图右键（PhotoCraft 同款）：停用 / 删除 / 应用，
   * 再加「蒙版载入选区」三连（加选 / 减选 / 交选由 selectionMode 承担）。
   */
  const openMaskMenu = useCallback(
    (e: React.MouseEvent, layerId: string) => {
      e.preventDefault();
      e.stopPropagation();
      const layer = doc.layers.find((l) => l.id === layerId);
      if (!layer?.mask) return;
      const rows: readonly (readonly [string, string] | null)[] = [
        [layer.maskActive ? "停用图层蒙版" : "启用图层蒙版", "layer.layerMask.toggle"],
        ["删除图层蒙版", "layer.layerMask.delete"],
        ["应用图层蒙版", "layer.layerMask.apply"],
        null,
        ["添加蒙版到选区", "layer.layerMask.addToSelection"],
        ["从选区减去蒙版", "layer.layerMask.subtractFromSelection"],
        ["蒙版与选区交叉", "layer.layerMask.intersectSelection"],
        null,
        ["选择并遮住…", "select.selectAndMask"],
      ];
      setCtxMenu({ x: e.clientX, y: e.clientY, entries: entriesFromRows(rows) });
    },
    [doc, entriesFromRows],
  );

  // Reelix 联动探测：装着没开 / 开着（5 秒一探，心跳 10 秒过期）。
  // 必须放在组件顶层 —— 之前误写进 menuGroups 的 useMemo 工厂里，memo 不重算
  // 时这两个 Hook 不会执行，Hook 顺序错乱直接把编辑器渲染崩掉（创建画布白屏）。
  const [reelixState, setReelixState] = useState<ReelixLinkState>("absent");
  useEffect(() => {
    let alive = true;
    const probe = async () => {
      const s = await probeReelix();
      if (alive) setReelixState(s);
    };
    void probe();
    const timer = window.setInterval(() => void probe(), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  /**
   * 顶部菜单：一级 / 二级 / 三级全量对齐 PhotoCraft 的 770 条目录。
   *
   * 能真实执行的绑定到 Strata 内核；尚未实现的照常显示、置灰禁用 ——
   * 不做「看得见点得动但什么也不发生」的假按钮。
   */
  const menuGroups = useMemo<MenuGroup[]>(() => {
    /** 对话框式调整统一落到「新建调整图层」，参数随时可回改。 */
    const adjustLayer = (kind: AdjustId): MenuState => ({
      run: () => {
        onCommit(addAdjustLayer(doc, newAdjustState(kind)), zh.layers.adjustAdd);
        // 建完必须把属性面板露出来：曲线 / 色阶 / 渐变映射这些编辑器都藏在里面，
        // 不主动打开的话用户只会看到「菜单点了像没反应」，以为功能不存在。
        setDockOpen((prev) => ({ ...prev, props: true }));
      },
    });

    /**
     * 图层样式菜单：没有就挂上，已有就提示去图层面板里调参数。
     * 调整层没有自己的像素，不提供样式。
     */
    const layerStyleMenu = (style: StyleId): MenuState | undefined => {
      const layer = doc.layers[at];
      if (!layer || layer.kind === "adjust") return undefined;
      if (hasStyle(layer, style)) {
        return { run: () => setToast(zh.menu.styleExists), checked: true };
      }
      return { run: () => onCommit(addLayerStyle(doc, style), zh.menu.styleAdded) };
    };

    const resolve: MenuResolver = (id) => {
      switch (id) {
        /* ---------------------------------------------------------- 文件 */
        case "file.new":
          return { run: newCanvas };
        case "file.open":
        case "file.openAs":
          return { run: () => void openImage() };
        case "file.save":
        case "file.saveAs":
        case "file.saveACopy":
          return { run: () => void saveProject() };
        case "file.close":
          return { run: () => onCloseDoc(doc.id) };
        case "file.closeAll":
          return { run: closeAll };
        case "file.closeOthers":
          return docs.length > 1 ? { run: closeOthers } : undefined;
        case "file.export.quickExportAsPng":
          return { run: () => void exportPng(), hint: "Ctrl+Shift+S" };
        case "file.export.exportAs":
          return { run: () => void exportPng() };
        case "file.export.psd":
          return { run: () => void exportPsd() };
        case "file.exit":
          return { run: onQuit };

        /* ---------------------------------------------------------- 编辑 */
        case "edit.undo":
          return canUndo ? { run: onUndo, hint: "Ctrl+Z" } : undefined;
        case "edit.redo":
          return canRedo ? { run: onRedo, hint: "Ctrl+Shift+Z" } : undefined;
        case "edit.cut":
          return hasSelection ? { run: doCut, hint: "Ctrl+X" } : undefined;
        case "edit.copy":
          return { run: () => doCopy(false), hint: "Ctrl+C" };
        case "edit.copyMerged":
          return { run: () => doCopy(true) };
        case "edit.paste":
          return canPaste ? { run: doPaste, hint: "Ctrl+V" } : undefined;
        case "edit.clear":
          return hasSelection ? { run: doDeletePixels, hint: "Delete" } : undefined;
        case "edit.fill":
          return { run: () => doFill(fg) };
        case "edit.stroke":
          // 描边宽度默认给 3px；选项条上的羽化值若已设，顺手沿用
          return hasSelection
            ? {
                run: () =>
                  setStrokeDialog({
                    width: String(Math.max(1, Math.round(selRadius) || 3)),
                    color: fg,
                    position: "center",
                    opacity: "100",
                  }),
              }
            : undefined;
        case "edit.search":
          return { run: () => setPalette(true) };
        case "edit.contentAwareFill":
          return hasSelection ? { run: doInpaint } : undefined;
        case "edit.freeTransform":
          return freeActive
            ? { run: commitFreeTransform, hint: "Enter" }
            : canTransform
              ? { run: beginFreeTransform }
              : undefined;
        case "edit.transform.rotate180":
          return canTransform
            ? { run: () => onCommit(rotateLayerHalf(doc), zh.menu.rotateHalf) }
            : undefined;
        case "edit.transform.flipHorizontal":
          return canTransform
            ? { run: () => onCommit(flipLayer(doc, "h"), zh.menu.flipH) }
            : undefined;
        case "edit.transform.flipVertical":
          return canTransform
            ? { run: () => onCommit(flipLayer(doc, "v"), zh.menu.flipV) }
            : undefined;
        case "edit.keyboardShortcuts":
          return { run: () => setModal("shortcuts") };
        case "edit.preferences.general":
          return { run: () => setPrefsOpen(true) };

        /* ---------------------------------------------------------- 图像 */
        // 反相 / 去色 / 均衡是 PS 传统的一键烙印；其余弹出式调整
        // 统一落到「新建调整图层」—— 参数随时可回改，比一次性烙死更强
        case "image.adjustments.brightnessContrast":
          return adjustLayer("bc");
        case "image.adjustments.levels":
          return adjustLayer("levels");
        case "image.adjustments.curves":
          return adjustLayer("curves");
        case "image.adjustments.exposure":
          return adjustLayer("exposure");
        case "image.adjustments.vibrance":
          return adjustLayer("vibrance");
        case "image.adjustments.hueSaturation":
          return adjustLayer("huesat");
        case "image.adjustments.colorBalance":
          return adjustLayer("colorbalance");
        case "image.adjustments.blackWhite":
          return adjustLayer("blackwhite");
        case "image.adjustments.photoFilter":
          return adjustLayer("photofilter");
        case "image.adjustments.channelMixer":
          return adjustLayer("channelmixer");
        case "image.adjustments.colorLookup":
          return adjustLayer("colorlookup");
        case "image.adjustments.invert":
          return { run: () => doAdjust(zh.menu.adjustInvert, preset("invert")), hint: "Ctrl+I" };
        case "image.adjustments.posterize":
          return adjustLayer("posterize");
        case "image.adjustments.threshold":
          return adjustLayer("threshold");
        case "image.adjustments.gradientMap":
          return adjustLayer("gradientmap");
        case "image.adjustments.selectiveColor":
          return adjustLayer("selectivecolor");
        case "image.adjustments.shadowsHighlights":
          return adjustLayer("shadowhighlight");
        case "image.adjustments.hdrToning":
          return adjustLayer("hdtoning");
        case "image.adjustments.desaturate":
          return { run: () => doAdjust(zh.menu.adjustGray, preset("bw")), hint: "Ctrl+Shift+U" };
        case "image.adjustments.matchColor":
          return adjustLayer("matchcolor");
        case "image.adjustments.replaceColor":
          return adjustLayer("replacecolor");
        case "image.adjustments.equalize":
          return { run: () => doAdjust(adjustDef("equalize").label, preset("equalize")) };
        case "image.autoTone":
          return { run: () => doAuto("tone", zh.menu.autoTone) };
        case "image.autoContrast":
          return { run: () => doAuto("contrast", zh.menu.autoContrast) };
        case "image.autoColor":
          return { run: () => doAuto("color", zh.menu.autoColor) };
        case "image.imageSize":
          return { run: () => setSizeDialog("image"), hint: "Ctrl+Alt+I" };
        case "image.canvasSize":
          return { run: () => setSizeDialog("canvas"), hint: "Ctrl+Alt+C" };
        case "image.duplicate":
          return { run: duplicateImage };
        case "image.crop":
          return {
            run: () => {
              setTool("crop");
              setToast(zh.menu.cropReady);
            },
          };
        case "image.trim":
          return { run: doTrim };
        case "image.mode.grayscale":
          return { run: () => onCommit(grayscaleDocument(doc), zh.menu.grayscale) };
        case "image.mode.rgb":
          return { run: () => setToast(zh.menu.alreadyRgb), checked: true };
        case "image.imageRotation.180":
          return { run: () => onCommit(rotateDocument(doc, 180), "旋转 180°") };
        case "image.imageRotation.90cw":
          return { run: () => onCommit(rotateDocument(doc, 90), zh.menu.rotateDocCw) };
        case "image.imageRotation.90ccw":
          return { run: () => onCommit(rotateDocument(doc, 270), zh.menu.rotateDocCcw) };
        case "image.imageRotation.flipCanvasHorizontal":
          return { run: () => onCommit(flipDocument(doc, "h"), zh.menu.flipCanvasH) };
        case "image.imageRotation.flipCanvasVertical":
          return { run: () => onCommit(flipDocument(doc, "v"), zh.menu.flipCanvasV) };
        case "image.calculations":
          // 通道运算：两个 Alpha 通道逐像素运算，至少得有两个通道
          return alphaChannelsOf(doc).length >= 2
            ? { run: () => setCalcOpen(true) }
            : { run: () => setToast(zh.dialog.channelCalcNeed2) };

        /* ---------------------------------------------------------- 选择 */
        case "select.editInQuickMaskMode":
          return { run: () => toggleQuickMask(), hint: "Q" };
        case "select.selectAndMask":
          return hasSelection
            ? { run: () => setRefineOpen(true) }
            : { run: () => setToast(zh.dialog.refineEdgeEmpty) };

        /* ---------------------------------------------------------- 图层 */
        case "layer.new.layer":
          return {
            run: () => onCommit(addLayer(doc), zh.menu.newLayer),
            hint: "Ctrl+Shift+N",
          };
        case "layer.newFillLayer.solidColor":
          return { run: () => onCommit(addFillLayer(doc, fg), zh.menu.fillLayer) };
        case "layer.renameLayer": {
          const layer = doc.layers[at];
          return layer
            ? { run: () => setRenameDialog({ id: layer.id, name: layer.name }) }
            : undefined;
        }
        case "layer.new.group":
        case "layer.groupLayers":
          return { run: () => onCommit(groupLayers(doc), zh.menu.group), hint: "Ctrl+G" };
        case "layer.new.layerViaCopy":
          return hasSelection
            ? { run: () => onCommit(layerViaCopy(doc), zh.menu.layerViaCopy) }
            : undefined;
        case "layer.new.layerViaCut":
          return hasSelection
            ? { run: () => onCommit(layerViaCut(doc), zh.menu.layerViaCut) }
            : undefined;
        case "layer.duplicate":
          return {
            run: () => onCommit(duplicateLayer(doc), zh.menu.duplicateLayer),
            hint: "Ctrl+J",
          };
        case "layer.delete":
          return { run: () => onCommit(removeLayer(doc), zh.menu.deleteLayer) };
        case "layer.delete.hiddenLayers":
          return doc.layers.some((l) => !l.visible)
            ? { run: () => onCommit(deleteHiddenLayers(doc), zh.menu.deleteHidden) }
            : undefined;
        case "layer.quickExportAsPng":
          return doc.layers[at]?.kind === "pixel" ? { run: doExportLayerPng } : undefined;
        case "layer.exportAs":
          return doc.layers[at]?.kind === "pixel" ? { run: doExportLayerPng } : undefined;
        case "layer.mergeVisible":
          return doc.layers.some((l) => l.visible)
            ? { run: () => onCommit(mergeVisible(doc), zh.menu.mergeVisible) }
            : undefined;
        case "layer.layerMask.addReveal":
        case "layer.layerMask.add":
          return doc.layers[at]?.kind === "pixel" && !doc.layers[at]?.mask
            ? { run: () => onCommit(addMask(doc, "reveal"), zh.menu.addMask) }
            : undefined;
        case "layer.layerMask.revealAll":
          return doc.layers[at]?.kind === "pixel" && !doc.layers[at]?.mask
            ? { run: () => onCommit(addMask(doc, "reveal"), zh.menu.addMask) }
            : undefined;
        case "layer.layerMask.hideAll":
          return doc.layers[at]?.kind === "pixel" && !doc.layers[at]?.mask
            ? { run: () => onCommit(addMask(doc, "hide"), zh.menu.maskHideAll) }
            : undefined;
        case "layer.layerMask.addSelection":
        case "layer.layerMask.revealSelection":
          return doc.layers[at]?.kind === "pixel" && !doc.layers[at]?.mask && hasSelection
            ? { run: () => onCommit(addMaskFromSelection(doc), zh.menu.addMask) }
            : undefined;
        case "layer.layerMask.hideSelection":
          return doc.layers[at]?.kind === "pixel" && !doc.layers[at]?.mask && hasSelection
            ? {
                run: () =>
                  onCommit(invertMask(addMaskFromSelection(doc)), zh.menu.maskHideSelection),
              }
            : undefined;
        case "layer.layerMask.fromTransparency":
          return doc.layers[at]?.kind === "pixel" && !doc.layers[at]?.mask
            ? { run: () => onCommit(addMaskFromTransparency(doc), zh.menu.addMask) }
            : undefined;
        case "layer.layerMask.toggle":
        case "layer.layerMask.enabled":
          return doc.layers[at]?.mask
            ? { run: () => onCommit(toggleMaskActive(doc), zh.menu.maskToggle), checked: !!doc.layers[at]?.maskActive }
            : undefined;
        case "layer.layerMask.delete":
          return doc.layers[at]?.mask
            ? { run: () => onCommit(removeMask(doc), zh.menu.maskDelete) }
            : undefined;
        case "layer.layerMask.apply":
          return doc.layers[at]?.mask && doc.layers[at]?.maskActive
            ? { run: () => onCommit(applyMask(doc), zh.menu.maskApply) }
            : undefined;
        case "layer.clipping.toggle":
        case "layer.createClippingMask":
        case "layer.releaseClippingMask":
          return doc.layers[at]?.kind === "pixel" || doc.layers[at]?.kind === "group"
            ? {
                run: () => onCommit(toggleClip(doc), zh.menu.clippingToggle),
                checked: !!doc.layers[at]?.clip,
              }
            : undefined;
        case "layer.layerStyle.copy":
        case "layer.layerStyle.copyLayerStyle":
          return doc.layers[at]?.styles?.length ? { run: () => copyLayerStyle(doc) } : undefined;
        case "layer.layerStyle.paste":
        case "layer.layerStyle.pasteLayerStyle":
          return { run: () => onCommit(pasteLayerStyle(doc), zh.menu.stylePaste) };
        case "layer.layerStyle.clear":
          return doc.layers[at]?.styles?.length
            ? { run: () => onCommit(clearLayerStyle(doc), zh.menu.styleClear) }
            : undefined;
        case "layer.layerStyle.dropShadow":
          return layerStyleMenu("dropshadow");
        case "layer.layerStyle.innerShadow":
          return layerStyleMenu("innershadow");
        case "layer.layerStyle.outerGlow":
          return layerStyleMenu("outerglow");
        case "layer.layerStyle.innerGlow":
          return layerStyleMenu("innerglow");
        case "layer.layerStyle.stroke":
          return layerStyleMenu("stroke");
        case "layer.layerStyle.colorOverlay":
          return layerStyleMenu("coloroverlay");
        case "layer.layerStyle.hideAllEffects": {
          const layer = doc.layers[at];
          if (!layer?.styles?.length) return undefined;
          const off = layer.styles.map((s) => ({ ...s, enabled: false }));
          return {
            run: () => onCommit(updateLayer(doc, layer.id, { styles: off }), zh.menu.styleHideAll),
          };
        }
        case "layer.mergeLayers":
          return mergeOk
            ? { run: () => onCommit(mergeDown(doc), zh.menu.mergeDown) }
            : undefined;
        case "layer.flattenImage":
          return { run: () => onCommit(flattenImage(doc), zh.menu.flatten) };
        case "layer.ungroupLayers":
          return doc.layers[at]?.kind === "group"
            ? { run: () => onCommit(ungroupLayers(doc), zh.menu.ungroup) }
            : undefined;
        case "layer.arrange.bringForward":
          return canShiftLayer(doc, 1)
            ? { run: () => onCommit(moveLayer(doc, 1), zh.menu.moveLayerUp) }
            : undefined;
        case "layer.arrange.sendBackward":
          return canShiftLayer(doc, -1)
            ? { run: () => onCommit(moveLayer(doc, -1), zh.menu.moveLayerDown) }
            : undefined;
        case "layer.arrange.bringToFront":
          return canShiftLayer(doc, 1) ? { run: () => moveLayerToEdge(1) } : undefined;
        case "layer.arrange.sendToBack":
          return canShiftLayer(doc, -1) ? { run: () => moveLayerToEdge(-1) } : undefined;
        case "layer.arrange.reverse":
          return doc.layers.length > 1
            ? { run: () => onCommit(reverseLayerOrder(doc), zh.menu.reverseLayers) }
            : undefined;
        case "layer.newAdjustmentLayer.brightnessContrast":
          return adjustLayer("bc");
        case "layer.newAdjustmentLayer.levels":
          return adjustLayer("levels");
        case "layer.newAdjustmentLayer.curves":
          return adjustLayer("curves");
        case "layer.newAdjustmentLayer.exposure":
          return adjustLayer("exposure");
        case "layer.newAdjustmentLayer.hueSaturation":
          return adjustLayer("hs");
        case "layer.newAdjustmentLayer.colorBalance":
          return adjustLayer("colorbalance");
        case "layer.newAdjustmentLayer.blackWhite":
          return adjustLayer("bw");
        case "layer.newAdjustmentLayer.photoFilter":
          return adjustLayer("photofilter");
        case "layer.newAdjustmentLayer.channelMixer":
          return adjustLayer("channelmixer");
        case "layer.newAdjustmentLayer.invert":
          return adjustLayer("invert");
        case "layer.newAdjustmentLayer.posterize":
          return adjustLayer("posterize");
        case "layer.newAdjustmentLayer.threshold":
          return adjustLayer("threshold");
        case "layer.newAdjustmentLayer.gradientMap":
          return adjustLayer("gradientmap");
        case "layer.newAdjustmentLayer.vibrance":
          return adjustLayer("vibrance");
        case "layer.newAdjustmentLayer.selectiveColor":
          return adjustLayer("selectivecolor");
        case "layer.newAdjustmentLayer.colorLookup":
          return adjustLayer("colorlookup");
        case "layer.newAdjustmentLayer.shadowsHighlights":
          return adjustLayer("shadowhighlight");
        case "layer.newAdjustmentLayer.hdrToning":
          return adjustLayer("hdtoning");
        case "layer.newAdjustmentLayer.matchColor":
          return adjustLayer("matchcolor");
        case "layer.newAdjustmentLayer.replaceColor":
          return adjustLayer("replacecolor");
        case "layer.newAdjustmentLayer.equalize":
          return adjustLayer("equalize");
        case "layer.newAdjustmentLayer.cameraRaw":
          return adjustLayer("cameraraw");

        /* ---------------------------------------------------------- 选择 */
        case "select.saveSelection":
          // 把当前选区存成 Alpha 通道，没有选区时给提示（不弹空对话框）
          return hasSelection
            ? { run: () => setSaveSelOpen(true) }
            : { run: () => setToast(zh.dialog.channelSaveEmpty) };
        case "select.loadSelection":
          // 载入选区需要至少一个 Alpha 通道；挑张猫图前常先存一个，所以这里拦一下
          return alphaChannelsOf(doc).length > 0
            ? { run: () => setLoadSelOpen(true) }
            : { run: () => setToast(zh.dialog.channelLoadEmpty) };
        case "select.all":
          return { run: doSelectAll };
        case "select.deselect":
          return hasSelection ? { run: doDeselect } : undefined;
        case "select.inverse":
          return { run: doInvert };
        case "select.modify.feather":
          return hasSelection ? { run: doFeather, hint: `${selRadius} px` } : undefined;
        case "select.modify.expand":
          return hasSelection ? { run: doExpand, hint: `+${selRadius} px` } : undefined;
        case "select.modify.contract":
          return hasSelection ? { run: doContract, hint: `-${selRadius} px` } : undefined;
        case "select.modify.border":
          return hasSelection ? { run: doBorder, hint: `±${selRadius} px` } : undefined;
        case "select.modify.smooth":
          return hasSelection ? { run: doSmooth, hint: `${selRadius} px` } : undefined;
        case "select.similar":
          return hasSelection ? { run: doSimilar, hint: `±${tolerance}` } : undefined;
        case "select.reselect":
          return !hasSelection && lastSelectionRef.current
            ? {
                run: () =>
                  onCommit(
                    setSelection(doc, cloneSelection(lastSelectionRef.current!)),
                    zh.selection.reselected,
                  ),
              }
            : undefined;
        case "select.transformSelection":
          // 变换选区 = 把自由变换框开在选区上（PhotoCraft 同名行为）
          return hasSelection && canTransform ? { run: () => beginFreeTransform() } : undefined;
        case "layer.layerMask.addToSelection":
        case "layer.layerMask.subtractFromSelection":
        case "layer.layerMask.intersectSelection": {
          const layer = doc.layers[at];
          if (!layer?.mask) return undefined;
          const mask = cloneSelection(layer.mask);
          // 加选 = sel ∪ mask；减选 = sel ∩ ¬mask；交选 = sel ∩ mask
          if (id === "layer.layerMask.addToSelection") {
            return {
              run: () =>
                onCommit(
                  setSelection(doc, combineSelection(doc.selection, mask, "add")),
                  zh.selection.masked,
                ),
            };
          }
          if (id === "layer.layerMask.subtractFromSelection") {
            return {
              run: () =>
                onCommit(
                  setSelection(
                    doc,
                    combineSelection(doc.selection, invertSelection(mask), "intersect"),
                  ),
                  zh.selection.masked,
                ),
            };
          }
          return {
            run: () =>
              onCommit(
                setSelection(doc, combineSelection(doc.selection, mask, "intersect")),
                zh.selection.masked,
              ),
          };
        }

        /* ---------------------------------------------------------- 滤镜 */
        case "filter.cameraRaw":
          return adjustLayer("cameraraw");
        case "filter.filterGallery":
          return { run: () => setGallery(true) };
        case "filter.liquify":
          return { run: () => setLiquify(true) };

        /* ---------------------------------------------------------- 视图 */
        case "view.zoomIn":
          return { run: () => zoom(scale * ZOOM_STEP) };
        case "view.zoomOut":
          return { run: () => zoom(scale / ZOOM_STEP) };
        case "view.fitOnScreen":
        case "view.resetView":
          return { run: fit };
        case "view.actualPixels":
          return { run: () => zoom(1) };
        case "view.twoHundredPercent":
          return { run: () => zoom(2) };
        case "view.fillScreen":
          return { run: fillScreen };
        case "view.rulers":
          return { run: () => setShowRulers((v) => !v), checked: showRulers };
        case "view.show.grid":
          return { run: () => setShowGrid((v) => !v), checked: showGrid };
        case "view.show.guides":
          return { run: () => setShowGuides((v) => !v), checked: showGuides };
        case "view.show.pixelGrid":
          return { run: () => setShowPixelGrid((v) => !v), checked: showPixelGrid };
        case "view.extras":
          return { run: () => setExtras((v) => !v), checked: extras };
        case "view.lockGuides":
          return { run: () => setGuidesLocked((v) => !v), checked: guidesLocked };
        case "view.clearGuides":
        case "view.clearCanvasGuides":
          return {
            run: () => {
              setGuides({ x: [], y: [] });
              setToast("参考线已清除");
            },
          };
        case "view.snap":
          return { run: () => setSnapOn((v) => !v), checked: snapOn };
        case "view.snapTo.guides":
          return { run: () => setSnapGuides((v) => !v), checked: snapGuides };
        case "view.snapTo.grid":
          return { run: () => setSnapGrid((v) => !v), checked: snapGrid };
        case "view.snapTo.documentBounds":
          return { run: () => setSnapBounds((v) => !v), checked: snapBounds };
        case "view.snapTo.all":
          return {
            run: () => {
              setSnapOn(true);
              setSnapGuides(true);
              setSnapGrid(true);
              setSnapBounds(true);
            },
            checked: snapOn && snapGuides && snapGrid && snapBounds,
          };
        case "view.show.all":
          return {
            run: () => {
              setExtras(true);
              setShowGrid(true);
              setShowGuides(true);
            },
            checked: extras && showGrid && showGuides,
          };
        case "view.newGuide":
          return {
            run: () => {
              setShowRulers(true);
              setGuideDialog({ axis: "y", pos: String(Math.round(docH / 2)) });
            },
          };
        case "view.newGuideLayout":
          return {
            run: () =>
              setLayoutDialog({
                cols: "3",
                rows: "3",
                colGutter: "20",
                rowGutter: "20",
                margin: "0",
                clear: true,
              }),
          };
        case "view.newGuidesFromShape":
          return {
            run: () => {
              const b = selectionBounds(doc.selection);
              if (!b) {
                setToast(zh.dialog.guideFromShapeEmpty);
                return;
              }
              const xs = [b.x, b.x + b.width - 1];
              const ys = [b.y, b.y + b.height - 1];
              setGuides((gv) => ({ x: [...gv.x, ...xs], y: [...gv.y, ...ys] }));
              setExtras(true);
              setShowGuides(true);
              setToast(zh.dialog.guideFromShapeDone);
            },
          };
        case "view.show.smartGuides":
          return { run: () => setSmartGuides((v) => !v), checked: smartGuides };

        /* ---------------------------------------------------------- 窗口 */
        case "window.panel.color":
          return { run: () => toggleDock("color"), checked: dockOpen.color };
        case "window.panel.properties":
          return { run: () => toggleDock("props"), checked: dockOpen.props };
        case "window.panel.layers":
          return { run: () => toggleDock("layers"), checked: dockOpen.layers };
        case "window.panel.history":
          return { run: () => toggleDock("history"), checked: dockOpen.history };
        case "window.panel.navigator":
          return { run: () => toggleDock("navigator"), checked: dockOpen.navigator };
        case "window.panel.histogram":
          return { run: () => toggleDock("histogram"), checked: dockOpen.histogram };
        case "window.panel.scopes":
          return { run: () => toggleDock("scopes"), checked: dockOpen.scopes };
        case "window.panel.brushSettings":
          return {
            run: () => setBrushPanelOpen((v) => !v),
            checked: brushPanelOpen,
          };
        case "window.workspace.essentials":
        case "window.workspace.photography":
          return { run: () => pickWorkspace("photo"), checked: workspace === "photo" };
        case "window.workspace.painting":
        case "window.workspace.pixelArt":
          return { run: () => pickWorkspace("paint"), checked: workspace === "paint" };
        case "window.workspace.resetWorkspace":
          return {
            run: () => {
              pickWorkspace("photo");
              setDockOpen({ props: true, color: true, layers: true, history: false, navigator: false, histogram: false, scopes: false });
            },
          };
        case "window.theme.toggle":
          return { run: () => onSetTheme(themeMode === "dark" ? "light" : "dark") };

        default: {
          // 已注册的滤镜统一进参数弹窗（实时预览 + 确定才落盘）
          const fx = filterDef(id);
          if (fx) return { run: () => setFilterFx(fx.id) };
          return undefined;
        }
      }
    };

    const groups = buildMenuGroups(resolve);

    // 右键菜单与顶部菜单共用同一份命令表：把 resolve 转发给上面的 resolveRef
    resolveRef.current = resolve;

    /* 文件 > 添加到 Reelix：检测到装了 Reelix 才出现（用户要求的联动） */
    if (reelixState !== "absent") {
      insertAfterId(groups, "file.openAs", [
        {
          kind: "item",
          id: "reelix.sendTo",
          label: "添加到 Reelix 当前项目",
          hint: reelixState === "running" ? "直接进素材箱（PNG）" : "Reelix 未运行 · 存入投递箱",
          onSelect: () => {
            void (async () => {
              try {
                const ok = await sendToReelix(doc);
                if (ok) {
                  setToast(
                    reelixState === "running"
                      ? "已发送到 Reelix 素材箱"
                      : "已存入投递箱，Reelix 打开时自动导入"
                  );
                } else {
                  setToast("发送失败：投递箱不可写");
                }
              } catch {
                setToast("发送失败");
              }
            })();
          },
        },
      ]);
    }

    /* 文件 > 最近打开：与开始页共用同一份记录。 */
    const recent: MenuEntry[] = recentItems.length
      ? [
          ...recentItems.map((it) => ({
            kind: "item" as const,
            label: it.name,
            hint: it.missing ? "文件已移动" : it.path,
            onSelect: () => void openFileAt(it.path),
          })),
          { kind: "sep" as const },
          { kind: "item" as const, label: "清除最近打开", onSelect: clearRecent },
        ]
      : [{ kind: "item" as const, label: "暂无最近打开的文件", disabled: true }];
    insertAfterId(groups, "file.openAs", [
      { kind: "item", label: "最近打开", children: recent },
    ]);

    /* 窗口末尾：已打开的文档列表，当前文档打勾。 */
    appendToGroup(groups, "window", [
      { kind: "sep" },
      ...docs.map((d) => ({
        kind: "item" as const,
        label: d.name,
        checked: d.id === doc.id,
        onSelect: () => onSelectDoc(d.id),
      })),
    ]);

    /* 帮助：真实链接 + 应用内的快捷键 / 关于。 */
    appendToGroup(groups, "help", [
      { kind: "item", label: zh.menu.shortcuts, onSelect: () => setModal("shortcuts") },
      {
        kind: "item",
        label: zh.menu.palette,
        hint: "Ctrl+K",
        onSelect: () => setPalette(true),
      },
      { kind: "sep" },
      { kind: "item", label: "Strata 项目主页", onSelect: () => void openUrl(REPO_URL) },
      { kind: "item", label: "报告问题…", onSelect: () => void openUrl(ISSUES_URL) },
      { kind: "sep" },
      { kind: "item", label: zh.menu.about, onSelect: () => setModal("about") },
    ]);

    return groups;
  }, [
    at,
    beginFreeTransform,
    brushPanelOpen,
    canPaste,
    canRedo,
    canTransform,
    canUndo,
    clearRecent,
    closeAll,
    closeOthers,
    commitFreeTransform,
    doc,
    docs,
    doAdjust,
    doAuto,
    doContract,
    doCopy,
    doCut,
    doDeletePixels,
    doDeselect,
    doExpand,
    doFeather,
    doFill,
    doInpaint,
    doInvert,
    doPaste,
    doSelectAll,
    doSmooth,
    doTrim,
    dockOpen,
    exportPng,
    fg,
    fit,
    freeActive,
    hasSelection,
    mergeOk,
    moveLayerToEdge,
    newCanvas,
    onCloseDoc,
    onCommit,
    onQuit,
    onRedo,
    onSelectDoc,
    onSetTheme,
    onUndo,
    openFileAt,
    openImage,
    pickWorkspace,
    recentItems,
    reelixState,
    saveProject,
    scale,
    selRadius,
    showGrid,
    showRulers,
    showGuides,
    guidesLocked,
    showPixelGrid,
    extras,
    themeMode,
    toggleDock,
    workspace,
    zoom,
  ]);

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
    // 菜单是三级树，命令面板要的是平表：深度优先拍平，只收能真实执行的叶子。
    let seq = 0;
    const walk = (items: MenuEntry[], group: string) => {
      for (const it of items) {
        if (it.kind === "sep") continue;
        if (!it.disabled && it.onSelect) {
          seq += 1;
          list.push({
            id: it.id ? `menu.${it.id}` : `menu.${seq}`,
            label: it.label,
            hint: it.hint,
            group,
            run: it.onSelect,
          });
        }
        if (it.children) walk(it.children, group);
      }
    };
    for (const mg of menuGroups) walk(mg.items, mg.label);
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
      // 多边形套索画到一半：Esc 先撤掉整段折线（PS 的老规矩）
      if (polyPts) {
        setPolyPts(null);
        return;
      }
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
      // 编辑区通用快捷键：全选 / 复制 / 剪切 / 粘贴 / 重做（之前只绑了 Z/Y，A/C/X/V 缺失）
      if (k === "a") {
        e.preventDefault();
        doSelectAll();
        return;
      }
      if (k === "c") {
        e.preventDefault();
        doCopy(false);
        return;
      }
      if (k === "x") {
        e.preventDefault();
        doCut();
        return;
      }
      if (k === "v") {
        e.preventDefault();
        doPaste();
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
      // 视图 > 额外内容（Ctrl+H）
      if (k === "h" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setExtras((v) => !v);
        return;
      }
      // 参考线三连：Ctrl+; 显示 / Ctrl+Shift+; 吸附 / Ctrl+Alt+; 锁定。
      // Shift 会让分号键输出冒号，两个键位都收。
      if (k === ";" || k === ":") {
        e.preventDefault();
        if (e.altKey) setGuidesLocked((v) => !v);
        else if (e.shiftKey) setSnapOn((v) => !v);
        else setShowGuides((v) => !v);
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
      // Ctrl+Shift+A：Camera Raw（滤镜菜单里印了快捷键，按下就得有反应）
      if (k === "a" && e.shiftKey) {
        e.preventDefault();
        onCommit(addAdjustLayer(doc, newAdjustState("cameraraw")), zh.layers.adjustAdd);
        return;
      }
      if (k === "backspace") {
        e.preventDefault();
        doFill(bg);
        return;
      }
      return;
    }

    // Tab：沉浸模式，收起全部面板只留画布（PS 的老习惯）
    if (e.key === "Tab") {
      e.preventDefault();
      setHidePanels((v) => !v);
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
    // Q：快速蒙版（PS 同键位）
    if (e.key.toLowerCase() === "q" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      toggleQuickMask();
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
    <div className={hidePanels ? "editor is-immersive" : "editor"}>
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
            sampleAllLayers={sampleAllLayers}
            onSampleAllLayers={setSampleAllLayers}
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
                onContextMenu={openCanvasMenu}
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
              {/* 参考线：从标尺里拉出来的对齐线，纯浮层，不进像素也不进历史 */}
              {extras && showGuides && (guides.x.length > 0 || guides.y.length > 0) && (
                <div className="editor-guides" aria-hidden="true">
                  {guides.x.map((gx, i) => (
                    <div
                      key={`gx-${i}`}
                      className="editor-guide is-v"
                      style={{ left: gx * scale }}
                    />
                  ))}
                  {guides.y.map((gy, i) => (
                    <div
                      key={`gy-${i}`}
                      className="editor-guide is-h"
                      style={{ top: gy * scale }}
                    />
                  ))}
                </div>
              )}
              {/* 像素网格：放大到 800% 以上才画，否则格子会糊成一片灰 */}
              {extras && showPixelGrid && scale >= 8 && (
                <div
                  className="editor-pixelgrid"
                  aria-hidden="true"
                  style={{ backgroundSize: `${scale}px ${scale}px` }}
                />
              )}
              {/* 标尺：贴着画布上沿 / 左沿的刻度条，随缩放和对齐画布原点。
                  从刻度条上按住往里拖，就能拉出新参考线。 */}
              {showRulers && (
                <>
                  <div
                    className="editor-ruler editor-ruler-h"
                    style={{ backgroundSize: `${100 * scale}px 100%, ${10 * scale}px 100%` }}
                    onPointerDown={onRulerDown("y")}
                    onPointerMove={onRulerMove}
                    onPointerUp={onRulerUp}
                    onPointerCancel={onRulerUp}
                  />
                  <div
                    className="editor-ruler editor-ruler-v"
                    style={{ backgroundSize: `100% ${100 * scale}px, 100% ${10 * scale}px` }}
                    onPointerDown={onRulerDown("x")}
                    onPointerMove={onRulerMove}
                    onPointerUp={onRulerUp}
                    onPointerCancel={onRulerUp}
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
        <RightDock
          open={dockOpen}
          onToggle={toggleDock}
          navigator={
            <NavigatorPanel
              docW={docW}
              docH={docH}
              source={compRef.current}
              version={panelTick}
              scale={scale}
              viewportW={viewportSize.w}
              viewportH={viewportSize.h}
              panX={pan.x}
              panY={pan.y}
              onCenter={(x, y) =>
                setPan({
                  x: viewportSize.w / 2 - x * scale,
                  y: viewportSize.h / 2 - y * scale,
                })
              }
              onZoom={zoom}
            />
          }
          histogram={<HistogramPanel source={compRef.current} version={panelTick} />}
          scopes={<ScopesPanel source={compRef.current} version={panelTick} />}
          color={
            <ColorPanel
              fg={fg}
              bg={bg}
              onFg={setFg}
              onBg={setBg}
              onSwap={swapColors}
              onReset={resetColors}
              onPickTool={pickTool}
            />
          }
          properties={<PropertiesPanel doc={doc} onChange={onCommit} onPreview={onPreview} />}
          layers={
            <LayersPanel
              doc={doc}
              onChange={onCommit}
              onPreview={onPreview}
              maskEdit={maskEdit}
              onMaskEdit={setMaskEdit}
              channelVis={channelVis}
              activeChannel={activeChannel}
              onChannel={pickChannel}
              onSaveSelection={() => {
                if (!hasSelection) {
                  setToast(zh.dialog.channelSaveEmpty);
                  return;
                }
                setSaveSelOpen(true);
              }}
              onLoadSelection={() => {
                if (alphaChannelsOf(doc).length === 0) {
                  setToast(zh.dialog.channelLoadEmpty);
                  return;
                }
                setLoadSelOpen(true);
              }}
              onChannelCalc={() => {
                if (alphaChannelsOf(doc).length < 2) {
                  setToast(zh.dialog.channelCalcNeed2);
                  return;
                }
                setCalcOpen(true);
              }}
              viewAlpha={viewAlpha}
              onViewAlpha={setViewAlpha}
              onLayerContextMenu={openLayerMenu}
              onMaskContextMenu={openMaskMenu}
            />
          }
          history={
            <HistoryPanel
              labels={historyLabels}
              index={historyIndex}
              onJump={onHistoryJump}
            />
          }
        />
      </div>

      <StatusBar doc={doc} scale={scale} tool={tool} />

      {palette && (
        <CommandPalette commands={commands} onClose={() => setPalette(false)} />
      )}
      {modal !== null && (
        <InfoModals which={modal} info={info} onClose={() => setModal(null)} />
      )}
      {/* 新建参考线：方向 + 位置，位置以文档像素计 */}
      {guideDialog && (
        <Modal
          title={zh.dialog.newGuideTitle}
          onClose={() => setGuideDialog(null)}
          width={400}
          footer={
            <>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => setGuideDialog(null)}
              >
                {zh.dialog.cancel}
              </button>
              <button type="button" className="btn-primary btn-sm" onClick={submitGuide}>
                {zh.dialog.confirm}
              </button>
            </>
          }
        >
          <p className="isz-hint">{zh.dialog.newGuideHint}</p>
          <div className="field-row">
            <div className="field">
              <span className="field-label">{zh.dialog.guideOrientation}</span>
              <div className="editor-ws" role="group" aria-label={zh.dialog.guideOrientation}>
                <button
                  type="button"
                  className={guideDialog.axis === "y" ? "ws-btn is-on" : "ws-btn"}
                  onClick={() =>
                    setGuideDialog((v) => (v ? { ...v, axis: "y" } : v))
                  }
                >
                  {zh.dialog.guideHorizontal}
                </button>
                <button
                  type="button"
                  className={guideDialog.axis === "x" ? "ws-btn is-on" : "ws-btn"}
                  onClick={() =>
                    setGuideDialog((v) => (v ? { ...v, axis: "x" } : v))
                  }
                >
                  {zh.dialog.guideVertical}
                </button>
              </div>
            </div>
            <label className="field">
              <span className="field-label">{zh.dialog.guidePosition}</span>
              <span className="field-input">
                <input
                  type="number"
                  min={0}
                  max={guideDialog.axis === "x" ? docW : docH}
                  value={guideDialog.pos}
                  autoFocus
                  onChange={(e) => {
                    const pos = e.target.value;
                    setGuideDialog((v) => (v ? { ...v, pos } : v));
                  }}
                  onKeyDown={(e) => e.key === "Enter" && submitGuide()}
                />
                <span className="field-unit">{zh.dialog.px}</span>
              </span>
            </label>
          </div>
        </Modal>
      )}
      {/* 编辑 > 描边：宽度 / 颜色 / 位置 / 不透明度 */}
      {strokeDialog && (
        <Modal
          title={zh.dialog.strokeTitle}
          onClose={() => setStrokeDialog(null)}
          width={430}
          footer={
            <>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => setStrokeDialog(null)}
              >
                {zh.dialog.cancel}
              </button>
              <button type="button" className="btn-primary btn-sm" onClick={submitStroke}>
                {zh.dialog.confirm}
              </button>
            </>
          }
        >
          <p className="isz-hint">{zh.dialog.strokeHint}</p>
          <div className="field-row">
            <label className="field">
              <span className="field-label">{zh.dialog.strokeWidth}</span>
              <span className="field-input">
                <input
                  type="number"
                  min={1}
                  max={300}
                  value={strokeDialog.width}
                  autoFocus
                  onChange={(e) => {
                    const width = e.target.value;
                    setStrokeDialog((v) => (v ? { ...v, width } : v));
                  }}
                  onKeyDown={(e) => e.key === "Enter" && submitStroke()}
                />
                <span className="field-unit">{zh.dialog.px}</span>
              </span>
            </label>
            <label className="field">
              <span className="field-label">{zh.dialog.strokeOpacity}</span>
              <span className="field-input">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={strokeDialog.opacity}
                  onChange={(e) => {
                    const opacity = e.target.value;
                    setStrokeDialog((v) => (v ? { ...v, opacity } : v));
                  }}
                  onKeyDown={(e) => e.key === "Enter" && submitStroke()}
                />
                <span className="field-unit">%</span>
              </span>
            </label>
          </div>
          <div className="field-row">
            <div className="field">
              <span className="field-label">{zh.dialog.strokeColor}</span>
              <span className="field-input">
                <ColorChip
                  hex={strokeDialog.color}
                  label={zh.dialog.strokeColor}
                  onChange={(color) => setStrokeDialog((v) => (v ? { ...v, color } : v))}
                />
              </span>
            </div>
            <div className="field">
              <span className="field-label">{zh.dialog.strokePosition}</span>
              <div className="editor-ws" role="group" aria-label={zh.dialog.strokePosition}>
                {(
                  [
                    ["inside", zh.dialog.strokeInside],
                    ["center", zh.dialog.strokeCenter],
                    ["outside", zh.dialog.strokeOutside],
                  ] as const
                ).map(([pos, label]) => (
                  <button
                    key={pos}
                    type="button"
                    className={strokeDialog.position === pos ? "ws-btn is-on" : "ws-btn"}
                    onClick={() => setStrokeDialog((v) => (v ? { ...v, position: pos } : v))}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      )}
      {/* 图层 > 重命名图层 */}
      {renameDialog && (
        <Modal
          title={zh.dialog.renameTitle}
          onClose={() => setRenameDialog(null)}
          width={420}
          footer={
            <>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => setRenameDialog(null)}
              >
                {zh.dialog.cancel}
              </button>
              <button type="button" className="btn-primary btn-sm" onClick={submitRename}>
                {zh.dialog.confirm}
              </button>
            </>
          }
        >
          <p className="isz-hint">{zh.dialog.renameHint}</p>
          <label className="field">
            <span className="field-label">{zh.dialog.renameName}</span>
            <span className="field-input">
              <input
                type="text"
                value={renameDialog.name}
                autoFocus
                onChange={(e) => {
                  const name = e.target.value;
                  setRenameDialog((v) => (v ? { ...v, name } : v));
                }}
                onKeyDown={(e) => e.key === "Enter" && submitRename()}
              />
            </span>
          </label>
        </Modal>
      )}
      {/* 新建参考线版面：列 / 行 / 间距 / 边距，一次铺满整张画布 */}
      {layoutDialog && (
        <Modal
          title={zh.dialog.layoutTitle}
          onClose={() => setLayoutDialog(null)}
          width={460}
          footer={
            <>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => setLayoutDialog(null)}
              >
                {zh.dialog.cancel}
              </button>
              <button type="button" className="btn-primary btn-sm" onClick={submitLayout}>
                {zh.dialog.confirm}
              </button>
            </>
          }
        >
          <p className="isz-hint">{zh.dialog.layoutHint}</p>
          <div className="guide-layout-form">
            <div className="field-row">
              <label className="field">
                <span className="field-label">{zh.dialog.layoutColumns}</span>
                <span className="field-input">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={layoutDialog.cols}
                    autoFocus
                    onChange={(e) => {
                      const cols = e.target.value;
                      setLayoutDialog((v) => (v ? { ...v, cols } : v));
                    }}
                  />
                </span>
              </label>
              <label className="field">
                <span className="field-label">{zh.dialog.layoutRows}</span>
                <span className="field-input">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={layoutDialog.rows}
                    onChange={(e) => {
                      const rows = e.target.value;
                      setLayoutDialog((v) => (v ? { ...v, rows } : v));
                    }}
                  />
                </span>
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span className="field-label">{zh.dialog.layoutColGutter}</span>
                <span className="field-input">
                  <input
                    type="number"
                    min={0}
                    value={layoutDialog.colGutter}
                    onChange={(e) => {
                      const colGutter = e.target.value;
                      setLayoutDialog((v) => (v ? { ...v, colGutter } : v));
                    }}
                  />
                  <span className="field-unit">{zh.dialog.px}</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">{zh.dialog.layoutRowGutter}</span>
                <span className="field-input">
                  <input
                    type="number"
                    min={0}
                    value={layoutDialog.rowGutter}
                    onChange={(e) => {
                      const rowGutter = e.target.value;
                      setLayoutDialog((v) => (v ? { ...v, rowGutter } : v));
                    }}
                  />
                  <span className="field-unit">{zh.dialog.px}</span>
                </span>
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span className="field-label">{zh.dialog.layoutMargin}</span>
                <span className="field-input">
                  <input
                    type="number"
                    min={0}
                    value={layoutDialog.margin}
                    onChange={(e) => {
                      const margin = e.target.value;
                      setLayoutDialog((v) => (v ? { ...v, margin } : v));
                    }}
                  />
                  <span className="field-unit">{zh.dialog.px}</span>
                </span>
              </label>
              <div className="field guide-layout-clear">
                <Check
                  label={zh.dialog.layoutClear}
                  on={layoutDialog.clear}
                  onChange={(clear) => setLayoutDialog((v) => (v ? { ...v, clear } : v))}
                />
              </div>
            </div>
          </div>
        </Modal>
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
      {saveSelOpen && (
        <SaveSelectionDialog
          doc={doc}
          onApply={(next) => {
            setSaveSelOpen(false);
            onCommit(next, zh.dialog.channelSaveTitle);
          }}
          onClose={() => setSaveSelOpen(false)}
        />
      )}
      {loadSelOpen && (
        <LoadSelectionDialog
          doc={doc}
          onPreview={onPreview}
          onApply={(next) => {
            setLoadSelOpen(false);
            onCommit(next, zh.dialog.channelLoadTitle);
          }}
          onClose={() => setLoadSelOpen(false)}
        />
      )}
      {calcOpen && (
        <ChannelCalcDialog
          doc={doc}
          onApply={(next) => {
            setCalcOpen(false);
            onCommit(next, zh.dialog.channelCalcTitle);
          }}
          onClose={() => setCalcOpen(false)}
        />
      )}
      {refineOpen && (
        <RefineEdgeDialog
          doc={doc}
          onPreview={onPreview}
          onApply={(next) => {
            setRefineOpen(false);
            onCommit(next, zh.dialog.refineEdgeTitle);
          }}
          onClose={() => setRefineOpen(false)}
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
      {filterFx && (
        <FilterFxDialog
          doc={doc}
          filterId={filterFx}
          onPreview={onPreview}
          onApply={(next) => {
            setFilterFx(null);
            onCommit(next, filterDef(filterFx)?.label ?? zh.dialog.filterTitle);
          }}
          onClose={() => setFilterFx(null)}
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
      {/* 画布 / 图层面板共用的右键菜单浮层 */}
      <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />
    </div>
  );
}
