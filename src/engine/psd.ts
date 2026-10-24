/**
 * PSD 读写（ag-psd 桥接层）。
 *
 * 「先读后写」：读侧重建图层栈（像素图层逐层落回 surface，PSD 的自上而下
 * children 顺序翻转为 Strata 的自下而上 layers）；写侧把像素图层翻回去交给
 * ag-psd 编码。调整图层 / 文字图层 / 图层组是 Strata 独有的延迟合成模型，
 * PSD 里没有一一对应物 —— 写出时跳过（读入时组与文字图层按像素取已有的
 * canvas，取不到就跳过），这是有损边界，注释里写清楚。
 *
 * 依赖 ag-psd（MIT），仅在此文件 import，保持按需加载。
 */
import { readPsd, writePsd, type Layer as PsdLayer, type Psd } from "ag-psd";
import { createLayer, type BlendId, type StrataLayer } from "../core/layer";
import { baseName, nextDocId, type StrataDoc } from "../core/document";
import { mustCtx } from "./surface";

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

/* ---------------------------------------------------------------- 读 */

/** 把 ag-psd 的一个（可能嵌套的）图层摊平成 Strata 像素图层，取不到像素就跳过。 */
function flattenPsdLayer(
  node: PsdLayer,
  width: number,
  height: number,
): StrataLayer | null {
  const canvas = (node as { canvas?: HTMLCanvasElement }).canvas;
  if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
  const layer = createLayer(width, height, node.name || "图层");
  const ctx = mustCtx(layer.surface);
  ctx.drawImage(canvas, node.left ?? 0, node.top ?? 0);
  layer.opacity = Math.round((node.opacity ?? 1) * 100);
  layer.visible = node.hidden !== true;
  layer.blend = blendFromPsd(node.blendMode);
  return layer;
}

/** 解码 PSD → StrataDoc。图层栈顺序：ag-psd 自上而下 → Strata 自下而上。 */
export function decodePsdToDoc(
  bytes: Uint8Array,
  name: string,
  sourcePath?: string,
): StrataDoc {
  const psd = readPsd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
    skipLayerImageData: false,
    skipCompositeImageData: false,
    skipThumbnail: true,
  });
  const width = psd.width;
  const height = psd.height;
  const layers: StrataLayer[] = [];
  const walk = (nodes: PsdLayer[]): void => {
    // children 自上而下，逐个翻到栈顶之前 —— 最终保持 PSD 的层叠顺序
    for (const node of nodes) {
      const flat = flattenPsdLayer(node, width, height);
      if (flat) layers.push(flat);
      if (node.children?.length) walk(node.children);
    }
  };
  if (psd.children?.length) walk(psd.children);
  // 一个图层都没有（整张平铺的 PSD）：退回合成图像
  if (layers.length === 0 && psd.canvas) {
    const only = createLayer(width, height, "背景");
    mustCtx(only.surface).drawImage(psd.canvas, 0, 0);
    layers.push(only);
  }
  // 仍然空：给一张透明底，别让上层拿到空栈
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

/* ---------------------------------------------------------------- 写 */

/**
 * 编码 StrataDoc → PSD 字节。只写像素图层（adjust / text / group 是 Strata
 * 的延迟合成模型，写进 PSD 需要先烤成像素，这里按「不写」处理 —— 存完整
 * 工程请用 .strata，PSD 导出面向与其他软件交换）。
 */
export async function encodeDocToPsd(doc: StrataDoc): Promise<Uint8Array> {
  const children: PsdLayer[] = [];
  // Strata 自下而上 → PSD 自上而下
  for (let i = doc.layers.length - 1; i >= 0; i -= 1) {
    const l = doc.layers[i];
    if (l.kind !== "pixel") continue;
    children.push({
      name: l.name,
      left: 0,
      top: 0,
      right: doc.width,
      bottom: doc.height,
      canvas: l.surface,
      opacity: Math.min(1, Math.max(0, l.opacity / 100)),
      hidden: !l.visible,
      blendMode: blendToPsd(l.blend),
    });
  }
  if (children.length === 0) {
    // 空像素栈：把合成结果烤成单层再写（compositor 延迟引入，避免循环依赖）
    const { composeDoc } = await import("./compositor");
    const flat = document.createElement("canvas");
    flat.width = doc.width;
    flat.height = doc.height;
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
  return new Uint8Array(writePsd(psd));
}
