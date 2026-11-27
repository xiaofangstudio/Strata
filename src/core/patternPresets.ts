/**
 * 内置图案预设（对照新版 PhotoCraft 的 Pattern Overlay preset picker）。
 *
 * 以前「图案叠加」只是代码画的棋盘格，用户选不了图案。这里给出一组真正
 * 可平铺的确定性图案描述；渲染函数只依赖传入的 2D context，既能画 48px
 * 缩略图，也能画平铺用的 tile，node 测试用假 context 就能钉死绘制行为。
 */

export type PatternPresetKind =
  | "checker"
  | "dots"
  | "stripes"
  | "grid"
  | "noise"
  | "bricks"
  | "waves"
  | "weave"
  | "cross";

export type PatternPresetGroup = "basic" | "texture" | "fabric";

export interface PatternPreset {
  id: PatternPresetKind;
  /** i18n key 名（zh.panel.patternNames.<id>），不在 core 写死中文 */
  labelKey: PatternPresetKind;
  group: PatternPresetGroup;
  colors: readonly [string, string];
  cell: number;
  kind: PatternPresetKind;
}

export const PATTERN_PRESETS: readonly PatternPreset[] = [
  { id: "checker", labelKey: "checker", group: "basic", colors: ["#ffffff", "#303030"], cell: 12, kind: "checker" },
  { id: "dots", labelKey: "dots", group: "basic", colors: ["#f5f2e8", "#2f6fbf"], cell: 14, kind: "dots" },
  { id: "stripes", labelKey: "stripes", group: "basic", colors: ["#fff7e6", "#c4512f"], cell: 10, kind: "stripes" },
  { id: "grid", labelKey: "grid", group: "basic", colors: ["#f2f6ff", "#5a7ea6"], cell: 12, kind: "grid" },
  { id: "noise", labelKey: "noise", group: "texture", colors: ["#ded9cf", "#5d5548"], cell: 8, kind: "noise" },
  { id: "bricks", labelKey: "bricks", group: "texture", colors: ["#efe3d4", "#a65b46"], cell: 16, kind: "bricks" },
  { id: "waves", labelKey: "waves", group: "texture", colors: ["#e4f3f7", "#3b8ea5"], cell: 16, kind: "waves" },
  { id: "weave", labelKey: "weave", group: "fabric", colors: ["#e9dfcf", "#8a775c"], cell: 12, kind: "weave" },
  { id: "cross", labelKey: "cross", group: "fabric", colors: ["#f4eefa", "#7957a4"], cell: 12, kind: "cross" },
];

export const PATTERN_GROUP_ORDER: readonly PatternPresetGroup[] = ["basic", "texture", "fabric"];

export function findPatternPreset(id: string | null | undefined): PatternPreset | null {
  if (!id) return null;
  const key = id.startsWith("builtin:") ? id.slice(8) : id;
  return PATTERN_PRESETS.find((p) => p.id === key) ?? null;
}

export function patternPresetsByGroup(group: PatternPresetGroup): PatternPreset[] {
  return PATTERN_PRESETS.filter((p) => p.group === group);
}

/** 稳定哈希，别用 Math.random：同一预设每次画出的缩略图必须一样。 */
function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** 把预设画进任意 2D context。size 是 tiles 边长，图案按自身 cell 缩放。 */
export function drawPatternPreset(ctx: CanvasRenderingContext2D, preset: PatternPreset, size = 48): void {
  const cell = Math.max(3, (preset.cell * size) / 48);
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = preset.colors[0];
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = preset.colors[1];
  ctx.strokeStyle = preset.colors[1];
  ctx.lineWidth = Math.max(1, cell / 8);

  switch (preset.kind) {
    case "checker":
      for (let y = 0; y < size; y += cell) {
        for (let x = 0; x < size; x += cell) {
          if ((Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0) {
            ctx.fillRect(x, y, cell, cell);
          }
        }
      }
      break;
    case "dots":
      for (let y = cell / 2; y < size + cell; y += cell) {
        for (let x = cell / 2; x < size + cell; x += cell) {
          ctx.beginPath();
          ctx.arc(x, y, cell * 0.26, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    case "stripes":
      for (let x = 0; x < size; x += cell) {
        ctx.fillRect(x, 0, cell / 2, size);
      }
      break;
    case "grid":
      for (let p = 0; p <= size; p += cell) {
        ctx.fillRect(p, 0, ctx.lineWidth, size);
        ctx.fillRect(0, p, size, ctx.lineWidth);
      }
      break;
    case "noise":
      for (let y = 0; y < size; y += cell / 2) {
        for (let x = 0; x < size; x += cell / 2) {
          const v = hash(Math.round(x), Math.round(y));
          if (v > 0.46) ctx.fillRect(x, y, Math.max(1, cell / 3), Math.max(1, cell / 3));
        }
      }
      break;
    case "bricks": {
      const bh = cell / 2;
      for (let row = 0, y = 0; y < size; row += 1, y += bh) {
        const offset = row % 2 === 0 ? 0 : cell / 2;
        for (let x = -offset; x < size; x += cell) {
          ctx.fillRect(x, y, cell - ctx.lineWidth, bh - ctx.lineWidth);
        }
      }
      break;
    }
    case "waves":
      for (let y = 0; y < size; y += cell) {
        ctx.beginPath();
        for (let x = 0; x <= size; x += 2) {
          const py = y + Math.sin((x / cell) * Math.PI) * (cell * 0.28);
          if (x === 0) ctx.moveTo(x, py);
          else ctx.lineTo(x, py);
        }
        ctx.lineWidth = Math.max(1, cell / 6);
        ctx.stroke();
      }
      break;
    case "weave":
      for (let y = 0; y < size; y += cell) {
        for (let x = 0; x < size; x += cell) {
          const warp = ((Math.floor(x / cell) + Math.floor(y / cell)) % 2) === 0;
          ctx.fillRect(x + (warp ? cell * 0.2 : 0), y, cell * 0.6, cell * 0.35);
          ctx.fillRect(x, y + (warp ? cell * 0.55 : cell * 0.2), cell * 0.35, cell * 0.6);
        }
      }
      break;
    case "cross":
      for (let y = cell / 2; y < size + cell; y += cell) {
        for (let x = cell / 2; x < size + cell; x += cell) {
          ctx.fillRect(x - cell * 0.08, y - cell * 0.32, cell * 0.16, cell * 0.64);
          ctx.fillRect(x - cell * 0.32, y - cell * 0.08, cell * 0.64, cell * 0.16);
        }
      }
      break;
  }
}
