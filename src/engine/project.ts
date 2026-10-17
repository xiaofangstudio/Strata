/**
 * .strata 工程文件。
 *
 * 一次编辑会话的全部状态（图层栈 / 混合模式 / 不透明度 / 蒙版 / 调整图层）
 * 都必须能存能开。采用「JSON 清单 + 内嵌 PNG」的单文件方案：清单描述结构，
 * 每个像素层与蒙版各自编码成 PNG 再 base64 进文件。
 *
 * 单文件、零外部依赖、双击即开；magic 与 version 已经预留，后续换成二进制
 * 容器（Rust 侧压缩 + 分块）时旧文件仍可识别。
 */
import {
  cloneStyle,
  createAdjustLayer,
  createGroupLayer,
  createLayer,
  type AdjustState,
  type BlendId,
  type LayerKind,
  type LayerStyle,
  type StrataLayer,
} from "../core/layer";
import { nextDocId, type StrataDoc } from "../core/document";
import { isSelectionEmpty } from "../core/selection";
import { decodeImage } from "./image";
import { createSurface, mustCtx } from "./surface";

/** 工程文件扩展名（小写，不含点）。 */
export const STRATA_EXTENSION = "strata";

const MAGIC = "STRATA-PROJECT";
/** 4 = 图层组；3 = 文档选区；2 = 剪贴蒙版与图层样式。 */
const VERSION = 4;

/** 落盘时的一个图层。像素与蒙版走 base64 PNG，结构走明文。 */
interface FileLayer {
  name: string;
  visible: boolean;
  opacity: number;
  blend: BlendId;
  locked: boolean;
  kind: LayerKind;
  adjust?: AdjustState;
  maskActive: boolean;
  /** 剪贴蒙版；未开启时省略 */
  clip?: boolean;
  /** 图层样式；为空时省略 */
  styles?: LayerStyle[];
  /**
   * 所属图层组在 layers 数组里的**下标**（顶层省略）。
   *
   * 数据库里父子关系是层 id，而 id 每次打开都会重新生成，落盘的必须是稳定
   * 的东西 —— 下标正好，且与 active 用同一套坐标。
   */
  parent?: number;
  /** 像素层的 base64 PNG（不含 data: 前缀）；调整层与组没有 */
  surface?: string;
  /** 蒙版的 base64 PNG；未创建蒙版时没有 */
  mask?: string;
}

/** 落盘的整个工程。 */
interface ProjectFile {
  magic: string;
  version: number;
  name: string;
  width: number;
  height: number;
  dpi?: number;
  /** 选中图层下标 */
  active: number;
  layers: FileLayer[];
  /** 文档选区的 base64 PNG（v3 起）；无选区时省略 */
  selection?: string;
}

/** 画布 → base64 PNG（剥掉 data URL 前缀）。 */
function canvasToB64(canvas: HTMLCanvasElement): string {
  const url = canvas.toDataURL("image/png");
  const comma = url.indexOf(",");
  return comma >= 0 ? url.slice(comma + 1) : "";
}

/** base64 → 字节。分块解码，避免一次性展开超长参数列表。 */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64 PNG → 文档尺寸的画布。尺寸以工程清单为准，防止旧文件尺寸漂移。 */
async function b64ToCanvas(
  b64: string,
  width: number,
  height: number,
): Promise<HTMLCanvasElement> {
  const canvas = createSurface(width, height);
  const bitmap = await decodeImage(b64ToBytes(b64), "image/png");
  mustCtx(canvas).drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

/** 路径是否为 Strata 工程文件。 */
export function isStrataPath(path: string): boolean {
  return path.toLowerCase().endsWith(`.${STRATA_EXTENSION}`);
}

/** 把整份文档序列化成 .strata 字节。 */
export async function encodeProject(doc: StrataDoc): Promise<Uint8Array> {
  const layers: FileLayer[] = [];
  doc.layers.forEach((l, i) => {
    const fl: FileLayer = {
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      blend: l.blend,
      locked: l.locked,
      kind: l.kind,
      maskActive: l.maskActive,
    };
    if (l.adjust) fl.adjust = l.adjust;
    if (l.clip) fl.clip = true;
    if (l.styles && l.styles.length) fl.styles = l.styles;
    // 组也想记下自己属于哪个上层组：存下标，读回时再换成新 id
    if (l.parent) {
      const pi = doc.layers.findIndex((x) => x.id === l.parent);
      if (pi >= 0 && pi !== i) fl.parent = pi;
    }
    // 调整图层与组都不占像素，不写 surface，省下整幅空白（或 1×1 占位）PNG
    if (l.kind === "pixel") fl.surface = canvasToB64(l.surface);
    if (l.mask) fl.mask = canvasToB64(l.mask);
    layers.push(fl);
  });
  const active = Math.max(
    0,
    doc.layers.findIndex((l) => l.id === doc.activeLayerId),
  );
  const file: ProjectFile = {
    magic: MAGIC,
    version: VERSION,
    name: doc.name,
    width: doc.width,
    height: doc.height,
    dpi: doc.dpi,
    active,
    layers,
  };
  // 空选区不必落盘（占一张整幅 PNG）；有选区才写
  if (doc.selection && !isSelectionEmpty(doc.selection)) {
    file.selection = canvasToB64(doc.selection);
  }
  return new TextEncoder().encode(JSON.stringify(file));
}

/** 把 .strata 字节还原成文档。结构不合法时抛出可展示的错误。 */
export async function decodeProject(bytes: Uint8Array): Promise<StrataDoc> {
  let file: ProjectFile;
  try {
    file = JSON.parse(new TextDecoder().decode(bytes)) as ProjectFile;
  } catch {
    throw new Error("工程文件已损坏，无法读取");
  }
  if (!file || file.magic !== MAGIC) {
    throw new Error("这不是 Strata 工程文件");
  }
  if (file.version > VERSION) {
    throw new Error("该工程由更高版本的 Strata 保存，请升级后再打开");
  }
  if (!Array.isArray(file.layers) || file.layers.length === 0) {
    throw new Error("工程里没有任何图层");
  }

  const { width, height } = file;
  const layers: StrataLayer[] = [];
  /** 文件下标 → 新建图层的 id（第二趟接父指针要用） */
  const ids: string[] = [];
  for (const fl of file.layers) {
    const mask = fl.mask ? await b64ToCanvas(fl.mask, width, height) : null;
    const common = {
      visible: fl.visible,
      opacity: fl.opacity,
      blend: fl.blend,
      locked: fl.locked,
      mask,
      maskActive: fl.maskActive,
      clip: !!fl.clip,
      styles: fl.styles ? fl.styles.map(cloneStyle) : [],
    };
    if (fl.kind === "adjust" && fl.adjust) {
      layers.push({ ...createAdjustLayer(fl.name, fl.adjust), ...common });
    } else if (fl.kind === "group") {
      // 组这层壳不带像素，照原样重建；子层各自成层，稍后按 parent 认领
      layers.push({ ...createGroupLayer(fl.name), ...common });
    } else {
      const base = createLayer(width, height, fl.name);
      if (fl.surface) {
        const bitmap = await decodeImage(b64ToBytes(fl.surface), "image/png");
        mustCtx(base.surface).drawImage(bitmap, 0, 0);
        bitmap.close();
      }
      layers.push({ ...base, ...common });
    }
    ids.push(layers[layers.length - 1].id);
  }

  // 第二趟接父指针：组在数组里排在它子层的「上面」，正向建层时父组还没出现，
  // 所以得等全部建完再统一连。下标指向的必须是组，否则一律当顶层处理。
  file.layers.forEach((fl, i) => {
    const pi = fl.parent;
    if (typeof pi !== "number" || pi < 0 || pi >= ids.length || pi === i) return;
    if (layers[pi].kind === "group") layers[i].parent = ids[pi];
  });

  const active = layers[Math.min(Math.max(0, file.active), layers.length - 1)];
  const selection = file.selection
    ? await b64ToCanvas(file.selection, width, height)
    : null;
  return {
    id: nextDocId(),
    name: file.name,
    width,
    height,
    layers,
    activeLayerId: active.id,
    selection,
    dpi: file.dpi,
    dirty: false,
  };
}
