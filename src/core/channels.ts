/**
 * 通道。
 *
 * 一张 RGB 图天然自带四个通道：红、绿、蓝与透明度。这里**不把通道当数据存** ——
 * 通道是打开文档时从像素现算出来的派生视图，于是有三条直接的好处：
 *  · 缩略图与「载入选区」全部现算，不占文档体积、不落盘；
 *  · 通道是视图，不进撤销栈、不改一个像素，随时开随时关；
 *  · 工程格式与历史栈完全不用为它扩字段。
 *
 * 两种观察方式，与 PS 一致：
 *  · **关掉某个通道的眼睛** —— 该通道不再参与合成。关掉红，画面就少了一份红、
 *    整体偏青；关掉透明度，整幅按不透明看，方便检查透明区域底下存了什么颜色。
 *  · **点通道名单独查看** —— 整幅按该通道的灰度呈现（0 黑 255 白），
 *    一眼看清这一原色的浓淡，是修图里最常用的观察手段。
 *
 * 所有像素运算先落到 `applyChannelViewToBuffer` 这类**纯函数**上，画布只是薄壳。
 * 单测跑在 node 里（没有真实光栅化），能验的就是这层纯逻辑。
 */
import { createSurface, mustCtx, readPixels, writePixels } from "../engine/surface";

/** 复合通道 + 三个原色通道 + 透明度。 */
export type ChannelId = "rgb" | "red" | "green" | "blue" | "alpha";

/** 各原色通道是否参与合成。 */
export interface ChannelVis {
  red: boolean;
  green: boolean;
  blue: boolean;
  alpha: boolean;
}

/** 默认：四个通道全开，屏幕显示的就是完整合成结果。 */
export const DEFAULT_CHANNEL_VIS: ChannelVis = {
  red: true,
  green: true,
  blue: true,
  alpha: true,
};

/** 面板里从上到下的通道顺序，与 PS 相同。 */
export const CHANNEL_ORDER: ChannelId[] = ["rgb", "red", "green", "blue", "alpha"];

/* ------------------------------------------------------------------ 视图态 */

/** 取某一像素在指定通道上的 0–255 灰度值；复合通道取 Rec.601 亮度。 */
export function channelValue(
  r: number,
  g: number,
  b: number,
  a: number,
  id: ChannelId,
): number {
  switch (id) {
    case "red":
      return r;
    case "green":
      return g;
    case "blue":
      return b;
    case "alpha":
      return a;
    default:
      return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
}

/** 视图是否处于默认态（完整彩色合成、没有任何通道被关）。 */
export function isChannelViewDefault(vis: ChannelVis, active: ChannelId): boolean {
  return active === "rgb" && vis.red && vis.green && vis.blue && vis.alpha;
}

/**
 * 点眼睛：切换某个通道是否参与合成。
 * 复合通道没有独立开关，点它等于同时开关红绿蓝 —— 与 PS 一致。
 */
export function toggleChannelVis(vis: ChannelVis, id: ChannelId): ChannelVis {
  switch (id) {
    case "red":
      return { ...vis, red: !vis.red };
    case "green":
      return { ...vis, green: !vis.green };
    case "blue":
      return { ...vis, blue: !vis.blue };
    case "alpha":
      return { ...vis, alpha: !vis.alpha };
    default: {
      const on = !(vis.red && vis.green && vis.blue);
      return { ...vis, red: on, green: on, blue: on };
    }
  }
}

/* ----------------------------------------------------------- 像素：视图渲染 */

/**
 * 按通道视图重写一段 RGBA 缓冲（**原位**，纯函数）。
 *
 * active 为 "rgb"：把关掉的通道分量归零；透明度关掉时按 255 处理（当不透明看）。
 * active 为单通道：整幅换成该通道的灰度，并强制不透明 —— 通道视图是一张灰度图，
 * 透明区域在通道里就是纯黑，画布不该因此漏底。
 */
export function applyChannelViewToBuffer(
  p: Uint8ClampedArray,
  vis: ChannelVis,
  active: ChannelId,
): void {
  const isolate = active !== "rgb";
  for (let i = 0; i < p.length; i += 4) {
    const r = p[i];
    const g = p[i + 1];
    const b = p[i + 2];
    const a = p[i + 3];

    if (isolate) {
      const v = channelValue(r, g, b, a, active);
      p[i] = v;
      p[i + 1] = v;
      p[i + 2] = v;
      p[i + 3] = 255;
      continue;
    }

    p[i] = vis.red ? r : 0;
    p[i + 1] = vis.green ? g : 0;
    p[i + 2] = vis.blue ? b : 0;
    p[i + 3] = vis.alpha ? a : 255;
  }
}

/** 屏幕显示用：按通道视图原地重写整张画布；默认态直接跳过，零开销。 */
export function applyChannelView(
  canvas: HTMLCanvasElement,
  vis: ChannelVis,
  active: ChannelId,
): void {
  if (isChannelViewDefault(vis, active)) return;
  const data = readPixels(canvas);
  applyChannelViewToBuffer(data.data, vis, active);
  writePixels(canvas, data);
}

/* ------------------------------------------------------------- 像素：派生图 */

/** 把一段 RGBA 缓冲转成某个通道的灰度（保留 alpha）——缩略图用。 */
export function channelGrayToBuffer(p: Uint8ClampedArray, id: ChannelId): void {
  for (let i = 0; i < p.length; i += 4) {
    const v = channelValue(p[i], p[i + 1], p[i + 2], p[i + 3], id);
    p[i] = v;
    p[i + 1] = v;
    p[i + 2] = v;
  }
}

/**
 * 把一段 RGBA 缓冲转成选区遮罩的像素：白底 + 「通道值」写进 alpha。
 *
 * 与 PS 的「载入通道作为选区」同一口径 —— 通道值直接就是选中程度，
 * 255 全选中、0 全不选，中间值自然形成软边。想要硬边可以载入后再用
 * 选择菜单的「扩大 / 收缩 / 羽化」收拾。
 */
export function channelMaskToBuffer(p: Uint8ClampedArray, id: ChannelId): void {
  for (let i = 0; i < p.length; i += 4) {
    const v = channelValue(p[i], p[i + 1], p[i + 2], p[i + 3], id);
    p[i] = 255;
    p[i + 1] = 255;
    p[i + 2] = 255;
    p[i + 3] = v;
  }
}

/** 由一张合成结果抽出某个通道，做成与它同尺寸的选区遮罩。 */
export function channelToSelection(
  src: HTMLCanvasElement,
  id: ChannelId,
): HTMLCanvasElement {
  const out = createSurface(src.width, src.height);
  const data = readPixels(src);
  channelMaskToBuffer(data.data, id);
  writePixels(out, data);
  return out;
}

/** 抽出某个通道做成一张 size×size 的缩略图（等比居中，留白处透明）。 */
export function channelThumb(
  src: HTMLCanvasElement,
  id: ChannelId,
  size = 36,
): HTMLCanvasElement {
  const c = createSurface(size, size);
  if (src.width < 1 || src.height < 1) return c;
  const ctx = mustCtx(c);
  const k = Math.min(size / src.width, size / src.height);
  const w = src.width * k;
  const h = src.height * k;
  ctx.drawImage(src, (size - w) / 2, (size - h) / 2, w, h);
  // 单通道缩略图要看出浓淡：把画出来的那块转成灰度（复合通道保持彩色）
  if (id !== "rgb") {
    const data = readPixels(c);
    channelGrayToBuffer(data.data, id);
    writePixels(c, data);
  }
  return c;
}
