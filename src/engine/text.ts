/**
 * 文字引擎（M3）。
 *
 * 与画笔 / 形状一条心：文字最终也只是「一层像素」——先在一张离屏画布上
 * 用 Canvas2D 的 fillText 栅格化，再整层交给合成器，于是混合模式、图层样式、
 * 蒙版、剪贴蒙版、撤销栈全部自动生效，不必为文字另开一条渲染通路。
 *
 * M4 起补上了**可反复编辑的文本层**：文本状态存在图层上（StrataLayer.text），
 * surface 只是它的渲染缓存，改字号/字距/对齐/抗锯齿/OpenType 都会重新栅格化。
 * 这一层仍然只负责「文本状态 → 像素」，与图层/历史/合成解耦。
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

/* ------------------------------------------------ 可编辑文本层的状态 */

/** 抗锯齿方式（PS 的 7 种；Canvas 没有对应开关，用 alpha 后处理模拟）。 */
export type TextAntiAlias =
  | "none"
  | "sharp"
  | "crisp"
  | "strong"
  | "smooth"
  | "windowsLcd"
  | "windows";

/** 排版方向：横排 / 竖排（中文竖排是真实需求）。 */
export type TextOrientation = "horizontal" | "vertical";

/** OpenType 特性开关（渲染时做字符替换，见 substituteOpenType）。 */
export type OpenTypeFeature =
  | "liga"
  | "calt"
  | "dlig"
  | "swsh"
  | "onum"
  | "salt"
  | "titl"
  | "ornm"
  | "ordn"
  | "frac";

/** 语言选项（影响避头尾与连字策略的开关，记录在文本层上）。 */
export type TextLanguage = "default" | "eastAsian" | "middleEastern" | "mes";

/** 一个可编辑文本层的全部状态。 */
export interface TextLayerState {
  content: string;
  settings: TextSettings;
  color: string;
  /** 点文字的锚点 / 段落文本的左上角（文档坐标） */
  x: number;
  y: number;
  /** 有值即段落文本：超出宽度自动折行 */
  boxWidth?: number;
  orientation: TextOrientation;
  antiAlias: TextAntiAlias;
  openType: Partial<Record<OpenTypeFeature, boolean>>;
  language: TextLanguage;
}

/** 默认的文本层状态（字号等在 UI 层按偏好覆盖）。 */
export function defaultTextState(x: number, y: number): TextLayerState {
  return {
    content: "",
    settings: { ...DEFAULT_TEXT },
    color: "#000000",
    x,
    y,
    orientation: "horizontal",
    antiAlias: "smooth",
    openType: {},
    language: "default",
  };
}

/**
 * OpenType 特性的字符级替换。
 *
 * Canvas2D 不下发 font-feature-settings，所以这里用 Unicode 里有对应码位的
 * 特性做真实替换：连字（fi/fl…）、可选连字（st/ct）、分数（1/2 → ½）、
 * 序数（1st → 1ˢᵗ）。字体本身没有这几个码位时会画成方块 —— 这是字体的责任，
 * 与「开关无效」不是一回事。
 */
export function substituteOpenType(
  content: string,
  on: Partial<Record<OpenTypeFeature, boolean>>,
): string {
  let out = content;
  if (on.liga || on.calt) {
    out = out
      .replace(/ffi/g, "ﬃ")
      .replace(/ffl/g, "ﬄ")
      .replace(/fi/g, "ﬁ")
      .replace(/fl/g, "ﬂ")
      .replace(/ff/g, "ﬀ");
  }
  if (on.dlig) {
    out = out.replace(/\bst\b/g, "ﬆ").replace(/\bct\b/g, "ﬅ");
  }
  if (on.frac) {
    const frac: Record<string, string> = {
      "1/2": "½", "1/3": "⅓", "2/3": "⅔", "1/4": "¼", "3/4": "¾",
      "1/5": "⅕", "2/5": "⅖", "3/5": "⅗", "4/5": "⅘",
      "1/6": "⅙", "5/6": "⅚", "1/8": "⅛", "3/8": "⅜", "5/8": "⅝", "7/8": "⅞",
    };
    for (const [k, v] of Object.entries(frac)) out = out.split(k).join(v);
  }
  if (on.ordn) {
    // 数字与后缀字母都要有上标码位，否则 "1st" 里的 st 会原样留下
    const sup: Record<string, string> = {
      "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
      "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
      s: "ˢ", t: "ᵗ", n: "ⁿ", d: "ᵈ", r: "ʳ", h: "ʰ",
    };
    out = out.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_m, d: string, suf: string) =>
      d + suf.split("").map((c) => sup[c.toLowerCase()] ?? c).join(""),
    );
  }
  return out;
}

/** 段落文本：按 boxWidth 折行（中英混排按字符断，够用且不依赖分词）。 */
export function layoutLines(state: TextLayerState): string[] {
  const raw = textLines(state.content);
  if (!state.boxWidth || state.boxWidth <= 0) return raw;
  const ctx = meterCtx();
  ctx.font = fontString(state.settings);
  applyLetterSpacing(ctx, state.settings.letterSpacing);
  const limit = state.boxWidth;
  const out: string[] = [];
  for (const line of raw) {
    if (ctx.measureText(line).width <= limit) {
      out.push(line);
      continue;
    }
    // 断行策略跟「语言选项」走：
    // - 东亚：按字符断（中文没有词间空格，必须这样）
    // - 其它：只在空格处断，整词移到下一行（英文硬按字符断会把单词劈开）
    const eastAsian = state.language === "eastAsian";
    const tokens = eastAsian ? Array.from(line) : line.split(/(?<=\s)/);
    let cur = "";
    for (const tok of tokens) {
      const next = cur + tok;
      if (cur && ctx.measureText(next).width > limit) {
        out.push(cur.replace(/\s+$/, ""));
        cur = tok;
      } else {
        cur = next;
      }
      // 东亚模式下单个字符仍可能超宽，兜底也要断
      if (eastAsian && ctx.measureText(cur).width > limit) {
        out.push(cur);
        cur = "";
      }
    }
    out.push(cur.replace(/\s+$/, ""));
  }
  return out;
}

/** 抗锯齿：对画布 alpha 做后处理（Canvas 没有 AA 开关，这是唯一可行路径）。 */
export function applyAntiAlias(surface: HTMLCanvasElement, mode: TextAntiAlias): void {
  if (mode === "smooth") return;
  const ctx = mustCtx(surface);
  const img = ctx.getImageData(0, 0, surface.width, surface.height);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) {
    const a = d[i] / 255;
    let v: number;
    switch (mode) {
      case "none":
        // 硬边：只有全不透明与全透明
        v = a >= 0.5 ? 1 : 0;
        break;
      case "crisp":
        v = Math.min(1, a * 1.35);
        break;
      case "strong":
        v = Math.pow(a, 0.72);
        break;
      case "sharp": {
        // 先把半透明压掉一半再加权，边缘更「薄」更锐
        const s2 = a < 0.5 ? a * 0.45 : 1 - (1 - a) * 0.55;
        v = Math.min(1, s2 * 1.15);
        break;
      }
      case "windows":
        // 平台灰度 AA：gamma 提亮 + 轻微对比
        v = Math.min(1, Math.pow(a, 1.15) * 1.06);
        break;
      case "windowsLcd": {
        // 次像素 AA：边缘带一点冷色边（LCD 条纹的可见特征）
        v = Math.min(1, a * 1.2);
        if (a > 0.05 && a < 0.95) {
          const i0 = i - 3;
          d[i0] = Math.min(255, d[i0] * 0.92);
          d[i0 + 2] = Math.min(255, d[i0 + 2] * 1.08);
        }
        break;
      }
      default:
        v = a;
    }
    d[i] = v * 255;
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * 文本状态 → 一张与文档等大的画布。
 *
 * 与旧版 rasterizeText 的差别：支持竖排、段落折行、抗锯齿模式、OpenType 替换。
 * 弯曲仍然复用 warpCanvas（先画进文字块画布，弯完贴回）。
 */
export function rasterizeTextState(
  width: number,
  height: number,
  state: TextLayerState,
  mask?: HTMLCanvasElement | null,
): HTMLCanvasElement {
  const surface = createSurface(width, height);
  const s = state.settings;
  const content = substituteOpenType(state.content, state.openType);
  if (content.trim().length === 0) return surface;
  const ctx = mustCtx(surface);

  if (state.orientation === "vertical") {
    // 竖排：每行变成一列，字符自上而下堆叠，列从右往左推进
    const lines = layoutLines({ ...state, content });
    const step = Math.max(1, Math.round(s.size * s.lineHeight));
    ctx.font = fontString(s);
    ctx.fillStyle = state.color;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    let colX = state.x;
    for (const line of lines) {
      let cy = state.y;
      for (const ch of Array.from(line)) {
        ctx.fillText(ch, colX, cy);
        cy += step;
      }
      colX -= step;
    }
  } else if (s.warp !== "none" && s.warpAmount !== 0) {
    const wrapped = layoutLines({ ...state, content });
    const flat: TextSettings = { ...s, align: "left" };
    const m = measureTextBlock(wrapped.join("\n"), flat);
    const pad = Math.ceil(s.size * 0.8 + (Math.abs(s.warpAmount) / 100) * s.size);
    const bw = Math.ceil(m.width + pad * 2);
    const bh = Math.ceil(m.height + pad * 2);
    const block = createSurface(bw, bh);
    const bctx = mustCtx(block);
    bctx.font = fontString(flat);
    applyLetterSpacing(bctx, flat.letterSpacing);
    bctx.fillStyle = state.color;
    bctx.textBaseline = "top";
    bctx.textAlign = "left";
    for (let i = 0; i < wrapped.length; i += 1) {
      bctx.fillText(wrapped[i], pad, pad + i * m.lineHeight);
    }
    warpCanvas(block, s.warp, s.warpAmount);
    const anchorLeft =
      s.align === "center" ? state.x - m.width / 2 : s.align === "right" ? state.x - m.width : state.x;
    ctx.drawImage(block, Math.round(anchorLeft - pad), Math.round(state.y - pad));
  } else {
    const lines = layoutLines({ ...state, content });
    ctx.font = fontString(s);
    applyLetterSpacing(ctx, s.letterSpacing);
    ctx.fillStyle = state.color;
    ctx.textBaseline = "top";
    ctx.textAlign = s.align;
    const lineHeight = Math.max(1, Math.round(s.size * s.lineHeight));
    for (let i = 0; i < lines.length; i += 1) {
      ctx.fillText(lines[i], state.x, state.y + i * lineHeight);
    }
  }

  applyAntiAlias(surface, state.antiAlias);

  if (mask) {
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(mask, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  }
  return surface;
}

/** 文本块的外接尺寸（用于面板显示、工作路径、选区）。 */
export function textStateBounds(state: TextLayerState): { width: number; height: number } {
  if (state.orientation === "vertical") {
    const lines = layoutLines(state);
    const step = Math.max(1, Math.round(state.settings.size * state.settings.lineHeight));
    const maxChars = Math.max(1, ...lines.map((l) => Array.from(l).length));
    return { width: step * Math.max(1, lines.length), height: step * maxChars };
  }
  const m = measureTextBlock(layoutLines(state).join("\n"), state.settings);
  return { width: Math.ceil(m.width), height: Math.ceil(m.height) };
}
