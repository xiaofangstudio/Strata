/**
 * 文字引擎（M3）。
 *
 * 与画笔 / 形状一条心：文字最终也只是「一层像素」——先在一张离屏画布上
 * 用 Canvas2D 的 fillText 栅格化，再整层交给合成器，于是混合模式、图层样式、
 * 蒙版、剪贴蒙版、撤销栈全部自动生效，不必为文字另开一条渲染通路。
 *
 * 这里不做「可反复编辑的文本对象」（那是 M4 的活）：本函数只负责把
 * 一次输入变成像素，所见即所得。
 */
import { createSurface, mustCtx } from "./surface";

/** 字体族：只列系统里必定有的中文字体，保证零依赖、零下载。 */
export type TextFamilyId = "sans" | "song" | "kai" | "mono";
export type TextAlign = "left" | "center" | "right";

/** 文字变形（PS 弯曲文字的八款经典样式）。 */
export type WarpStyle = "none" | "arc" | "bulge" | "flag" | "wave" | "fish" | "rise";

export const WARP_STYLES: { id: WarpStyle; label: string }[] = [
  { id: "none", label: "无" },
  { id: "arc", label: "扇形" },
  { id: "bulge", label: "凸起" },
  { id: "flag", label: "旗帜" },
  { id: "wave", label: "波浪" },
  { id: "fish", label: "鱼形" },
  { id: "rise", label: "上升" },
];

export interface TextSettings {
  /** 字号（像素） */
  size: number;
  family: TextFamilyId;
  bold: boolean;
  italic: boolean;
  /** 行距倍数（相对字号） */
  lineHeight: number;
  align: TextAlign;
  /** 字距（像素，Canvas2D letterSpacing，负值收紧） */
  letterSpacing: number;
  /** 变形样式（none = 不变形） */
  warp: WarpStyle;
  /** 变形强度（-100 ~ 100，负值反向弯曲） */
  warpAmount: number;
}

export const TEXT_FAMILIES: { id: TextFamilyId; label: string; stack: string }[] = [
  {
    id: "sans",
    label: "黑体",
    stack: '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif',
  },
  {
    id: "song",
    label: "宋体",
    stack: '"SimSun", "Songti SC", "Noto Serif CJK SC", serif',
  },
  {
    id: "kai",
    label: "楷体",
    stack: '"KaiTi", "STKaiti", "Kaiti SC", serif',
  },
  {
    id: "mono",
    label: "等宽",
    stack: '"Cascadia Mono", Consolas, "Courier New", monospace',
  },
];

export const DEFAULT_TEXT: TextSettings = {
  size: 48,
  family: "sans",
  bold: false,
  italic: false,
  lineHeight: 1.25,
  align: "left",
  letterSpacing: 0,
  warp: "none",
  warpAmount: 0,
};

/** 字体族 → CSS font-family 串。未知 id 退回第一个（黑体），不抛错。 */
export function fontStack(id: TextFamilyId): string {
  return (TEXT_FAMILIES.find((f) => f.id === id) ?? TEXT_FAMILIES[0]).stack;
}

/** 组装 Canvas2D 的 font 简写，顺序必须是 style → weight → size → family。 */
export function fontString(s: TextSettings): string {
  const style = s.italic ? "italic " : "";
  const weight = s.bold ? "700" : "400";
  const size = Math.max(1, Math.round(s.size));
  return `${style}${weight} ${size}px ${fontStack(s.family)}`;
}

/** 字距：WebView2 的 Canvas2D 支持 ctx.letterSpacing，旧内核没有就静默跳过。 */
function applyLetterSpacing(ctx: CanvasRenderingContext2D, px: number): void {
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if (typeof c.letterSpacing === "string") c.letterSpacing = `${px}px`;
}

/** 统一换行符后按行拆开 —— 空串也算一行，光标与行距才对得上。 */
export function textLines(content: string): string[] {
  return content.replace(/\r\n?/g, "\n").split("\n");
}

/* ------------------------------------------------------------------ 度量 */

/** 共享的测量画布：不参与显示，只为拿到 measureText。 */
let meter: HTMLCanvasElement | null = null;
function meterCtx(): CanvasRenderingContext2D {
  if (!meter) meter = createSurface(1, 1);
  return mustCtx(meter);
}

export interface TextBlockMetrics {
  width: number;
  height: number;
  lineHeight: number;
  lines: string[];
}

/** 量出一段文字按当前设置排版后占多大（宽取最长行）。 */
export function measureTextBlock(content: string, s: TextSettings): TextBlockMetrics {
  const ctx = meterCtx();
  ctx.font = fontString(s);
  applyLetterSpacing(ctx, s.letterSpacing);
  const lines = textLines(content);
  let width = 0;
  for (const line of lines) width = Math.max(width, ctx.measureText(line).width);
  const lineHeight = Math.max(1, Math.round(s.size * s.lineHeight));
  return {
    width,
    height: lineHeight * Math.max(1, lines.length),
    lineHeight,
    lines,
  };
}

/* ------------------------------------------------------------------ 绘制 */

/**
 * 把文字画到目标上下文；(x, y) 是文本框左上角。
 *
 * 用 textBaseline = "top" 让「行顶」落在计算出的基线上，行的推进量固定为
 * size × lineHeight —— 与 measureTextBlock 完全一致，因此预览框和最终像素
 * 严丝合缝，不会出现「看着对齐、落笔跑偏」。
 */
export function paintText(
  ctx: CanvasRenderingContext2D,
  content: string,
  s: TextSettings,
  x: number,
  y: number,
  color: string,
): void {
  const m = measureTextBlock(content, s);
  ctx.save();
  ctx.font = fontString(s);
  applyLetterSpacing(ctx, s.letterSpacing);
  ctx.fillStyle = color;
  ctx.textBaseline = "top";
  ctx.textAlign = s.align;
  for (let i = 0; i < m.lines.length; i += 1) {
    ctx.fillText(m.lines[i], x, y + i * m.lineHeight);
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ 变形 */

/**
 * 对一块文字画布做弯曲变形（PS 弯曲文字的经典位移场）。
 *
 * 与滤镜内核同一套路：对每个目标像素反查源坐标（最近邻）。arc/flag/wave
 * 是纵向弯曲，fish 是横向鼓出，bulge 是径向凸起，rise 是斜切上扬 ——
 * amount 负值全部反向。
 */
export function warpCanvas(
  src: HTMLCanvasElement,
  warp: WarpStyle,
  amount: number,
): HTMLCanvasElement {
  if (warp === "none" || amount === 0) return src;
  const w = src.width;
  const h = src.height;
  const ctx = mustCtx(src);
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  const out = new Uint8ClampedArray(data.length);
  const b = Math.max(-100, Math.min(100, amount)) / 100;
  for (let y = 0; y < h; y += 1) {
    const ty = h <= 1 ? 0 : (y / (h - 1)) * 2 - 1;
    for (let x = 0; x < w; x += 1) {
      const tx = w <= 1 ? 0 : (x / (w - 1)) * 2 - 1;
      let sx = tx;
      let sy = ty;
      switch (warp) {
        case "arc":
          sy = ty - b * (1 - tx * tx) * 0.5;
          break;
        case "flag":
          sy = ty - b * Math.sin(((tx + 1) / 2) * Math.PI * 2) * 0.25;
          break;
        case "wave":
          sy = ty - b * Math.sin(((tx + 1) / 2) * Math.PI * 6) * 0.2;
          break;
        case "rise":
          sx = tx + b * ((ty + 1) / 2) * 0.35;
          break;
        case "fish":
          sx = tx + b * (1 - ty * ty) * 0.35;
          break;
        case "bulge": {
          const r = Math.hypot(tx, ty);
          if (r < 1) {
            const k = 1 + b * (1 - r * r) * 0.5;
            sx = tx * k;
            sy = ty * k;
          }
          break;
        }
      }
      const xi = Math.round(((sx + 1) / 2) * (w - 1));
      const yi = Math.round(((sy + 1) / 2) * (h - 1));
      const so = (Math.min(h - 1, Math.max(0, yi)) * w + Math.min(w - 1, Math.max(0, xi))) * 4;
      const o = (y * w + x) * 4;
      out[o] = data[so];
      out[o + 1] = data[so + 1];
      out[o + 2] = data[so + 2];
      out[o + 3] = data[so + 3];
    }
  }
  ctx.putImageData(new ImageData(out, w, h), 0, 0);
  return src;
}

/**
 * 栅格化到一张「与文档等大」的透明画布上。
 *
 * 尺寸与图层一致，之后无论是并进当前图层还是新建图层，逻辑都只剩一句
 * drawImage。mask 非空时按选区抠一刀（羽化也被 destination-in 正确保留）。
 */
export function rasterizeText(
  width: number,
  height: number,
  content: string,
  s: TextSettings,
  x: number,
  y: number,
  color: string,
  mask?: HTMLCanvasElement | null,
): HTMLCanvasElement {
  const surface = createSurface(width, height);
  if (content.trim().length > 0) {
    const useWarp = s.warp !== "none" && s.warpAmount !== 0;
    if (useWarp) {
      // 变形：先把文字画进「文字块」画布（留足上下弯曲的余量），弯完再贴回去。
      // 对齐语义与 paintText 一致 —— x 是按对齐方式的锚点，先换算成块左缘。
      const m = measureTextBlock(content, s);
      const pad = Math.ceil(s.size * 0.8 + (Math.abs(s.warpAmount) / 100) * s.size);
      const bw = Math.ceil(m.width + pad * 2);
      const bh = Math.ceil(m.height + pad * 2);
      const block = createSurface(bw, bh);
      paintText(mustCtx(block), content, { ...s, align: "left" }, pad, pad, color);
      warpCanvas(block, s.warp, s.warpAmount);
      const anchorLeft =
        s.align === "center" ? x - m.width / 2 : s.align === "right" ? x - m.width : x;
      mustCtx(surface).drawImage(block, Math.round(anchorLeft - pad), Math.round(y - pad));
    } else {
      paintText(mustCtx(surface), content, s, x, y, color);
    }
  }
  if (mask) {
    const ctx = mustCtx(surface);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(mask, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  }
  return surface;
}
