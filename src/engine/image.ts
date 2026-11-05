import { invoke } from "@tauri-apps/api/core";

/**
 * 可打开 / 可导入的图片扩展名（小写，不含点）。
 * 与立项规划书 §7.5「PNG / JPEG / WebP / TIFF 等」对齐。
 */
export const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "tif",
  "tiff",
  "bmp",
  "gif",
  /* 六项差距全修：HEIC/HEIF 由 Rust 侧 heic-rs 解码 */
  "heic",
  "heif",
  "hif",
  /* 相机 RAW：Rust 侧 strata_raw 显影（部分格式只能取内嵌预览，见 decode.rs） */
  "dng",
  "cr2",
  "cr3",
  "nef",
  "arw",
  "orf",
  "raf",
  "rw2",
  "pef",
  "srw",
  "3fr",
  "fff",
  "iiq",
  "mos",
  "erf",
  "mef",
  "kdc",
  "dcr",
  "nrw",
  "raw",
];

/** 走 Rust 侧 HEIC 解码器的扩展名。 */
export const HEIC_EXTENSIONS: readonly string[] = ["heic", "heif", "hif"];
/** 走 Rust 侧 RAW 显影器的扩展名。 */
export const RAW_EXTENSIONS: readonly string[] = [
  "dng", "cr2", "cr3", "nef", "arw", "orf", "raf", "rw2", "pef", "srw",
  "3fr", "fff", "iiq", "mos", "erf", "mef", "kdc", "dcr", "nrw", "raw",
];

/** Tauri 解码命令的统一返回结构（8bit RGBA，行优先）。 */
export interface DecodedImage {
  width: number;
  height: number;
  rgba: number[];
  /** Rust 侧新增：sensor=完整 RAW 显影 / embedded-preview=相机内嵌 JPEG / image=普通图片 */
  source?: "sensor" | "embedded-preview" | "image";
  /** Rust 侧新增：显影降级、色彩转换失败等中文提示，null 表示正常 */
  warning?: string | null;
}

/**
 * 最近一次原生解码的提示（消费式）。
 *
 * decodeNativeImage 返回的是 ImageBitmap，没法附带元数据；而 CR3 只能取内嵌预览、
 * 显影失败退回预览这类情况**必须让用户知道**，否则会以为打开的是 RAW 显影结果。
 * 打开流程在 loadImage 之后调 takeDecodeWarning() 取一次并弹提示。
 */
let pendingDecodeWarning: string | null = null;

export function takeDecodeWarning(): string | null {
  const w = pendingDecodeWarning;
  pendingDecodeWarning = null;
  return w;
}

/** 只在需要在 UI 之外静默丢弃时用（例如只生成缩略图）。 */
export function clearDecodeWarning(): void {
  pendingDecodeWarning = null;
}

/**
 * 调用 Rust 侧解码器，把 HEIC / 相机 RAW 解成 RGBA 位图。
 * 错误信息由内核给中文短句，这里只补一层「文件类型」上下文。
 */
export async function decodeNativeImage(path: string, tonemap = 0): Promise<ImageBitmap> {
  const ext = extOf(path);
  const command = HEIC_EXTENSIONS.includes(ext) ? "decode_heic" : "decode_raw";
  const args = HEIC_EXTENSIONS.includes(ext) ? { path } : { path, tonemap };
  let img: DecodedImage;
  try {
    img = await invoke<DecodedImage>(command, args);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(why || `${ext.toUpperCase()} 解码失败`);
  }
  if (!img || !Number.isFinite(img.width) || !Number.isFinite(img.height) ||
      img.width <= 0 || img.height <= 0 || !img.rgba?.length) {
    throw new Error("解码器没有返回有效图像，请确认文件完整且格式受支持");
  }
  const expected = img.width * img.height * 4;
  if (img.rgba.length < expected) {
    throw new Error("解码器返回的像素数据不完整");
  }
  // 每次解码先清掉上一次的提示，避免旧警告被后续打开流程误取。
  pendingDecodeWarning = img.warning ?? null;
  if (img.source === "embedded-preview" && !pendingDecodeWarning) {
    // Rust 侧没给 reason 时也要兜底说明，不能让用户把预览图当 RAW 显影。
    pendingDecodeWarning = "当前显示的是相机内嵌 JPEG 预览，并非 RAW 显影结果。";
  }
  // 广播给应用外壳：欢迎页 / 双击启动 / 编辑器内打开三条链路都会经过这里，
  // 用事件而不是在某一处消费，保证哪条来路都能看到提示。
  if (pendingDecodeWarning && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("strata:decode-warning", { detail: pendingDecodeWarning }));
  }
  const data = new Uint8ClampedArray(expected);
  for (let i = 0; i < expected; i += 1) data[i] = img.rgba[i];
  return createImageBitmap(new ImageData(data, img.width, img.height));
}

/** 扩展名 → MIME 类型。 */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  bmp: "image/bmp",
  gif: "image/gif",
};

/** 浏览器解不开、必须走自研解码器的格式。 */
const NEEDS_OWN_DECODER = new Set(["tif", "tiff"]);

/** 取小写扩展名（不含点）。 */
export function extOf(path: string): string {
  const seg = path.split(/[\\/]/).pop() ?? "";
  const dot = seg.lastIndexOf(".");
  return dot > 0 ? seg.slice(dot + 1).toLowerCase() : "";
}

/** 由扩展名推断 MIME，未知时退回 PNG。 */
export function mimeOf(path: string): string {
  return MIME_BY_EXT[extOf(path)] ?? "image/png";
}

/** 读取本地文件字节。文件系统访问统一走内核命令。 */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  const data = await invoke<number[]>("read_file_bytes", { path });
  return Uint8Array.from(data);
}

/** 写入本地文件字节。 */
export async function writeFileBytes(
  path: string,
  data: Uint8Array,
): Promise<void> {
  await invoke("write_file_bytes", { path, data: Array.from(data) });
}

/** 把图片字节解码成位图，供 canvas 直接绘制。 */
export async function decodeImage(
  bytes: Uint8Array,
  mime: string,
): Promise<ImageBitmap> {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  try {
    return await createImageBitmap(blob);
  } catch {
    throw new Error("这个图片格式解不开，请换 PNG / JPG / WebP 试试");
  }
}

/** 文件属性，由内核 files_stat 返回。 */
export interface FileStat {
  exists: boolean;
  size: number;
  /** Unix 毫秒；拿不到时为 null */
  modified: number | null;
}

/**
 * 查询文件属性。
 *
 * 刻意不抛错：最近文件里出现已被删除或移动的路径是常态，
 * 上层需要的是「不存在」这个事实，而不是一个异常。
 */
export async function fileStat(path: string): Promise<FileStat> {
  try {
    return await invoke<FileStat>("files_stat", { path });
  } catch {
    return { exists: false, size: 0, modified: null };
  }
}

/**
 * 把 RGBA 像素包装成位图。
 *
 * 这里重新复制一份像素：解码器给出的数组类型标注是 ArrayBufferLike，
 * 而 ImageData 只接受 ArrayBuffer 承载的数组，直接传入会在类型层被拒。
 * 复制一次即可同时满足类型与「不共享底层缓冲」的语义。
 */
async function bitmapFromRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<ImageBitmap> {
  const data = new Uint8ClampedArray(rgba);
  return await createImageBitmap(new ImageData(data, width, height));
}

/** 从本地路径读图并解码。 */
export async function loadImage(path: string): Promise<ImageBitmap> {
  const ext = extOf(path);
  // HEIC / 相机 RAW：浏览器与 WebView2 都解不开，交给 Rust 侧解码器。
  // 这条是统一入口 —— 编辑器内「打开」和「双击文件启动」都会经过这里。
  if (HEIC_EXTENSIONS.includes(ext) || RAW_EXTENSIONS.includes(ext)) {
    return decodeNativeImage(path);
  }
  const bytes = await readFileBytes(path);
  if (NEEDS_OWN_DECODER.has(ext)) {
    // TIFF：浏览器与 WebView2 都不认，交给自研解码器。
    // 这里按需加载 —— 只有真的打开 TIFF 时才把解码器拉进来，
    // 平时不占首屏体积。
    const { decodeTiff } = await import("./tiff");
    const img = await decodeTiff(bytes);
    return await bitmapFromRgba(img.rgba, img.width, img.height);
  }
  return decodeImage(bytes, mimeOf(path));
}

/**
 * 生成缩略图。返回可直接塞进 <img src> 的 data URL。
 *
 * 用 4:3 的白色衬底把图片等比装进去，这样列表里的缩略图
 * 尺寸整齐、位置一致，不会因为原图比例不同而忽大忽小。
 */
export async function makeThumbnail(
  bitmap: ImageBitmap,
  box = 96,
  quality = 0.82,
): Promise<string> {
  const c = document.createElement("canvas");
  c.width = box;
  c.height = box;
  const ctx = c.getContext("2d");
  if (!ctx) return "";

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const s = Math.min(box / bitmap.width, box / bitmap.height);
  const w = Math.max(1, Math.round(bitmap.width * s));
  const h = Math.max(1, Math.round(bitmap.height * s));
  ctx.drawImage(bitmap, Math.round((box - w) / 2), Math.round((box - h) / 2), w, h);

  return c.toDataURL("image/webp", quality);
}

/** 把 canvas 编码成 PNG 字节。 */
export async function encodePng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) {
    throw new Error("PNG 编码失败");
  }
  return new Uint8Array(await blob.arrayBuffer());
}
