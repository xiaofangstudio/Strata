/**
 * 像素内核的公共数据形状。
 *
 * 液化、内容识别填充、自动色调这一类算法都直接读写裸像素缓冲区：它们不需要
 * 画布，也不需要 DOM，只需要「一串 RGBA 字节 + 宽高」。用最小结构体而不是
 * 直接抓 ImageData，一是让这些内核能在无 DOM 的测试环境里跑，二是让算法与
 * 渲染层彻底解耦 —— P 图与绘画要共用同一套内核，就不能让内核依赖画布。
 */

/** 裸 RGBA 缓冲区。长度恒为 width * height * 4，取值 0–255。 */
export interface Raster {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** 整数像素矩形（文档坐标）。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 两矩形求交；不相交时返回 width 或 height 为 0 的矩形。 */
export function intersectRect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, x1 - x), height: Math.max(0, y1 - y) };
}

/** 建一张全透明（或指定纯色）的 Raster。 */
export function createRaster(width: number, height: number, fill?: readonly number[]): Raster {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const data = new Uint8ClampedArray(w * h * 4);
  if (fill) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fill[0] ?? 0;
      data[i + 1] = fill[1] ?? 0;
      data[i + 2] = fill[2] ?? 0;
      data[i + 3] = fill[3] ?? 255;
    }
  }
  return { data, width: w, height: h };
}

/** 由真 ImageData（或任何同形对象）取一份 Raster 视图，不拷贝像素。 */
export function asRaster(img: {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}): Raster {
  return { data: img.data, width: img.width, height: img.height };
}

/** 深拷贝一份 Raster。 */
export function cloneRaster(src: Raster): Raster {
  return { data: new Uint8ClampedArray(src.data), width: src.width, height: src.height };
}

/** 两个 Raster 尺寸是否一致。 */
export function sameSize(a: Raster, b: Raster): boolean {
  return a.width === b.width && a.height === b.height;
}

/** 把浮点坐标夹进合法像素范围。 */
function clampCoord(v: number, max: number): number {
  return v < 0 ? 0 : v > max ? max : v;
}

/**
 * 双线性采样，结果写进 `out` 的前 4 位（0–255，浮点）。
 *
 * 取 `out` 参数而不是返回数组，是因为液化要对几十万个像素各采样一次，
 * 每次分配一个长度为 4 的数组会直接把 GC 拖垮。
 *
 * 越界坐标按边缘夹取（clamp-to-edge），于是「往外推」不会在边界外采到
 * 透明像素，局部形变不会顺带啃掉画布边缘。
 */
export function sampleBilinear(src: Raster, x: number, y: number, out: Float32Array): void {
  const { width: w, height: h, data } = src;
  const maxX = w - 1;
  const maxY = h - 1;
  const cx = clampCoord(x, maxX);
  const cy = clampCoord(y, maxY);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = x0 >= maxX ? maxX : x0 + 1;
  const y1 = y0 >= maxY ? maxY : y0 + 1;
  const fx = cx - x0;
  const fy = cy - y0;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  for (let c = 0; c < 4; c += 1) {
    out[c] =
      data[i00 + c] * w00 + data[i10 + c] * w10 + data[i01 + c] * w01 + data[i11 + c] * w11;
  }
}

/**
 * 距离衰减权重：中心 1、边缘 0，且一阶导在边缘也为 0。
 *
 * `(1 - t²)²` 在 t=1 处值与导数同时归零，因此一次涂抹的作用范围是一条
 * 光滑的曲线 —— 用线性衰减会在半径边界留下一圈可见的圆环接缝。
 */
export function falloff(dist: number, radius: number): number {
  if (radius <= 0) return 0;
  const t = dist / radius;
  if (t >= 1) return 0;
  const u = 1 - t * t;
  return u * u;
}
