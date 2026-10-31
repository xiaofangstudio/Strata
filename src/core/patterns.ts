/**
 * 图案库（编辑 > 定义图案 / 图层 > 新建填充图层 > 图案）。
 *
 * 图案就是一张小图，铺满画布时按 repeat 平铺。这里存两样东西：
 * - **内存里的 canvas**：铺图时直接 `createPattern` 用，同步、不用等解码；
 * - **localStorage 里的 data URL**：下次启动还在，启动时异步解回来。
 *
 * 上限 12 条：图案是用户自己截的色块/纹理，体积小但数量没必要无限；
 * 超出就丢最旧的一条（FIFO），和画笔预设的 24 条上限是同一套思路。
 */
import { createSurface, mustCtx, readPixels } from "../engine/surface";
import { contentBounds } from "../engine/warp";
import type { StrataDoc } from "./document";

const STORAGE_KEY = "strata.patterns";
const MAX_PATTERNS = 12;

export interface PatternEntry {
  id: string;
  name: string;
  /** 已解码的小图（同步可用来平铺） */
  canvas: HTMLCanvasElement;
}

interface StoredPattern {
  id: string;
  name: string;
  dataUrl: string;
}

let entries: PatternEntry[] = [];
let loaded = false;

function readStored(): StoredPattern[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as StoredPattern[];
    return Array.isArray(list) ? list.filter((p) => p && typeof p.dataUrl === "string") : [];
  } catch {
    return [];
  }
}

function writeStored(): void {
  try {
    const list: StoredPattern[] = entries.map((e) => ({
      id: e.id,
      name: e.name,
      dataUrl: e.canvas.toDataURL("image/png"),
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* 存储满或不可用时放弃持久化，本次会话仍可用 */
  }
}

/** 启动时把上次存的图案解回 canvas（异步，失败就跳过这一条）。 */
export function loadPatterns(): void {
  if (loaded) return;
  loaded = true;
  const stored = readStored();
  if (stored.length === 0) return;
  for (const p of stored) {
    const img = new Image();
    img.onload = () => {
      const c = createSurface(img.width, img.height);
      mustCtx(c).drawImage(img, 0, 0);
      entries = [...entries, { id: p.id, name: p.name, canvas: c }];
    };
    img.src = p.dataUrl;
  }
}

/** 当前图案列表（最新的在前）。 */
export function patternList(): PatternEntry[] {
  return entries;
}

/** 最新一条图案，供「图案填充」直接用。 */
export function latestPattern(): HTMLCanvasElement | null {
  return entries.length > 0 ? entries[0].canvas : null;
}

/**
 * 定义图案：把活动图层里「选区范围（没有选区就取内容范围）」截下来存进图案库。
 * 返回新图案的名字；截不到东西时返回 null。
 */
export function definePattern(doc: StrataDoc, name?: string): string | null {
  const layer = doc.layers.find((l) => l.id === doc.activeLayerId);
  if (!layer || layer.kind !== "pixel") return null;

  let box = contentBounds(layer.surface);
  if (doc.selection) {
    // 有选区时以选区外接框为准（与 PS 的「定义图案」一致）
    const sel = readPixels(doc.selection);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < sel.height; y += 1) {
      for (let x = 0; x < sel.width; x += 1) {
        if (sel.data[(y * sel.width + x) * 4 + 3] > 127) {
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 >= x0 && y1 >= y0) box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  if (!box || box.w < 1 || box.h < 1) return null;

  const c = createSurface(box.w, box.h);
  mustCtx(c).drawImage(layer.surface, -box.x, -box.y);
  const id = `pat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const label = name?.trim() || `图案 ${entries.length + 1}`;
  entries = [{ id, name: label, canvas: c }, ...entries].slice(0, MAX_PATTERNS);
  writeStored();
  return label;
}
