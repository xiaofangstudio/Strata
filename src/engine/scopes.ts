/**
 * 色彩示波器（波形图 / 矢量图 / 分量 RGB）。
 *
 * 对齐达芬奇（DaVinci Resolve）的三个经典仪表，给调色一个客观参照：
 *  · **波形图 Waveform**：横轴 = 画面横向位置，纵轴 = 亮度（下黑上白），
 *    一个像素点的堆积密度用明度表示 —— 一眼看出暗部有没有压死、高光有没有过曝；
 *  · **分量 parade**：红绿蓝三条波形并排，用于判断偏色与通道溢出；
 *  · **矢量图 Vectorscope**：把每个像素的色度投到极坐标上（角度 = 色相、
 *    半径 = 饱和度），标点详见万能。正点的颜色方格 + 满意度指示。
 *
 * 为什么这里全是纯函数：示波器要从画布像素里出数，node 里没有 canvas，
 * 于是所有计算都吃 `{ data, width, height }` 这种裸 RGBA 结构 ——
 * 既能塞进单测，也让 UI 层只管画，不碰数学。
 *
 * 参考：PhotoCraft `algo/histogram.rs` 的降采样思路；
 * 波形与矢量的布局语义对齐 DaVinci Resolve 的 Scope。
 */

/** 一块密度图：宽 × 高，每格是被命中的次数。max 用来归一化显示。 */
export interface ScopeBins {
  width: number;
  height: number;
  /** 长度 = width × height，值 = 命中次数 */
  bins: Uint32Array;
  /** 单格最大命中数（归一化用），全空时为 0 */
  max: number;
}

/** 新建一个空的密度累计器。 */
function newBins(width: number, height: number): ScopeBins {
  return { width, height, bins: new Uint32Array(width * height), max: 0 };
}

/** 往密度图里 +1，顺手维护 max。 */
function hit(b: ScopeBins, x: number, y: number): void {
  const i = y * b.width + x;
  b.bins[i] += 1;
  if (b.bins[i] > b.max) b.max = b.bins[i];
}

/**
 * 抽样步长：像素数越多跳得越多，保证 4000×3000 也不会把主线程拖住。
 * 仪器是给人看趋势的，不需要逐像素统计。
 */
function stepFor(width: number, height: number, budget = 1_200_000): number {
  const total = width * height;
  if (total <= budget) return 1;
  return Math.max(1, Math.ceil(Math.sqrt(total / budget)));
}

/* ------------------------------------------------------------ 波形图 */

export type WaveChannel = "luma" | "r" | "g" | "b";

/**
 * 波形图。
 *
 * 输出宽度固定为 `outW`（默认 256），每一列对应画面的一段横向位置；
 * 纵轴 256 级自下而上（第 0 行 = 黑）。y 越小（越黑）在图上越靠下。
 */
export function computeWaveform(
  img: { data: Uint8ClampedArray; width: number; height: number },
  channel: WaveChannel = "luma",
  outW = 256,
): ScopeBins {
  const { data, width, height } = img;
  const out = newBins(outW, 256);
  if (width < 1 || height < 1) return out;

  const step = stepFor(width, height);
  const colScale = outW / width;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      if (a === 0) continue;
      let v: number;
      if (channel === "r") v = data[i];
      else if (channel === "g") v = data[i + 1];
      else if (channel === "b") v = data[i + 2];
      else v = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
      const col = Math.min(outW - 1, Math.floor(x * colScale));
      // 纵轴翻转：0 在最下面一行
      hit(out, col, 255 - v);
    }
  }
  return out;
}

/**
 * 分量波形（parade）：在一张图上把 R / G / B 三条波形横向三等分排开，
 * 与达芬奇的 Parade 模式一致 —— 一眼看出哪个通道偏了。
 */
export function computeParade(
  img: { data: Uint8ClampedArray; width: number; height: number },
  outW = 384,
): { r: ScopeBins; g: ScopeBins; b: ScopeBins; slotWidth: number } {
  const per = Math.max(8, Math.floor(outW / 3));
  return {
    r: computeWaveform(img, "r", per),
    g: computeWaveform(img, "g", per),
    b: computeWaveform(img, "b", per),
    slotWidth: per,
  };
}

/* ------------------------------------------------------------ 矢量图 */

/**
 * 矢量图（vectorscope）。
 *
 * 把每个像素的色度（Cb / Cr，ITU-R BT.601）投到一张 size×size 的方图上：
 *   x = (Cb + 0.5) × size　　y = (0.5 − Cr) × size
 * 于是正中央是「没有彩度」（灰），越靠外越艳，角度即色相。
 *
 * 达芬奇里的小方框（75% / 100% 彩条落点）由 UI 层按同一套公式画，
 * 不掺进这里 —— 纯数据与装饰分开，便于单测。
 */
export function computeVectorscope(
  img: { data: Uint8ClampedArray; width: number; height: number },
  size = 256,
): ScopeBins {
  const { data, width, height } = img;
  const out = newBins(size, size);
  if (width < 1 || height < 1) return out;

  const step = stepFor(width, height);
  const half = size / 2;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue;
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      // BT.601 色差分量，取值约 -0.5…0.5
      const cb = -0.169 * r - 0.331 * g + 0.5 * b;
      const cr = 0.5 * r - 0.419 * g - 0.081 * b;
      // 放大到 ±0.5 满量程，越界夹到边缘（超饱和就直接压在圆周上）
      const px = Math.round(half + cb * size * 2 * 0.5);
      const py = Math.round(half - cr * size * 2 * 0.5);
      if (px < 0 || py < 0 || px >= size || py >= size) continue;
      hit(out, px, py);
    }
  }
  return out;
}

/* --------------------------------------------------------- 辅助：显示 */

/**
 * 把密度换算成 0–1 的强度。
 *
 * 直接线性会让稀疏的边缘几乎看不见（大多数像素集中在一小段），
 * 所以取对数压缩：log(1+v)/log(1+max)，稀疏但有意义的点也能亮起来 ——
 * 这也是各类示波器的通行做法。
 */
export function binIntensity(v: number, max: number): number {
  if (v <= 0 || max <= 0) return 0;
  return Math.min(1, Math.log1p(v) / Math.log1p(max));
}
