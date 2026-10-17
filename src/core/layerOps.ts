/**
 * 图层栈操作。
 *
 * 全部写成「旧文档 → 新文档」的纯函数：不改入参、每次都返回新对象，
 * 这样 React 的 diff、撤销栈的快照、以及后续多文档标签页都能直接复用。
 */
import { cloneSurface, createSurface, mustCtx } from "../engine/surface";
import { composeDoc, paintSurface } from "../engine/compositor";
import { clipBaseOf } from "../engine/styles";
import {
  adjustDef,
  adjustFilter,
  cloneLayer,
  cloneStyle,
  createAdjustLayer,
  createGroupLayer,
  createLayer,
  createMask,
  newLayerStyle,
  type AdjustState,
  type BlendId,
  type LayerStyle,
  type StrataLayer,
  type StyleId,
} from "./layer";
import { activeLayer, type StrataDoc } from "./document";
import {
  isSelectionEmpty,
  selectionBounds,
  type Rect,
  type SelectionMask,
} from "./selection";

/** 图层可改属性。 */
export type LayerPatch = Partial<
  Pick<
    StrataLayer,
    | "name"
    | "visible"
    | "opacity"
    | "blend"
    | "locked"
    | "surface"
    | "mask"
    | "maskActive"
    | "adjust"
    | "clip"
    | "styles"
    | "parent"
  >
>;

function indexOf(doc: StrataDoc, id: string): number {
  return doc.layers.findIndex((l) => l.id === id);
}

/* ------------------------------------------------------------ 图层组结构 */

/** 某个组的直属子层（按数组顺序，即从下到上）。 */
export function groupChildren(doc: StrataDoc, id: string): StrataLayer[] {
  return doc.layers.filter((l) => l.parent === id);
}

/** id 是否是 groupId 的后代（隔着几层组都算）。 */
function isInside(doc: StrataDoc, id: string, groupId: string): boolean {
  let cur: StrataLayer | undefined = doc.layers.find((l) => l.id === id);
  while (cur?.parent) {
    if (cur.parent === groupId) return true;
    const pid: string = cur.parent;
    cur = doc.layers.find((l) => l.id === pid);
  }
  return false;
}

/**
 * 一个「整块」在数组里的下标区间。
 *
 * 普通层只有它自己；组则连它下边紧挨着的所有后代一起算 —— 搬移、复制、
 * 删除都必须整块走，否则组一移就散架。组内子层恒为连续一段（所有插入点
 * 都按这个不变式落位），所以只要往下探到第一个非后代即可。
 */
function blockOf(doc: StrataDoc, id: string): { start: number; end: number } | null {
  const at = indexOf(doc, id);
  if (at < 0) return null;
  if (doc.layers[at].kind !== "group") return { start: at, end: at };
  let start = at;
  while (start > 0 && isInside(doc, doc.layers[start - 1].id, id)) start -= 1;
  return { start, end: at };
}

/**
 * 「在选中图层之上插入一层」的统一落点。
 *
 * 选中普通层 → 落在它上面、同层级（在组里就留在组里）；选中组 → 落进组内
 * 最上层；什么也没选 → 落到栈顶。新层插完即被选中。
 */
function spliceAbove(doc: StrataDoc, layer: StrataLayer): StrataDoc {
  const at = indexOf(doc, doc.activeLayerId);
  const cur = at >= 0 ? doc.layers[at] : null;
  const parent = cur ? (cur.kind === "group" ? cur.id : cur.parent ?? null) : null;
  const placed: StrataLayer = { ...layer, parent };
  const layers = [...doc.layers];
  // 选中组时插到组的正下方 —— 也就是组内最上层
  const where = cur?.kind === "group" ? at : at < 0 ? layers.length : at + 1;
  layers.splice(where, 0, placed);
  return { ...doc, layers, activeLayerId: placed.id, dirty: true };
}

/* ------------------------------------------------------------ 编组 / 解组 */

/**
 * 把选中图层编成一个组（PS 的「图层 > 编组」，Ctrl+G）。
 *
 * 组落在原来那层的正上方，被编进去的层成为它的子层 —— 面板里是「组一行、
 * 子层缩进排在下面」，合成时则整组先渲进缓冲、再当作一层画出来。于是组的
 * 不透明度和混合模式成了「整组的统调」，这正是图层面板最常用的整理手段。
 */
export function groupLayers(doc: StrataDoc, name?: string): StrataDoc {
  const cur = activeLayer(doc);
  if (!cur) return doc;
  const seq = doc.layers.filter((l) => l.kind === "group").length + 1;
  const group = createGroupLayer(name ?? `组 ${seq}`);
  const child: StrataLayer = { ...cur, parent: group.id };
  const layers = [...doc.layers];
  layers.splice(indexOf(doc, cur.id), 1, child, group);
  return { ...doc, layers, activeLayerId: group.id, dirty: true };
}

/**
 * 解散选中的组（PS 的「图层 > 取消编组」，Ctrl+Shift+G）。
 *
 * 组这一层壳去掉，子层原样回到组所在的层级；选中它原来的第一个子层。
 * 只解散一层：嵌套的子组保持自己的结构不变。
 */
export function ungroupLayers(doc: StrataDoc): StrataDoc {
  const cur = activeLayer(doc);
  if (!cur || cur.kind !== "group") return doc;
  const at = indexOf(doc, cur.id);
  if (at < 0) return doc;
  const kids = groupChildren(doc, cur.id);
  const layers = doc.layers
    .map((l) => (l.parent === cur.id ? { ...l, parent: cur.parent ?? null } : l))
    .filter((l) => l.id !== cur.id);
  // 空组解完就没有图层了，文档总得留一层
  if (layers.length === 0) return doc;
  const next = kids[0] ?? layers[Math.min(at, layers.length - 1)];
  return { ...doc, layers, activeLayerId: next.id, dirty: true };
}

/** 在选中图层之上插入一个空图层。 */
export function addLayer(doc: StrataDoc, name?: string): StrataDoc {
  return spliceAbove(doc, createLayer(doc.width, doc.height, name ?? `图层 ${doc.layers.length + 1}`));
}

/**
 * 把一张「已经栅格化的东西」（目前是文字）落到画布上（M3 文字工具）。
 *
 * 活动图层是未锁定的像素层时直接并进去 —— 与画笔、油漆桶的行为一致，
 * 用户不必先手动新建图层；否则在选中图层之上新开一层，绝不悄悄改动
 * 调整层或蒙版层。
 */
export function placeRaster(
  doc: StrataDoc,
  name: string,
  surface: HTMLCanvasElement,
): StrataDoc {
  const cur = activeLayer(doc);
  if (cur && cur.kind === "pixel" && !cur.locked) {
    const next = cloneSurface(cur.surface);
    mustCtx(next).drawImage(surface, 0, 0);
    return updateLayer(doc, cur.id, { surface: next });
  }
  const layer = { ...createLayer(doc.width, doc.height, name), surface };
  return spliceAbove(doc, layer);
}

/**
 * 复制选中图层，插在原图层正上方。
 *
 * 选中组时连整棵子树一起复制（副本落在原组上方），否则组的复制没有意义。
 */
export function duplicateLayer(doc: StrataDoc): StrataDoc {
  const cur = activeLayer(doc);
  if (!cur) return doc;
  if (cur.kind === "group") return duplicateGroup(doc, cur);
  const copy = cloneLayer(cur);
  copy.name = `${cur.name} 副本`;
  const at = indexOf(doc, cur.id);
  const layers = [...doc.layers];
  layers.splice(at + 1, 0, copy);
  return { ...doc, layers, activeLayerId: copy.id, dirty: true };
}

/** 复制一个组：连它的整棵子树一起复制，副本整块落在原组上方。 */
function duplicateGroup(doc: StrataDoc, group: StrataLayer): StrataDoc {
  const block = blockOf(doc, group.id);
  if (!block) return doc;
  // 组内子层恒为连续一段，顺序照抄即可；先记下「旧 id → 新 id」再重接父指针，
  // 因为父组在数组里排在子层后面，一趟走不完。
  const remap = new Map<string, string>();
  const copies: StrataLayer[] = [];
  for (let i = block.start; i <= block.end; i += 1) {
    const src = doc.layers[i];
    const copy = cloneLayer(src);
    remap.set(src.id, copy.id);
    copies.push(copy);
  }
  for (const c of copies) {
    if (c.parent) c.parent = remap.get(c.parent) ?? c.parent;
  }
  const top = copies[copies.length - 1];
  top.name = `${group.name} 副本`;
  const layers = [...doc.layers];
  layers.splice(block.end + 1, 0, ...copies);
  return { ...doc, layers, activeLayerId: top.id, dirty: true };
}

/**
 * 删除选中图层；最后一层不允许删（文档总得有承载像素的地方）。
 *
 * 选中组时整块删掉（含所有后代），否则会留下一堆无家可归的子层。
 */
export function removeLayer(doc: StrataDoc): StrataDoc {
  const at = indexOf(doc, doc.activeLayerId);
  if (at < 0) return doc;
  const cur = doc.layers[at];
  const block = blockOf(doc, cur.id) ?? { start: at, end: at };
  const doomed = new Set<string>();
  for (let i = block.start; i <= block.end; i += 1) doomed.add(doc.layers[i].id);
  const layers = doc.layers.filter((l) => !doomed.has(l.id));
  if (layers.length === 0) return doc;
  // 原位置上现在站的是「上方那一层」；删的是栈顶时退到下面一层
  const next = layers[Math.min(block.start, layers.length - 1)];
  return { ...doc, layers, activeLayerId: next.id, dirty: true };
}

/**
 * 把选中图层与它下面一层合并（PS 的「向下合并」）。
 *
 * 语义对齐 PS：合并结果**继承下层的名称与属性**（混合模式、不透明度），
 * 只把上层的像素按上层自己的模式与不透明度烙进结果像素里。这样当下层是
 * 「正片叠底 50%」时，合并前后的观感一致。
 */
export function mergeDown(doc: StrataDoc): StrataDoc {
  const at = indexOf(doc, doc.activeLayerId);
  if (at <= 0) return doc;
  const above = doc.layers[at];
  const below = doc.layers[at - 1];

  // 下层是调整层时没有可承载的像素，合并没有意义，直接不动。
  // 组同理：组是「一层壳」，得先把自己渲成像素才谈得上合并，语义太绕，先不做。
  if (below.kind === "adjust" || below.kind === "group") return doc;
  if (above.kind === "group") return doc;
  // 跨层级合并（组里的层并到组外的层）会把层从组里抽走，语义混乱，不做。
  if ((above.parent ?? null) !== (below.parent ?? null)) return doc;

  const merged: StrataLayer = {
    ...below,
    surface: cloneSurface(below.surface),
    // 样式在合并时一律烙进像素，合并层不再持有样式，避免「对着合并后的像素再画一遍」。
    styles: [],
  };
  const ctx = mustCtx(merged.surface);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";

  // 下层自带样式时先把样式烙进像素。蒙版 / 不透明度 / 混合模式仍留在合并层上实时生效，
  // 因此烙的时候临时关掉这三样，免得被应用两次。
  if (below.styles && below.styles.some((s) => s.enabled)) {
    ctx.clearRect(0, 0, merged.surface.width, merged.surface.height);
    paintSurface(ctx, { ...below, opacity: 100, blend: "normal", maskActive: false, clip: false });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
  }

  if (above.kind === "adjust") {
    // 调整层无法「画」进像素，改为把它的滤镜作用到下层像素上。
    // 走的是和屏幕渲染完全相同的一串滤镜，所以合并前后的观感一致。
    const filter = above.adjust ? adjustFilter(above.adjust, above.id) : "";
    if (filter) {
      const w = merged.surface.width;
      const h = merged.surface.height;
      const original = cloneSurface(merged.surface);
      const alpha = Math.max(0, Math.min(1, above.opacity / 100));
      const back = 1 - alpha;

      // 蒙版只影响「这一层作用在哪」，因此裁的是要被滤镜处理的那份底图
      const target = cloneSurface(merged.surface);
      if (above.maskActive && above.mask) {
        const tc = mustCtx(target);
        tc.globalCompositeOperation = "destination-in";
        tc.drawImage(above.mask, 0, 0);
        tc.globalCompositeOperation = "source-over";
      }

      ctx.clearRect(0, 0, w, h);
      ctx.filter = filter;
      ctx.globalAlpha = alpha;
      ctx.drawImage(target, 0, 0);
      ctx.filter = "none";

      // 不透明度与蒙版没覆盖到的地方，把原样按比例补回来
      if (back > 0) {
        const rest = cloneSurface(original);
        if (above.maskActive && above.mask) {
          const rc = mustCtx(rest);
          rc.globalCompositeOperation = "destination-out";
          rc.drawImage(above.mask, 0, 0);
          rc.globalCompositeOperation = "source-over";
        }
        ctx.globalAlpha = back;
        ctx.drawImage(rest, 0, 0);
      }
      ctx.globalAlpha = 1;
    }
  } else {
    // 上层是剪贴层时不能整层糊上来，得先找出它依附的基底轮廓再抠进去，
    // 找法跟合成器一致：往下的第一个「非剪贴像素层」。
    let clipShape: HTMLCanvasElement | null = null;
    if (above.clip) {
      for (let i = at - 1; i >= 0; i -= 1) {
        const b = doc.layers[i];
        if (b.kind === "pixel" && !b.clip) {
          clipShape = clipBaseOf(b, merged.surface.width, merged.surface.height);
          break;
        }
      }
    }
    paintSurface(ctx, above, clipShape);
  }

  const layers = [...doc.layers];
  layers.splice(at - 1, 2, merged);
  return { ...doc, layers, activeLayerId: merged.id, dirty: true };
}

/** 拼合图像：所有可见图层（含蒙版与调整）合成一层「背景」。 */
export function flattenImage(doc: StrataDoc): StrataDoc {
  const out = createLayer(doc.width, doc.height, "背景");
  composeDoc(doc, out.surface);
  return { ...doc, layers: [out], activeLayerId: out.id, dirty: true };
}

/**
 * 上移 / 下移选中图层。dir = 1 向上（更靠前），-1 向下。
 *
 * 搬动的是「整块」：组要连自己的子层一起走，否则一移就散架。而且只在同层级
 * 的兄弟之间换位 —— 把组里的层一步挪到组外会让它失去归属，所以走到组的边界
 * 就停下（对齐 PS 上下移按钮的行为）。
 */
export function moveLayer(doc: StrataDoc, dir: 1 | -1): StrataDoc {
  return shiftBlock(doc, doc.activeLayerId, dir);
}

/** 把某一层所在的整块，与它在同层级里的相邻兄弟整块互换位置。 */
function shiftBlock(doc: StrataDoc, id: string, dir: 1 | -1): StrataDoc {
  const at = indexOf(doc, id);
  if (at < 0) return doc;
  const block = blockOf(doc, doc.layers[at].id);
  if (!block) return doc;
  const { start, end } = block;
  const parent = doc.layers[at].parent ?? null;

  // 组内子层排在组的「下面」（下标更小），所以向上 = 往后找、向下 = 往前找
  const near = dir === 1 ? end + 1 : start - 1;
  if (near < 0 || near >= doc.layers.length) return doc;
  if ((doc.layers[near].parent ?? null) !== parent) return doc;

  const other = blockOf(doc, doc.layers[near].id);
  if (!other) return doc;

  const size = end - start + 1;
  const moved = doc.layers.slice(start, end + 1);
  const rest = [...doc.layers.slice(0, start), ...doc.layers.slice(end + 1)];
  // 插入点按「抽走本块之后」的坐标算，免得下标整体前移了 size 位
  const insertAt = dir === 1 ? other.end + 1 - size : other.start;
  rest.splice(insertAt, 0, ...moved);
  return { ...doc, layers: rest, dirty: true };
}

/**
 * 选中的整块还能不能再挪一格 —— 图层面板两个上下移按钮的可用态。
 *
 * 不能用「数组下标是否到顶」来判断：组里最下面那层的下标可能不是 0，却已
 * 经没有同层级的兄弟可换了。判据与 shiftBlock 完全一致。
 */
export function canShiftLayer(doc: StrataDoc, dir: 1 | -1): boolean {
  const at = indexOf(doc, doc.activeLayerId);
  if (at < 0) return false;
  const block = blockOf(doc, doc.layers[at].id);
  if (!block) return false;
  const parent = doc.layers[at].parent ?? null;
  const near = dir === 1 ? block.end + 1 : block.start - 1;
  if (near < 0 || near >= doc.layers.length) return false;
  return (doc.layers[near].parent ?? null) === parent;
}

/**
 * 在画布上拖动像素：把选中层（组则连整棵子树）整体平移 dx / dy。
 *
 * 组必须整棵一起挪 —— 只挪组这层壳等于什么都没挪，而拖动一个组在画面上正是
 * 「把这一摞东西一起搬走」。平移后原位置留空，与 PS 的移动工具一致。
 */
export function translateLayer(doc: StrataDoc, dx: number, dy: number): StrataDoc {
  if (dx === 0 && dy === 0) return doc;
  const cur = activeLayer(doc);
  if (!cur || cur.kind === "adjust") return doc;

  const targets = new Set<string>();
  if (cur.kind === "group") {
    // 组内子层恒为连续一段，这一段正好就是它的整棵子树
    const block = blockOf(doc, cur.id);
    if (block) {
      for (let i = block.start; i <= block.end; i += 1) targets.add(doc.layers[i].id);
    }
  } else {
    targets.add(cur.id);
  }

  const layers = doc.layers.map((l) => {
    if (!targets.has(l.id) || l.kind !== "pixel") return l;
    const moved = createSurface(doc.width, doc.height);
    mustCtx(moved).drawImage(l.surface, dx, dy);
    return { ...l, surface: moved };
  });
  return { ...doc, layers, dirty: true };
}

/**
 * 拖拽排序：把 from 位置的图层落到 to 位置。
 *
 * 同样按「整块 + 同层级」处理：组整体搬，落点也必须落在同一层级的兄弟堆里 ——
 * 面板目前只用上下移按钮，这里保持同样的约束，免得拖一下就散了架。
 */
export function reorderLayer(doc: StrataDoc, from: number, to: number): StrataDoc {
  if (from === to || from < 0 || to < 0 || from >= doc.layers.length || to >= doc.layers.length) {
    return doc;
  }
  const src = doc.layers[from];
  const dst = doc.layers[to];
  if ((src.parent ?? null) !== (dst.parent ?? null)) return doc;
  const block = blockOf(doc, src.id);
  const anchor = blockOf(doc, dst.id);
  if (!block || !anchor) return doc;
  // 落点在自己块里（只有组会碰到）等于没动
  if (to >= block.start && to <= block.end) return doc;

  const size = block.end - block.start + 1;
  const moved = doc.layers.slice(block.start, block.end + 1);
  const rest = [...doc.layers.slice(0, block.start), ...doc.layers.slice(block.end + 1)];
  const insertAt = to < block.start ? anchor.start : anchor.end + 1 - size;
  rest.splice(insertAt, 0, ...moved);
  return { ...doc, layers: rest, dirty: true };
}

/** 改选中图层的属性。 */
export function updateLayer(doc: StrataDoc, id: string, patch: LayerPatch): StrataDoc {
  const layers = doc.layers.map((l) => (l.id === id ? { ...l, ...patch } : l));
  return { ...doc, layers, dirty: true };
}

/** 切换选中图层。 */
export function selectLayer(doc: StrataDoc, id: string): StrataDoc {
  if (doc.activeLayerId === id) return doc;
  return { ...doc, activeLayerId: id };
}

/** 把某层的不透明度 / 混合模式改了（面板滑杆与下拉用）。 */
export function setOpacity(doc: StrataDoc, id: string, opacity: number): StrataDoc {
  return updateLayer(doc, id, { opacity: Math.max(0, Math.min(100, Math.round(opacity))) });
}

export function setBlend(doc: StrataDoc, id: string, blend: BlendId): StrataDoc {
  return updateLayer(doc, id, { blend });
}

/* ---------------------------------------------------------------- 蒙版 */

/**
 * 给选中图层加蒙版。
 *
 * `reveal` 生成全白（全部显示），`hide` 生成全黑（全部隐藏）—— 与 PS 的
 * 「显示全部 / 隐藏全部」一致。已有蒙版时不重复添加。
 */
export function addMask(doc: StrataDoc, mode: "reveal" | "hide" = "reveal"): StrataDoc {
  const cur = activeLayer(doc);
  if (!cur || cur.mask) return doc;
  const mask = createMask(doc.width, doc.height);
  if (mode === "reveal") {
    const ctx = mustCtx(mask);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, mask.width, mask.height);
  }
  return updateLayer(doc, cur.id, { mask, maskActive: true });
}

/** 删除选中图层的蒙版。 */
export function removeMask(doc: StrataDoc): StrataDoc {
  const cur = activeLayer(doc);
  if (!cur || !cur.mask) return doc;
  return updateLayer(doc, cur.id, { mask: null, maskActive: false });
}

/** 蒙版启用 / 停用（停用时按其不存在处理，方便对比效果）。 */
export function toggleMaskActive(doc: StrataDoc): StrataDoc {
  const cur = activeLayer(doc);
  if (!cur || !cur.mask) return doc;
  return updateLayer(doc, cur.id, { maskActive: !cur.maskActive });
}

/** 反相蒙版（遮住的显示、显示的遮住）。 */
export function invertMask(doc: StrataDoc): StrataDoc {
  const cur = activeLayer(doc);
  if (!cur || !cur.mask) return doc;
  const mask = cloneSurface(cur.mask);
  const ctx = mustCtx(mask);
  const img = ctx.getImageData(0, 0, mask.width, mask.height);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = 255 - d[i];
  ctx.putImageData(img, 0, 0);
  return updateLayer(doc, cur.id, { mask });
}

/* ---------------------------------------------------------------- 调整图层 */

/** 在选中图层之上插入一个调整图层（选中组时落进组内最上层）。 */
export function addAdjustLayer(doc: StrataDoc, adjust: AdjustState): StrataDoc {
  return spliceAbove(doc, createAdjustLayer(adjustDef(adjust.id).label, adjust));
}

/** 改调整图层的参数。 */
export function setAdjust(doc: StrataDoc, id: string, adjust: AdjustState): StrataDoc {
  return updateLayer(doc, id, { adjust });
}

/* ------------------------------------------------------------ 剪贴蒙版 */

/**
 * 切换选中图层的剪贴状态。
 *
 * 剪贴层只显示在「下方最近的像素层」的不透明范围内。最底下一层没有可依附的
 * 基底，因此不允许剪贴（对齐 PS：底层不能创建剪贴蒙版）。
 */
export function toggleClip(doc: StrataDoc): StrataDoc {
  const at = indexOf(doc, doc.activeLayerId);
  if (at <= 0) return doc;
  const cur = doc.layers[at];
  // 调整层没有自己的像素，剪贴无从谈起（界面上也禁掉了，这里再兜一层）。
  if (cur.kind === "adjust") return doc;
  return updateLayer(doc, cur.id, { clip: !cur.clip });
}

/* ---------------------------------------------------------- 图层样式 */

/** 有哪些样式已开启（供面板显示徽标 / 图标）。 */
export function hasStyle(layer: StrataLayer, id: StyleId): boolean {
  return !!layer.styles?.some((s) => s.id === id);
}

/**
 * 给选中图层加一种样式（已存在则不动）。
 *
 * 调整图层没有自己的像素，样式无从依附，直接忽略。
 */
export function addLayerStyle(doc: StrataDoc, id: StyleId): StrataDoc {
  const cur = activeLayer(doc);
  if (!cur || cur.kind === "adjust") return doc;
  const list = cur.styles ?? [];
  if (list.some((s) => s.id === id)) return doc;
  return updateLayer(doc, cur.id, { styles: [...list.map(cloneStyle), newLayerStyle(id)] });
}

/** 改某个样式的参数。 */
export function updateLayerStyle(
  doc: StrataDoc,
  id: StyleId,
  patch: Partial<LayerStyle>,
): StrataDoc {
  const cur = activeLayer(doc);
  if (!cur) return doc;
  const list = cur.styles ?? [];
  if (!list.some((s) => s.id === id)) return doc;
  return updateLayer(doc, cur.id, {
    // id 不允许被 patch 改掉，其余字段就地覆盖。
    styles: list.map((s) => (s.id === id ? { ...s, ...patch, id } : cloneStyle(s))),
  });
}

/** 开 / 关某样式（不删除，方便反复对比）。 */
export function toggleLayerStyle(doc: StrataDoc, id: StyleId): StrataDoc {
  const cur = activeLayer(doc);
  const hit = cur?.styles?.find((s) => s.id === id);
  if (!cur || !hit) return doc;
  return updateLayerStyle(doc, id, { enabled: !hit.enabled });
}

/** 删掉某个样式。 */
export function removeLayerStyle(doc: StrataDoc, id: StyleId): StrataDoc {
  const cur = activeLayer(doc);
  const list = cur?.styles ?? [];
  if (!cur || !list.some((s) => s.id === id)) return doc;
  return updateLayer(doc, cur.id, {
    styles: list.filter((s) => s.id !== id).map(cloneStyle),
  });
}

/* ---------------------------------------------------------------- 选区 */

/** 换掉当前选区（null 表示取消选区）。选区变更也算一次改动，进撤销栈。 */
export function setSelection(doc: StrataDoc, selection: SelectionMask | null): StrataDoc {
  return { ...doc, selection, dirty: true };
}

/** 当前层是否是可承载像素的图层（调整层没有像素，一切按选区改像素的操作都跳过）。 */
function pixelLayer(doc: StrataDoc): StrataLayer | null {
  const cur = activeLayer(doc);
  return cur && cur.kind === "pixel" ? cur : null;
}

/** 用纯色填充选区。没有选区时铺满整层（等价于 PS 的 Alt+Delete）。 */
export function fillSelection(doc: StrataDoc, color: string): StrataDoc {
  const cur = pixelLayer(doc);
  if (!cur) return doc;
  const surface = cloneSurface(cur.surface);
  const ctx = mustCtx(surface);
  const sel = doc.selection;
  if (!sel || isSelectionEmpty(sel)) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, surface.width, surface.height);
  } else {
    // 先把色块画在暂存上，再按选区抠一刀贴回 —— 选区羽化也能正确透出
    const patch = createSurface(surface.width, surface.height, color);
    const pc = mustCtx(patch);
    pc.globalCompositeOperation = "destination-in";
    pc.drawImage(sel, 0, 0);
    pc.globalCompositeOperation = "source-over";
    ctx.drawImage(patch, 0, 0);
  }
  return updateLayer(doc, cur.id, { surface });
}

/** 删除选区内的像素（选区为空时清空整层）。 */
export function deleteSelection(doc: StrataDoc): StrataDoc {
  const cur = pixelLayer(doc);
  if (!cur) return doc;
  const surface = cloneSurface(cur.surface);
  const ctx = mustCtx(surface);
  const sel = doc.selection;
  ctx.globalCompositeOperation = "destination-out";
  if (sel && !isSelectionEmpty(sel)) ctx.drawImage(sel, 0, 0);
  else ctx.fillRect(0, 0, surface.width, surface.height);
  ctx.globalCompositeOperation = "source-over";
  return updateLayer(doc, cur.id, { surface });
}

/* ---------------------------------------------------------------- 画布裁剪 */

/** 把一张画布整体平移并缩到新尺寸（用于裁剪所有图层与蒙版）。 */
function cropSurface(
  src: HTMLCanvasElement,
  x: number,
  y: number,
  width: number,
  height: number,
): HTMLCanvasElement {
  const out = createSurface(width, height);
  mustCtx(out).drawImage(src, -x, -y);
  return out;
}

/**
 * 把整份文档裁到指定矩形。
 *
 * 所有图层与蒙版同尺寸平移裁切，因此层间对齐关系不会变；裁剪之后原来的
 * 选区坐标系已经失效，一律清空（对齐 PS）。
 */
export function cropDocument(doc: StrataDoc, rect: Rect): StrataDoc {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const width = Math.max(1, Math.min(doc.width - x, Math.round(rect.width)));
  const height = Math.max(1, Math.min(doc.height - y, Math.round(rect.height)));
  if (x === 0 && y === 0 && width === doc.width && height === doc.height) return doc;

  const layers = doc.layers.map((l) =>
    // 调整层与组都没有自己的像素（surface 只是 1×1 占位），跟着裁会把占位面
    // 撑成整幅画布，纯属白吃内存；蒙版是真像素，照常平移裁切。
    l.kind === "pixel"
      ? {
          ...l,
          surface: cropSurface(l.surface, x, y, width, height),
          mask: l.mask ? cropSurface(l.mask, x, y, width, height) : l.mask,
        }
      : { ...l, mask: l.mask ? cropSurface(l.mask, x, y, width, height) : l.mask },
  );
  return { ...doc, width, height, layers, selection: null, dirty: true };
}

/** 裁切到选区边界（PS 的「裁切到选区」）。没有选区或选区为空时不动。 */
export function trimToSelection(doc: StrataDoc): StrataDoc {
  const r = selectionBounds(doc.selection);
  if (!r) return doc;
  return cropDocument(doc, r);
}

/* ------------------------------------------------------- 图像 / 画布大小 */

/** 重采样一张表面（放大 / 缩小时开启平滑插值，避免锯齿）。 */
function scaleSurface(
  src: HTMLCanvasElement,
  width: number,
  height: number,
): HTMLCanvasElement {
  const out = createSurface(width, height);
  const ctx = mustCtx(out);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, width, height);
  return out;
}

/**
 * 图像大小：整幅重定像素。
 *
 * 每个图层的像素与蒙版、以及选区遮罩，全部同比例缩放 —— 层间的对齐关系
 * 才不会散掉。对齐 PS 的「图像 > 图像大小」（重定图像像素）。
 */
export function resizeDocument(doc: StrataDoc, width: number, height: number): StrataDoc {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (w === doc.width && h === doc.height) return doc;
  const layers = doc.layers.map((l) =>
    // 同上：调整层与组的占位面不参与缩放
    l.kind === "pixel"
      ? {
          ...l,
          surface: scaleSurface(l.surface, w, h),
          mask: l.mask ? scaleSurface(l.mask, w, h) : l.mask,
        }
      : { ...l, mask: l.mask ? scaleSurface(l.mask, w, h) : l.mask },
  );
  return {
    ...doc,
    width: w,
    height: h,
    layers,
    selection: doc.selection ? scaleSurface(doc.selection, w, h) : doc.selection,
    dirty: true,
  };
}

/** 画布大小的锚点（九宫格），决定原内容在新画布里的落点。 */
export type Anchor = "nw" | "n" | "ne" | "w" | "c" | "e" | "sw" | "s" | "se";

const ANCHOR_X: Record<Anchor, (dw: number) => number> = {
  nw: () => 0,
  w: () => 0,
  sw: () => 0,
  n: (dw) => Math.round(dw / 2),
  c: (dw) => Math.round(dw / 2),
  s: (dw) => Math.round(dw / 2),
  ne: (dw) => dw,
  e: (dw) => dw,
  se: (dw) => dw,
};

const ANCHOR_Y: Record<Anchor, (dh: number) => number> = {
  nw: () => 0,
  n: () => 0,
  ne: () => 0,
  w: (dh) => Math.round(dh / 2),
  c: (dh) => Math.round(dh / 2),
  e: (dh) => Math.round(dh / 2),
  sw: (dh) => dh,
  s: (dh) => dh,
  se: (dh) => dh,
};

/**
 * 画布大小：只改画布尺寸，像素本身不缩放。
 *
 * 多出来的区域是透明的，被切掉的部分直接丢弃；原内容按九宫格锚点摆放。
 * 尺寸一变，原来的选区坐标就失效了，一律清空（对齐 PS）。
 */
export function resizeCanvas(
  doc: StrataDoc,
  width: number,
  height: number,
  anchor: Anchor = "c",
): StrataDoc {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (w === doc.width && h === doc.height) return doc;
  const dx = ANCHOR_X[anchor](w - doc.width);
  const dy = ANCHOR_Y[anchor](h - doc.height);
  const place = (src: HTMLCanvasElement) => {
    const out = createSurface(w, h);
    mustCtx(out).drawImage(src, dx, dy);
    return out;
  };
  const layers = doc.layers.map((l) =>
    // 同上：调整层与组的占位面不参与搬移，否则会被撑成整幅画布
    l.kind === "pixel"
      ? { ...l, surface: place(l.surface), mask: l.mask ? place(l.mask) : l.mask }
      : { ...l, mask: l.mask ? place(l.mask) : l.mask },
  );
  return { ...doc, width: w, height: h, layers, selection: null, dirty: true };
}

/* ---------------------------------------------- 图像 > 调整（一键，破坏性） */

/**
 * 把一条调整直接烙进当前图层的像素。
 *
 * 非破坏的玩法走调整图层（参数随时可改、可删）；「图像 > 调整」里的一键项
 * 是 PS 的老玩法：当场改像素。滤镜只作用在该图层自己的像素上，图层蒙版不
 * 参与 —— 蒙版仍在合成时生效，效果自然被限制在可见区域内。
 */
export function applyAdjustToLayer(doc: StrataDoc, state: AdjustState): StrataDoc {
  const at = doc.layers.findIndex((l) => l.id === doc.activeLayerId);
  if (at < 0) return doc;
  const layer = doc.layers[at];
  if (layer.kind !== "pixel" || layer.locked) return doc;
  const filter = adjustFilter(state, layer.id);
  if (!filter) return doc;
  const next = createSurface(layer.surface.width, layer.surface.height);
  const ctx = mustCtx(next);
  ctx.filter = filter;
  ctx.drawImage(layer.surface, 0, 0);
  ctx.filter = "none";
  const layers = doc.layers.slice();
  layers[at] = { ...layer, surface: next };
  return { ...doc, layers, dirty: true };
}

/* ---------------------------------------------------------------- 剪贴板 */

/**
 * 应用内剪贴板。
 *
 * 只存自己的像素缓冲，不碰系统剪贴板 —— 像素本来就在内存里，直接搬最快，
 * 也不必为此引入剪贴板插件与 PNG 往返编解码。
 * 除了像素，还记住内容在源文档里的落点：粘回同尺寸文档时原位贴合，
 * 内容尺寸与文档不同则退到左上角，绝不糊到画布外。
 */
export interface ClipBuffer {
  surface: HTMLCanvasElement;
  /** 内容在源文档中的左上角 */
  x: number;
  y: number;
}

let clip: ClipBuffer | null = null;

/** 剪贴板里有没有东西（菜单据此启用 / 禁用「粘贴」）。 */
export function clipHasContent(): boolean {
  return clip !== null;
}

/**
 * 把当前图层的像素拷进剪贴板。
 *
 * merged = true 时取所有可见图层的合成结果（PS 的「复制合并」）。
 * 有选区时只取包围盒内的像素，并按选区遮罩抠形 —— 羽化边缘也一并带走。
 * 返回是否真的拷到了东西。
 */
export function copyToClipboard(doc: StrataDoc, merged = false): boolean {
  const cur = pixelLayer(doc);
  if (!merged && !cur) return false;
  const full = createSurface(doc.width, doc.height);
  if (merged) composeDoc(doc, full);
  else mustCtx(full).drawImage(cur!.surface, 0, 0);

  const sel = doc.selection;
  const box = isSelectionEmpty(sel) ? null : selectionBounds(sel);
  const x = box ? Math.max(0, box.x) : 0;
  const y = box ? Math.max(0, box.y) : 0;
  const w = box ? Math.min(doc.width - x, box.width) : doc.width;
  const h = box ? Math.min(doc.height - y, box.height) : doc.height;
  if (w < 1 || h < 1) return false;

  const out = createSurface(w, h);
  const ctx = mustCtx(out);
  ctx.drawImage(full, -x, -y);
  if (box && sel) {
    // 选区遮罩与文档同尺寸，平移同样的偏移量就能对齐到这块小画布上
    const cut = createSurface(w, h);
    mustCtx(cut).drawImage(sel, -x, -y);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(cut, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  }
  clip = { surface: out, x, y };
  return true;
}

/** 剪贴板里内容的尺寸（用于状态栏提示）。 */
export function clipSize(): { width: number; height: number } | null {
  return clip ? { width: clip.surface.width, height: clip.surface.height } : null;
}

/**
 * 粘贴：把剪贴板内容作为新图层盖在选中层之上，并选中这个新图层。
 *
 * 剪切 / 复制后的内容回到它原来的位置 —— 这是「P 图」里最常见的动作：
 * 抠一块出来、改一改、再盖回去。内容比画布还大时不缩放，只有落在画布内的
 * 部分被保留（与 PS 一致）。
 */
export function pasteFromClipboard(doc: StrataDoc, name?: string): StrataDoc {
  if (!clip) return doc;
  const layer = createLayer(doc.width, doc.height, name ?? "粘贴的图层");
  const dx = Math.min(clip.x, Math.max(0, doc.width - clip.surface.width));
  const dy = Math.min(clip.y, Math.max(0, doc.height - clip.surface.height));
  mustCtx(layer.surface).drawImage(clip.surface, dx, dy);
  return spliceAbove(doc, layer);
}

/** 剪切：先拷进剪贴板，再把选区内的像素删掉。 */
export function cutSelection(doc: StrataDoc): StrataDoc {
  if (!copyToClipboard(doc)) return doc;
  return deleteSelection(doc);
}

