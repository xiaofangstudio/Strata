/**
 * PSD 读写（ag-psd 桥接层）。
 *
 * 六项差距全修 · 第 1 项：写侧从「只写像素层」补齐到组 / 文字 / 调整层 /
 * 蒙版全写回，读侧同步重建同样的结构，保证「导出 → 读回」分层不丢。
 *
 * 字段语义（组：名称/混合/不透明度/可见性/展开状态；文字：transform + style；
 * 蒙版：灰度通道）参考 ArtCraft PhotoCraft 的 `crates/psd`（MIT / Apache-2.0）
 * 的 GroupSpec 与图层资源定义；实现为 TypeScript 重写，不是代码拷贝。
 * 依赖 ag-psd（MIT），仅在此文件 import，保持按需加载。
 *
 * 有损边界（务必如实告知用户）：
 *  · Strata 的调整层是「参数 + 延迟滤镜」，PSD 只认固定的调整资源；
 *    能映射的写 adjustment 资源（读侧由 psdAdjustmentFrom 反向重建参数），
 *    10 类无等价物写成占位层：优先保留烤平像素 + 蒙版，拿不到才透明占位，
 *    每条「层名 + 降级原因」都并入 warnings（UI 会弹给用户，不静默吞掉）。
 *    效果不会出现在 PSD 里（需要视觉一致时请先在 Strata 里栅格化）。
 *  · 组展开状态（PSD opened）在 Strata 文档模型里没有原生字段，桥接层用
 *    透明扩展字段 opened 承载，保证往返不丢；UI 是否消费由主线程决定。
 *  · 文字变形（warpAmount）没有 PSD 等价物，写回时保留文字与像素缓存，变形效果
 *    固化在缓存里，重新读回后是不可编辑变形的普通文字层。
 */
import {
  readPsd,
  writePsd,
  type Layer as PsdLayer,
  type LinkedFile,
  type PlacedLayer,
  type Psd,
  type LayerTextData,
  type TextStyle,
} from "ag-psd";
import {
  createAdjustLayer,
  createGroupLayer,
  createLayer,
  newAdjustState,
  type AdjustState,
  type BlendId,
  type StrataLayer,
} from "../core/layer";
import { baseName, nextDocId, type StrataDoc } from "../core/document";
import { DEFAULT_TEXT, TEXT_FAMILIES, type TextLayerState } from "../engine/text";
import { createSurface, mustCtx } from "./surface";

export const PSD_EXTENSION = "psd";

export function isPsdPath(path: string): boolean {
  return path.toLowerCase().endsWith(`.${PSD_EXTENSION}`);
}

/* ---------------------------------------------------------------- 混合模式 */

/** ag-psd 的混合模式串（空格分隔）→ Strata 的 kebab-case BlendId。 */
const PSD_BLEND: Record<string, BlendId> = {
  normal: "normal",
  dissolve: "dissolve",
  darken: "darken",
  multiply: "multiply",
  "color burn": "color-burn",
  "linear burn": "linear-burn",
  "darker color": "darker-color",
  lighten: "lighten",
  screen: "screen",
  "color dodge": "color-dodge",
  "linear dodge": "linear-dodge",
  "lighter color": "lighter-color",
  overlay: "overlay",
  "soft light": "soft-light",
  "hard light": "hard-light",
  "vivid light": "vivid-light",
  "linear light": "linear-light",
  "pin light": "pin-light",
  "hard mix": "hard-mix",
  difference: "difference",
  exclusion: "exclusion",
  subtract: "subtract",
  divide: "divide",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

function blendFromPsd(mode: string | undefined): BlendId {
  return (mode && PSD_BLEND[mode]) || "normal";
}

/** BlendId → ag-psd 混合模式串；soft 模式两边语义一致，直接 kebab 还原。 */
function blendToPsd(id: BlendId): PsdLayer["blendMode"] {
  return id.replace(/-/g, " ") as PsdLayer["blendMode"];
}

/* ------------------------------------------------- 扁平图层栈 ↔ PSD 树（纯逻辑） */

/**
 * Strata 的图层栈是「扁平数组 + parent 指针」，PSD 的 children 是嵌套树。
 * 这里只做结构转换，不碰任何浏览器 API —— 便于在 node 环境下单测。
 *
 * 返回的 children 仍是 Strata 的自下而上顺序；写 PSD 时再逆序。
 */
export interface PsdForestNode {
  layer: StrataLayer;
  children: PsdForestNode[];
}

export function buildPsdForest(layers: readonly StrataLayer[]): PsdForestNode[] {
  const ids = new Set(layers.map((l) => l.id));
  const byParent = new Map<string, StrataLayer[]>();
  for (const l of layers) {
    // 父 id 已经不在文档里（组被删了但指针没清）时按顶层处理，别把层弄丢
    const key = l.parent && ids.has(l.parent) ? l.parent : "";
    const bucket = byParent.get(key);
    if (bucket) bucket.push(l);
    else byParent.set(key, [l]);
  }
  const seen = new Set<string>();
  const visit = (key: string): PsdForestNode[] => {
    const out: PsdForestNode[] = [];
    for (const layer of byParent.get(key) ?? []) {
      if (seen.has(layer.id)) continue; // 环状 parent 的兜底
      seen.add(layer.id);
      out.push({ layer, children: visit(layer.id) });
    }
    return out;
  };
  const roots = visit("");
  // 环或异常 parent 剩下的层一律挂回顶层，绝不静默丢层
  for (const l of layers) {
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    roots.push({ layer: l, children: visit(l.id) });
  }
  return roots;
}

/* ---------------------------------------------------------------- 颜色小工具 */

function hexToColor(hex: string): { r: number; g: number; b: number } {
  const s = hex.replace("#", "");
  const n = Number.parseInt(s.length === 3 ? s.split("").map((c) => c + c).join("") : s, 16);
  if (!Number.isFinite(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function colorToHex(c: unknown): string {
  const part = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  if (!c || typeof c !== "object") return "#000000";
  const o = c as Record<string, unknown>;
  const num = (k: string): number | undefined => (typeof o[k] === "number" ? (o[k] as number) : undefined);
  // ag-psd 的 Color 是个 union：RGB 用 r/g/b（0–255），FRGB 用 fr/fg/fb（0–1）
  const r = num("r");
  if (r !== undefined) return `#${part(r)}${part(num("g") ?? 0)}${part(num("b") ?? 0)}`;
  return `#${part((num("fr") ?? 0) * 255)}${part((num("fg") ?? 0) * 255)}${part((num("fb") ?? 0) * 255)}`;
}

/* ---------------------------------------------------- 色相 / 颜色互转 */

/**
 * 标准 HSL（固定 s=0.55、l=0.5）把 0–360 色相换算成 ag-psd 的 RGB Color
 * （r/g/b 各 0–255），供 photo filter 的 color 字段使用。与 colorToHue 互逆，
 * 保证 Strata 的 hue 参数能往返（仅受 0–255 取整影响，误差 ≤ 1°）。
 */
function hueToColor(hueDeg: number): { r: number; g: number; b: number } {
  const h = (((hueDeg % 360) + 360) % 360) / 360;
  const s = 0.55;
  const l = 0.5;
  const q = l + s - l * s;
  const p = 2 * l - q;
  const comp = (t: number): number => {
    let k = (t * 6) % 6;
    if (k < 0) k += 6;
    const v = k < 1 ? p + (q - p) * k : k < 3 ? q : k < 4 ? p + (q - p) * (4 - k) : p;
    return Math.round(Math.max(0, Math.min(1, v)) * 255);
  };
  // 标准 HSL：R = comp(h + 1/3)、G = comp(h)、B = comp(h − 1/3)
  return { r: comp(h + 1 / 3), g: comp(h), b: comp(h - 1 / 3) };
}

/** hueToColor 的逆：从 ag-psd 的 Color 反算 0–360 色相。 */
function colorToHue(c: unknown): number {
  const { r, g, b } = hexToColor(colorToHex(c));
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d < 1e-6) return 0;
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/* ---------------------------------------------------- 降级警告 / 组展开 */

/** 一条 warnings 的文案：层名 + 括号里的降级原因，供 UI 直接 join 展示。 */
function warnLine(name: string, reason: string): string {
  return `${name}（${reason}）`;
}

/**
 * Strata 的文档模型（core/layer.ts 的 StrataLayer）目前没有组展开字段，
 * UI 的折叠状态存在 LayersPanel 的局部 state 里。桥接层用一个透明扩展字段
 * 承载 PSD 的 opened，保证「导出 → 读回」不丢展开状态；UI 是否消费由主线程决定。
 */
type LayerWithOpened = StrataLayer & { opened?: boolean };

/** 缺省视为展开（opened !== false）。 */
function openedOf(l: StrataLayer): boolean {
  return (l as LayerWithOpened).opened !== false;
}

/* ---------------------------------------------------------------- 蒙版 */

/**
 * PSD 的蒙版是单通道灰度图，Strata 的蒙版只用 alpha。
 * 这里同时把灰度写进 RGB 与 A：无论 ag-psd 取红通道还是 alpha 通道都对。
 */
function maskToPsd(layer: StrataLayer, w: number, h: number): PsdLayer["mask"] | undefined {
  if (!layer.mask) return undefined;
  const src = layer.mask;
  const out = createSurface(w, h);
  const octx = mustCtx(out);
  octx.drawImage(src, 0, 0, src.width, src.height, 0, 0, w, h);
  const img = octx.getImageData(0, 0, w, h);
  const px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const v = px[i + 3];
    px[i] = v;
    px[i + 1] = v;
    px[i + 2] = v;
    px[i + 3] = v;
  }
  octx.putImageData(img, 0, 0);
  return {
    left: 0,
    top: 0,
    right: w,
    bottom: h,
    defaultColor: 0,
    disabled: !layer.maskActive,
    canvas: out,
  };
}

/** PSD 灰度蒙版 → Strata alpha-only 蒙版。 */
function maskFromPsd(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  const out = createSurface(w, h);
  const ctx = mustCtx(out);
  ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    // 读侧兼容两种来源：不透明灰度图取 R，带 alpha 的图取 A
    const v = px[i + 3] === 255 ? px[i] : px[i + 3];
    px[i] = 0;
    px[i + 1] = 0;
    px[i + 2] = 0;
    px[i + 3] = v;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/* ---------------------------------------------------------------- 文字层 */

function fontNameOf(family: string | undefined): string {
  const stack = TEXT_FAMILIES.find((f) => f.id === (family ?? "sans"))?.stack ?? TEXT_FAMILIES[0].stack;
  // CSS font stack 的第一项就是真实字体名，PSD 只要一个 PostScript 名
  const first = stack.split(",")[0].trim().replace(/^["']|["']$/g, "");
  return first || "Microsoft YaHei";
}

function textToPsd(state: TextLayerState): LayerTextData {
  const s = state.settings;
  const style: TextStyle = {
    font: { name: fontNameOf(s.family) } as TextStyle["font"],
    fontSize: s.size,
    fauxBold: s.bold,
    fauxItalic: s.italic,
    leading: s.size * s.lineHeight,
    tracking: s.letterSpacing,
    fillColor: hexToColor(state.color) as TextStyle["fillColor"],
  };
  const transform = [1, 0, 0, 1, state.x, state.y];
  return {
    text: state.content,
    transform,
    antiAlias: "smooth",
    orientation: state.orientation === "vertical" ? "vertical" : "horizontal",
    shapeType: state.boxWidth ? "box" : "point",
    boxBounds: state.boxWidth ? [0, 0, state.boxWidth, s.size * 2] : undefined,
    style,
    paragraphStyle: {
      justification: s.align === "center" ? "center" : s.align === "right" ? "right" : "left",
    } as LayerTextData["paragraphStyle"],
  } as LayerTextData;
}

function textFromPsd(node: LayerTextData): TextLayerState {
  const st = node.style ?? {};
  const p = node.paragraphStyle as { justification?: string } | undefined;
  const t = node.transform ?? [1, 0, 0, 1, 0, 0];
  const size = typeof st.fontSize === "number" && st.fontSize > 0 ? st.fontSize : DEFAULT_TEXT.size;
  return {
    content: node.text ?? "",
    settings: {
      ...DEFAULT_TEXT,
      size,
      bold: st.fauxBold === true,
      italic: st.fauxItalic === true,
      lineHeight: st.leading ? Math.max(0.5, st.leading / size) : DEFAULT_TEXT.lineHeight,
      letterSpacing: typeof st.tracking === "number" ? st.tracking : 0,
      align: p?.justification === "center" ? "center" : p?.justification === "right" ? "right" : "left",
    },
    color: colorToHex(st.fillColor),
    x: t[4] ?? 0,
    y: t[5] ?? 0,
    boxWidth: node.shapeType === "box" ? (node.boxBounds?.[2] as number) || undefined : undefined,
    orientation: node.orientation === "vertical" ? "vertical" : "horizontal",
    antiAlias: "smooth",
    openType: {},
    language: "default",
  };
}

/* ---------------------------------------------------------------- 调整层 */

/**
 * Strata 调整参数 → PSD 调整资源。返回 null 表示没有等价物。
 * 纯函数，单测可直接喂 newAdjustState 的结果。
 *
 * 字段按 ag-psd 的 AdjustmentLayer 类型能力尽量补全（见各 case 注释）：
 * 参数名以 core/layer.ts 的 ADJUST_DEFS 为准，单位以 ag-psd 序列化源码为准
 * （photo filter 的 density 是 0–1、levels 的 midtoneInput 是 0–10 等）。
 */
export function psdAdjustmentOf(state: AdjustState): PsdLayer["adjustment"] | null {
  const p = state.params ?? {};
  const n = (k: string, d = 0): number => (Number.isFinite(p[k]) ? p[k] : d);
  const curvePts = (
    pts: { x: number; y: number }[] | undefined,
  ): { input: number; output: number }[] =>
    (pts ?? [{ x: 0, y: 0 }, { x: 1, y: 1 }]).map((c) => ({
      input: Math.round(Math.max(0, Math.min(1, c.x)) * 255),
      output: Math.round(Math.max(0, Math.min(1, c.y)) * 255),
    }));
  const neutralCurve = (pts: { x: number; y: number }[] | undefined): boolean =>
    !pts || pts.length < 2 || pts.every((c) => Math.abs(c.x - c.y) < 1e-4);
  const toStop = (s: { at: number; color: string }) => ({
    location: Math.max(0, Math.min(1, s.at)),
    midpoint: 0.5,
    color: hexToColor(s.color),
  });
  switch (state.id) {
    case "bc":
      return { type: "brightness/contrast", brightness: n("brightness"), contrast: n("contrast") };
    case "levels":
      // ag-psd 的 channels[] 支持复合 + 分通道，但 Strata 的 levels 状态只有
      // 一组复合参数（分通道色阶放在 channellevels，属于无等价物清单），
      // 因此这里确实只能写一条复合通道 —— 补不了分通道，如实注明。
      return {
        type: "levels",
        channels: [
          {
            shadowInput: n("inBlack"),
            highlightInput: n("inWhite", 255),
            shadowOutput: n("outBlack"),
            highlightOutput: n("outWhite", 255),
            midtoneInput: n("gamma", 100) / 100,
          },
        ],
      };
    case "curves": {
      // channels[0] = 复合 RGB；channels[1..3] = 红 / 绿 / 蓝分通道曲线。
      // 非恒等的分通道才写点，其余留空数组（PSD 用通道位掩码跳过）。
      const channels: { input: number; output: number }[][] = [curvePts(state.curve)];
      for (const c of [state.curveR, state.curveG, state.curveB]) {
        channels.push(neutralCurve(c) ? [] : curvePts(c));
      }
      while (channels.length > 1 && channels[channels.length - 1].length === 0) channels.pop();
      return { type: "curves", channels };
    }
    case "exposure":
      return {
        type: "exposure",
        exposure: n("exposure"),
        offset: n("offset"),
        gamma: n("gamma", 1),
      };
    case "vibrance":
      return {
        type: "vibrance",
        vibrance: n("vibrance"),
        saturation: n("saturation"),
      };
    case "hs":
      // 简版只有 hue / saturate，没有 lightness 与分色相参数。
      return {
        type: "hue/saturation",
        master: { hue: n("hue"), saturation: n("saturate"), lightness: 0 },
      } as PsdLayer["adjustment"];
    case "huesat": {
      // 补齐 6 个分色相通道。a/b/c/d 是 PSD 的色相分段边界，Strata 没有
      // 对应参数，用 0 占位（不影响 Strata 侧 hue/sat/light 的往返）。
      const ch = (hue: string, sat: string, light: string) => ({
        a: 0,
        b: 0,
        c: 0,
        d: 0,
        hue: n(hue),
        saturation: n(sat),
        lightness: n(light),
      });
      return {
        type: "hue/saturation",
        colorize: n("colorize") > 0,
        master: { hue: n("hue"), saturation: n("saturate"), lightness: n("lightness") },
        reds: ch("redHue", "redSat", "redLight"),
        yellows: ch("yellowHue", "yellowSat", "yellowLight"),
        greens: ch("greenHue", "greenSat", "greenLight"),
        cyans: ch("cyanHue", "cyanSat", "cyanLight"),
        blues: ch("blueHue", "blueSat", "blueLight"),
        magentas: ch("magentaHue", "magentaSat", "magentaLight"),
      } as PsdLayer["adjustment"];
    }
    case "colorbalance":
      // 旧版只写 shadows 且参数名（cyanRed…）在 Strata 里不存在，恒为 0。
      // 补齐阴影 / 中间调 / 高光三组；Strata 没有「保留明度」开关，按 false 写。
      return {
        type: "color balance",
        shadows: { cyanRed: n("shcr"), magentaGreen: n("shmg"), yellowBlue: n("shyb") },
        midtones: { cyanRed: n("mdcr"), magentaGreen: n("mdmg"), yellowBlue: n("mdyb") },
        highlights: { cyanRed: n("hicr"), magentaGreen: n("himg"), yellowBlue: n("hiyb") },
        preserveLuminosity: false,
      } as PsdLayer["adjustment"];
    case "bw":
      // 简单灰度只有 amount 强度，而 PSD 的 black & white 资源既没有强度字段
      // 也没有六色权重可写 —— 只能保留类型，amount 无法往返（如实注明）。
      return { type: "black & white" } as PsdLayer["adjustment"];
    case "blackwhite":
      return {
        type: "black & white",
        reds: n("red"),
        yellows: n("yellow"),
        greens: n("green"),
        cyans: n("cyan"),
        blues: n("blue"),
        magentas: n("magenta"),
      } as PsdLayer["adjustment"];
    case "photofilter":
      // 旧版 density 用了不存在的参数名，且单位错（ag-psd 是 0–1）。
      return {
        type: "photo filter",
        color: hueToColor(n("hue", 40)),
        density: n("strength") / 100,
        preserveLuminosity: n("preserve") > 0,
      } as PsdLayer["adjustment"];
    case "channelmixer": {
      // 旧版只写 monochrome（且参数名不存在）。补齐 red / green / blue 三条
      // 输出通道的系数；Strata 无「单色」开关，gray 通道补零占位。
      const chan = (r: string, g: string, b: string, c: string) => ({
        red: n(r),
        green: n(g),
        blue: n(b),
        constant: n(c),
      });
      return {
        type: "channel mixer",
        monochrome: false,
        red: chan("rr", "rg", "rb", "rc"),
        green: chan("gr", "gg", "gb", "gc"),
        blue: chan("br", "bg", "bb", "bc"),
        gray: { red: 0, green: 0, blue: 0, constant: 0 },
      } as PsdLayer["adjustment"];
    }
    case "gradientmap":
      // gradientType 是 ag-psd 的必需字段，旧版漏了它（writePsd 会抛错，
      // 落到 catch 的降级路径）。补齐色标，色标位置 0–1、颜色转 RGB。
      return {
        type: "gradient map",
        gradientType: "solid",
        name: "gradient map",
        colorStops: (state.stops ?? [
          { at: 0, color: "#000000" },
          { at: 1, color: "#ffffff" },
        ]).map(toStop),
      } as PsdLayer["adjustment"];
    case "invert":
      return { type: "invert" };
    case "posterize":
      return { type: "posterize", levels: Math.max(2, Math.round(n("levels", 4))) };
    case "threshold":
      return { type: "threshold", level: Math.max(1, Math.round(n("level", 128))) };
    default:
      // channellevels / shadowhighlight / colortemp / equalize / hdtoning /
      // matchcolor / replacecolor / cameraraw / selectivecolor / colorlookup
      return null;
  }
}

/** Strata 里没有 PSD 等价物的调整层：导出时列出名字提醒用户。 */
export const PSD_UNMAPPABLE_ADJUSTMENTS: readonly string[] = [
  "channellevels",
  "shadowhighlight",
  "colortemp",
  "equalize",
  "hdtoning",
  "matchcolor",
  "replacecolor",
  "cameraraw",
  "selectivecolor",
  "colorlookup",
];

/**
 * ag-psd 调整资源 → Strata 调整参数（psdAdjustmentOf 的逆映射）。
 *
 * 覆盖写侧 psdAdjustmentOf 会产出的全部调整资源，保证「导出 → 读回」参数不丢。
 * ag-psd 能读但 Strata 写不出的资源（selective color / color lookup / 未知类型）
 * 返回 null，readNode 会退化成普通像素层，绝不丢层。
 *
 * 有损点（都与写侧字段一一对应，如实注明）：
 *  · bw 的 amount 强度、blackwhite↔bw 的区分靠「是否带六色权重」；
 *  · photo filter 的 hue 经 RGB 中转有 ≤1° 舍入误差，preserve 只有 0/100 两档；
 *  · color balance 的 preserveLuminosity 在 Strata 无对应参数，恒不还原；
 *  · hue/saturation 的分色相分段边界 a/b/c/d 是 PSD 专有，Strata 无对应参数。
 */
export function psdAdjustmentFrom(
  adj: NonNullable<PsdLayer["adjustment"]>,
): AdjustState | null {
  const num = (v: unknown, d = 0): number =>
    typeof v === "number" && Number.isFinite(v) ? v : d;
  const pts = (
    ch: { input: number; output: number }[] | undefined,
  ): { x: number; y: number }[] | undefined =>
    ch && ch.length >= 2
      ? ch.map((p) => ({ x: p.input / 255, y: p.output / 255 }))
      : undefined;
  switch (adj.type) {
    case "brightness/contrast": {
      const s = newAdjustState("bc");
      s.params.brightness = num(adj.brightness);
      s.params.contrast = num(adj.contrast);
      return s;
    }
    case "levels": {
      const s = newAdjustState("levels");
      const c = adj.channels?.[0];
      if (c) {
        s.params.inBlack = num(c.shadowInput);
        s.params.inWhite = num(c.highlightInput, 255);
        s.params.outBlack = num(c.shadowOutput);
        s.params.outWhite = num(c.highlightOutput, 255);
        s.params.gamma = Math.round(num(c.midtoneInput, 1) * 100);
      }
      return s;
    }
    case "curves": {
      const s = newAdjustState("curves");
      const ch = adj.channels ?? [];
      const comp = pts(ch[0]);
      if (comp) s.curve = comp;
      const r = pts(ch[1]);
      const g = pts(ch[2]);
      const b = pts(ch[3]);
      if (r) s.curveR = r;
      if (g) s.curveG = g;
      if (b) s.curveB = b;
      return s;
    }
    case "exposure": {
      const s = newAdjustState("exposure");
      s.params.exposure = num(adj.exposure);
      s.params.offset = num(adj.offset);
      s.params.gamma = num(adj.gamma, 1);
      return s;
    }
    case "vibrance": {
      const s = newAdjustState("vibrance");
      s.params.vibrance = num(adj.vibrance);
      s.params.saturation = num(adj.saturation);
      return s;
    }
    case "hue/saturation": {
      // 是否带 6 个分色相通道用来区分 huesat（全功能）与 hs（简版）。
      const full = Boolean(
        adj.reds || adj.yellows || adj.greens || adj.cyans || adj.blues || adj.magentas,
      );
      const s = newAdjustState(full ? "huesat" : "hs");
      s.params.hue = num(adj.master?.hue);
      s.params.saturate = num(adj.master?.saturation);
      if (full) {
        s.params.lightness = num(adj.master?.lightness);
        s.params.colorize = adj.colorize ? 1 : 0;
        const writeCh = (
          c: { hue?: number; saturation?: number; lightness?: number } | undefined,
          prefix: string,
        ): void => {
          if (!c) return;
          s.params[`${prefix}Hue`] = num(c.hue);
          s.params[`${prefix}Sat`] = num(c.saturation);
          s.params[`${prefix}Light`] = num(c.lightness);
        };
        writeCh(adj.reds, "red");
        writeCh(adj.yellows, "yellow");
        writeCh(adj.greens, "green");
        writeCh(adj.cyans, "cyan");
        writeCh(adj.blues, "blue");
        writeCh(adj.magentas, "magenta");
      }
      return s;
    }
    case "color balance": {
      const s = newAdjustState("colorbalance");
      const sh = adj.shadows;
      const md = adj.midtones;
      const hi = adj.highlights;
      if (sh) {
        s.params.shcr = num(sh.cyanRed);
        s.params.shmg = num(sh.magentaGreen);
        s.params.shyb = num(sh.yellowBlue);
      }
      if (md) {
        s.params.mdcr = num(md.cyanRed);
        s.params.mdmg = num(md.magentaGreen);
        s.params.mdyb = num(md.yellowBlue);
      }
      if (hi) {
        s.params.hicr = num(hi.cyanRed);
        s.params.himg = num(hi.magentaGreen);
        s.params.hiyb = num(hi.yellowBlue);
      }
      return s;
    }
    case "black & white": {
      const full =
        adj.reds !== undefined ||
        adj.yellows !== undefined ||
        adj.greens !== undefined ||
        adj.cyans !== undefined ||
        adj.blues !== undefined ||
        adj.magentas !== undefined;
      const s = newAdjustState(full ? "blackwhite" : "bw");
      if (full) {
        s.params.red = num(adj.reds);
        s.params.yellow = num(adj.yellows);
        s.params.green = num(adj.greens);
        s.params.cyan = num(adj.cyans);
        s.params.blue = num(adj.blues);
        s.params.magenta = num(adj.magentas);
      }
      return s;
    }
    case "photo filter": {
      const s = newAdjustState("photofilter");
      s.params.strength = Math.round(num(adj.density) * 100);
      s.params.preserve = adj.preserveLuminosity ? 100 : 0;
      s.params.hue = Math.round(colorToHue(adj.color));
      return s;
    }
    case "channel mixer": {
      const s = newAdjustState("channelmixer");
      const fill = (
        c: { red?: number; green?: number; blue?: number; constant?: number } | undefined,
        keys: [string, string, string, string],
      ): void => {
        if (!c) return;
        s.params[keys[0]] = num(c.red);
        s.params[keys[1]] = num(c.green);
        s.params[keys[2]] = num(c.blue);
        s.params[keys[3]] = num(c.constant);
      };
      fill(adj.red, ["rr", "rg", "rb", "rc"]);
      fill(adj.green, ["gr", "gg", "gb", "gc"]);
      fill(adj.blue, ["br", "bg", "bb", "bc"]);
      return s;
    }
    case "gradient map": {
      const s = newAdjustState("gradientmap");
      if (adj.colorStops?.length) {
        s.stops = adj.colorStops.map((cs) => ({
          at: num(cs.location),
          color: colorToHex(cs.color),
        }));
      }
      return s;
    }
    case "invert":
      return newAdjustState("invert");
    case "posterize": {
      const s = newAdjustState("posterize");
      s.params.levels = num(adj.levels, 6);
      return s;
    }
    case "threshold": {
      const s = newAdjustState("threshold");
      s.params.level = num(adj.level, 128);
      return s;
    }
    default:
      // selective color / color lookup / 其它 ag-psd 资源：Strata 无对应状态
      return null;
  }
}

/* ---------------------------------------------------------------- 读 */

/** 读侧重建单个 PSD 节点。导出供纯数据层往返测试直接调用。 */
export function readNode(
  node: PsdLayer,
  width: number,
  height: number,
  parent: string | null,
  out: StrataLayer[],
  linked?: Map<string, LinkedFile>,
): void {
  const common = (l: StrataLayer): void => {
    l.parent = parent;
    l.opacity = Math.round((node.opacity ?? 1) * 100);
    l.visible = node.hidden !== true;
    l.blend = blendFromPsd(node.blendMode);
    if (node.mask?.canvas) {
      l.mask = maskFromPsd(node.mask.canvas, width, height);
      l.maskActive = node.mask.disabled !== true;
    }
    l.locked = node.transparencyProtected === true;
    l.clip = node.clipping === true;
  };

  const canvas = (node as { canvas?: HTMLCanvasElement }).canvas;
  const drawCanvas = (l: StrataLayer): void => {
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      mustCtx(l.surface).drawImage(canvas, node.left ?? 0, node.top ?? 0);
    }
  };

  if (node.children?.length) {
    const group = createGroupLayer(node.name || "组");
    common(group);
    // 组展开状态：PSD 的 opened 缺省视为展开，写回桥接层的扩展字段。
    (group as LayerWithOpened).opened = node.opened !== false;
    out.push(group);
    // PSD children 自上而下 → Strata 自下而上；子层紧跟组，合成器按 parent 递归
    for (const child of [...node.children].reverse()) {
      readNode(child, width, height, group.id, out);
    }
    return;
  }

  // 调整层：把 ag-psd 的 adjustment 资源反向映射回 Strata 参数。
  // 映射不了的资源（外部 PSD 的 selective color 等）退回普通像素层，绝不丢层。
  const adj = node.adjustment ? psdAdjustmentFrom(node.adjustment) : null;
  if (adj) {
    const layer = createAdjustLayer(node.name || "调整层", adj);
    common(layer);
    drawCanvas(layer);
    out.push(layer);
    return;
  }

  const layer = createLayer(width, height, node.name || "图层");
  drawCanvas(layer);
  common(layer);
  if (node.text) layer.text = textFromPsd(node.text);
  if (node.placedLayer) {
    // 智能对象（SoLd/PlLd）：smart 给 UI 全兼容的像素快照；smartRaw 保留
    // lnk2 原始嵌入字节，写回 PSD 时按 id 关联回写，往返不丢智能对象性。
    layer.smart = layer.surface.toDataURL("image/png");
    const file = linked?.get(node.placedLayer.id);
    const raw = file ? linkedToSmart(file) : null;
    if (raw) layer.smartRaw = raw.smartRaw;
  }
  out.push(layer);
}

/** 解码 PSD → StrataDoc。组、文字、蒙版、可见性、混合模式全部重建。 */
export function decodePsdToDoc(
  bytes: Uint8Array,
  name: string,
  sourcePath?: string,
): StrataDoc {
  const psd = readPsd(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    {
      skipLayerImageData: false,
      skipCompositeImageData: false,
      skipThumbnail: true,
    },
  );
  const width = psd.width;
  const height = psd.height;
  const layers: StrataLayer[] = [];
  // lnk2/lnkD 的原始嵌入字节按 id 建索引，readNode 里与 placedLayer 关联。
  const linked = new Map(
    (psd.linkedFiles ?? []).filter((f) => !!f.id).map((f) => [f.id as string, f]),
  );
  for (const node of [...(psd.children ?? [])].reverse()) {
    readNode(node, width, height, null, layers, linked);
  }
  // 一个图层都没有（整张平铺的 PSD）：退回合成图像
  if (layers.length === 0 && psd.canvas) {
    const only = createLayer(width, height, "背景");
    mustCtx(only.surface).drawImage(psd.canvas, 0, 0);
    layers.push(only);
  }
  if (layers.length === 0) layers.push(createLayer(width, height, "背景"));
  return {
    id: nextDocId(),
    name: baseName(name) || "未命名",
    width,
    height,
    layers,
    activeLayerId: layers[layers.length - 1].id,
    sourcePath,
    dirty: false,
  };
}

/* ------------------------------------------------------ 智能对象（SoLd/lnk2） */

/**
 * 智能对象的 PSD 真往返。
 *
 * 以前 Strata 打开含智能对象的 PSD：层退化成普通像素层，SoLd / PlLd 信息与
 * lnk2 原始嵌入字节全部丢弃，复杂商业稿「开 → 存 → 再开」就丢了智能对象性。
 * ag-psd 把 SoLd 解析到 `layer.placedLayer`、lnk2/lnkD 解析到 `psd.linkedFiles`
 * （data 字段就是嵌入文件的原始字节），读侧按 id 关联，写侧如实回写两个块。
 *
 * Strata 层的字段分工：
 *  · `smart` —— 原始像素快照（PNG data URL），供既有 UI（栅格化判定、编辑原始内容）使用；
 *  · `smartRaw` —— 嵌入文件原始字节（data URL，mime 标明格式），PSD 往返保真靠它。
 */

/** mime → lnk2 的类型码；未知 mime 按 imgx（Photoshop 嵌入子文档）。 */
function linkedTypeOfMime(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpeg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/tiff") return "tif";
  return "imgx";
}

function mimeOfLinkedType(type: string | undefined): string {
  switch (type) {
    case "png":
      return "image/png";
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "tif":
    case "tiff":
      return "image/tiff";
    default:
      return "application/x-photoshop";
  }
}

function u8ToBase64(data: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < data.length; i += CHUNK) {
    bin += String.fromCharCode(...data.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToU8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** ag-psd 写 SoLd 时强制 GUID 格式的 id；.randomUUID 不可用时拼一个合法形状。 */
function newGuid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    const hex = (n: number) =>
      Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
  }
}

/**
 * 层的智能对象数据 → PSD 写出件（placedLayer + linkedFile）。
 * smartRaw 优先（真原始字节）；只有 smart 时把 PNG 快照作为嵌入文件写出，
 * 这样 Strata 自己「转为智能对象」的层存 PSD 后 Photoshop 也认。
 */
export function smartToLinked(
  l: { name?: string; smart?: string; smartRaw?: string },
  w: number,
  h: number,
  guid: string,
): { placedLayer: PlacedLayer; linkedFile: LinkedFile } | null {
  const source = l.smartRaw
    ? { b64: l.smartRaw.split(",")[1] ?? "", mime: l.smartRaw.match(/^data:([^;,]+);/)?.[1] ?? "" }
    : l.smart
      ? { b64: l.smart.split(",")[1] ?? "", mime: "image/png" }
      : null;
  if (!source || !source.b64) return null;
  const type = linkedTypeOfMime(source.mime);
  return {
    placedLayer: {
      id: guid,
      type: "raster",
      transform: [1, 0, 0, 1, 0, 0],
      width: w,
      height: h,
    },
    linkedFile: {
      id: guid,
      name: `${l.name || "智能对象"}.${type === "imgx" ? "psd" : type}`,
      type,
      data: base64ToU8(source.b64),
    },
  };
}

/** PSD 的 linkedFile → 层的 smartRaw（原始字节 data URL）。空数据返回 null。 */
export function linkedToSmart(file: Pick<LinkedFile, "data" | "type">): { smartRaw: string } | null {
  if (!file.data || file.data.length === 0) return null;
  return { smartRaw: `data:${mimeOfLinkedType(file.type)};base64,${u8ToBase64(file.data)}` };
}

/* ---------------------------------------------------------------- 写 */

/** 导出结果：字节 + 有损降级警告（UI 要弹给用户，不静默）。 */
export interface PsdEncodeResult {
  bytes: Uint8Array;
  warnings: string[];
}

function commonPsdFields(l: StrataLayer, w: number, h: number): Partial<PsdLayer> {
  return {
    name: l.name,
    left: 0,
    top: 0,
    right: w,
    bottom: h,
    opacity: Math.min(1, Math.max(0, l.opacity / 100)),
    hidden: !l.visible,
    blendMode: blendToPsd(l.blend),
    transparencyProtected: l.locked,
    clipping: l.clip,
    mask: maskToPsd(l, w, h),
  };
}

/** 写侧把一棵森林节点转成 PsdLayer。导出供纯数据层往返测试直接调用。 */
export function nodeToPsd(
  node: PsdForestNode,
  w: number,
  h: number,
  warnings: string[],
  linkedOut: LinkedFile[] = [],
): PsdLayer {
  const l = node.layer;
  const base = commonPsdFields(l, w, h);
  if (l.kind === "group") {
    return {
      ...base,
      opened: openedOf(l),
      children: [...node.children].reverse().map((c) => nodeToPsd(c, w, h, warnings, linkedOut)),
    };
  }
  if (l.kind === "adjust") {
    const adj = l.adjust ? psdAdjustmentOf(l.adjust) : null;
    if (adj) return { ...base, adjustment: adj };
    // 无等价物：每条都写进 warnings（层名 + 降级原因），不再静默吞掉。
    // 优先保留可见像素：若该调整层已被烤平过（surface 达到文档尺寸），
    // 就把烤平像素连同蒙版一起写回；拿不到才保留透明占位层。
    const label = l.name || "调整层";
    const adjId = l.adjust?.id ?? "未知调整";
    warnings.push(
      warnLine(label, `${adjId} 无 PSD 等价调整资源，效果未写入，仅保留占位层`),
    );
    const baked =
      l.surface && l.surface.width >= w && l.surface.height >= h ? l.surface : null;
    return { ...base, name: `${label}（效果未写入）`, canvas: baked ?? createSurface(w, h) };
  }
  const pixel: PsdLayer = { ...base, canvas: l.surface };
  if (l.text) pixel.text = textToPsd(l.text);
  // 智能对象（smart/smartRaw）：写回 SoLd + lnk2，Photoshop 与 Strata 都能再认出它。
  const linked = smartToLinked(l, w, h, newGuid());
  if (linked) {
    pixel.placedLayer = linked.placedLayer;
    linkedOut.push(linked.linkedFile);
  }
  return pixel;
}

/**
 * 编码 StrataDoc → PSD 字节。
 * 组按 parent 指针重建嵌套、文字写 text 资源、蒙版转灰度、调整层按可映射表写回。
 */
export async function encodeDocToPsd(doc: StrataDoc): Promise<PsdEncodeResult> {
  const warnings: string[] = [];
  const forest = buildPsdForest(doc.layers);
  // 森林自下而上 → PSD children 自上而下
  const linkedOut: LinkedFile[] = [];
  const children = [...forest].reverse().map((n) => nodeToPsd(n, doc.width, doc.height, warnings, linkedOut));
  if (children.length === 0) {
    // 空像素栈：把合成结果烤成单层再写（compositor 延迟引入，避免循环依赖）
    const { composeDoc } = await import("./compositor");
    const flat = createSurface(doc.width, doc.height);
    composeDoc(doc, flat);
    children.push({
      name: doc.name || "合成",
      left: 0,
      top: 0,
      right: doc.width,
      bottom: doc.height,
      canvas: flat,
      opacity: 1,
      hidden: false,
      blendMode: "normal",
    });
  }
  const psd: Psd = {
    width: doc.width,
    height: doc.height,
    channels: 4,
    bitsPerChannel: 8,
    colorMode: 3, // RGB
    children,
  };
  // 智能对象的嵌入字节（lnk2）：与 placedLayer 的 id 一一对应。
  if (linkedOut.length > 0) psd.linkedFiles = linkedOut;
  let buffer: ReturnType<typeof writePsd>;
  try {
    buffer = writePsd(psd);
  } catch {
    // 某个调整资源的参数格式 ag-psd 不接受时，降级为透明占位再写一次，
    // 不能因为一层就让整份 PSD 导出失败。但每一条被降级的层都必须
    // 点名 + 说明原因并入 warnings，用户不能再被静默吞掉。
    const strip = (nodes: PsdLayer[]): void => {
      for (const n of nodes) {
        if (n.adjustment && !n.canvas) {
          const label = n.name || "调整层";
          const adjType = n.adjustment.type ?? "未知调整资源";
          warnings.push(
            warnLine(
              label,
              `调整资源「${adjType}」被 ag-psd 拒绝（参数格式不兼容），已降级为透明占位层`,
            ),
          );
          n.canvas = createSurface(doc.width, doc.height);
          delete n.adjustment;
        }
        // 智能对象写回失败时降级为像素层：警告 + 摘掉 placedLayer，
        // linkedFiles 里孤儿条目在重试前一并清掉。
        if (n.placedLayer) {
          const label = n.name || "智能对象";
          warnings.push(
            warnLine(label, "智能对象资源被 ag-psd 拒绝，已降级为普通像素层（原始数据仍在 .strata 工程里）"),
          );
          delete n.placedLayer;
        }
        if (n.children) strip(n.children);
      }
    };
    strip(children);
    if (linkedOut.length > 0 && !children.some((c) => c.placedLayer)) {
      delete psd.linkedFiles;
    }
    buffer = writePsd(psd);
  }
  return { bytes: new Uint8Array(buffer), warnings };
}
