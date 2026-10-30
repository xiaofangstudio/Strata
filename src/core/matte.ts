/**
 * 修边（matting）像素算法。
 *
 * 全部写成对 RGBA 数组的原地纯运算，不碰 canvas —— 这样 node 环境可以直接
 * 对小数组断言，UI 层只负责把图层的 ImageData 递进来。
 *
 * 语义对照 Photoshop 的「图层 > 修边」：
 *   - 移去黑色 / 白色杂边：按 alpha 反预乘对应底色；
 *   - 去边：半透明边缘像素取最近不透明邻居的颜色，保留自身 alpha；
 *   - 净化颜色：半透明像素按透明度向邻域更不透明的颜色靠拢。
 */

/** 移去黑色杂边：c' = c / a（预乘黑色的反运算）。 */
export function removeBlackMatteData(d: Uint8ClampedArray): void {
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    if (a <= 0 || a >= 1) continue;
    d[i] = d[i] / a;
    d[i + 1] = d[i + 1] / a;
    d[i + 2] = d[i + 2] / a;
  }
}

/**
 * 移去白色杂边：c' = (c − 255·(1 − a)) / a。
 * 白色合成式为 c_out = c·a + 255·(1 − a)，反解即得。
 */
export function removeWhiteMatteData(d: Uint8ClampedArray): void {
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    if (a <= 0 || a >= 1) continue;
    const inv = 255 * (1 - a);
    d[i] = (d[i] - inv) / a;
    d[i + 1] = (d[i + 1] - inv) / a;
    d[i + 2] = (d[i + 2] - inv) / a;
  }
}

/**
 * 去边：半透明边缘像素取最近的不透明邻居颜色（切比雪夫距离，由近及远）。
 * alpha 保持不变 —— 只换颜色，不改透明度。
 */
export function defringeData(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  radius = 2,
): void {
  const src = new Uint8ClampedArray(d);
  const r0 = Math.max(1, Math.round(radius));
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const a = src[o + 3];
      if (a <= 0 || a >= 250) continue;
      let found = -1;
      for (let r = 1; r <= r0 && found < 0; r += 1) {
        for (let dy = -r; dy <= r && found < 0; dy += 1) {
          for (let dx = -r; dx <= r && found < 0; dx += 1) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const so = (ny * w + nx) * 4;
            if (src[so + 3] >= 250) found = so;
          }
        }
      }
      if (found >= 0) {
        d[o] = src[found];
        d[o + 1] = src[found + 1];
        d[o + 2] = src[found + 2];
      }
    }
  }
}

/** 净化颜色：半透明像素按 (1 − a) 的权重向邻域更不透明的颜色靠拢。 */
export function decontaminateData(
  d: Uint8ClampedArray,
  w: number,
  h: number,
): void {
  const src = new Uint8ClampedArray(d);
  const nb: readonly [number, number][] = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const a = src[o + 3] / 255;
      if (a <= 0 || a >= 1) continue;
      let best = -1;
      let bestA = a;
      for (const [dx, dy] of nb) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const so = (ny * w + nx) * 4;
        const na = src[so + 3] / 255;
        if (na > bestA) {
          bestA = na;
          best = so;
        }
      }
      if (best < 0) continue;
      const t = 1 - a;
      d[o] = src[o] * (1 - t) + src[best] * t;
      d[o + 1] = src[o + 1] * (1 - t) + src[best + 1] * t;
      d[o + 2] = src[o + 2] * (1 - t) + src[best + 2] * t;
    }
  }
}
