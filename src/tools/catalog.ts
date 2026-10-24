/**
 * 工具目录。
 *
 * 立项规划书 §7.1：工具不做折叠菜单，直接铺开、随手可点；靠形状与快捷键
 * 相互区分，按钮维持常规尺寸。这里只描述结构（id / 快捷键 / 分组 / 是否
 * 已接入），中文名一律取自 i18n 字典，避免界面文案散落在代码里。
 *
 * `ready` 为 false 的工具在界面上以「待接入」态呈现（禁用 + 提示），
 * 不做假可用 —— 也就是说，没有任何一个工具点了不动却没说明的。
 */

export type ToolId =
  | "move"
  | "marquee"
  | "ellipse"
  | "lasso"
  | "polyLasso"
  | "singleRow"
  | "singleColumn"
  | "wand"
  | "pencil"
  | "magicEraser"
  | "shapeRect"
  | "shapeEllipse"
  | "shapeLine"
  | "text"
  | "crop"
  | "eyedropper"
  | "brush"
  | "eraser"
  | "bucket"
  | "gradient"
  | "clone"
  | "heal"
  | "blur"
  | "sharpen"
  | "dodge"
  | "burn"
  | "sponge"
  | "hand"
  | "zoom";

export type ToolGroupId =
  | "transform"
  | "select"
  | "shape"
  | "text"
  | "paint"
  | "retouch"
  | "sample"
  | "crop"
  | "nav";

export interface ToolDef {
  id: ToolId;
  /** 快捷键字母（PS 习惯） */
  shortcut: string;
  /** 工具轨上的分组 */
  group: ToolGroupId;
  /** 是否已经真正接入；false 时界面呈现禁用态并给出说明 */
  ready: boolean;
}

/** 分组顺序即左侧工具轨的显示顺序。中文名取自 i18n 的 `toolGroups`。 */
export const TOOL_GROUPS: ToolGroupId[] = [
  "transform",
  "select",
  "shape",
  "text",
  "paint",
  "retouch",
  "sample",
  "crop",
  "nav",
];

export const TOOLS: ToolDef[] = [
  { id: "move", shortcut: "V", group: "transform", ready: true },

  { id: "marquee", shortcut: "M", group: "select", ready: true },
  { id: "ellipse", shortcut: "M", group: "select", ready: true },
  { id: "singleRow", shortcut: "M", group: "select", ready: true },
  { id: "singleColumn", shortcut: "M", group: "select", ready: true },
  { id: "lasso", shortcut: "L", group: "select", ready: true },
  { id: "polyLasso", shortcut: "L", group: "select", ready: true },
  { id: "wand", shortcut: "W", group: "select", ready: true },

  { id: "shapeRect", shortcut: "U", group: "shape", ready: true },
  { id: "shapeEllipse", shortcut: "U", group: "shape", ready: true },
  { id: "shapeLine", shortcut: "U", group: "shape", ready: true },

  { id: "text", shortcut: "T", group: "text", ready: true },

  { id: "brush", shortcut: "B", group: "paint", ready: true },
  { id: "pencil", shortcut: "B", group: "paint", ready: true },
  { id: "eraser", shortcut: "E", group: "paint", ready: true },
  { id: "magicEraser", shortcut: "E", group: "paint", ready: true },
  { id: "bucket", shortcut: "G", group: "paint", ready: true },
  { id: "gradient", shortcut: "G", group: "paint", ready: true },

  { id: "clone", shortcut: "S", group: "retouch", ready: true },
  { id: "heal", shortcut: "J", group: "retouch", ready: true },
  { id: "blur", shortcut: "R", group: "retouch", ready: true },
  { id: "sharpen", shortcut: "R", group: "retouch", ready: true },
  { id: "dodge", shortcut: "O", group: "retouch", ready: true },
  { id: "burn", shortcut: "O", group: "retouch", ready: true },
  { id: "sponge", shortcut: "O", group: "retouch", ready: true },

  { id: "eyedropper", shortcut: "I", group: "sample", ready: true },

  { id: "crop", shortcut: "C", group: "crop", ready: true },

  { id: "hand", shortcut: "H", group: "nav", ready: true },
  { id: "zoom", shortcut: "Z", group: "nav", ready: true },
];

const BY_ID = new Map<ToolId, ToolDef>(TOOLS.map((t) => [t.id, t]));

export function toolDef(id: ToolId): ToolDef {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`未登记的工具：${id}`);
  return found;
}

/** 快捷键字母 → 工具。同一字母多个工具时取目录里第一个（PS 也是主次之分）。 */
export function toolByShortcut(letter: string): ToolId | null {
  const up = letter.toUpperCase();
  return TOOLS.find((t) => t.shortcut === up)?.id ?? null;
}

/** 同字母的全部工具（用于 PS 式「再按一次切换」循环）。 */
export function toolsWithShortcut(letter: string): ToolId[] {
  const up = letter.toUpperCase();
  return TOOLS.filter((t) => t.shortcut === up).map((t) => t.id);
}

/** 是否是需要画选区框的工具（选项条据此切换内容）。 */
export function isSelectionTool(id: ToolId): boolean {
  return (
    id === "marquee" ||
    id === "ellipse" ||
    id === "lasso" ||
    id === "polyLasso" ||
    id === "singleRow" ||
    id === "singleColumn" ||
    id === "wand"
  );
}

/** 按分组取出工具，供工具轨渲染。 */
export function toolsInGroup(group: string): ToolDef[] {
  return TOOLS.filter((t) => t.group === group);
}

/** 需要画笔参数的工具有哪些（选项条据此切换内容）。 */
export function usesBrush(id: ToolId): boolean {
  return id === "brush" || id === "pencil" || id === "eraser";
}

/** 走「点一下就落库」而不是「拖一圈」的选区工具。 */
export function isClickSelectTool(id: ToolId): boolean {
  return id === "wand" || id === "singleRow" || id === "singleColumn";
}

/** 形状工具（矩形 / 椭圆 / 直线）：拖拽绘制，选项条给出填充与描边。 */
export function isShapeTool(id: ToolId): boolean {
  return id === "shapeRect" || id === "shapeEllipse" || id === "shapeLine";
}

/** 文字工具：在画布上点一下落一个文本框，输入后栅格化成像素。 */
export function isTextTool(id: ToolId): boolean {
  return id === "text";
}

/** 修饰类工具（选项条据此切换为「力度 / 范围 / 海绵模式」一套）。 */
export function isRetouchTool(id: ToolId): boolean {
  return (
    id === "clone" ||
    id === "heal" ||
    id === "blur" ||
    id === "sharpen" ||
    id === "dodge" ||
    id === "burn" ||
    id === "sponge"
  );
}
