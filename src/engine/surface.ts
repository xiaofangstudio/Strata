/**
 * 像素承载层（surface）工具。
 *
 * 每一个图层、以及文档的合成结果，都落在一张离屏 canvas 上。
 * 用 canvas 而不是裸 ImageData，是因为画笔、变换、合成都能直接走
 * Canvas2D 的绘制管线，不必自己写采样与混合。
 */

/** 新建一张指定尺寸的离屏画布；fill 为 undefined 时保持透明。 */
export function createSurface(
  width: number,
  height: number,
  fill?: string,
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  if (fill) {
    const ctx = mustCtx(c);
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  return c;
}

/** 由位图生成一张同尺寸画布。 */
export function surfaceFromBitmap(bitmap: ImageBitmap): HTMLCanvasElement {
  const c = createSurface(bitmap.width, bitmap.height);
  mustCtx(c).drawImage(bitmap, 0, 0);
  return c;
}

/** 深拷贝一张画布（撤销栈与图层复制都靠它）。 */
export function cloneSurface(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = createSurface(src.width, src.height);
  mustCtx(c).drawImage(src, 0, 0);
  return c;
}

/** 取 2D 上下文；拿不到就抛错，避免各处静默失败。 */
export function mustCtx(
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法获取 2D 绘图上下文");
  return ctx;
}

/** 把画布内容导出为 ImageData。 */
export function readPixels(canvas: HTMLCanvasElement): ImageData {
  return mustCtx(canvas).getImageData(0, 0, canvas.width, canvas.height);
}

/** 用 ImageData 覆盖整张画布。 */
export function writePixels(
  canvas: HTMLCanvasElement,
  data: ImageData,
): void {
  mustCtx(canvas).putImageData(data, 0, 0);
}

/** 画布是否完全透明（用于判断空图层）。 */
export function isBlank(canvas: HTMLCanvasElement): boolean {
  const { data } = readPixels(canvas);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) return false;
  }
  return true;
}
