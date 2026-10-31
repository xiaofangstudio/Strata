/**
 * 可编辑文本层（Type 组的底座）。
 *
 * 设计：文本层 = **像素图层 + `text` 状态**。surface 是渲染缓存，
 * 任何文本属性变更都走 `syncText()` 重新栅格化。这样合成器、变换、
 * 混合模式、图层样式、蒙版、撤销栈全部沿用既有通路，不需要为文字另开分支。
 *
 * 「栅格化文字」= 删掉 text 字段；「转换为段落/点文字」= 切换 boxWidth。
 */
import { createSurface, mustCtx, readPixels } from "../engine/surface";
import {
  rasterizeTextState,
  textStateBounds,
  type TextLayerState,
  type TextSettings,
} from "../engine/text";
import { createLayer, type StrataLayer } from "./layer";
import type { StrataDoc } from "./document";

/** 该图层是不是可编辑文本层。 */
export function hasText(
  layer: StrataLayer | undefined | null,
): layer is StrataLayer & { text: TextLayerState } {
  return Boolean(layer && layer.text && layer.text.content !== undefined);
}

/** 当前活动图层是文本层时返回它。 */
export function activeTextLayer(doc: StrataDoc): (StrataLayer & { text: TextLayerState }) | null {
  const l = doc.layers.find((x) => x.id === doc.activeLayerId);
  return hasText(l) ? l : null;
}

/** 用文本状态重建 surface（返回新图层对象，不改原对象）。 */
export function syncText(layer: StrataLayer & { text: TextLayerState }): StrataLayer {
  const w = layer.surface.width;
  const h = layer.surface.height;
  const surface = rasterizeTextState(w, h, layer.text);
  return { ...layer, surface };
}

/** 新建一个文本图层对象（尚未插进文档）。 */
export function makeTextLayer(
  docW: number,
  docH: number,
  state: TextLayerState,
  name: string,
): StrataLayer {
  const base = createLayer(docW, docH, name);
  const surface = rasterizeTextState(docW, docH, state);
  return { ...base, surface, text: state };
}

/** 按内容第一行给图层起名（PS 的默认命名习惯）。 */
export function textLayerName(content: string): string {
  // 跳过开头的空行：首行为空但第二行有字时，用第二行命名（PS 也是这样）
  const first = content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return "文字";
  return first.length > 16 ? `${first.slice(0, 16)}…` : first;
}

/** 改文本状态（浅合并）并重新栅格化。 */
export function updateText(
  doc: StrataDoc,
  id: string,
  patch: Partial<TextLayerState>,
): StrataDoc {
  const layers = doc.layers.map((l) => {
    if (l.id !== id || !hasText(l)) return l;
    const next: StrataLayer & { text: TextLayerState } = {
      ...l,
      text: { ...l.text, ...patch },
    };
    const synced = syncText(next);
    return { ...synced, name: patch.content !== undefined ? textLayerName(patch.content) : l.name };
  });
  return { ...doc, layers, dirty: true };
}

/** 改排版参数（字号/字体/行距/字距/对齐/弯曲）。 */
export function updateTextSettings(
  doc: StrataDoc,
  id: string,
  patch: Partial<TextSettings>,
): StrataDoc {
  const layers = doc.layers.map((l) => {
    if (l.id !== id || !hasText(l)) return l;
    const next: StrataLayer & { text: TextLayerState } = {
      ...l,
      text: { ...l.text, settings: { ...l.text.settings, ...patch } },
    };
    return syncText(next);
  });
  return { ...doc, layers, dirty: true };
}

/** 栅格化文本层：去掉 text 字段，从此就是普通像素层。 */
export function rasterizeTextLayer(doc: StrataDoc, id: string): StrataDoc {
  const layers = doc.layers.map((l) => {
    if (l.id !== id || !hasText(l)) return l;
    const { text: _drop, ...rest } = l;
    return { ...rest, name: l.name };
  });
  return { ...doc, layers, dirty: true };
}

/** 段落文字：给一个可见的框宽（自动折行）。 */
export function toParagraphText(doc: StrataDoc, id: string): StrataDoc {
  const layer = doc.layers.find((l) => l.id === id);
  if (!hasText(layer) || layer.text.boxWidth) return doc;
  const b = textStateBounds(layer.text);
  const boxWidth = Math.max(40, Math.round(b.width * 1.4));
  return updateText(doc, id, { boxWidth });
}

/** 点文字：去掉框宽，只在换行符处断行。 */
export function toPointText(doc: StrataDoc, id: string): StrataDoc {
  const layer = doc.layers.find((l) => l.id === id);
  if (!hasText(layer) || !layer.text.boxWidth) return doc;
  return updateText(doc, id, { boxWidth: undefined });
}

/**
 * 命中测试：文档坐标 (x,y) 落在哪一层文本的像素上。
 * 双击画布进入文字编辑时用；从最上层往下找，取第一个命中的。
 */
export function textLayerAt(doc: StrataDoc, x: number, y: number): (StrataLayer & { text: TextLayerState }) | null {
  for (let i = doc.layers.length - 1; i >= 0; i -= 1) {
    const l = doc.layers[i];
    if (!l.visible || !hasText(l)) continue;
    if (x < 0 || y < 0 || x >= l.surface.width || y >= l.surface.height) continue;
    const px = readPixels(l.surface).data[(Math.floor(y) * l.surface.width + Math.floor(x)) * 4 + 3];
    if (px > 8) return l;
  }
  return null;
}

/**
 * 把文本层的内容画成一张「工作路径」用的小画布：轮廓化的文字。
 * 没有矢量字形 API，这里用边缘检测近似出轮廓 —— 用于「创建工作路径」。
 */
export function textOutlineSurface(layer: StrataLayer & { text: TextLayerState }): HTMLCanvasElement {
  const w = layer.surface.width;
  const h = layer.surface.height;
  const out = createSurface(w, h);
  const src = readPixels(layer.surface).data;
  const img = readPixels(out);
  const d = img.data;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = (y * w + x) * 4;
      const a = src[i + 3];
      if (a < 40) continue;
      // 邻域里出现「明显更透明」的像素 → 认为处在字形边缘
      const edge =
        src[i - 4 + 3] * 2 < a ||
        src[i + 4 + 3] * 2 < a ||
        src[i - w * 4 + 3] * 2 < a ||
        src[i + w * 4 + 3] * 2 < a;
      if (!edge) continue;
      d[i] = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
      d[i + 3] = 255;
    }
  }
  mustCtx(out).putImageData(img, 0, 0);
  return out;
}
