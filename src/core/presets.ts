/**
 * 新建画布的尺寸边界与常用预设。
 *
 * 开始页面与编辑界面里的「新建画布」共用同一份定义，避免两处各写一套
 * 数字、日后改不动。
 */

export interface CanvasPreset {
  key: string;
  label: string;
  w: number;
  h: number;
  dpi?: number;
}

export const PRESETS: CanvasPreset[] = [
  { key: "fhd", label: "全高清", w: 1920, h: 1080 },
  { key: "square", label: "方形", w: 1080, h: 1080 },
  { key: "portrait", label: "竖版", w: 1080, h: 1920 },
  { key: "uhd", label: "4K", w: 3840, h: 2160 },
  { key: "a4", label: "A4 印刷", w: 2480, h: 3508, dpi: 300 },
];

export const MIN_SIDE = 1;
export const MAX_SIDE = 16384;
export const MIN_DPI = 1;
export const MAX_DPI = 2400;
export const DEFAULT_DPI = "72";

/** 画布底色。这是画布内容本身，不是界面颜色，故不走主题令牌。 */
export const CANVAS_WHITE = "#ffffff";
