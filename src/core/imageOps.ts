/**
 * 文档级图像操作：颜色模式转换、显示全部、应用图像、陷印、比例标记、
 * 图层多选、测量。
 *
 * 纯算法在 colorMode.ts（可单测），这里只做 canvas / 文档层的接线：
 * 读像素 → 调纯函数 → 落回图层 → 返回新文档（沿用项目「旧文档进、新文档出」的约定）。
 */
import { blendInto } from "../engine/blend";
import { createSurface, mustCtx, readPixels, writePixels } from "../engine/surface";
import { contentBounds } from "../engine/warp";
import { activeLayer, type StrataDoc } from "./document";
import type { BlendId, StrataLayer } from "./layer";
import { convertProfile } from "./colorProfile";
import {
  applyPalette,
  splitChannels,
  toBitmap,
  toCmyk,
  toDuotone,
  toIndexed,
  toLab,
} from "./colorMode";

export type ColorModeId = NonNullable<StrataDoc["colorMode"]>;

/** 各模式的参数（没用到的字段忽略）。 */
export interface ColorModeOptions {
  /** 位图：阈值 0~255 */
  threshold?: number;
  /** 位图：半调网点单元大小，0 = 不半调 */
  halftone?: number;
  /** 双色调：深色 / 浅色 */
  dark?: string;
  light?: string;
  /** 双色调：油墨浓度 0~100 */
  strength?: number;
  /** 索引颜色：颜色数 */
  colors?: number;
  /** 索引颜色：是否抖动 */
  dither?: boolean;
  /** CMYK：油墨总量上限 % */
  inkLimit?: number;
  /** CMYK：底色去除 % */
  ucr?: number;
  /** Lab：最大彩度 */
  chroma?: number;
}

/** 把 #rrggbb 解析成 [r,g,b]。 */
function hexRgb(hex: string, fallback: [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const v = Number.parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** 把一张 surface 换成同样尺寸的新像素（写回新画布，避免原地改）。 */
function surfaceFromData(
  width: number,
  height: number,
  data: Uint8ClampedArray,
): HTMLCanvasElement {
  const s = createSurface(width, height);
  writePixels(s, new ImageData(new Uint8ClampedArray(data), width, height));
  return s;
}

/**
 * 切换颜色模式。
 * - bitmap / duotone / indexed / cmyk / lab：对所有像素层做真实的像素转换
 * - multichannel：图层转灰度，并把原 R/G/B 存成三条 Alpha 通道
 * - grayscale 由 layerOps 负责（已有实现）
 */
export function setColorMode(
  doc: StrataDoc,
  mode: ColorModeId,
  opts: ColorModeOptions = {},
): StrataDoc {
  const threshold = opts.threshold ?? 128;
  const halftone = opts.halftone ?? 0;
  const dark = hexRgb(opts.dark ?? "#1b2a4a", [27, 42, 74]);
  const light = hexRgb(opts.light ?? "#f2d9a0", [242, 217, 160]);
  const strength = opts.strength ?? 100;
  const colors = opts.colors ?? 64;
  const dither = opts.dither ?? true;
  const inkLimit = opts.inkLimit ?? 300;
  const ucr = opts.ucr ?? 40;
  const chroma = opts.chroma ?? 110;

  let palette: readonly [number, number, number][] | undefined = doc.palette;

  const convert = (surface: HTMLCanvasElement): HTMLCanvasElement => {
    const img = readPixels(surface);
    const src = { data: img.data, width: img.width, height: img.height };
    if (mode === "bitmap") {
      const out = toBitmap(src, threshold, halftone);
      return surfaceFromData(img.width, img.height, out.data);
    }
    if (mode === "duotone") {
      const out = toDuotone(src, dark, light, strength);
      return surfaceFromData(img.width, img.height, out.data);
    }
    if (mode === "indexed") {
      const res = toIndexed(src, colors, dither);
      palette = res.palette.map((p) => [p[0], p[1], p[2]] as [number, number, number]);
      return surfaceFromData(img.width, img.height, res.buf.data);
    }
    if (mode === "cmyk") {
      const out = toCmyk(src, inkLimit, ucr);
      return surfaceFromData(img.width, img.height, out.data);
    }
    if (mode === "lab") {
      const out = toLab(src, chroma);
      return surfaceFromData(img.width, img.height, out.data);
    }
    // multichannel：只留灰度
    const out = toDuotone(src, [0, 0, 0], [255, 255, 255], 100);
    return surfaceFromData(img.width, img.height, out.data);
  };

  const layers: StrataLayer[] = doc.layers.map((l) =>
    l.kind === "pixel" ? { ...l, surface: convert(l.surface) } : l,
  );

  // 多通道：把活动层的 R/G/B 存成三条 Alpha 通道（真实可见的产物）
  let alphaChannels = doc.alphaChannels;
  if (mode === "multichannel") {
    const cur = activeLayer(doc);
    if (cur && cur.kind === "pixel") {
      const img = readPixels(cur.surface);
      const { channels, names } = splitChannels({
        data: img.data,
        width: img.width,
        height: img.height,
      });
      const extra = channels.slice(0, 3).map((c, i) => {
        const mask = createSurface(img.width, img.height);
        const mimg = readPixels(mask);
        for (let p = 0; p < img.width * img.height; p += 1) {
          // 通道灰度 → 蒙版 alpha
          mimg.data[p * 4 + 3] = c.data[p * 4];
        }
        mustCtx(mask).putImageData(mimg, 0, 0);
        return { id: `mc-${i}-${Date.now()}`, name: `${names[i]}通道`, mask };
      });
      alphaChannels = [...(doc.alphaChannels ?? []), ...extra];
    }
  }

  return { ...doc, layers, colorMode: mode, palette, alphaChannels, dirty: true };
}

/* ------------------------------------------------------------ 显示全部 */

/**
 * 显示全部：把画布边界对齐到「所有图层（含隐藏层）内容的外接框」。
 *
 * Strata 的图层画布恒等于文档尺寸，内容不可能跑到画布外，所以 PS 意义上
 * 的「露出被裁掉的像素」在这里不成立；与之等价且有用的是：让画布正好
 * 贴合全部内容 —— 内容超出边界时扩（防御性保留），有多余透明边时收。
 * 与「图像 > 裁剪」的区别：这里把隐藏图层也算进内容范围。
 */
export function revealAll(doc: StrataDoc): StrataDoc {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of doc.layers) {
    if (l.kind !== "pixel") continue;
    const b = contentBounds(l.surface);
    if (!b) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (!Number.isFinite(minX)) return doc;
  const nw = Math.max(1, Math.round(maxX - minX));
  const nh = Math.max(1, Math.round(maxY - minY));
  if (nw === doc.width && nh === doc.height && minX === 0 && minY === 0) return doc;
  const layers = doc.layers.map((l) => {
    if (l.kind !== "pixel") return l;
    const s = createSurface(nw, nh);
    mustCtx(s).drawImage(l.surface, -minX, -minY);
    let mask = l.mask;
    if (mask) {
      const m = createSurface(nw, nh);
      mustCtx(m).drawImage(mask, -minX, -minY);
      mask = m;
    }
    return { ...l, surface: s, mask };
  });
  return { ...doc, width: nw, height: nh, layers, selection: null, dirty: true };
}

/* -------------------------------------------------------------- 应用图像 */

export interface ApplyImageOptions {
  /** 来源图层 id（默认：当前图层下面那一层） */
  sourceId?: string;
  /** 使用来源的哪个通道：rgb / r / g / b / gray */
  channel?: "rgb" | "r" | "g" | "b" | "gray";
  /** 混合模式 */
  blend?: BlendId;
  /** 不透明度 0~100 */
  opacity?: number;
  /** 反相 */
  invert?: boolean;
}

/**
 * 应用图像：把另一个图层的通道按混合模式叠进当前图层。
 * 只考虑来源的某一个通道时，该通道被复制成灰度（PS 的 Channel 选项语义）。
 */
export function applyImage(doc: StrataDoc, opts: ApplyImageOptions = {}): StrataDoc {
  const cur = activeLayer(doc);
  if (!cur || cur.kind !== "pixel" || cur.locked) return doc;
  const curIdx = doc.layers.findIndex((l) => l.id === cur.id);
  const source =
    doc.layers.find((l) => l.id === opts.sourceId) ??
    [...doc.layers.slice(0, Math.max(0, curIdx))].reverse().find((l) => l.kind === "pixel" && l.visible);
  if (!source || source.id === cur.id) return doc;

  const channel = opts.channel ?? "rgb";
  const invert = opts.invert ?? false;
  let srcSurface = source.surface;
  if (channel !== "rgb") {
    const img = readPixels(source.surface);
    const out = createSurface(img.width, img.height);
    const oimg = readPixels(out);
    for (let p = 0; p < img.width * img.height; p += 1) {
      const i = p * 4;
      const pick =
        channel === "r"
          ? img.data[i]
          : channel === "g"
            ? img.data[i + 1]
            : channel === "b"
              ? img.data[i + 2]
              : 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
      const v = invert ? 255 - pick : pick;
      oimg.data[i] = v;
      oimg.data[i + 1] = v;
      oimg.data[i + 2] = v;
      oimg.data[i + 3] = 255;
    }
    mustCtx(out).putImageData(oimg, 0, 0);
    srcSurface = out;
  } else if (invert) {
    const img = readPixels(source.surface);
    const out = createSurface(img.width, img.height);
    const oimg = readPixels(out);
    for (let i = 0; i < img.data.length; i += 4) {
      oimg.data[i] = 255 - img.data[i];
      oimg.data[i + 1] = 255 - img.data[i + 1];
      oimg.data[i + 2] = 255 - img.data[i + 2];
      oimg.data[i + 3] = img.data[i + 3];
    }
    mustCtx(out).putImageData(oimg, 0, 0);
    srcSurface = out;
  }

  const next = createSurface(doc.width, doc.height);
  const ctx = mustCtx(next);
  ctx.drawImage(cur.surface, 0, 0);
  blendInto(ctx, srcSurface, (opts.opacity ?? 100) / 100, opts.blend ?? "normal");
  const layers = doc.layers.slice();
  layers[curIdx] = { ...cur, surface: next };
  return { ...doc, layers, dirty: true };
}

/* ---------------------------------------------------------------- 陷印 */

/**
 * 陷印：让浅色区域向深色一侧「长」出 width 像素，避免印刷套印不准时出现白缝。
 * 实现方式是「取邻域内最深的颜色」——深色自然侵蚀浅色，白边消失。
 */
export function trapInk(doc: StrataDoc, width: number): StrataDoc {
  const cur = activeLayer(doc);
  if (!cur || cur.kind !== "pixel" || cur.locked) return doc;
  const img = readPixels(cur.surface);
  const w = img.width;
  const h = img.height;
  const r = Math.max(0, Math.round(width));
  if (r === 0) return doc;
  const out = createSurface(w, h);
  const oimg = readPixels(out);
  const lum = new Float32Array(w * h);
  for (let p = 0; p < w * h; p += 1) {
    const i = p * 4;
    lum[p] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = y * w + x;
      let bestI = p;
      let best = lum[p];
      for (let dy = -r; dy <= r; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (lum[q] < best) {
            best = lum[q];
            bestI = q;
          }
        }
      }
      const si = bestI * 4;
      const di = p * 4;
      oimg.data[di] = img.data[si];
      oimg.data[di + 1] = img.data[si + 1];
      oimg.data[di + 2] = img.data[si + 2];
      oimg.data[di + 3] = img.data[di + 3];
    }
  }
  mustCtx(out).putImageData(oimg, 0, 0);
  const layers = doc.layers.slice();
  const at = doc.layers.findIndex((l) => l.id === cur.id);
  layers[at] = { ...cur, surface: out };
  return { ...doc, layers, dirty: true };
}

/* ------------------------------------------------------------ 比例标记 */

export interface ScaleMarkerOptions {
  /** 标记代表的实际长度（单位由 measureScale.unit 决定） */
  units: number;
  /** 距离画面左下的边距（像素） */
  margin?: number;
  color?: string;
  /** 线宽 */
  lineWidth?: number;
  fontSize?: number;
}

/**
 * 放置比例标记：在画面左下角画一根带文字的线段（长度按测量比例折算成像素）。
 */
export function placeScaleMarker(doc: StrataDoc, opts: ScaleMarkerOptions): StrataDoc {
  const cur = activeLayer(doc);
  if (!cur || cur.kind !== "pixel" || cur.locked) return doc;
  const scale = doc.measureScale ?? { px: 100, real: 100, unit: "px" };
  const pxPerUnit = scale.px / Math.max(0.0001, scale.real);
  const barPx = Math.max(8, Math.round(opts.units * pxPerUnit));
  const margin = opts.margin ?? 24;
  const color = opts.color ?? "#ffffff";
  const lw = opts.lineWidth ?? 3;
  const fs = opts.fontSize ?? 14;

  const surface = createSurface(doc.width, doc.height);
  const ctx = mustCtx(surface);
  ctx.drawImage(cur.surface, 0, 0);
  const x0 = margin;
  const x1 = Math.min(doc.width - margin, margin + barPx);
  const y = doc.height - margin;
  // 描边 + 主色，深底浅底都看得清
  ctx.lineCap = "butt";
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.lineWidth = lw + 2;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.moveTo(x0, y - 6);
  ctx.lineTo(x0, y + 6);
  ctx.moveTo(x1, y - 6);
  ctx.lineTo(x1, y + 6);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.moveTo(x0, y - 6);
  ctx.lineTo(x0, y + 6);
  ctx.moveTo(x1, y - 6);
  ctx.lineTo(x1, y + 6);
  ctx.stroke();
  ctx.font = `${fs}px system-ui, sans-serif`;
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillText(`${opts.units} ${scale.unit}`, x0 + 1, y - 9);
  ctx.fillStyle = color;
  ctx.fillText(`${opts.units} ${scale.unit}`, x0, y - 10);

  const layers = doc.layers.slice();
  const at = doc.layers.findIndex((l) => l.id === cur.id);
  layers[at] = { ...cur, surface };
  return { ...doc, layers, dirty: true };
}

/* ---------------------------------------------------------- 图层多选 */

/** 设置多选图层集合（去重、过滤不存在的 id）。 */
export function setLayerSelection(doc: StrataDoc, ids: readonly string[]): StrataDoc {
  const known = new Set(doc.layers.map((l) => l.id));
  const next = Array.from(new Set(ids.filter((id) => known.has(id))));
  return { ...doc, selectedLayerIds: next.length ? next : undefined };
}

/** 按名称/类型查找图层并以之替换当前多选。 */
export function findLayers(doc: StrataDoc, query: string): StrataDoc {
  const q = query.trim().toLowerCase();
  if (!q) return doc;
  const hits = doc.layers.filter((l) => {
    if (l.name.toLowerCase().includes(q)) return true;
    if (q === "像素" || q === "pixel") return l.kind === "pixel";
    if (q === "调整" || q === "adjust") return l.kind === "adjust";
    if (q === "组" || q === "group") return l.kind === "group";
    if (q === "隐藏" || q === "hidden") return !l.visible;
    return false;
  });
  if (hits.length === 0) return doc;
  const base = setLayerSelection(doc, hits.map((l) => l.id));
  return { ...base, activeLayerId: hits[hits.length - 1].id };
}

/** 隔离图层：只留下多选（无多选时留活动图层）可见，其余全部隐藏。 */
export function isolateLayers(doc: StrataDoc): StrataDoc {
  const keep = new Set(doc.selectedLayerIds ?? [doc.activeLayerId]);
  if (keep.size === 0) return doc;
  const anyHidden = doc.layers.some((l) => !keep.has(l.id) && l.visible);
  const layers = doc.layers.map((l) =>
    keep.has(l.id) ? { ...l, visible: true } : { ...l, visible: anyHidden ? false : l.visible },
  );
  if (!anyHidden) {
    // 已经隔离过了 → 再次执行等于还原全部可见
    return { ...doc, layers: doc.layers.map((l) => ({ ...l, visible: true })), dirty: true };
  }
  return { ...doc, layers, dirty: true };
}

/* ------------------------------------------------------------ 测量 */

export interface MeasureRow {
  label: string;
  value: string;
}

/**
 * 记录测量：按当前测量比例把选区的面积 / 周长 / 尺寸换算成实际单位。
 * 没有选区时退化为测量活动图层的内容范围。
 */
export function measureDocument(doc: StrataDoc): MeasureRow[] {
  const scale = doc.measureScale ?? { px: 100, real: 100, unit: "px" };
  const pxPerUnit = scale.px / Math.max(0.0001, scale.real);
  const toUnit = (px: number): number => (pxPerUnit === 0 ? px : px / pxPerUnit);

  let box: { x: number; y: number; width: number; height: number } | null = null;
  if (doc.selection) {
    const img = readPixels(doc.selection);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let area = 0;
    for (let y = 0; y < img.height; y += 1) {
      for (let x = 0; x < img.width; x += 1) {
        if (img.data[(y * img.width + x) * 4 + 3] > 127) {
          area += 1;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (area > 0) {
      box = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
      const w = box.width;
      const h = box.height;
      const perimeterApprox = 2 * (w + h);
      return [
        { label: "单位", value: scale.unit },
        { label: "选区面积", value: `${(toUnit(area) ** 2).toFixed(2)} ${scale.unit}²` },
        { label: "选区宽度", value: `${toUnit(w).toFixed(2)} ${scale.unit}` },
        { label: "选区高度", value: `${toUnit(h).toFixed(2)} ${scale.unit}` },
        { label: "选区周长（外接框）", value: `${toUnit(perimeterApprox).toFixed(2)} ${scale.unit}` },
        { label: "像素面积", value: `${area} px²` },
      ];
    }
  }
  const cur = activeLayer(doc);
  if (cur && cur.kind === "pixel") {
    const b = contentBounds(cur.surface);
    if (b) {
      return [
        { label: "单位", value: scale.unit },
        { label: "内容宽度", value: `${toUnit(b.w).toFixed(2)} ${scale.unit}` },
        { label: "内容高度", value: `${toUnit(b.h).toFixed(2)} ${scale.unit}` },
        { label: "内容像素", value: `${b.w} × ${b.h} px` },
      ];
    }
  }
  return [{ label: "提示", value: "先建立选区或选中一个有内容的图层" }];
}

/** 索引模式改完颜色表后重新映射。 */
export function remapPalette(
  doc: StrataDoc,
  palette: readonly [number, number, number][],
): StrataDoc {
  const cur = activeLayer(doc);
  if (!cur || cur.kind !== "pixel") return doc;
  const img = readPixels(cur.surface);
  const out = applyPalette(
    { data: img.data, width: img.width, height: img.height },
    palette.map((p) => [p[0], p[1], p[2]] as const),
  );
  const at = doc.layers.findIndex((l) => l.id === cur.id);
  const layers = doc.layers.slice();
  layers[at] = { ...cur, surface: surfaceFromData(img.width, img.height, out.data) };
  return { ...doc, layers, palette, dirty: true };
}

/* ------------------------------------------------------------- 数据组 */

/**
 * 应用数据组：按数据组里的变量值切换对应图层可见性。
 * 「1 / true / on / 是」视为显示，其余视为隐藏 —— 与 PS 的可见性变量一致。
 */
export function applyDataSet(doc: StrataDoc, setName: string): StrataDoc {
  const set = (doc.dataSets ?? []).find((s) => s.name === setName);
  if (!set) return doc;
  const visibleByLayer = new Map<string, boolean>();
  for (const v of doc.variables ?? []) {
    const raw = set.values[v.name];
    if (raw === undefined) continue;
    const on = /^(1|true|on|yes|是|显示)$/i.test(raw.trim());
    visibleByLayer.set(v.layerId, on);
  }
  if (visibleByLayer.size === 0) return doc;
  const layers = doc.layers.map((l) =>
    visibleByLayer.has(l.id) ? { ...l, visible: visibleByLayer.get(l.id) as boolean } : l,
  );
  return { ...doc, layers, dirty: true };
}

/* ---------------------------------------------------------------- 渐隐 */

/**
 * 渐隐：把「上一步之后」的结果按 percent% 混回「上一步之前」。
 *
 * 这是 PS「编辑 > 渐隐」的语义 —— 不撤销，而是把刚才那一步的强度调低。
 * 逐层按 id 对齐：只混两边都存在的像素层，其余保持 after 的样子。
 */
export function fadeDocument(before: StrataDoc, after: StrataDoc, percent: number): StrataDoc {
  const p = Math.min(100, Math.max(0, percent)) / 100;
  if (p >= 1) return after;
  if (p <= 0) return before;
  const prevById = new Map(before.layers.map((l) => [l.id, l]));
  const layers = after.layers.map((l) => {
    if (l.kind !== "pixel") return l;
    const prev = prevById.get(l.id);
    if (!prev || prev.kind !== "pixel") return l;
    const w = Math.max(l.surface.width, prev.surface.width);
    const h = Math.max(l.surface.height, prev.surface.height);
    const mixed = createSurface(w, h);
    const ctx = mustCtx(mixed);
    ctx.drawImage(prev.surface, 0, 0);
    ctx.globalAlpha = p;
    ctx.drawImage(l.surface, 0, 0);
    ctx.globalAlpha = 1;
    return { ...l, surface: mixed };
  });
  return { ...after, layers, dirty: true };
}

/* ------------------------------------------------------------ 色彩配置 */

/** 指定配置文件：只换解释标签，一个像素都不动（PS 的 Assign Profile 语义）。 */
export function assignProfile(doc: StrataDoc, profile: NonNullable<StrataDoc["profile"]>): StrataDoc {
  return { ...doc, profile, dirty: true };
}

/**
 * 转换为配置文件：真的把像素从当前配置文件换算到目标空间。
 * 当前没标配置文件时按 sRGB 处理。
 */
export function convertToProfile(
  doc: StrataDoc,
  target: NonNullable<StrataDoc["profile"]>,
): StrataDoc {
  const from = doc.profile ?? "srgb";
  if (from === target) return doc;
  const layers = doc.layers.map((l) => {
    if (l.kind !== "pixel") return l;
    const img = readPixels(l.surface);
    const out = convertProfile(
      { data: img.data, width: img.width, height: img.height },
      from,
      target,
    );
    return { ...l, surface: surfaceFromData(img.width, img.height, out.data) };
  });
  return { ...doc, layers, profile: target, dirty: true };
}
