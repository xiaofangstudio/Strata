/**
 * 图案平铺用的 tile 解析：内置预设优先、用户定义图案次之、找不到就退回
 * 内置棋盘格。渲染层只拿 HTMLCanvasElement 调 createPattern，不关心来源。
 */
import { findPatternPreset, PATTERN_PRESETS, drawPatternPreset } from "../core/patternPresets";
import { patternList } from "../core/patterns";
import { createSurface, mustCtx } from "./surface";

const cache = new Map<string, HTMLCanvasElement>();

/** 画一张内置预设 tile；结果按 id + 尺寸缓存，避免每帧重建。 */
export function builtinPatternTile(id: string, size = 48): HTMLCanvasElement | null {
  const preset = findPatternPreset(id);
  if (!preset) return null;
  const key = `${preset.id}:${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = createSurface(size, size);
  drawPatternPreset(mustCtx(canvas), preset, size);
  cache.set(key, canvas);
  return canvas;
}

/** 图层样式里的 patternId → 真正可平铺的小图。 */
export function patternTileFor(patternId: string | undefined, size = 48): HTMLCanvasElement {
  const fallback = (): HTMLCanvasElement =>
    builtinPatternTile(PATTERN_PRESETS[0].id, size) ?? createSurface(size, size);
  if (!patternId) return fallback();
  if (patternId.startsWith("builtin:")) return builtinPatternTile(patternId.slice(8), size) ?? fallback();
  const user = patternList().find((p) => p.id === patternId);
  return user?.canvas ?? fallback();
}

/** 缩略图用：用户图案直接给原图，内置图案画一张小 tile。 */
export function patternThumbFor(patternId: string, size = 32): HTMLCanvasElement {
  if (!patternId.startsWith("builtin:")) {
    const user = patternList().find((p) => p.id === patternId);
    if (user) return user.canvas;
  }
  return patternTileFor(patternId, size);
}
