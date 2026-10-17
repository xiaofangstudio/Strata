/**
 * 颜色小工具：十六进制 ⇄ RGB ⇄ HSV，外加一排常用色。
 *
 * 只做纯计算，不碰 DOM —— 拾色器（ColorPicker）、选项条（controls）都从这里取。
 */

/** HSV：h 0–360，s / v 0–1。 */
export interface HSV {
  h: number;
  s: number;
  v: number;
}

/**
 * 常用色：两排 16 色 —— 明暗轴 + 色相环上最容易直接拿来用的原色。
 * 拾色器浮层空间有限，只放这一组；完整色板见 `STANDARD_SWATCHES`。
 */
export const COLOR_PRESETS: string[] = [
  "#000000",
  "#333333",
  "#666666",
  "#999999",
  "#cccccc",
  "#ffffff",
  "#e53935",
  "#fb8c00",
  "#fdd835",
  "#43a047",
  "#00acc1",
  "#1e88e5",
  "#3949ab",
  "#8e24aa",
  "#d81b60",
  "#795548",
];

/**
 * 标准色板：10 级灰阶 + 12 色相 × 5 档明度 / 饱和度，共 70 色。
 * 常驻调色面板直接铺成 12 列，和 PS 的「色板」面板一样一眼能挑到需要的色。
 */
const GRAY_RAMP = [
  "#000000",
  "#1a1a1a",
  "#333333",
  "#4d4d4d",
  "#666666",
  "#808080",
  "#999999",
  "#b3b3b3",
  "#cccccc",
  "#ffffff",
];

/** 每一档：淡 → 亮 → 纯 → 深 → 暗。 */
const SWATCH_LEVELS = [
  { s: 0.25, v: 1 },
  { s: 0.55, v: 1 },
  { s: 1, v: 1 },
  { s: 1, v: 0.72 },
  { s: 0.7, v: 0.45 },
];

/** 色相环上等距的 12 个角度。 */
const SWATCH_HUES = Array.from({ length: 12 }, (_, i) => i * 30);

export const STANDARD_SWATCHES: string[] = [
  ...GRAY_RAMP,
  ...SWATCH_LEVELS.flatMap((lv) => SWATCH_HUES.map((h) => hsvToHex(h, lv.s, lv.v))),
];

/** `#rgb` / `#rrggbb` / 不带 `#` 都能收，其余一律判为非法。 */
export function normalizeHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`.toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
  return null;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = normalizeHex(hex) ?? "#000000";
  return {
    r: parseInt(h.slice(1, 3), 16),
    g: parseInt(h.slice(3, 5), 16),
    b: parseInt(h.slice(5, 7), 16),
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function rgbToHsv(r: number, g: number, b: number): HSV {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

export function hexToHsv(hex: string): HSV {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHsv(r, g, b);
}

export function hsvToHex(h: number, s: number, v: number): string {
  const { r, g, b } = hsvToRgb(h, s, v);
  return rgbToHex(r, g, b);
}
