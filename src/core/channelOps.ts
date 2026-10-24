/**
 * Alpha 通道操作（存 / 载 / 运算）。
 *
 * 对应 PS 的「选择 > 存储选区 / 载入选区」与「图像 > 计算」。通道就是一份
 * 起了名的持久选区：存的时候从当前选区拷贝一张遮罩、跟着工程走；载的时候
 * 原样变回选区，像素级一致。
 *
 * 通道运算是纯数学，单独拆成 `combineChannelData` 放最前面 —— 单测在 node
 * 里跑的就是它；下面的文档级函数只是把这套数学裹上 canvas 与文档结构。
 *
 * 算法参考：PhotoCraft `engine/channel_cmds.rs`（MIT / Apache-2.0）的
 * 通道运算语义（相加 = 并集取大、相减 = 差集、交叠 = 交集取小）。
 */
import {
  cloneSelection,
  combineSelection,
  type SelectionMask,
  type SelectionMode,
} from "./selection";
import { createSurface, readPixels, writePixels } from "../engine/surface";
import type { AlphaChannel } from "./channels";
import type { StrataDoc } from "./document";

/** 通道运算的三种混合，语义与选区布尔运算一致。 */
export type ChannelOp = "add" | "subtract" | "intersect";

export const CHANNEL_OPS: readonly { value: ChannelOp; label: string }[] = [
  { value: "add", label: "相加" },
  { value: "subtract", label: "相减" },
  { value: "intersect", label: "交叠" },
];

/* ---------------------------------------------------------------- 纯数学 */

/**
 * 两张同尺寸遮罩的逐像素运算（纯函数，node 可测）。
 *
 * 输入输出都是**只取 alpha 分量**的 RGBA 缓冲（alpha 即选中程度）：
 *  · 相加   —— 并集：max(a, b)
 *  · 相减   —— 差集：max(0, a - b)
 *  · 交叠   —— 交集：min(a, b)
 * `invA` / `invB` 先对各自的源取补（PS 计算对话框里的「反相」复选框），
 * `invert` 对结果取补。RGB 一律写白，与选区的白底语义一致。
 */
export function combineChannelData(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  op: ChannelOp,
  invA = false,
  invB = false,
  invert = false,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i += 4) {
    const av = invA ? 255 - a[i + 3] : a[i + 3];
    const bv = invB ? 255 - b[i + 3] : b[i + 3];
    let r: number;
    if (op === "add") r = Math.max(av, bv);
    else if (op === "subtract") r = Math.max(0, av - bv);
    else r = Math.min(av, bv);
    if (invert) r = 255 - r;
    out[i] = 255;
    out[i + 1] = 255;
    out[i + 2] = 255;
    out[i + 3] = r;
  }
  return out;
}

/* ------------------------------------------------------------ 工具函数 */

let chSeq = 0;

/** 生成进程内唯一的通道 id。 */
export function nextAlphaChannelId(): string {
  chSeq += 1;
  return `ch-${Date.now().toString(36)}-${chSeq}`;
}

/** 文档上的 Alpha 通道列表（旧工程没有该字段，按空处理）。 */
export function alphaChannelsOf(doc: StrataDoc): AlphaChannel[] {
  return doc.alphaChannels ?? [];
}

/** 按 id 找通道。 */
export function findAlphaChannel(
  doc: StrataDoc,
  id: string,
): AlphaChannel | undefined {
  return alphaChannelsOf(doc).find((c) => c.id === id);
}

/** 下一个不重名的通道名（Alpha 1 / Alpha 2 …，跳过分隔线副本后缀）。 */
export function nextChannelName(doc: StrataDoc, base = "Alpha"): string {
  const used = new Set(alphaChannelsOf(doc).map((c) => c.name));
  for (let i = 1; i < 999; i += 1) {
    const name = `${base} ${i}`;
    if (!used.has(name)) return name;
  }
  return `${base} ${Date.now().toString(36)}`;
}

/** 遮罩是否全空（没有任何像素被选中）—— 与选区判空同一口径。 */
export function isChannelMaskEmpty(mask: SelectionMask): boolean {
  const d = readPixels(mask).data;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] !== 0) return false;
  }
  return true;
}

/** 把一段 alpha 数组写进一张新建的遮罩画布（RGB 白、alpha 即选中程度）。 */
function maskFromAlpha(data: Uint8ClampedArray, width: number, height: number): SelectionMask {
  const mask = createSurface(width, height);
  writePixels(mask, { data, width, height } as ImageData);
  return mask;
}

/** 取一张遮罩的 alpha 数组（长度 = 宽 × 高 × 4，只认 alpha 分量）。 */
function alphaOf(mask: SelectionMask): Uint8ClampedArray {
  return readPixels(mask).data;
}

/** 换掉文档的通道列表，标记脏。 */
function withChannels(doc: StrataDoc, channels: AlphaChannel[]): StrataDoc {
  return { ...doc, alphaChannels: channels, dirty: true };
}

/* -------------------------------------------------------- 文档级操作 */

/**
 * 把当前选区存成新的 Alpha 通道（PS：选择 > 存储选区）。
 * 没有选区时原样返回（调用方应先判空并给提示）。
 */
export function saveSelectionAsChannel(doc: StrataDoc, name?: string): StrataDoc {
  if (!doc.selection) return doc;
  const channels = alphaChannelsOf(doc).slice();
  channels.push({
    id: nextAlphaChannelId(),
    name: name?.trim() || nextChannelName(doc),
    mask: cloneSelection(doc.selection),
  });
  return withChannels(doc, channels);
}

/**
 * 把某个 Alpha 通道载回选区（PS：选择 > 载入选区）。
 * `mode` 与选区工具的四态同义：new 替换 / add 相加 / subtract 相减 / intersect 交叠。
 */
export function loadChannelAsSelection(
  doc: StrataDoc,
  channelId: string,
  mode: SelectionMode = "new",
): StrataDoc {
  const ch = findAlphaChannel(doc, channelId);
  if (!ch) return doc;
  const next =
    mode === "new"
      ? cloneSelection(ch.mask)
      : combineSelection(doc.selection, cloneSelection(ch.mask), mode);
  return { ...doc, selection: next, dirty: true };
}

/** 新建一张全空（全不选）通道（PS：通道面板的「创建新通道」）。 */
export function createBlankChannel(doc: StrataDoc, name?: string): StrataDoc {
  const channels = alphaChannelsOf(doc).slice();
  channels.push({
    id: nextAlphaChannelId(),
    name: name?.trim() || nextChannelName(doc),
    mask: createSurface(doc.width, doc.height),
  });
  return withChannels(doc, channels);
}

/** 复制通道，副本紧挨原层之后，名字带「副本」后缀（PS 同款）。 */
export function duplicateChannel(doc: StrataDoc, channelId: string): StrataDoc {
  const channels = alphaChannelsOf(doc).slice();
  const at = channels.findIndex((c) => c.id === channelId);
  if (at < 0) return doc;
  const src = channels[at];
  channels.splice(at + 1, 0, {
    id: nextAlphaChannelId(),
    name: nextChannelName(doc, `${src.name} 副本`),
    mask: cloneSelection(src.mask),
  });
  return withChannels(doc, channels);
}

/** 删除通道（至少不是破坏性的：通道只是数据，删了不碰画面）。 */
export function deleteChannel(doc: StrataDoc, channelId: string): StrataDoc {
  const channels = alphaChannelsOf(doc).filter((c) => c.id !== channelId);
  return withChannels(doc, channels);
}

/** 重命名通道。 */
export function renameChannel(doc: StrataDoc, channelId: string, name: string): StrataDoc {
  const channels = alphaChannelsOf(doc).map((c) =>
    c.id === channelId ? { ...c, name: name.trim() || c.name } : c,
  );
  return withChannels(doc, channels);
}

/**
 * 通道运算（PS：图像 > 计算）。
 *
 * 两个源通道按 op 逐像素运算，可选各自反相与结果反相，产物是一个**新通道**；
 * 结果与「文档选区」无关，纯粹是通道之间的数学，因此不进选区、只加通道。
 */
export function combineAlphaChannels(
  doc: StrataDoc,
  opts: {
    source1: string;
    source2: string;
    op: ChannelOp;
    invert1?: boolean;
    invert2?: boolean;
    invert?: boolean;
    name?: string;
  },
): StrataDoc {
  const a = findAlphaChannel(doc, opts.source1);
  const b = findAlphaChannel(doc, opts.source2);
  if (!a || !b || a.mask.width !== b.mask.width || a.mask.height !== b.mask.height) {
    return doc;
  }
  const data = combineChannelData(
    alphaOf(a.mask),
    alphaOf(b.mask),
    opts.op,
    opts.invert1,
    opts.invert2,
    opts.invert,
  );
  const channels = alphaChannelsOf(doc).slice();
  channels.push({
    id: nextAlphaChannelId(),
    name: opts.name?.trim() || nextChannelName(doc, "运算"),
    mask: maskFromAlpha(data, a.mask.width, a.mask.height),
  });
  return withChannels(doc, channels);
}

/** 只算结果、不落文档 —— 通道运算对话框的实时预览用。 */
export function previewChannelCombine(
  doc: StrataDoc,
  opts: {
    source1: string;
    source2: string;
    op: ChannelOp;
    invert1?: boolean;
    invert2?: boolean;
    invert?: boolean;
  },
): SelectionMask | null {
  const a = findAlphaChannel(doc, opts.source1);
  const b = findAlphaChannel(doc, opts.source2);
  if (!a || !b || a.mask.width !== b.mask.width || a.mask.height !== b.mask.height) {
    return null;
  }
  const data = combineChannelData(
    alphaOf(a.mask),
    alphaOf(b.mask),
    opts.op,
    opts.invert1,
    opts.invert2,
    opts.invert,
  );
  return maskFromAlpha(data, a.mask.width, b.mask.height);
}

/** 深拷贝通道列表（cloneDoc 用，避免两个文档共用同一张遮罩画布）。 */
export function cloneAlphaChannels(
  channels: AlphaChannel[] | undefined,
): AlphaChannel[] | undefined {
  if (!channels) return undefined;
  return channels.map((c) => ({ ...c, mask: cloneSelection(c.mask) }));
}
