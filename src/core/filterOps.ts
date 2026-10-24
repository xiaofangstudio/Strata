/**
 * 滤镜落盘 / 预览的文档层操作。
 *
 * 与 applyAdjustToLayer 同一条路径：只改当前像素图层的像素，调整层与锁定
 * 图层原样退回。选区感知 —— 有选区时按选区 alpha 把滤镜结果与原图逐像素
 * 混合，与 PS「滤镜只作用于选区内」一致；蒙版不参与（合成时自然被遮）。
 */
import type { StrataDoc } from "./document";
import { createSurface, mustCtx } from "../engine/surface";
import type { FilterDef } from "../engine/filters/defs";
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
