/**
 * 一份打开的文档。
 *
 * M0 只承载「一张位图 + 尺寸」，M1 起改为图层栈：文档本身只描述画布，
 * 像素全部落在图层里。这样图层面板、混合模式、撤销栈都能直接接上。
 */
import { cloneLayer, createLayer, layerFromBitmap, type StrataLayer } from "./layer";
import { cloneSelection, type SelectionMask } from "./selection";
import { type AlphaChannel } from "./channels";
import { cloneAlphaChannels } from "./channelOps";

/** 选区遮罩：与画布同尺寸，alpha 分量即「选中程度」。无选区时为 null。 */
export type { SelectionMask };

export interface StrataDoc {
  /** 文档唯一标识 */
  id: string;
  /** 文档名（标签页 / 最近文件展示用） */
  name: string;
  /** 画布宽度（像素） */
  width: number;
  /** 画布高度（像素） */
  height: number;
  /** 图层栈，下标 0 为最底层（绘制顺序即从此向上） */
  layers: StrataLayer[];
  /** 当前选中图层 id */
  activeLayerId: string;
  /** 新建画布时指定的打印分辨率（dpi）；打开图片时未知则为 undefined */
  dpi?: number;
  /** 源文件路径；新建画布时为 undefined */
  sourcePath?: string;
  /**
   * 当前选区遮罩（与画布同尺寸，alpha 即选中程度）。
   * 无选区 / 全选后取消时为 null —— 与 PS 一样，null 表示「不限制范围」。
   */
  selection?: SelectionMask | null;
  /**
   * 持久 Alpha 通道（「存储选区」的落点，随工程存盘）。
   * 旧工程没有此字段，读取时按空数组处理。
   */
  alphaChannels?: AlphaChannel[];
  /** 相对磁盘是否有未保存改动 */
  dirty?: boolean;
  /* ---------------------------------------------------- 颜色模式与精度 */
  /**
   * 当前颜色模式。Strata 的渲染管线固定 8 位 sRGB，这里记录的是「上一次
   * 应用过哪种模式转换」以及给菜单打勾用；像素本身该变的已经变过了。
   */
  colorMode?: "rgb" | "bitmap" | "grayscale" | "duotone" | "indexed" | "cmyk" | "lab" | "multichannel";
  /** 通道位深标记（8 / 16 / 32）。管线原生 8 位，16/32 只是精度标记 */
  bitsPerChannel?: 8 | 16 | 32;
  /** 索引颜色模式下调色板（颜色表编辑用） */
  palette?: readonly [number, number, number][];
  /** 当前文档的色彩配置文件（指定 / 转换配置文件用） */
  profile?: "srgb" | "display-p3" | "adobe-rgb" | "gray";
  /* ------------------------------------------------------ 多选与测量 */
  /**
   * 多选的图层 id（选择 > 所有图层 / 查找图层 / 取消选择图层）。
   * 与 activeLayerId 分开：activeLayerId 始终是「唯一的作用对象」，
   * selectedLayerIds 是「一批可以一起删/一起隐藏的图层」。
   */
  selectedLayerIds?: string[];
  /** 测量比例：px 个像素 = real 个 unit（分析 > 设置测量比例） */
  measureScale?: { px: number; real: number; unit: string };
  /** 测量结果表要显示哪些列（分析 > 选择数据点） */
  measureFields?: string[];
  /* -------------------------------------------------- 变量与数据集 */
  /**
   * 变量定义（图像 > 变量）：把某个图层绑到一个变量名上。
   * 目前支持「可见性变量」—— 这是 PS 数据驱动图形的三种变量之一，
   * 也是在没有独立文本层的架构下唯一能真实生效的一种。
   */
  variables?: { layerId: string; name: string }[];
  /** 数据集（图像 > 变量 > 数据集）：一项 = 一组 变量名→值 */
  dataSets?: { name: string; values: Record<string, string> }[];
}

let seq = 0;

/** 生成一个进程内唯一的文档 id。 */
export function nextDocId(): string {
  seq += 1;
  return `doc-${Date.now().toString(36)}-${seq}`;
}

/** 从文件路径中取出不含扩展名的文件名。 */
export function baseName(path: string): string {
  const seg = path.split(/[\\/]/).pop() ?? path;
  const dot = seg.lastIndexOf(".");
  return dot > 0 ? seg.slice(0, dot) : seg;
}

/** 取当前选中图层；找不到时退回最上层，保证任何时刻都有可操作对象。 */
export function activeLayer(doc: StrataDoc): StrataLayer | null {
  return (
    doc.layers.find((l) => l.id === doc.activeLayerId) ??
    doc.layers[doc.layers.length - 1] ??
    null
  );
}

/** 由一张位图新建文档（打开图片走这里）。 */
export function docFromBitmap(
  bitmap: ImageBitmap,
  name: string,
  sourcePath?: string,
): StrataDoc {
  const layer = layerFromBitmap(bitmap, "背景");
  return {
    id: nextDocId(),
    name,
    width: bitmap.width,
    height: bitmap.height,
    layers: [layer],
    activeLayerId: layer.id,
    sourcePath,
    dirty: false,
  };
}

/** 新建空白文档。 */
export function docFromBlank(
  width: number,
  height: number,
  name: string,
  bg: "white" | "transparent",
  dpi?: number,
): StrataDoc {
  const layer = createLayer(
    width,
    height,
    "背景",
    bg === "white" ? "#ffffff" : undefined,
  );
  return {
    id: nextDocId(),
    name,
    width,
    height,
    layers: [layer],
    activeLayerId: layer.id,
    dpi,
    dirty: false,
  };
}

/** 深拷贝整份文档（多文档标签页与历史栈都靠它）。 */
export function cloneDoc(doc: StrataDoc): StrataDoc {
  return {
    ...doc,
    layers: doc.layers.map(cloneLayer),
    // 选区也要拷一份，否则两个文档标签页会共用同一张遮罩画布。
    selection: doc.selection ? cloneSelection(doc.selection) : doc.selection,
    // Alpha 通道同理：各自一份遮罩，互不串台。
    alphaChannels: cloneAlphaChannels(doc.alphaChannels),
  };
}
