import { invoke } from "@tauri-apps/api/core";

/** 常见图片扩展名（小写，不含点），M0 支持打开的范围。 */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];

/** 扩展名 → MIME 类型。 */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  bmp: "image/bmp",
  gif: "image/gif",
};

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

/** 从本地路径读图并解码。 */
export async function loadImage(path: string): Promise<ImageBitmap> {
  const bytes = await readFileBytes(path);
  return decodeImage(bytes, mimeOf(path));
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
