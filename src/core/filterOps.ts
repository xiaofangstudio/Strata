/**
 * 滤镜落盘 / 预览的文档层操作。
 *
 * 与 applyAdjustToLayer 同一条路径：只改当前像素图层的像素，调整层与锁定
 * 图层原样退回。选区感知 —— 有选区时按选区 alpha 把滤镜结果与原图逐像素
 * 混合，与 PS「滤镜只作用于选区内」一致；蒙版不参与（合成时自然被遮）。
 */
import type { StrataLayer } from "./layer";
import type { StrataDoc } from "./document";
import { cloneSurface, createSurface, mustCtx } from "../engine/surface";
import { filterDef, type FilterDef } from "../engine/filters/defs";
import type { RgbaBuffer } from "../engine/filters/kernels";

function toBuffer(img: ImageData): RgbaBuffer {
  return { data: img.data, width: img.width, height: img.height };
}

/** 选区 alpha 与滤镜结果混合（sel 可为 null = 全图）。 */
function blendWithSelection(
  orig: RgbaBuffer,
  filtered: RgbaBuffer,
  sel: ImageData | null,
): RgbaBuffer {
  if (!sel) return filtered;
  const { data, width, height } = orig;
  const out = new Uint8ClampedArray(data);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const a = sel.data[i + 3] / 255;
      if (a >= 1) {
        out[i] = filtered.data[i];
        out[i + 1] = filtered.data[i + 1];
        out[i + 2] = filtered.data[i + 2];
      } else if (a > 0) {
        for (let c = 0; c < 3; c += 1) {
          out[i + c] = data[i + c] * (1 - a) + filtered.data[i + c] * a;
        }
      }
    }
  }
  return { data: out, width, height };
}

/**
 * 把滤镜烙进当前像素图层。图层不可改（非像素层 / 锁定）时原样返回，
 * 弹窗据此判定「这一下没得改」并禁用确定按钮。
 */
export function applyFilterToLayer(
  doc: StrataDoc,
  def: FilterDef,
  params: Record<string, number>,
): StrataDoc {
  const at = doc.layers.findIndex((l) => l.id === doc.activeLayerId);
  if (at < 0) return doc;
  const layer = doc.layers[at];
  if (layer.kind !== "pixel" || layer.locked) return doc;

  // 智能对象上的滤镜走「智能滤镜栈」：非破坏，随时能关掉或清掉。
  // 有选区时把选区存成滤镜蒙版 —— 与 PS 的行为一致。
  if (layer.smart) {
    return pushSmartFilter(doc, layer, def, params);
  }

  const src = mustCtx(layer.surface).getImageData(0, 0, layer.surface.width, layer.surface.height);
  const sel = doc.selection
    ? mustCtx(doc.selection).getImageData(0, 0, doc.selection.width, doc.selection.height)
    : null;

  const orig = toBuffer(src);
  const filtered = def.apply(orig, params);
  const merged = blendWithSelection(orig, filtered, sel);

  const next = createSurface(layer.surface.width, layer.surface.height);
  const img = new ImageData(layer.surface.width, layer.surface.height);
  img.data.set(merged.data);
  mustCtx(next).putImageData(img, 0, 0);

  const layers = doc.layers.slice();
  layers[at] = { ...layer, surface: next };
  return { ...doc, layers, dirty: true };
}

/* ------------------------------------------------------------ 智能滤镜 */

/**
 * 往智能对象的滤镜栈里推一个滤镜，并按「原始像素 + 全部启用滤镜」重新渲染。
 *
 * 之所以能非破坏：原始像素存在 layer.smartBase（内存）里，每次重渲染都从它出发，
 * 而不是在上一次的结果上继续叠 —— 所以关掉中间某个滤镜也能干净地回到中间态。
 */
export function pushSmartFilter(
  doc: StrataDoc,
  layer: StrataLayer,
  def: FilterDef,
  params: Record<string, number>,
): StrataDoc {
  const base = layer.smartBase ?? cloneSurface(layer.surface);
  const mask = doc.selection ? cloneSurface(doc.selection) : layer.smartFilterMask ?? null;
  const stack = [...(layer.smartFilters ?? []), { id: def.id, params, enabled: true }];
  const rendered = renderSmartStack(base, stack, mask, layer.smartFilterMaskActive !== false);
  const layers = doc.layers.map((l) =>
    l.id === layer.id
      ? { ...l, smartBase: base, smartFilters: stack, smartFilterMask: mask, surface: rendered }
      : l,
  );
  return { ...doc, layers, dirty: true };
}

/** 按滤镜栈重新渲染一块基准像素（导出给撤销/菜单操作用）。 */
function renderSmartStack(
  base: HTMLCanvasElement,
  stack: { id: string; params: Record<string, number>; enabled: boolean }[],
  mask: HTMLCanvasElement | null,
  maskActive: boolean,
): HTMLCanvasElement {
  const out = cloneSurface(base);
  for (const item of stack) {
    if (!item.enabled) continue;
    const def = filterDef(item.id);
    if (!def) continue;
    const img = mustCtx(out).getImageData(0, 0, out.width, out.height);
    const filtered = def.apply(toBuffer(img), item.params);
    const mc = mustCtx(out);
    if (mask && maskActive && mask.width === out.width && mask.height === out.height) {
      const m = mustCtx(mask).getImageData(0, 0, mask.width, mask.height);
      mc.putImageData(new ImageData(new Uint8ClampedArray(blendWithSelection(toBuffer(img), filtered, m).data), out.width, out.height), 0, 0);
    } else {
      mc.putImageData(new ImageData(new Uint8ClampedArray(filtered.data), out.width, out.height), 0, 0);
    }
  }
  return out;
}

/** 清空智能滤镜：回到原始像素。 */
export function clearSmartFilters(doc: StrataDoc): StrataDoc {
  const cur = doc.layers.find((l) => l.id === doc.activeLayerId);
  if (!cur?.smartFilters?.length) return doc;
  const surface = cur.smartBase ? cloneSurface(cur.smartBase) : cur.surface;
  const layers = doc.layers.map((l) =>
    l.id === cur.id
      ? { ...l, smartFilters: undefined, smartFilterMask: null, surface }
      : l,
  );
  return { ...doc, layers, dirty: true };
}

/** 停用/启用所有智能滤镜。 */
export function toggleSmartFilters(doc: StrataDoc): StrataDoc {
  const cur = doc.layers.find((l) => l.id === doc.activeLayerId);
  if (!cur?.smartFilters?.length) return doc;
  const anyOn = cur.smartFilters.some((f) => f.enabled);
  const stack = cur.smartFilters.map((f) => ({ ...f, enabled: !anyOn }));
  const base = cur.smartBase ?? cloneSurface(cur.surface);
  const rendered = renderSmartStack(base, stack, cur.smartFilterMask ?? null, cur.smartFilterMaskActive !== false);
  const layers = doc.layers.map((l) =>
    l.id === cur.id ? { ...l, smartFilters: stack, smartBase: base, surface: rendered } : l,
  );
  return { ...doc, layers, dirty: true };
}

/** 删除智能滤镜蒙版。 */
export function deleteFilterMask(doc: StrataDoc): StrataDoc {
  const cur = doc.layers.find((l) => l.id === doc.activeLayerId);
  if (!cur?.smartFilterMask) return doc;
  const base = cur.smartBase ?? cloneSurface(cur.surface);
  const rendered = renderSmartStack(base, cur.smartFilters ?? [], null, false);
  const layers = doc.layers.map((l) =>
    l.id === cur.id ? { ...l, smartFilterMask: null, surface: rendered } : l,
  );
  return { ...doc, layers, dirty: true };
}

/** 停用/启用智能滤镜蒙版。 */
export function toggleFilterMask(doc: StrataDoc): StrataDoc {
  const cur = doc.layers.find((l) => l.id === doc.activeLayerId);
  if (!cur?.smartFilterMask) return doc;
  const on = !(cur.smartFilterMaskActive !== false);
  const base = cur.smartBase ?? cloneSurface(cur.surface);
  const rendered = renderSmartStack(base, cur.smartFilters ?? [], cur.smartFilterMask, on);
  const layers = doc.layers.map((l) =>
    l.id === cur.id ? { ...l, smartFilterMaskActive: on, surface: rendered } : l,
  );
  return { ...doc, layers, dirty: true };
}
