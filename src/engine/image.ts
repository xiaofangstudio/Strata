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
];

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
  const bytes = await readFileBytes(path);
  if (NEEDS_OWN_DECODER.has(extOf(path))) {
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
