/**
 * 用户自有笔尖图片（PNG / 灰度图）的导入与编解码。
 *
 * 不接 `brush://` 之类的假入口：只接受真实文件，坏文件给出明确原因。
 * 导入后把 64×64 的灰度遮罩编码成 base64 存进偏好设置——是用户数据，
 * 不塞进 `.strata` 工程文件；落笔时同步解码成贴图，形状真的会变。
 */
import { createSurface, mustCtx } from "../engine/surface";

export const TIP_MASK_SIZE = 64;
const MASK_BYTES = TIP_MASK_SIZE * TIP_MASK_SIZE;
/** base64 长度上限：64×64 原始字节编码后约 5.5KB，留点余量挡住垃圾数据 */
const MAX_MASK_B64 = Math.ceil((MASK_BYTES * 4) / 3) + 8;
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/bmp"];
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** 只接受用户自己选的图像文件；错误原因直接给用户看。 */
export function validateTipFile(file: { type: string; size: number }): string | null {
  if (!ACCEPTED_TYPES.includes(file.type.toLowerCase())) {
    return "只支持 PNG / JPEG / WebP / BMP 图像笔尖";
  }
  if (file.size <= 0) return "文件是空的";
  if (file.size > MAX_FILE_BYTES) return "笔尖图片不能超过 8 MB";
  return null;
}

/** 字节遮罩 → base64（分块转换，避免大数组一次性展开成超长参数） */
export function encodeTipMask(bytes: Uint8Array): string {
  if (bytes.length !== MASK_BYTES) throw new Error("笔尖遮罩尺寸不对");
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** base64 → 字节遮罩；坏数据返回 null，绝不让半张图混进笔刷库。 */
export function decodeTipMask(data: string | null | undefined): Uint8Array | null {
  if (typeof data !== "string" || data.length === 0 || data.length > MAX_MASK_B64) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    return null;
  }
  if (binary.length !== MASK_BYTES) return null;
  const out = new Uint8Array(MASK_BYTES);
  for (let i = 0; i < MASK_BYTES; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * 图像 → 64×64 灰度遮罩。
 * alpha 决定形状边界，亮度决定内部浓度：彩色笔尖按感知亮度取灰度，
 * 纯灰度图则直接沿用亮度，两种来源都能当笔尖用。
 */
export async function imageToTipMask(blob: Blob): Promise<Uint8Array> {
  if (typeof createImageBitmap !== "function") {
    throw new Error("当前环境不支持图片解码");
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const c = createSurface(TIP_MASK_SIZE, TIP_MASK_SIZE);
    const ctx = mustCtx(c);
    ctx.drawImage(bitmap, 0, 0, TIP_MASK_SIZE, TIP_MASK_SIZE);
    const { data } = ctx.getImageData(0, 0, TIP_MASK_SIZE, TIP_MASK_SIZE);
    const mask = new Uint8Array(MASK_BYTES);
    for (let i = 0; i < MASK_BYTES; i += 1) {
      const p = i * 4;
      const lum = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255;
      mask[i] = Math.round((data[p + 3] / 255) * (0.25 + 0.75 * lum) * 255);
    }
    return mask;
  } finally {
    bitmap.close?.();
  }
}

/** 某个输出像素的 alpha（0–255）：遮罩取样 + 硬度曲线。纯函数，便于钉死形状行为。 */
export function tipAlphaAt(
  mask: Uint8Array,
  x: number,
  y: number,
  side: number,
  hardness: number,
): number {
  const mx = Math.min(TIP_MASK_SIZE - 1, Math.floor((x / side) * TIP_MASK_SIZE));
  const my = Math.min(TIP_MASK_SIZE - 1, Math.floor((y / side) * TIP_MASK_SIZE));
  const v = mask[my * TIP_MASK_SIZE + mx] / 255;
  const hard = Math.max(0, Math.min(100, hardness)) / 100;
  return Math.round(Math.pow(v, 1 + (1 - hard) * 1.6) * 255);
}

/** 遮罩 → 彩色笔尖贴图，同步生成，供落笔与预览共用。硬度控制边界对比。 */
export function maskTipCanvas(
  data: string | null | undefined,
  color: string,
  hardness: number,
  size: number,
): HTMLCanvasElement | null {
  const mask = decodeTipMask(data);
  if (!mask) return null;
  const side = Math.max(2, Math.round(size));
  const c = createSurface(side, side);
  const ctx = mustCtx(c);
  const img = ctx.createImageData(side, side);
  let r = 0;
  let g = 0;
  let b = 0;
  const hex = color.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    const n = Number.parseInt(hex, 16);
    r = (n >> 16) & 255;
    g = (n >> 8) & 255;
    b = n & 255;
  }
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const p = (y * side + x) * 4;
      img.data[p] = r;
      img.data[p + 1] = g;
      img.data[p + 2] = b;
      img.data[p + 3] = tipAlphaAt(mask, x, y, side, hardness);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
