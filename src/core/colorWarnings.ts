/**
 * 拾色器的两类警告（纯函数，不碰 DOM）：
 *   · 网页安全色：RGB 三通道都落在 {0,51,102,153,204,255} 这 216 色立方体上；
 *   · 超出印刷色域：用 HSL 彩度 / 亮度包络近似 CMYK 可达范围，越界即警告。
 *
 * 真实印刷需要 ICC（项目已有 CMS 管线），这里不假装做精确分色 —— 只做
 * 「这颜色大概率打不出来」的即时提示，并给出可一键应用的修正值。
 */

export interface ColorWarnings {
  webSafe: boolean;
  outOfGamut: boolean;
  nearestWebSafe: string;
  nearestGamut: string;
}

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const hex2 = (v: number) => clamp255(v).toString(16).padStart(2, "0");
const toHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

export function parseHexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function isWebSafe(hex: string): boolean {
  return parseHexRgb(hex).every((v) => v % 51 === 0);
}

export function nearestWebSafe(hex: string): string {
  const rgb = parseHexRgb(hex).map((v) => clamp255(Math.round(v / 51) * 51));
  return toHex(rgb[0], rgb[1], rgb[2]);
}

/**
 * 近似 CMYK 色域：以 HSL 的亮度 / 彩度建模。CMYK 四色油墨在亮部和暗部都
 * 撑不起高彩度，所以最大彩度随亮度远离 0.5 而收紧；纯红 / 纯绿 / 纯蓝这种
 * 屏幕原色会被判为界外，柔和的中间调则保留。真要精确分色请走项目 ICC 管线。
 */
export function isPrintableApprox(hex: string): boolean {
  const [r, g, b] = parseHexRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const L = (max + min) / 2;
  const C = max - min;
  const maxChroma = 0.76 - 0.52 * Math.abs(L - 0.5);
  return C <= maxChroma;
}

/**
 * 找同色相、降低彩度后第一个「可印刷」的颜色。
 * 二分的是往中性灰退让的比例，永远收敛，也不会改变明暗关系。
 */
export function nearestPrintable(hex: string): string {
  const [r, g, b] = parseHexRgb(hex).map((v) => v / 255);
  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
  const mix = (t: number) =>
    toHex(
      (gray + (r - gray) * t) * 255,
      (gray + (g - gray) * t) * 255,
      (gray + (b - gray) * t) * 255,
    );
  if (isPrintableApprox(hex)) return hex;
  let lo = 0; // 纯灰，必然可打印
  let hi = 1;
  for (let i = 0; i < 16; i += 1) {
    const mid = (lo + hi) / 2;
    if (!isPrintableApprox(mix(mid))) hi = mid;
    else lo = mid;
  }
  return mix(lo);
}

export function colorWarnings(hex: string): ColorWarnings {
  return {
    webSafe: isWebSafe(hex),
    outOfGamut: !isPrintableApprox(hex),
    nearestWebSafe: nearestWebSafe(hex),
    nearestGamut: nearestPrintable(hex),
  };
}
