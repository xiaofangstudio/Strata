/**
 * 屏幕显示用的合成入口 —— **按视图分辨率合成，而不是文档分辨率**。
 *
 * 为什么需要这个：
 *
 * 原来画布视图的每一帧都在"文档原生分辨率"上整档合成（6000×4000 就是 24MP），
 * 再缩小贴到屏幕上。可屏幕上一块 1200×800 的区域根本装不下 24MP 的信息，
 * 那 96% 的像素算完就被丢掉 —— 也就是每拖一下都在白算二十几次。
 * 图层一多、再加一个逐像素调色层，单帧就上到几百毫秒，表现是"5 秒 3 帧"。
 *
 * 这里的做法：把每层的像素和蒙版按视图缩放缩一份，合成在缩小的坐标系里跑。
 * 因为合成的像素数按 scale² 下降，25% 视图下就是 1/16 的计算量。
 *
 * **不损画质**：只有在缩小显示（scale × dpr < 1）时才降采样，
 * 而在那个缩放下屏幕上本来也只显示这么点像素，1:1 对应。
 * 放大到 100% 及以上时 s 夹到 1，走原路径，与导出完全一致。
 */
import type { StrataDoc } from "../core/document";
import type { StrataLayer } from "../core/layer";
import type { GradeWindow } from "../core/gradeWindow";
import { composeDoc, type LayerOverride } from "./compositor";
import { mustCtx } from "./surface";

/** 缩小时允许的最小比例：再小就只剩马赛克了，宁可慢一点。 */
const MIN_SCALE = 0.06;

/**
 * 缩小目标画布池。
 *
 * 一次合成里「每个图层一张」就够（用完即弃，同一帧内互不重叠），
 * 按序号复用，避免每帧 new 出几十张 canvas 把 GC 拖垮。
 */
const pool: HTMLCanvasElement[] = [];
let used = 0;

function grab(w: number, h: number): HTMLCanvasElement {
  let c = pool[used];
  if (!c) {
    c = document.createElement("canvas");
    pool[used] = c;
  }
  used += 1;
  const pw = Math.max(1, Math.round(w));
  const ph = Math.max(1, Math.round(h));
  if (c.width !== pw) c.width = pw;
  if (c.height !== ph) c.height = ph;
  const ctx = mustCtx(c);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.clearRect(0, 0, pw, ph);
  return c;
}

/**
 * 供「拖动图层」的实时预览复用：把源画布按 s 缩一份并缓存。
 *
 * 预览每帧都要搬动这一层，若每帧重新把整幅 24MP 表面缩一遍，缩本身就成了
 * 主要开销；而拖动期间源画布根本不变，所以缩一次、之后每帧只搬缩略图。
 * 返回的画布由缓存持有，**调用方只能读，不要往上面画**。
 */
export function shrinkSurfaceForDisplay(src: HTMLCanvasElement, s: number): HTMLCanvasElement {
  return shrink(src, s, true);
}

/** 把一张画布等比缩到 s 倍，返回池里的画布（下次合成会被覆盖，别长期持有）。 */
function shrinkToPool(
  src: CanvasImageSource & { width: number; height: number },
  s: number,
): HTMLCanvasElement {
  const out = grab(src.width * s, src.height * s);
  const ctx = mustCtx(out);
  ctx.imageSmoothingEnabled = true;
  // 缩小用 medium：high 在几十兆像素上会慢到离谱，而这个尺寸下肉眼看不出差别
  ctx.imageSmoothingQuality = "medium";
  ctx.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

/**
 * 缩小结果缓存。
 *
 * 为什么必须有：合成一次要先把每层从全分辨率缩到视图尺寸，图层一多，
 * "缩"本身就比"合"还贵（20 层 × 24MP 的读取 ≈ 每帧几十毫秒）。
 * 而绝大部分图层在一帧里根本不会变 —— 缓存住它们的缩小版，只重算变的那一层。
 *
 * 失效策略：用源画布的引用做 key（源换了就是新对象，自然重建）；
 * **正在编辑的那一层永远不缓存**，因为画笔 / 渐变是就地改像素的，
 * 画布引用不变但内容变了，缓存会留下上一笔的残影。
 */
const shrinkCache = new WeakMap<HTMLCanvasElement, { s: number; out: HTMLCanvasElement }>();

function shrink(src: HTMLCanvasElement, s: number, cacheable: boolean): HTMLCanvasElement {
  if (!cacheable) return shrinkToPool(src, s);

  const tw = Math.max(1, Math.round(src.width * s));
  const th = Math.max(1, Math.round(src.height * s));
  const hit = shrinkCache.get(src);
  if (hit && hit.out.width === tw && hit.out.height === th) return hit.out;

  const out = document.createElement("canvas");
  out.width = tw;
  out.height = th;
  const ctx = mustCtx(out);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";
  ctx.drawImage(src, 0, 0, tw, th);
  shrinkCache.set(src, { s, out });
  return out;
}

/** 范围几何按比例缩 —— 坐标、半径、羽化一起缩，形状才不走样。 */
function shrinkWindow(w: GradeWindow, s: number): GradeWindow {
  const feather = Math.max(0, w.feather * s);
  if (w.kind === "ellipse") {
    return {
      ...w,
      cx: w.cx * s,
      cy: w.cy * s,
      rx: Math.max(0.5, w.rx * s),
      ry: Math.max(0.5, w.ry * s),
      feather,
    };
  }
  if (w.kind === "quad") {
    return {
      ...w,
      points: w.points.map((p) => ({ x: p.x * s, y: p.y * s })),
      edges: w.edges ? w.edges.map((v) => v * s) : undefined,
      feather,
    };
  }
  if (w.kind === "line") {
    return { ...w, x1: w.x1 * s, y1: w.y1 * s, x2: w.x2 * s, y2: w.y2 * s, feather };
  }
  return { ...w, points: w.points.map((p) => ({ x: p.x * s, y: p.y * s })), feather };
}

/**
 * 一层缩到 s 倍。
 *
 * 只动「像素 + 蒙版 + 范围几何」这三样跟分辨率绑死的东西；
 * 混合模式、不透明度、样式、剪贴关系都原样保留 —— 它们本来就与分辨率无关，
 * 而样式里的像素偏移量跟着整体一起缩，视觉比例自然是对的。
 */
function shrinkLayer(l: StrataLayer, s: number, cacheable: boolean): StrataLayer {
  const out: StrataLayer = { ...l };
  // 调整层不画自己的像素（它读的是下方合成结果），没有可缩的东西
  if (l.kind !== "adjust" && l.surface) {
    out.surface = shrink(l.surface, s, cacheable);
  }
  if (l.mask) out.mask = shrink(l.mask, s, cacheable);
  if (l.window) out.window = shrinkWindow(l.window, s);
  return out;
}

/**
 * 屏幕显示用的合成。
 *
 * @param viewScale 视图缩放 × devicePixelRatio（屏幕上每个文档像素占多少物理像素）
 * @returns 合成结果的分辨率（调用方据此把画面贴到显示画布上）
 */
export function composeForDisplay(
  doc: StrataDoc,
  target: HTMLCanvasElement,
  viewScale: number,
  /**
   * prescaled：override.layer.surface 已经按显示比例缩好（并且偏移也已经烘进去），
   * 这里只补缩蒙版 / 范围，不再缩表面。拖动图层时用它省掉每帧的整幅重缩。
   */
  override?: (LayerOverride & { prescaled?: boolean }) | null,
): { width: number; height: number } {
  const s = Math.min(1, Math.max(MIN_SCALE, viewScale));

  // 1:1 或放大：不需要降采样，走与导出完全相同的路径
  if (s >= 0.999) {
    used = 0;
    composeDoc(doc, target, override);
    return { width: target.width, height: target.height };
  }

  used = 0;
  // 正在编辑的那一层不缓存：它的像素是就地改的，引用不变但内容在变
  const activeId = doc.activeLayerId;
  const layers = doc.layers.map((l) => shrinkLayer(l, s, l.id !== activeId));
  const dispOverride = override
    ? {
        index: override.index,
        layer:
          override.prescaled && override.layer.surface
            ? {
                ...override.layer,
                mask: override.layer.mask ? shrink(override.layer.mask, s, false) : override.layer.mask,
                window: override.layer.window ? shrinkWindow(override.layer.window, s) : override.layer.window,
              }
            : shrinkLayer(override.layer, s, false),
      }
    : null;
  const dispDoc: StrataDoc = {
    ...doc,
    width: Math.max(1, Math.round(doc.width * s)),
    height: Math.max(1, Math.round(doc.height * s)),
    layers,
  };
  composeDoc(dispDoc, target, dispOverride);
  used = 0;
  return { width: target.width, height: target.height };
}
