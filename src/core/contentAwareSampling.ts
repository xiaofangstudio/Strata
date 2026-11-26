/**
 * 内容识别填充工作区的取样平面（移植自 ArtCraft PhotoCraft
 * `crates/algo/src/content_aware.rs` 的 `SamplingStroke` / `paint_strokes`，MIT / Apache-2.0）。
 *
 * PhotoCraft 的 Content-Aware Fill 不是「框个选区就补」，而是有三张平面：
 *  · 填充区（hole）—— 用户选区，要被抹掉的部分；
 *  · 取样区（sampling）—— 允许借纹理的地方，初始是自动取样窗口，用户可以用笔刷加减；
 *  · 取样窗口（window）—— 自动取样区的矩形范围。
 * 真正喂给填充内核的是 `sampling ∩ ¬hole`：笔刷把取样区刷到别处，填充结果就必须改。
 *
 * 这里只放纯函数，不碰 DOM。笔刷用硬边圆刷，按像素中心到线段的距离判定，
 * 与 PhotoCraft 的 `paint_strokes` 同语义；一次笔画覆盖的是各线段像素的并集，
 * 所以快速拖动不会留下断点。
 */

export interface SamplingStroke {
  /** true = 加入取样区，false = 从取样区挖掉。 */
  add: boolean;
  /** 笔刷直径（文档像素）。 */
  size: number;
  /** 文档像素坐标的路径点。 */
  points: Array<[number, number]>;
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 像素中心 (x+0.5, y+0.5) 到线段 a–b 的平方距离。 */
function segmentDistanceSquared(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

/**
 * 按顺序把笔画画进取样掩码。返回新数组，入参不改（工作区的撤销靠重放历史笔画）。
 * 掩码长度不等于 w*h 时原样返回，避免越界写。
 */
export function paintSamplingStrokes(
  mask: Uint8Array,
  w: number,
  h: number,
  strokes: readonly SamplingStroke[],
): Uint8Array {
  const out = Uint8Array.from(mask);
  if (out.length !== w * h) return out;
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    const radius = Math.max(0.5, stroke.size / 2);
    const radius2 = radius * radius;
    const segments: Array<[[number, number], [number, number]]> =
      stroke.points.length === 1
        ? [[stroke.points[0], stroke.points[0]]]
        : stroke.points.slice(0, -1).map((p, i) => [p, stroke.points[i + 1]]);
    for (const [a, b] of segments) {
      const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - radius));
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - radius));
      const x1 = Math.min(w - 1, Math.ceil(Math.max(a[0], b[0]) + radius));
      const y1 = Math.min(h - 1, Math.ceil(Math.max(a[1], b[1]) + radius));
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          if (
            segmentDistanceSquared(x + 0.5, y + 0.5, a[0], a[1], b[0], b[1]) <= radius2
          ) {
            out[y * w + x] = stroke.add ? 1 : 0;
          }
        }
      }
    }
  }
  return out;
}

/** 掩码外接矩形；全空时返回 null。 */
export function maskBounds(mask: Uint8Array, w: number, h: number): PixelRect | null {
  if (mask.length !== w * h) return null;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!mask[y * w + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/**
 * 自动取样窗口：填充区外接框外扩 pad，夹回画布。
 * PhotoCraft 默认给的是洞周围一圈，而不是整张图；这样只在相关纹理里找样本。
 */
export function samplingWindow(
  hole: Uint8Array,
  w: number,
  h: number,
  pad = 24,
): PixelRect | null {
  const box = maskBounds(hole, w, h);
  if (!box) return null;
  const margin = Math.max(0, Math.round(pad));
  const x = Math.max(0, box.x - margin);
  const y = Math.max(0, box.y - margin);
  const x1 = Math.min(w, box.x + box.width + margin);
  const y1 = Math.min(h, box.y + box.height + margin);
  return { x, y, width: Math.max(0, x1 - x), height: Math.max(0, y1 - y) };
}

/** 矩形窗口转取样掩码；越界部分自动夹掉。 */
export function windowSamplingMask(w: number, h: number, rect: PixelRect): Uint8Array {
  const out = new Uint8Array(w * h);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(w, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(h, Math.ceil(rect.y + rect.height));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) out[y * w + x] = 1;
  }
  return out;
}

/** 取样区内扣掉填充区：洞里的像素不能当自己的样本。 */
export function restrictSampling(sample: Uint8Array, hole: Uint8Array): Uint8Array {
  const out = new Uint8Array(sample.length);
  for (let i = 0; i < out.length; i += 1) out[i] = sample[i] && !hole[i] ? 1 : 0;
  return out;
}

/** 掩码降采样：hole 用「任一子像素命中」，sample 用「全部子像素允许」，后者更保守。 */
export function downsampleMasks(
  hole: Uint8Array,
  sample: Uint8Array,
  w: number,
  h: number,
  nw: number,
  nh: number,
): { hole: Uint8Array; sample: Uint8Array } {
  const outHole = new Uint8Array(nw * nh);
  const outSample = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y += 1) {
    for (let x = 0; x < nw; x += 1) {
      const sx0 = Math.floor((x * w) / nw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * w) / nw));
      const sy0 = Math.floor((y * h) / nh);
      const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * h) / nh));
      let anyHole = 0;
      let allSample = 1;
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          const i = Math.min(h - 1, sy) * w + Math.min(w - 1, sx);
          if (hole[i]) anyHole = 1;
          if (!sample[i]) allSample = 0;
        }
      }
      outHole[y * nw + x] = anyHole;
      outSample[y * nw + x] = allSample;
    }
  }
  return { hole: outHole, sample: outSample };
}

/** 统计掩码里 1 的个数，工作区用它提示「取样区不足」。 */
export function countMask(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) n += 1;
  return n;
}
