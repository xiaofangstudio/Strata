/**
 * 导出编码：PNG / JPEG / WebP。
 *
 * 之前只写了 PNG（无损、体积大）。这里补上两种有损格式 —— 但有个坑必须处理：
 * **JPEG 没有 alpha 通道**，直接把带透明的画布交给它，透明区会变成黑色。
 * 所以 JPEG 一律先铺一层白底再编码（与 PS 的「拼合后存 JPG」一致）。
 */
import { encodePng } from "./image";

export type ExportFormat = "png" | "jpeg" | "webp";

export interface ExportFormatSpec {
  id: ExportFormat;
  label: string;
  ext: string;
  mime: string;
  /** 有损格式才需要质量参数 */
  lossy: boolean;
  /** 面板上的一句说明 */
  note: string;
}

export const EXPORT_FORMATS: readonly ExportFormatSpec[] = [
  { id: "png", label: "PNG", ext: "png", mime: "image/png", lossy: false, note: "无损 · 保留透明" },
  { id: "jpeg", label: "JPEG", ext: "jpg", mime: "image/jpeg", lossy: true, note: "有损 · 体积小 · 白底" },
  { id: "webp", label: "WebP", ext: "webp", mime: "image/webp", lossy: true, note: "有损 · 体积更小 · 保留透明" },
];

export function formatSpec(id: ExportFormat): ExportFormatSpec {
  return EXPORT_FORMATS.find((f) => f.id === id) ?? EXPORT_FORMATS[0];
}

/** 把透明区铺成白底（JPEG 用）。不透明像素逐位不变。 */
function flattenOnWhite(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext("2d");
  if (!ctx) return src;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, 0, 0);
  return out;
}

/**
 * 把画布编成字节。
 *
 * @param quality 1–100，只对有损格式有效
 */
export async function encodeCanvas(
  canvas: HTMLCanvasElement,
  format: ExportFormat,
  quality = 92,
): Promise<Uint8Array> {
  if (format === "png") return encodePng(canvas);

  const src = format === "jpeg" ? flattenOnWhite(canvas) : canvas;
  const q = Math.min(100, Math.max(1, quality)) / 100;
  const blob = await new Promise<Blob | null>((resolve) => {
    src.toBlob(resolve, formatSpec(format).mime, q);
  });
  if (!blob) throw new Error("浏览器没能生成图像数据");
  return new Uint8Array(await blob.arrayBuffer());
}

/** 建议文件名：把原扩展名换掉，没有就补上。 */
export function suggestFileName(name: string, format: ExportFormat): string {
  const base = name.replace(/\.(png|jpe?g|webp|gif|bmp|tiff?|psd|strata)$/i, "");
  return `${base}.${formatSpec(format).ext}`;
}
