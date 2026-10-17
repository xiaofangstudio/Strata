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

export interface TextSettings {
  /** 字号（像素） */
  size: number;
  family: TextFamilyId;
  bold: boolean;
  italic: boolean;
  /** 行距倍数（相对字号） */
  lineHeight: number;
  align: TextAlign;
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
  ctx.fillStyle = color;
  ctx.textBaseline = "top";
  ctx.textAlign = s.align;
  for (let i = 0; i < m.lines.length; i += 1) {
    ctx.fillText(m.lines[i], x, y + i * m.lineHeight);
  }
  ctx.restore();
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
    paintText(mustCtx(surface), content, s, x, y, color);
  }
  if (mask) {
    const ctx = mustCtx(surface);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(mask, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  }
  return surface;
}
