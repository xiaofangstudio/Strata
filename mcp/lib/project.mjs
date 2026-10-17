/**
 * .strata 工程读写与校验（零依赖，纯 Node）。
 *
 * 严格对齐 src/engine/project.ts 的落盘格式（v3）：
 *   { magic, version, name, width, height, dpi?, active, layers:[FileLayer], selection? }
 *   FileLayer: { name, visible, opacity, blend, locked, kind, adjust?, maskActive,
 *                clip?, styles?, surface?, mask? }
 *
 * 本模块同时承载「内存中的工程对象」操作（增删改层、校验、摘要），
 * 供主服务器与 --selftest 复用。
 */
import fs from "node:fs";
import path from "node:path";
import {
  ADJUST_DEFS,
  ADJUST_IDS,
  BLEND_IDS,
  BLEND_MODES,
  CANVAS_LIMITS,
  DEFAULT_CURVE,
  DEFAULT_STOPS,
  MAGIC,
  PROJECT_EXTENSION,
  PROJECT_VERSION,
  STYLE_DEFS,
  STYLE_IDS,
} from "./capabilities.mjs";

/** 工具调用可预期的错误：message 会原样作为中文说明返回给调用方。 */
export class ToolError extends Error {}

const BLEND_LABEL = new Map(BLEND_MODES.map((b) => [b.id, b.label]));
const ADJUST_DEF_MAP = new Map(ADJUST_DEFS.map((d) => [d.id, d]));
const STYLE_DEF_MAP = new Map(STYLE_DEFS.map((s) => [s.id, s]));
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 是否是一段合法的 base64 文本（非空、字符集合法、无空白）。 */
export function isValidBase64(s) {
  if (typeof s !== "string" || s.length === 0) return false;
  if (!BASE64_RE.test(s)) return false;
  return s.length % 4 === 0;
}

/** base64 解码后是否以 PNG 文件头（8 字节魔数）开头。 */
export function isPngBase64(b64) {
  if (!isValidBase64(b64)) return false;
  let buf;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return false;
  }
  if (buf.length < 8) return false;
  for (let i = 0; i < 8; i += 1) if (buf[i] !== PNG_SIG[i]) return false;
  return true;
}

function clampTo(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/* ------------------------------------------------ 调整状态规范化 */

/** 规范化一份 AdjustState：校验 id，补默认参数并把越界值夹到范围内。 */
export function normalizeAdjust(input) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(input)) {
    return { ok: false, adjust: null, errors: ["adjust 必须是对象"], warnings };
  }
  const id = input.id;
  if (!ADJUST_IDS.includes(id)) {
    return {
      ok: false,
      adjust: null,
      errors: [`未知的调整类型 id：「${id ?? "(缺失)"}」，合法值见调整类型清单`],
      warnings,
    };
  }
  const def = ADJUST_DEF_MAP.get(id);
  const params = {};
  const given = isPlainObject(input.params) ? input.params : {};
  for (const p of def.params) {
    let v = given[p.id];
    if (v === undefined) {
      v = p.def;
    } else if (typeof v !== "number" || !Number.isFinite(v)) {
      errors.push(`调整「${def.label}」的参数 ${p.id}（${p.label}）必须是数字`);
      v = p.def;
    } else if (v < p.min || v > p.max) {
      warnings.push(
        `调整「${def.label}」的参数 ${p.id}（${p.label}）取值 ${v} 超出范围 [${p.min}, ${p.max}]，已夹到边界`,
      );
      v = clampTo(v, p.min, p.max);
    }
    if (p.dec === 0) v = Math.round(v);
    params[p.id] = v;
  }
  for (const key of Object.keys(given)) {
    if (!def.params.some((p) => p.id === key)) {
      warnings.push(`调整「${def.label}」忽略了不存在的参数：${key}`);
    }
  }

  const adjust = { id, params };
  if (id === "curves") {
    const pts = Array.isArray(input.curve) ? input.curve : DEFAULT_CURVE;
    const clean = [];
    for (const [i, pt] of pts.entries()) {
      if (!isPlainObject(pt) || typeof pt.x !== "number" || typeof pt.y !== "number") {
        errors.push(`曲线第 ${i + 1} 个控制点必须是 { x, y } 数字对象`);
        continue;
      }
      clean.push({ x: clampTo(pt.x, 0, 1), y: clampTo(pt.y, 0, 1) });
    }
    if (clean.length < 2) {
      errors.push("曲线至少需要 2 个控制点");
    } else {
      clean.sort((a, b) => a.x - b.x);
      adjust.curve = clean;
    }
  }
  if (id === "gradientmap") {
    const stops = Array.isArray(input.stops) ? input.stops : DEFAULT_STOPS;
    const clean = [];
    for (const [i, st] of stops.entries()) {
      if (!isPlainObject(st) || typeof st.at !== "number" || typeof st.color !== "string" || !HEX_RE.test(st.color)) {
        errors.push(`渐变映射第 ${i + 1} 个色标必须是 { at:number, color:"#rrggbb" }`);
        continue;
      }
      clean.push({ at: clampTo(st.at, 0, 1), color: st.color });
    }
    if (clean.length < 2) {
      errors.push("渐变映射至少需要 2 个色标");
    } else {
      clean.sort((a, b) => a.at - b.at);
      adjust.stops = clean;
    }
  }

  return { ok: errors.length === 0, adjust, errors, warnings };
}

/* ------------------------------------------------ 图层样式规范化 */

function normalizeStyle(input, i) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { ok: false, style: null, errors: [`第 ${i + 1} 个样式必须是对象`] };
  }
  if (!STYLE_IDS.includes(input.id)) {
    return { ok: false, style: null, errors: [`未知的图层样式 id：「${input.id ?? "(缺失)"}」`] };
  }
  const d = STYLE_DEF_MAP.get(input.id);
  const color = typeof input.color === "string" && HEX_RE.test(input.color) ? input.color : d.color;
  const num = (v, fallback, min, max) =>
    typeof v === "number" && Number.isFinite(v) ? clampTo(v, min, max) : fallback;
  const style = {
    id: d.id,
    enabled: input.enabled === undefined ? true : !!input.enabled,
    color,
    opacity: num(input.opacity, d.opacity0, 0, 100),
    size: num(input.size, d.size0, 0, d.sizeMax || 0),
    distance: num(input.distance, d.distance0, 0, 1000),
    angle: num(input.angle, d.angle0, 0, 360),
    spread: num(input.spread, 0, 0, 100),
    blend: BLEND_IDS.includes(input.blend) ? input.blend : d.blend0,
    position: typeof input.position === "number" && input.position >= 0 && input.position <= 2
      ? Math.round(input.position)
      : 0,
  };
  return { ok: true, style, errors };
}

/* ------------------------------------------------ FileLayer 规范化 */

/**
 * 把一个 manifest 里的图层对象规范成 FileLayer。
 * @param {object} input 用户给的图层描述
 * @param {number} i 图层序号（用于错误定位与默认命名）
 */
export function normalizeLayer(input, i) {
  const errors = [];
  const warnings = [];
  const at = i + 1;
  if (!isPlainObject(input)) {
    return { ok: false, layer: null, errors: [`第 ${at} 个图层必须是对象`], warnings };
  }

  const kind = input.kind === undefined ? "pixel" : input.kind;
  if (!["pixel", "adjust"].includes(kind)) {
    errors.push(`第 ${at} 个图层 kind 必须是 "pixel" 或 "adjust"`);
  }

  const name = typeof input.name === "string" && input.name.length > 0 ? input.name : `图层 ${at}`;

  let blend = input.blend === undefined ? "normal" : input.blend;
  if (!BLEND_IDS.includes(blend)) {
    errors.push(`第 ${at} 个图层（${name}）使用了未知混合模式：「${blend}」`);
    blend = "normal";
  }

  let opacity = input.opacity === undefined ? 100 : input.opacity;
  if (typeof opacity !== "number" || !Number.isFinite(opacity)) {
    errors.push(`第 ${at} 个图层（${name}）的不透明度必须是数字`);
    opacity = 100;
  } else if (opacity < 0 || opacity > 100) {
    warnings.push(`第 ${at} 个图层（${name}）不透明度 ${opacity} 超出 0–100，已夹到边界`);
    opacity = clampTo(opacity, 0, 100);
  }

  let adjust;
  if (kind === "adjust") {
    if (!isPlainObject(input.adjust)) {
      errors.push(`调整层（${name}）缺少 adjust 字段`);
    } else {
      const r = normalizeAdjust(input.adjust);
      errors.push(...r.errors.map((e) => `第 ${at} 层：${e}`));
      warnings.push(...r.warnings.map((w) => `第 ${at} 层：${w}`));
      if (r.ok) adjust = r.adjust;
    }
    if (input.surface !== undefined) {
      warnings.push(`第 ${at} 层是调整层，surface 会被忽略（调整层不占像素）`);
    }
    if (input.clip) {
      errors.push(`调整层（${name}）不支持剪贴蒙版`);
    }
  }

  let styles;
  if (input.styles !== undefined) {
    if (kind === "adjust") {
      errors.push(`调整层（${name}）不支持图层样式`);
    } else if (!Array.isArray(input.styles)) {
      errors.push(`第 ${at} 层（${name}）的 styles 必须是数组`);
    } else {
      styles = [];
      for (const [si, st] of input.styles.entries()) {
        const r = normalizeStyle(st, si);
        errors.push(...r.errors.map((e) => `第 ${at} 层：${e}`));
        if (r.ok) styles.push(r.style);
      }
    }
  }

  let surface;
  let surfaceMeta;
  if (kind === "pixel" && input.surface !== undefined) {
    const s = input.surface;
    if (typeof s !== "string") {
      errors.push(`第 ${at} 层（${name}）的 surface 必须是 base64 字符串`);
    } else if (!isValidBase64(s)) {
      errors.push(`第 ${at} 层（${name}）的 surface 不是合法 base64`);
    } else if (!isPngBase64(s)) {
      errors.push(`第 ${at} 层（${name}）的 surface 不是合法 PNG（文件头校验失败）`);
    } else {
      surface = s;
      surfaceMeta = { bytes: Buffer.from(s, "base64").length, base64Length: s.length };
    }
  }

  let mask;
  if (input.mask !== undefined) {
    const m = input.mask;
    if (typeof m !== "string" || !isPngBase64(m)) {
      errors.push(`第 ${at} 层（${name}）的 mask 不是合法 PNG base64`);
    } else {
      mask = m;
    }
  }

  if (errors.length > 0) {
    return { ok: false, layer: null, errors, warnings };
  }

  // 严格按 project.ts 的 FileLayer 字段顺序落盘
  const layer = {
    name,
    visible: input.visible === undefined ? true : !!input.visible,
    opacity: Math.round(opacity),
    blend,
    locked: input.locked === undefined ? false : !!input.locked,
    kind,
  };
  if (kind === "adjust") layer.adjust = adjust;
  layer.maskActive = input.maskActive === undefined ? false : !!input.maskActive;
  if (input.clip === true) layer.clip = true;
  if (styles && styles.length > 0) layer.styles = styles;
  if (kind === "pixel" && surface) layer.surface = surface;
  if (mask) layer.mask = mask;

  return { ok: true, layer, errors, warnings, surfaceMeta };
}

/* ------------------------------------------------ 工程整体规范化 */

/**
 * 由 manifest 组装一份完整合法的 .strata 工程对象。
 * 自动补 magic / version，校验尺寸与必填项。
 * @returns {{ok:boolean, file:object|null, errors:string[], warnings:string[]}}
 */
export function buildProjectFile(manifest) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(manifest)) {
    return { ok: false, file: null, errors: ["manifest 必须是对象"], warnings };
  }

  const width = manifest.width;
  const height = manifest.height;
  for (const [key, v] of [["width", width], ["height", height]]) {
    if (!Number.isInteger(v)) {
      errors.push(`${key} 必须是整数`);
    } else if (v < CANVAS_LIMITS.minSide || v > CANVAS_LIMITS.maxSide) {
      errors.push(`${key} 必须在 ${CANVAS_LIMITS.minSide}–${CANVAS_LIMITS.maxSide} 之间（当前 ${v}）`);
    }
  }

  let dpi;
  if (manifest.dpi !== undefined) {
    if (!Number.isInteger(manifest.dpi) || manifest.dpi < CANVAS_LIMITS.minDpi || manifest.dpi > CANVAS_LIMITS.maxDpi) {
      errors.push(`dpi 若是整数且必须在 ${CANVAS_LIMITS.minDpi}–${CANVAS_LIMITS.maxDpi} 之间`);
    } else {
      dpi = manifest.dpi;
    }
  }

  if (!Array.isArray(manifest.layers) || manifest.layers.length === 0) {
    errors.push("layers 必须是非空数组");
    return { ok: false, file: null, errors, warnings };
  }

  const layers = [];
  manifest.layers.forEach((raw, i) => {
    const r = normalizeLayer(raw, i);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    if (r.ok) layers.push(r.layer);
  });

  if (errors.length > 0) {
    return { ok: false, file: null, errors, warnings };
  }

  let active = manifest.active;
  if (active === undefined) {
    active = 0;
  } else if (!Number.isInteger(active) || active < 0 || active >= layers.length) {
    warnings.push(`active=${active} 超出图层范围，已改为 0`);
    active = 0;
  }

  let selection;
  if (manifest.selection !== undefined) {
    if (!isPngBase64(manifest.selection)) {
      errors.push("selection 不是合法 PNG base64");
    } else {
      selection = manifest.selection;
    }
  }
  if (errors.length > 0) return { ok: false, file: null, errors, warnings };

  const file = {
    magic: MAGIC,
    version: PROJECT_VERSION,
    name: typeof manifest.name === "string" && manifest.name.length > 0 ? manifest.name : "未命名",
    width,
    height,
  };
  if (dpi !== undefined) file.dpi = dpi;
  file.active = active;
  file.layers = layers;
  if (selection) file.selection = selection;

  return { ok: true, file, errors, warnings };
}

/* ------------------------------------------------ 摘要（默认剔除像素） */

function summarizeSurface(b64) {
  return {
    present: true,
    bytes: Buffer.from(b64, "base64").length,
    base64Length: b64.length,
    pngOk: isPngBase64(b64),
  };
}

function summarizeAdjust(adjust) {
  const def = ADJUST_DEF_MAP.get(adjust.id);
  const out = {
    id: adjust.id,
    label: def ? def.label : adjust.id,
    family: def ? def.family : "unknown",
    params: adjust.params,
  };
  if (adjust.curve) out.curve = adjust.curve;
  if (adjust.stops) out.stops = adjust.stops;
  return out;
}

/**
 * 单层摘要。includePixels 为 false 时像素只给统计信息，不回传 base64。
 */
export function summarizeLayer(fl, index, includePixels = false) {
  const kind = fl.kind === "adjust" ? "adjust" : "pixel";
  const out = {
    index,
    name: fl.name,
    kind,
    visible: fl.visible !== false,
    opacity: typeof fl.opacity === "number" ? fl.opacity : 100,
    blend: fl.blend ?? "normal",
    blendLabel: BLEND_LABEL.get(fl.blend) ?? "正常",
    locked: !!fl.locked,
    maskActive: !!fl.maskActive,
    clip: !!fl.clip,
    hasMask: typeof fl.mask === "string",
  };
  if (Array.isArray(fl.styles) && fl.styles.length > 0) {
    out.styles = fl.styles.map((s) => ({
      id: s.id,
      label: (STYLE_DEF_MAP.get(s.id) || {}).label ?? s.id,
      enabled: s.enabled !== false,
      color: s.color,
      opacity: s.opacity,
      size: s.size,
      distance: s.distance,
      angle: s.angle,
      spread: s.spread,
      blend: s.blend,
      position: s.position,
    }));
  } else {
    out.styles = [];
  }
  if (kind === "adjust" && isPlainObject(fl.adjust)) {
    out.adjust = summarizeAdjust(fl.adjust);
  }
  if (kind === "pixel") {
    const surface = typeof fl.surface === "string" ? fl.surface : null;
    out.surface = surface ? summarizeSurface(surface) : { present: false };
    if (includePixels && surface) out.surface.base64 = surface;
  }
  if (typeof fl.mask === "string") {
    out.mask = summarizeSurface(fl.mask);
    if (includePixels) out.mask.base64 = fl.mask;
  }
  return out;
}

/** 整份工程摘要。 */
export function summarizeProject(file, includePixels = false, extra = {}) {
  const layers = Array.isArray(file.layers) ? file.layers : [];
  return {
    ...extra,
    name: file.name,
    width: file.width,
    height: file.height,
    dpi: file.dpi,
    active: file.active,
    activeLayerName: layers[file.active] ? layers[file.active].name : null,
    layerCount: layers.length,
    pixelLayerCount: layers.filter((l) => l.kind !== "adjust").length,
    adjustLayerCount: layers.filter((l) => l.kind === "adjust").length,
    selection: typeof file.selection === "string" ? summarizeSurface(file.selection) : { present: false },
    includePixels,
    layers: layers.map((fl, i) => summarizeLayer(fl, i, includePixels)),
  };
}

/* ------------------------------------------------ 合法性校验 */

/**
 * 校验一份工程对象，返回问题列表。
 * @returns {{valid:boolean, issues:Array, counts:object}}
 */
export function validateProject(file) {
  const issues = [];
  const add = (level, code, p, message) => issues.push({ level, code, path: p, message });

  if (!isPlainObject(file)) {
    add("error", "not-object", "", "工程根节点必须是对象");
    return finalize(issues);
  }
  if (file.magic !== MAGIC) {
    add("error", "magic", "magic", `缺少或错误的 magic，应为「${MAGIC}」，实际「${file.magic ?? "(缺失)"}」`);
  }
  if (typeof file.version !== "number" || !Number.isInteger(file.version)) {
    add("error", "version", "version", "version 必须是整数");
  } else if (file.version > PROJECT_VERSION) {
    add("error", "version-too-high", "version", `版本 ${file.version} 高于当前支持的 ${PROJECT_VERSION}`);
  } else if (file.version < 1) {
    add("error", "version", "version", `版本 ${file.version} 非法`);
  }
  if (typeof file.name !== "string" || file.name.length === 0) {
    add("warning", "name", "name", "name 缺失或为空，打开时会显示为空标题");
  }
  for (const key of ["width", "height"]) {
    const v = file[key];
    if (!Number.isInteger(v)) {
      add("error", "size", key, `${key} 必须是整数（当前 ${JSON.stringify(v)}）`);
    } else if (v < CANVAS_LIMITS.minSide || v > CANVAS_LIMITS.maxSide) {
      add("error", "size", key, `${key} 必须在 ${CANVAS_LIMITS.minSide}–${CANVAS_LIMITS.maxSide} 之间（当前 ${v}）`);
    }
  }
  if (file.dpi !== undefined && (!Number.isInteger(file.dpi) || file.dpi < CANVAS_LIMITS.minDpi || file.dpi > CANVAS_LIMITS.maxDpi)) {
    add("warning", "dpi", "dpi", `dpi 建议为 ${CANVAS_LIMITS.minDpi}–${CANVAS_LIMITS.maxDpi} 的整数`);
  }

  if (!Array.isArray(file.layers) || file.layers.length === 0) {
    add("error", "layers-empty", "layers", "工程里没有任何图层");
    return finalize(issues);
  }
  if (!Number.isInteger(file.active) || file.active < 0 || file.active >= file.layers.length) {
    add("warning", "active", "active", `active=${file.active} 超出图层范围，打开时会夹到边界`);
  }

  file.layers.forEach((fl, i) => {
    const base = `layers[${i}]`;
    if (!isPlainObject(fl)) {
      add("error", "layer-type", base, `第 ${i + 1} 个图层不是对象`);
      return;
    }
    if (typeof fl.name !== "string" || fl.name.length === 0) {
      add("warning", "layer-name", `${base}.name`, `第 ${i + 1} 个图层没有名称`);
    }
    if (fl.kind !== "pixel" && fl.kind !== "adjust") {
      add("error", "layer-kind", `${base}.kind`, `第 ${i + 1} 个图层 kind 非法：「${fl.kind}」（应为 pixel / adjust）`);
    }
    if (!BLEND_IDS.includes(fl.blend)) {
      add("error", "layer-blend", `${base}.blend`, `第 ${i + 1} 个图层使用了未知混合模式：「${fl.blend}」`);
    }
    if (typeof fl.opacity !== "number" || fl.opacity < 0 || fl.opacity > 100) {
      add("error", "layer-opacity", `${base}.opacity`, `第 ${i + 1} 个图层不透明度必须在 0–100（当前 ${fl.opacity}）`);
    }
    if (typeof fl.visible !== "boolean") {
      add("warning", "layer-visible", `${base}.visible`, `第 ${i + 1} 个图层 visible 不是布尔值`);
    }
    if (fl.kind === "adjust") {
      if (!isPlainObject(fl.adjust)) {
        add("error", "adjust-missing", `${base}.adjust`, `第 ${i + 1} 个调整层缺少 adjust`);
      } else if (!ADJUST_IDS.includes(fl.adjust.id)) {
        add("error", "adjust-id", `${base}.adjust.id`, `第 ${i + 1} 层使用了未知调整类型：「${fl.adjust.id}」`);
      } else if (!isPlainObject(fl.adjust.params)) {
        add("warning", "adjust-params", `${base}.adjust.params`, `第 ${i + 1} 层缺少 adjust.params`);
      }
      if (fl.clip) add("error", "adjust-clip", `${base}.clip`, `第 ${i + 1} 层是调整层，不支持剪贴蒙版`);
      if (Array.isArray(fl.styles) && fl.styles.length > 0) {
        add("error", "adjust-styles", `${base}.styles`, `第 ${i + 1} 层是调整层，不支持图层样式`);
      }
    }
    if (Array.isArray(fl.styles)) {
      fl.styles.forEach((s, si) => {
        if (!isPlainObject(s) || !STYLE_IDS.includes(s.id)) {
          add("error", "style-id", `${base}.styles[${si}]`, `第 ${i + 1} 层第 ${si + 1} 个样式 id 未知：「${s && s.id}」`);
        }
      });
    }
    if (fl.surface !== undefined) {
      if (fl.kind === "adjust") {
        add("warning", "adjust-surface", `${base}.surface`, `第 ${i + 1} 层是调整层，surface 会被忽略`);
      } else if (!isPngBase64(fl.surface)) {
        add("error", "surface-png", `${base}.surface`, `第 ${i + 1} 层 surface 不是合法 PNG base64`);
      }
    }
    if (fl.mask !== undefined && !isPngBase64(fl.mask)) {
      add("error", "mask-png", `${base}.mask`, `第 ${i + 1} 层 mask 不是合法 PNG base64`);
    }
  });

  if (file.selection !== undefined && !isPngBase64(file.selection)) {
    add("error", "selection-png", "selection", "selection 不是合法 PNG base64");
  }

  return finalize(issues);
}

function finalize(issues) {
  const errors = issues.filter((i) => i.level === "error").length;
  return {
    valid: errors === 0,
    issues,
    counts: {
      total: issues.length,
      errors,
      warnings: issues.length - errors,
    },
  };
}

/* ------------------------------------------------ 内存工程操作 */

function cloneFile(file) {
  return JSON.parse(JSON.stringify(file));
}

function layerLabel(file, index) {
  const l = file.layers[index];
  return l && typeof l.name === "string" ? l.name : `#${index}`;
}

/** 修改某层属性。patch 仅允许 name/visible/opacity/blend/clip/locked/maskActive。 */
export function applyPatch(file, index, patch) {
  const errors = [];
  const warnings = [];
  if (!Number.isInteger(index) || index < 0 || index >= file.layers.length) {
    return { ok: false, file, errors: [`index=${index} 超出图层范围 [0, ${file.layers.length - 1}]`], warnings };
  }
  if (!isPlainObject(patch)) {
    return { ok: false, file, errors: ["patch 必须是对象"], warnings };
  }
  const allowed = ["name", "visible", "opacity", "blend", "clip", "locked", "maskActive"];
  for (const key of Object.keys(patch)) {
    if (!allowed.includes(key)) {
      errors.push(`patch 不支持修改字段：${key}（仅支持 ${allowed.join(" / ")}）`);
    }
  }
  if (errors.length > 0) return { ok: false, file, errors, warnings };

  const next = cloneFile(file);
  const layer = next.layers[index];
  const name = layerLabel(next, index);

  if (patch.name !== undefined) {
    if (typeof patch.name !== "string" || patch.name.length === 0) errors.push("name 必须是非空字符串");
    else layer.name = patch.name;
  }
  if (patch.visible !== undefined) {
    if (typeof patch.visible !== "boolean") errors.push("visible 必须是布尔值");
    else layer.visible = patch.visible;
  }
  if (patch.locked !== undefined) {
    if (typeof patch.locked !== "boolean") errors.push("locked 必须是布尔值");
    else layer.locked = patch.locked;
  }
  if (patch.maskActive !== undefined) {
    if (typeof patch.maskActive !== "boolean") errors.push("maskActive 必须是布尔值");
    else {
      if (typeof layer.mask !== "string" && patch.maskActive) {
        warnings.push(`图层「${name}」没有蒙版，maskActive 置 true 不会有实际效果`);
      }
      layer.maskActive = patch.maskActive;
    }
  }
  if (patch.opacity !== undefined) {
    if (typeof patch.opacity !== "number" || !Number.isFinite(patch.opacity)) {
      errors.push("opacity 必须是数字");
    } else {
      if (patch.opacity < 0 || patch.opacity > 100) warnings.push(`opacity=${patch.opacity} 超出 0–100，已夹到边界`);
      layer.opacity = Math.round(clampTo(patch.opacity, 0, 100));
    }
  }
  if (patch.blend !== undefined) {
    if (!BLEND_IDS.includes(patch.blend)) errors.push(`未知混合模式：「${patch.blend}」`);
    else layer.blend = patch.blend;
  }
  if (patch.clip !== undefined) {
    if (typeof patch.clip !== "boolean") errors.push("clip 必须是布尔值");
    else {
      if (patch.clip && layer.kind === "adjust") errors.push(`图层「${name}」是调整层，不支持剪贴蒙版`);
      else if (patch.clip && index === 0) errors.push("最底层之上才能创建剪贴蒙版（index 0 不能剪贴）");
      else layer.clip = patch.clip;
    }
  }

  if (errors.length > 0) return { ok: false, file, errors, warnings };
  return { ok: true, file: next, errors, warnings };
}

/** 插入像素层或调整层。index 缺省代表置顶。 */
export function addLayerToFile(file, layerInput, index) {
  const norm = normalizeLayer(layerInput, Array.isArray(file.layers) ? file.layers.length : 0);
  if (!norm.ok) return { ok: false, file, errors: norm.errors, warnings: norm.warnings };
  const next = cloneFile(file);
  let at = index;
  if (at === undefined) at = next.layers.length;
  if (!Number.isInteger(at) || at < 0 || at > next.layers.length) {
    return { ok: false, file, errors: [`index=${index} 超出插入范围 [0, ${next.layers.length}]`], warnings: norm.warnings };
  }
  next.layers.splice(at, 0, norm.layer);
  return { ok: true, file: next, errors: [], warnings: norm.warnings };
}

/** 删除某层（至少保留一层）。 */
export function removeLayerFromFile(file, index) {
  if (file.layers.length <= 1) {
    return { ok: false, file, errors: ["至少保留一个图层，无法删除"], warnings: [] };
  }
  if (!Number.isInteger(index) || index < 0 || index >= file.layers.length) {
    return { ok: false, file, errors: [`index=${index} 超出图层范围 [0, ${file.layers.length - 1}]`], warnings: [] };
  }
  const next = cloneFile(file);
  const [removed] = next.layers.splice(index, 1);
  if (next.active >= next.layers.length) next.active = next.layers.length - 1;
  return { ok: true, file: next, removed, errors: [], warnings: [] };
}

/** 移动图层：up 向上（更靠前）/ down 向下 / top 置顶 / bottom 置底。 */
export function moveLayerInFile(file, index, direction) {
  const dirs = ["up", "down", "top", "bottom"];
  if (!dirs.includes(direction)) {
    return { ok: false, file, errors: [`direction 必须是 ${dirs.join(" / ")} 之一`], warnings: [] };
  }
  if (!Number.isInteger(index) || index < 0 || index >= file.layers.length) {
    return { ok: false, file, errors: [`index=${index} 超出图层范围 [0, ${file.layers.length - 1}]`], warnings: [] };
  }
  const next = cloneFile(file);
  const from = index;
  let to = from;
  if (direction === "up") to = Math.min(next.layers.length - 1, from + 1);
  else if (direction === "down") to = Math.max(0, from - 1);
  else if (direction === "top") to = next.layers.length - 1;
  else to = 0;
  if (to === from) {
    return { ok: true, file: next, moved: false, from, to, errors: [], warnings: [`图层已在目标位置（${direction}）`] };
  }
  const [item] = next.layers.splice(from, 1);
  next.layers.splice(to, 0, item);
  if (next.active === from) next.active = to;
  return { ok: true, file: next, moved: true, from, to, errors: [], warnings: [] };
}

/** 复制某层，副本插在其正上方，命名沿用「原名 副本」。 */
export function duplicateLayerInFile(file, index) {
  if (!Number.isInteger(index) || index < 0 || index >= file.layers.length) {
    return { ok: false, file, errors: [`index=${index} 超出图层范围 [0, ${file.layers.length - 1}]`], warnings: [] };
  }
  const next = cloneFile(file);
  const src = next.layers[index];
  const copy = JSON.parse(JSON.stringify(src));
  copy.name = `${src.name} 副本`;
  next.layers.splice(index + 1, 0, copy);
  return { ok: true, file: next, copyIndex: index + 1, errors: [], warnings: [] };
}

/* ------------------------------------------------ 文件读写与路径安全 */

/**
 * 归一化并校验工程文件路径。
 * - 必须是绝对路径、非空、无 NUL
 * - 扩展名必须是 .strata
 * - 若设置了环境变量 STRATA_MCP_ROOT，则路径必须落在该根目录内（越权检查）
 * - mustExist 时校验文件确实存在且是普通文件
 */
export function resolveProjectPath(rawPath, { mustExist = false, forWrite = false } = {}) {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new ToolError("path 必须是非空字符串");
  }
  if (rawPath.includes("\0")) {
    throw new ToolError("path 含有非法字符");
  }
  const abs = path.resolve(rawPath);
  if (!path.isAbsolute(rawPath)) {
    throw new ToolError(`path 必须是绝对路径：${rawPath}`);
  }
  if (path.extname(abs).toLowerCase() !== `.${PROJECT_EXTENSION}`) {
    throw new ToolError(`path 必须以 .${PROJECT_EXTENSION} 结尾：${abs}`);
  }

  const root = process.env.STRATA_MCP_ROOT;
  if (root && root.trim().length > 0) {
    const rootAbs = path.resolve(root);
    const rel = path.relative(rootAbs, abs);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new ToolError(`path 越权：${abs} 不在允许的根目录内（STRATA_MCP_ROOT=${rootAbs}）`);
    }
  }

  if (mustExist) {
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new ToolError(`文件不存在：${abs}`);
    }
    if (!stat.isFile()) throw new ToolError(`路径不是文件：${abs}`);
  }

  if (forWrite) {
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) throw new ToolError(`目标目录不存在：${dir}`);
  }

  return abs;
}

/** 读取并解析 .strata 文件。 */
export function readProjectFile(rawPath) {
  const abs = resolveProjectPath(rawPath, { mustExist: true });
  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (e) {
    throw new ToolError(`读取失败：${e.message}`);
  }
  // 容忍（并提示）BOM：工程文件应为 UTF-8 无 BOM
  let bom = false;
  if (text.charCodeAt(0) === 0xfeff) {
    bom = true;
    text = text.slice(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ToolError("工程文件已损坏，无法读取（JSON 解析失败）");
  }
  return { file: parsed, abs, bom };
}

/** 写入 .strata 文件（UTF-8，无 BOM）。 */
export function writeProjectFile(rawPath, file) {
  const abs = resolveProjectPath(rawPath, { forWrite: true });
  const text = JSON.stringify(file);
  try {
    fs.writeFileSync(abs, text, { encoding: "utf8" });
  } catch (e) {
    throw new ToolError(`写入失败：${e.message}`);
  }
  return { abs, bytes: Buffer.byteLength(text, "utf8") };
}

export { MAGIC, PROJECT_VERSION, PROJECT_EXTENSION };
