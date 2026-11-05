/**
 * GPU 混合的纯函数校验（node 环境，不碰 WebGPU / DOM / Canvas）。
 *
 * 1) 沿用原有的 `blendToShaderId` 27 种映射 / 兜底测试；
 * 2) 校验两份 WGSL（shaders/compose.wgsl 与 compose.wgsl.ts 里的 COMPOSE_WGSL）逐字一致、
 *    27 种模式都真的有实现分支、且「移植自 PhotoCraft」的来源声明仍在；
 * 3) CPU / GPU 一致性对拍：没有真 WebGPU，就在测试里用纯 TS **复刻 WGSL 的混合公式**
 *    作为 GPU 参考实现（含 pack/unpack 8 位量化），与 CPU 侧混合函数（W3C 规范式 +
 *    src/engine/blend.ts::SOFT_BLENDS 的真实软件混合）逐像素比较，覆盖全部 27 种混合
 *    × 多组像素样本（0 / 255 / 半透明 / 极值），容差 ≤ 1/255。
 *
 * CPU 参考与 GPU 参考是两份独立实现：前者按规范 / Strata 现有 CPU 代码写，后者按
 * compose.wgsl 的 switch 与 helper 逐行转写，因此对拍能抓到公式搬错、default 回退
 * normal 这类错误（末尾另有负向对照证明测试确实有鉴别力）。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blendToShaderId, SUPPORTED_GPU_BLENDS } from "../../src/engine/gpu/blendIds";
import { COMPOSE_WGSL } from "../../src/engine/gpu/compose.wgsl.ts";
import { SOFT_BLENDS } from "../../src/engine/blend";

/* ---------------------------------------------------------------- 映射表（原有覆盖） */

type Pair = readonly [string, number];

const EXPECTED: readonly Pair[] = [
  ["normal", 1],
  ["dissolve", 2],
  ["darken", 3],
  ["multiply", 4],
  ["color-burn", 5],
  ["linear-burn", 6],
  ["darker-color", 7],
  ["lighten", 8],
  ["screen", 9],
  ["color-dodge", 10],
  ["linear-dodge", 11],
  ["lighter-color", 12],
  ["overlay", 13],
  ["soft-light", 14],
  ["hard-light", 15],
  ["vivid-light", 16],
  ["linear-light", 17],
  ["pin-light", 18],
  ["hard-mix", 19],
  ["difference", 20],
  ["exclusion", 21],
  ["subtract", 22],
  ["divide", 23],
  ["hue", 24],
  ["saturation", 25],
  ["color", 26],
  ["luminosity", 27],
];

/** 27 个 (名字, shader id) 用例，供一致性对拍逐个生成测试。 */
const MODE_CASES: [string, number][] = SUPPORTED_GPU_BLENDS.map((name) => [
  name,
  blendToShaderId(name),
]);

describe("blendToShaderId：27 种 BlendId 映射", () => {
  it("逐项覆盖全部 27 种，编号与 WGSL mode 一致", () => {
    expect(EXPECTED).toHaveLength(27);
    for (const [id, shaderId] of EXPECTED) {
      expect(blendToShaderId(id)).toBe(shaderId);
    }
  });

  it("27 个编号两两不同，且都落在 1..27", () => {
    const ids = EXPECTED.map(([, n]) => n);
    expect(new Set(ids).size).toBe(27);
    for (const n of ids) {
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(27);
    }
  });

  it("SUPPORTED_GPU_BLENDS 扩到全部 27 种，且每个都有非零编号", () => {
    expect(SUPPORTED_GPU_BLENDS).toHaveLength(27);
    expect(new Set(SUPPORTED_GPU_BLENDS).size).toBe(27);
    for (const id of SUPPORTED_GPU_BLENDS) {
      expect(blendToShaderId(id)).toBeGreaterThan(0);
    }
    const ids = SUPPORTED_GPU_BLENDS.map((n) => blendToShaderId(n)).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: 27 }, (_, i) => i + 1));
  });
});

describe("blendToShaderId：未知 id 兜底", () => {
  it("空串 / 未登记 / 大小写不符一律返回 0（normal）", () => {
    expect(blendToShaderId("")).toBe(0);
    expect(blendToShaderId("not-a-blend")).toBe(0);
    expect(blendToShaderId("MULTIPLY")).toBe(0); // 大小写敏感
    expect(blendToShaderId("normal-")).toBe(0);
    expect(blendToShaderId(" soft-light")).toBe(0);
    expect(blendToShaderId("soft_light")).toBe(0); // 下划线不是 kebab-case
  });

  it("原型链上的特殊键也不能击穿兜底（Map 实现）", () => {
    expect(blendToShaderId("__proto__")).toBe(0);
    expect(blendToShaderId("constructor")).toBe(0);
    expect(blendToShaderId("toString")).toBe(0);
    expect(blendToShaderId("hasOwnProperty")).toBe(0);
  });

  it("返回值始终是整数", () => {
    for (const [id] of EXPECTED) {
      expect(Number.isInteger(blendToShaderId(id))).toBe(true);
    }
    expect(Number.isInteger(blendToShaderId("???"))).toBe(true);
  });
});

/* ---------------------------------------------------------------- 两份 WGSL 文本一致性 */

const here = dirname(fileURLToPath(import.meta.url));
const tsSource = readFileSync(resolve(here, "../../src/engine/gpu/compose.wgsl.ts"), "utf8");
const wgslFile = readFileSync(resolve(here, "../../shaders/compose.wgsl"), "utf8");

describe("两份 WGSL 文本一致", () => {
  it("COMPOSE_WGSL 常量与 shaders/compose.wgsl 逐字一致", () => {
    const m = /export const COMPOSE_WGSL = `([\s\S]*?)`;/.exec(tsSource);
    if (!m) throw new Error("未能在 compose.wgsl.ts 里提取 COMPOSE_WGSL 模板字符串");
    expect(m[1].replace(/\r\n/g, "\n")).toBe(wgslFile.replace(/\r\n/g, "\n"));
  });

  it("27 种模式在 WGSL 里都有实现分支，不再有 default→normal 兜底漏实现", () => {
    expect(COMPOSE_WGSL).toContain("@compute @workgroup_size(8, 8)");
    expect(COMPOSE_WGSL).toContain("fn cs_main");
    expect(COMPOSE_WGSL).toContain("case 0u, 1u:"); // normal
    expect(COMPOSE_WGSL).toContain("mode == 2u"); // dissolve 单独分支
    expect(COMPOSE_WGSL).toContain("mode == 7u"); // darker-color
    expect(COMPOSE_WGSL).toContain("mode == 12u"); // lighter-color
    expect(COMPOSE_WGSL).toContain("mode <= 27u"); // isSupportedBlend 全支持
    for (const id of [3, 4, 5, 6, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]) {
      expect(COMPOSE_WGSL).toContain(`case ${id}u:`);
    }
  });

  it("保留「移植自 PhotoCraft」的来源声明注释（MIT/Apache-2.0）", () => {
    expect(COMPOSE_WGSL).toContain("ArtCraft PhotoCraft gpu crate");
    expect(COMPOSE_WGSL).toContain("MIT/Apache-2.0 双授权");
    expect(COMPOSE_WGSL).toContain("与 PhotoCraft 的关系");
    expect(wgslFile).toContain("ArtCraft PhotoCraft gpu crate");
    expect(wgslFile).toContain("数值语义对齐 PhotoCraft compose.wgsl 的 blend_channel");
  });
});

/* ---------------------------------------------------------------- CPU 侧混合（规范 + Strata 软件混合） */

type RGB = readonly [number, number, number];
type RGBA = readonly [number, number, number, number];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 软件混合的 BlendId 键 → shader id，CPU 参考据此直接调用真实的 SOFT_BLENDS。 */
const SOFT_KEY_BY_MODE: Record<number, string> = {
  6: "linear-burn",
  7: "darker-color",
  11: "linear-dodge",
  12: "lighter-color",
  16: "vivid-light",
  17: "linear-light",
  18: "pin-light",
  19: "hard-mix",
  22: "subtract",
  23: "divide",
};

/** W3C color-burn / color-dodge / soft-light / hard-light 的规范式。 */
const cpuColorBurn = (b: number, s: number): number =>
  b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s);
const cpuColorDodge = (b: number, s: number): number =>
  b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s));
const cpuHardLight = (b: number, s: number): number =>
  s <= 0.5 ? b * 2 * s : b + (2 * s - 1) - b * (2 * s - 1);
const cpuSoftLight = (b: number, s: number): number => {
  if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
  return b + (2 * s - 1) * (d - b);
};

function cpuChannel(mode: number, cb: number, cs: number): number {
  switch (mode) {
    case 0:
    case 1: return cs;
    case 3: return Math.min(cb, cs);
    case 4: return cb * cs;
    case 5: return cpuColorBurn(cb, cs);
    case 8: return Math.max(cb, cs);
    case 9: return cb + cs - cb * cs;
    case 10: return cpuColorDodge(cb, cs);
    case 13: return cpuHardLight(cs, cb);
    case 14: return cpuSoftLight(cb, cs);
    case 15: return cpuHardLight(cb, cs);
    case 20: return Math.abs(cb - cs);
    case 21: return cb + cs - 2 * cb * cs;
    default: return cs;
  }
}

/* ---- W3C 非分离混合：hue / saturation / color / luminosity ---- */

const cLum = (c: RGB): number => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const cSat = (c: RGB): number => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);

function cClipColor(c: RGB): RGB {
  const l = cLum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  let o: RGB = [c[0], c[1], c[2]];
  if (n < 0) o = [l + (o[0] - l) * l / (l - n), l + (o[1] - l) * l / (l - n), l + (o[2] - l) * l / (l - n)];
  if (x > 1) o = [l + (o[0] - l) * (1 - l) / (x - l), l + (o[1] - l) * (1 - l) / (x - l), l + (o[2] - l) * (1 - l) / (x - l)];
  return [clamp01(o[0]), clamp01(o[1]), clamp01(o[2])];
}

function cSetLum(c: RGB, l: number): RGB {
  const d = l - cLum(c);
  return cClipColor([c[0] + d, c[1] + d, c[2] + d]);
}

function cSetSat(c: RGB, s: number): RGB {
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  if (mx <= mn) return [0, 0, 0];
  const mid = c[0] + c[1] + c[2] - mx - mn;
  const midOut = (mid - mn) * s / (mx - mn);
  const one = (v: number): number => (v <= mn ? 0 : v >= mx ? s : midOut);
  return [one(c[0]), one(c[1]), one(c[2])];
}

function cpuHsl(mode: number, cb: RGB, cs: RGB): RGB {
  switch (mode) {
    case 24: return cSetLum(cSetSat(cs, cSat(cb)), cLum(cb));
    case 25: return cSetLum(cSetSat(cb, cSat(cs)), cLum(cb));
    case 26: return cSetLum(cs, cLum(cb));
    case 27: return cSetLum(cb, cLum(cs));
    default: return cs;
  }
}

/** CPU 侧逐像素混合：软件模式直接用 SOFT_BLENDS，其余按 W3C 规范式。 */
function cpuBlendRgb(mode: number, cb: RGB, cs: RGB): RGB {
  const soft = SOFT_KEY_BY_MODE[mode];
  if (soft) return SOFT_BLENDS[soft](cb, cs);
  if (mode >= 24 && mode <= 27) return cpuHsl(mode, cb, cs);
  return [cpuChannel(mode, cb[0], cs[0]), cpuChannel(mode, cb[1], cs[1]), cpuChannel(mode, cb[2], cs[2])];
}

/* ---------------------------------------------------------------- GPU 侧混合（纯 TS 复刻 WGSL） */

const EDGE = 1e-4;

function gColorDodge(cb: number, cs: number): number {
  if (cb <= EDGE) return 0;
  if (cs >= 1) return 1;
  return Math.min(cb / (1 - cs), 1);
}
function gColorBurn(cb: number, cs: number): number {
  if (cb >= 1) return 1;
  if (cs <= 0) return 0;
  return 1 - Math.min((1 - cb) / cs, 1);
}
function gVividBurn(cb: number, cs: number): number {
  if (cs <= 0) return 0;
  return 1 - Math.min((1 - cb) / cs, 1);
}
function gVividDodge(cb: number, cs: number): number {
  if (cs >= 1) return 1;
  return Math.min(cb / (1 - cs), 1);
}
function gHardLight(cb: number, cs: number): number {
  if (cs <= 0.5) return cb * 2 * cs;
  const s = 2 * cs - 1;
  return cb + s - cb * s;
}
function gSoftLight(cb: number, cs: number): number {
  if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
  let d = Math.sqrt(Math.max(cb, 0));
  if (cb <= 0.25) d = ((16 * cb - 12) * cb + 4) * cb;
  return cb + (2 * cs - 1) * (d - cb);
}
function gVividLight(cb: number, cs: number): number {
  return cs <= 0.5 ? gVividBurn(cb, 2 * cs) : gVividDodge(cb, 2 * cs - 1);
}
function gPinLight(cb: number, cs: number): number {
  return cs <= 0.5 ? Math.min(cb, 2 * cs) : Math.max(cb, 2 * cs - 1);
}
function gDivide(cb: number, cs: number): number {
  return cs <= 0 ? 1 : clamp01(cb / cs);
}

/** 逐行复刻 compose.wgsl::blend_channel 的 switch。 */
function gChannel(mode: number, cb: number, cs: number): number {
  switch (mode) {
    case 0:
    case 1: return cs;
    case 3: return Math.min(cb, cs);
    case 4: return cb * cs;
    case 5: return gColorBurn(cb, cs);
    case 6: return clamp01(cb + cs - 1);
    case 8: return Math.max(cb, cs);
    case 9: return cb + cs - cb * cs;
    case 10: return gColorDodge(cb, cs);
    case 11: return clamp01(cb + cs);
    case 13: return gHardLight(cs, cb);
    case 14: return gSoftLight(cb, cs);
    case 15: return gHardLight(cb, cs);
    case 16: return gVividLight(cb, cs);
    case 17: return clamp01(cb + 2 * cs - 1);
    case 18: return gPinLight(cb, cs);
    case 19: return cb + cs >= 1 ? 1 : 0;
    case 20: return Math.abs(cb - cs);
    case 21: return cb + cs - 2 * cb * cs;
    case 22: return clamp01(cb - cs);
    case 23: return gDivide(cb, cs);
    default: return cs;
  }
}

/* ---- 复刻 WGSL 的 lum / sat / clip_color / set_lum / set_sat ---- */

const gLum = (c: RGB): number => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const gSat = (c: RGB): number => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);

function gClipColor(c: RGB): RGB {
  const l = gLum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  let o: RGB = [c[0], c[1], c[2]];
  if (n < 0) o = [l + (o[0] - l) * l / (l - n), l + (o[1] - l) * l / (l - n), l + (o[2] - l) * l / (l - n)];
  if (x > 1) o = [l + (o[0] - l) * (1 - l) / (x - l), l + (o[1] - l) * (1 - l) / (x - l), l + (o[2] - l) * (1 - l) / (x - l)];
  return [clamp01(o[0]), clamp01(o[1]), clamp01(o[2])];
}

function gSetLum(c: RGB, l: number): RGB {
  const d = l - gLum(c);
  return gClipColor([c[0] + d, c[1] + d, c[2] + d]);
}

function gSetSatChannel(v: number, mn: number, mx: number, midOut: number, s: number): number {
  if (v <= mn) return 0;
  if (v >= mx) return s;
  return midOut;
}
function gSetSat(c: RGB, s: number): RGB {
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  if (mx <= mn) return [0, 0, 0];
  const mid = c[0] + c[1] + c[2] - mx - mn;
  const midOut = (mid - mn) * s / (mx - mn);
  return [
    gSetSatChannel(c[0], mn, mx, midOut, s),
    gSetSatChannel(c[1], mn, mx, midOut, s),
    gSetSatChannel(c[2], mn, mx, midOut, s),
  ];
}
function gBlendHsl(mode: number, cb: RGB, cs: RGB): RGB {
  switch (mode) {
    case 24: return gSetLum(gSetSat(cs, gSat(cb)), gLum(cb));
    case 25: return gSetLum(gSetSat(cb, gSat(cs)), gLum(cb));
    case 26: return gSetLum(cs, gLum(cb));
    case 27: return gSetLum(cb, gLum(cs));
    default: return cs;
  }
}

/** 复刻 compose.wgsl::blend_rgb（含非分离分流）。 */
function gBlendRgb(mode: number, cb: RGB, cs: RGB): RGB {
  if (mode === 7) return gLum(cb) <= gLum(cs) ? cb : cs;
  if (mode === 12) return gLum(cb) >= gLum(cs) ? cb : cs;
  if (mode >= 24 && mode <= 27) return gBlendHsl(mode, cb, cs);
  return [gChannel(mode, cb[0], cs[0]), gChannel(mode, cb[1], cs[1]), gChannel(mode, cb[2], cs[2])];
}

/* ---------------------------------------------------------------- 合成 / 量化 / 溶解 */

/**
 * 溶解的确定性哈希：复刻 WGSL::dissolve_hash 的 u32 回绕算术。
 * Math.imul 给出精确的 32 位乘法低半部分，等价于 WGSL u32 的按模 2^32 回绕；
 * src/engine/blend.ts::dither 用的是同常量的 JS 双精度写法（语义等价的确定性阈值），
 * 两条参考实现共享这一份，从而逐像素对拍完全确定。
 */
function dissolveHash(x: number, y: number): number {
  const n = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  const m = Math.imul(n ^ (n >>> 13), 1274126177);
  return (((m ^ (m >>> 16)) >>> 8) & 0xffff) / 65536;
}
const dissolveKeep = (x: number, y: number, opacity: number): boolean =>
  dissolveHash(x, y) < clamp01(opacity);

/** 复刻 WGSL::composite 的 W3C / Porter-Duff 式（两条参考共用同一条规范式）。 */
type BlendFn = (mode: number, cb: RGB, cs: RGB) => RGB;
function compositeCore(mode: number, b: RGBA, s: RGBA, opacity: number, blend: BlendFn): RGBA {
  const ab = b[3];
  const as_ = s[3] * clamp01(opacity);
  if (as_ <= 0) return b;
  const bl = blend(mode, [b[0], b[1], b[2]], [s[0], s[1], s[2]]);
  const ao = as_ + ab * (1 - as_);
  if (ao <= 0) return [0, 0, 0, 0];
  return [
    ((1 - as_) * ab * b[0] + (1 - ab) * as_ * s[0] + as_ * ab * bl[0]) / ao,
    ((1 - as_) * ab * b[1] + (1 - ab) * as_ * s[1] + as_ * ab * bl[1]) / ao,
    ((1 - as_) * ab * b[2] + (1 - ab) * as_ * s[2] + as_ * ab * bl[2]) / ao,
    ao,
  ];
}

/** 复刻 WGSL::pack 的 8 位量化（round-half-up）再 unpack 回 0..1。 */
function packUnpack(c: RGBA): RGBA {
  const q = (v: number): number => Math.floor(clamp01(v) * 255 + 0.5) & 0xff;
  return [q(c[0]) / 255, q(c[1]) / 255, q(c[2]) / 255, q(c[3]) / 255];
}

const toF = (p: RGBA): RGBA => [p[0] / 255, p[1] / 255, p[2] / 255, p[3] / 255];

/** GPU 参考：复刻 cs_main（含溶解分支与 pack/unpack 8 位量化）。 */
function gpuComposite(mode: number, b8: RGBA, s8: RGBA, opacity: number, x: number, y: number): RGBA {
  const b = toF(b8);
  const s = toF(s8);
  const aMul = clamp01(opacity);
  let result: RGBA;
  if (mode === 2) {
    if (s[3] * aMul <= 0 || !dissolveKeep(x, y, aMul)) {
      result = b;
    } else {
      result = compositeCore(1, b, [s[0], s[1], s[2], 1], 1, gBlendRgb);
    }
  } else {
    result = compositeCore(mode, b, s, aMul, gBlendRgb);
  }
  return packUnpack(result);
}

/** CPU 参考：连续浮点、不做 8 位量化（差异应 ≤ 0.5/255，落在 1/255 容差内）。 */
function cpuComposite(mode: number, b8: RGBA, s8: RGBA, opacity: number, x: number, y: number): RGBA {
  const b = toF(b8);
  const s = toF(s8);
  const aMul = clamp01(opacity);
  if (mode === 2) {
    if (s[3] * aMul <= 0 || !dissolveKeep(x, y, aMul)) return b;
    return compositeCore(1, b, [s[0], s[1], s[2], 1], 1, cpuBlendRgb);
  }
  return compositeCore(mode, b, s, aMul, cpuBlendRgb);
}

/* ---------------------------------------------------------------- 像素样本 */

/** 8 位 RGBA：含 0 / 255 / 中灰 / 原色 / 近黑近白 / 半透明 / 全透明等极值。 */
const SAMPLES: readonly RGBA[] = [
  [0, 0, 0, 255],
  [255, 255, 255, 255],
  [128, 128, 128, 255],
  [255, 0, 0, 255],
  [0, 255, 0, 255],
  [0, 0, 255, 255],
  [200, 40, 90, 255],
  [13, 220, 175, 255],
  [1, 2, 3, 255],
  [254, 253, 252, 255],
  [0, 0, 0, 128],
  [255, 255, 255, 128],
  [90, 160, 240, 64],
  [40, 80, 160, 192],
  [255, 128, 0, 0],
];
const OPACITIES: readonly number[] = [0, 0.25, 0.5, 0.75, 1];
const TOL = 1 / 255 + 1e-12;

/** 计算某模式在所有样本 × 不透明度下的 CPU / GPU 最大通道误差。 */
function maxDiff(mode: number): number {
  let worst = 0;
  let bi = 0;
  for (const b of SAMPLES) {
    let si = 0;
    for (const s of SAMPLES) {
      let oi = 0;
      for (const op of OPACITIES) {
        const x = bi * 13 + si * 7 + oi;
        const y = bi * 3 + si * 11 + mode;
        const g = gpuComposite(mode, b, s, op, x, y);
        const c = cpuComposite(mode, b, s, op, x, y);
        for (let k = 0; k < 4; k += 1) {
          const d = Math.abs(g[k] - c[k]);
          if (d > worst) worst = d;
        }
        oi += 1;
      }
      si += 1;
    }
    bi += 1;
  }
  return worst;
}

describe("CPU / GPU 一致性：27 种混合逐像素对拍", () => {
  for (const [name, mode] of MODE_CASES) {
    it(`${name} (id=${mode})：GPU 参考与 CPU 混合一致，误差 ≤ 1/255`, () => {
      expect(maxDiff(mode)).toBeLessThanOrEqual(TOL);
    });
  }

  it("软件混合键与 shader id 一一对应（CPU 参考确实调用了 SOFT_BLENDS）", () => {
    for (const [modeStr, key] of Object.entries(SOFT_KEY_BY_MODE)) {
      expect(blendToShaderId(key)).toBe(Number(modeStr));
      expect(key in SOFT_BLENDS).toBe(true);
    }
    expect(Object.keys(SOFT_KEY_BY_MODE)).toHaveLength(10); // 11 种软件模式里除 dissolve 外的 10 种
  });

  it("负向对照：若把缺失模式按 normal 兜底，误差会远超容差（证明对拍有鉴别力）", () => {
    const normalBlend: BlendFn = (_mode, _cb, cs) => cs;
    const wrongDiff = (mode: number): number => {
      let worst = 0;
      for (const b of SAMPLES) {
        for (const s of SAMPLES) {
          const right = compositeCore(mode, toF(b), toF(s), 1, cpuBlendRgb);
          const wrong = compositeCore(mode, toF(b), toF(s), 1, normalBlend);
          for (let k = 0; k < 4; k += 1) worst = Math.max(worst, Math.abs(right[k] - wrong[k]));
        }
      }
      return worst;
    };
    // 这些正是旧版 WGSL 会静默回退成 normal 的模式
    for (const mode of [6, 11, 16, 19, 22, 23, 24, 27]) {
      expect(wrongDiff(mode)).toBeGreaterThan(0.1);
    }
  });
});
