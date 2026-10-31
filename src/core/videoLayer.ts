/**
 * 视频图层（帧序列模型）。
 *
 * Strata 不带视频解码器（H.264/ProRes 那些是几百 KB 起步的原生依赖，与
 * 「零依赖、纯 WebView」的定位冲突）。所以这里实现的是 Photoshop 视频图层的
 * **同构子集**：一层 = 一串帧（每帧就是一张画布）+ 当前帧号 + 帧率。
 *
 * 能做什么：新建空视频层、从图片建层、插空帧、复制帧、删帧、换素材、
 * 调帧率、帧级还原/重载、栅格化。**做不了**：导入 mp4/mov 解码播放
 * （菜单会明确告知，不假装支持）。
 *
 * 层的 surface 恒等于「当前帧」的内容副本 —— 这样合成器、图层样式、蒙版
 * 全部照旧工作，不需要为视频另开渲染通路。
 */
import { cloneSurface, createSurface, mustCtx } from "../engine/surface";
import type { StrataLayer } from "./layer";
import type { StrataDoc } from "./document";

/** 一帧：内容 + 停留时长（秒）。 */
export interface VideoFrame {
  surface: HTMLCanvasElement;
  /** 该帧停留时长（秒），默认按帧率算 */
  hold: number;
}

/** 写进图层的帧序列状态。 */
export interface VideoState {
  frames: VideoFrame[];
  /** 当前帧下标 */
  index: number;
  /** 每秒帧数（决定 hold 与时长显示） */
  fps: number;
  /** 素材来源路径（换素材 / 重载用；空 = 完全内建） */
  footagePath?: string;
  /** 每帧的原始内容（「还原帧」用它回滚），与 frames 等长 */
  originals: HTMLCanvasElement[];
  /** 显示的是否是「改动后」的画面（Show Altered Video） */
  showAltered: boolean;
}

/** 该图层是不是视频（帧序列）层。 */
export function isVideoLayer(
  layer: StrataLayer | undefined | null,
): layer is StrataLayer & { video: VideoState } {
  return Boolean(layer && layer.video && layer.video.frames.length > 0);
}

/** 当前活动图层是视频层时返回它。 */
export function activeVideoLayer(doc: StrataDoc): (StrataLayer & { video: VideoState }) | null {
  const l = doc.layers.find((x) => x.id === doc.activeLayerId);
  return isVideoLayer(l) ? l : null;
}

/** 用当前帧刷新 layer.surface（合成器只看 surface）。 */
export function syncVideoFrame(layer: StrataLayer & { video: VideoState }): StrataLayer {
  const { frames, index, showAltered, originals } = layer.video;
  const src = showAltered ? frames[index].surface : originals[index];
  const w = layer.surface.width;
  const h = layer.surface.height;
  const surface = createSurface(w, h);
  mustCtx(surface).drawImage(src, 0, 0);
  return { ...layer, surface };
}

/** 新建一个视频层（一帧空画面）。 */
export function makeVideoLayer(
  docW: number,
  docH: number,
  name: string,
  first?: HTMLCanvasElement,
  footagePath?: string,
  fps = 24,
): StrataLayer {
  const frame = first ?? createSurface(docW, docH);
  const blank = createSurface(docW, docH);
  return {
    id: `vid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    visible: true,
    opacity: 100,
    blend: "normal",
    locked: false,
    kind: "pixel",
    surface: cloneSurface(first ?? blank),
    mask: null,
    maskActive: true,
    video: {
      frames: [{ surface: cloneSurface(frame), hold: 1 / fps }],
      index: 0,
      fps,
      footagePath,
      originals: [cloneSurface(frame)],
      showAltered: true,
    },
  } as StrataLayer;
}

/** 对视频层做一次修改并刷新 surface。 */
function mutate(
  doc: StrataDoc,
  id: string,
  fn: (v: VideoState) => VideoState | null,
): StrataDoc {
  const layers = doc.layers.map((l) => {
    if (l.id !== id || !isVideoLayer(l)) return l;
    const next = fn({
      frames: l.video.frames,
      index: l.video.index,
      fps: l.video.fps,
      footagePath: l.video.footagePath,
      originals: l.video.originals,
      showAltered: l.video.showAltered,
    });
    if (!next) return l;
    return syncVideoFrame({ ...l, video: next });
  });
  return { ...doc, layers, dirty: true };
}

/** 插一张空帧（插在当前帧之后）。 */
export function insertBlankFrame(doc: StrataDoc, id: string): StrataDoc {
  return mutate(doc, id, (v) => {
    const w = v.frames[v.index].surface.width;
    const h = v.frames[v.index].surface.height;
    const blank = createSurface(w, h);
    const frames = v.frames.slice();
    const originals = v.originals.slice();
    frames.splice(v.index + 1, 0, { surface: blank, hold: 1 / v.fps });
    originals.splice(v.index + 1, 0, cloneSurface(blank));
    return { ...v, frames, originals, index: v.index + 1 };
  });
}

/** 复制当前帧到它后面。 */
export function duplicateFrame(doc: StrataDoc, id: string): StrataDoc {
  return mutate(doc, id, (v) => {
    const cur = v.frames[v.index];
    const frames = v.frames.slice();
    const originals = v.originals.slice();
    frames.splice(v.index + 1, 0, { surface: cloneSurface(cur.surface), hold: cur.hold });
    originals.splice(v.index + 1, 0, cloneSurface(v.originals[v.index]));
    return { ...v, frames, originals, index: v.index + 1 };
  });
}

/** 删除当前帧（至少留一帧）。 */
export function deleteFrame(doc: StrataDoc, id: string): StrataDoc {
  return mutate(doc, id, (v) => {
    if (v.frames.length <= 1) return null;
    const frames = v.frames.filter((_, i) => i !== v.index);
    const originals = v.originals.filter((_, i) => i !== v.index);
    return { ...v, frames, originals, index: Math.min(v.index, frames.length - 1) };
  });
}

/** 用一张新图替换当前帧（换素材）。 */
export function replaceFootage(doc: StrataDoc, id: string, img: HTMLCanvasElement): StrataDoc {
  return mutate(doc, id, (v) => {
    const frames = v.frames.slice();
    const originals = v.originals.slice();
    frames[v.index] = { surface: cloneSurface(img), hold: frames[v.index].hold };
    originals[v.index] = cloneSurface(img);
    return { ...v, frames, originals };
  });
}

/** 设置帧率（同时把每帧 hold 归一到新帧率）。 */
export function setFrameRate(doc: StrataDoc, id: string, fps: number): StrataDoc {
  const f = Math.max(1, Math.min(60, Math.round(fps)));
  return mutate(doc, id, (v) => ({
    ...v,
    fps: f,
    frames: v.frames.map((fr) => ({ ...fr, hold: 1 / f })),
  }));
}

/** 切换「显示改动后的画面 / 原始画面」。 */
export function setShowAltered(doc: StrataDoc, id: string, on: boolean): StrataDoc {
  return mutate(doc, id, (v) => ({ ...v, showAltered: on }));
}

/** 把当前帧还原成原始内容。 */
export function restoreFrame(doc: StrataDoc, id: string): StrataDoc {
  return mutate(doc, id, (v) => {
    const frames = v.frames.slice();
    frames[v.index] = { surface: cloneSurface(v.originals[v.index]), hold: frames[v.index].hold };
    return { ...v, frames };
  });
}

/** 所有帧还原成原始内容。 */
export function restoreAllFrames(doc: StrataDoc, id: string): StrataDoc {
  return mutate(doc, id, (v) => ({
    ...v,
    frames: v.frames.map((fr, i) => ({ surface: cloneSurface(v.originals[i]), hold: fr.hold })),
  }));
}

/** 重载当前帧：素材来自磁盘时由调用方重新读图，这里只负责把新图放进去。 */
export function reloadFrame(doc: StrataDoc, id: string, img: HTMLCanvasElement): StrataDoc {
  return mutate(doc, id, (v) => {
    const frames = v.frames.slice();
    const originals = v.originals.slice();
    frames[v.index] = { surface: cloneSurface(img), hold: frames[v.index].hold };
    originals[v.index] = cloneSurface(img);
    return { ...v, frames, originals };
  });
}

/** 栅格化：丢掉帧序列，只留当前画面。 */
export function rasterizeVideoLayer(doc: StrataDoc, id: string): StrataDoc {
  const layers = doc.layers.map((l) => {
    if (l.id !== id || !isVideoLayer(l)) return l;
    const { video: _drop, ...rest } = l;
    return rest;
  });
  return { ...doc, layers, dirty: true };
}

/** 当前帧的序号 / 总帧数 / 时长，供提示文案用。 */
export function videoSummary(layer: StrataLayer & { video: VideoState }): string {
  const { frames, index, fps } = layer.video;
  const total = frames.reduce((s, f) => s + f.hold, 0);
  return `第 ${index + 1}/${frames.length} 帧 · ${fps} fps · 共 ${total.toFixed(2)} 秒`;
}
