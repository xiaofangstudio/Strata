/**
 * 完整色彩管理（六项差距全修 · 第 5 项）的前端接线。
 *
 * Rust 侧 `strata_cms` 是从 ArtCraft PhotoCraft `photocraft-cms` 移植过来的
 * 纯 Rust ICC v2/v4 引擎（MIT/Apache-2.0），提供真 ICC profile 解析、PCS
 * transform、4 种 rendering intent 与黑点补偿。这里只负责：
 *  · 把 Tauri 命令包成 TS API；
 *  · 「转换为配置文件」优先走真 ICC，失败回退矩阵近似；
 *  · 打开图片时读嵌入 ICC，按 ICC 规范真解析（desc tag）+ 猜标签兜底，
 *    识别成 Strata 的 ProfileId 标到文档上（统一入口 readEmbeddedProfileId）；
 *  · 提供可直接接入实时预览管线的 ICC 软打样 / 色域检查（往返误差法）：
 *    iccSoftProofBestEffort 真 ICC 优先、失败「明确回退」矩阵近似并带标记。
 *
 * 与 `core/colorProfile.ts` 的关系：那份是标准原色矩阵的同步近似，
 * 在 ICC 引擎不可用（比如纯网页版、无 Tauri）时继续兜底，不删除。
 * 旧的 iccSoftProof 保留导出（向后兼容），预览管线请用 iccSoftProofBestEffort。
 */
import { invoke } from "@tauri-apps/api/core";
import { convertProfile, type ProfileId } from "../core/colorProfile";
import { convertToProfile } from "../core/imageOps";
import type { StrataDoc } from "../core/document";
import { createSurface, readPixels, writePixels } from "./surface";

/** Strata 的 ProfileId → Rust 侧内建 profile 名。 */
const BUILTIN_NAME: Record<ProfileId, string> = {
  srgb: "srgb",
  "display-p3": "display-p3",
  "adobe-rgb": "adobe-rgb",
  gray: "gray",
};

/** rendering intent：0 感知 / 1 相对比色 / 2 饱和度 / 3 绝对比色。 */
export type RenderingIntent = 0 | 1 | 2 | 3;

export const INTENT_LABELS: Record<RenderingIntent, string> = {
  0: "感知（适合照片）",
  1: "相对比色 + 黑点补偿（默认）",
  2: "饱和度（适合图表）",
  3: "绝对比色（适合打样对比）",
};

/** 内建 profile 字节缓存：一次会话里只向内核要一次。 */
const profileCache = new Map<ProfileId, Uint8Array>();

export async function builtinProfile(id: ProfileId): Promise<Uint8Array> {
  const hit = profileCache.get(id);
  if (hit) return hit;
  const data = await invoke<number[]>("cms_builtin_profile", { name: BUILTIN_NAME[id] });
  const bytes = Uint8Array.from(data);
  if (bytes.length < 128) throw new Error("内建色彩配置文件不完整");
  profileCache.set(id, bytes);
  return bytes;
}

/** 读取图片里的嵌入 ICC；没有嵌入 profile 是常态，返回 null 不报错。 */
export async function readEmbeddedProfile(path: string): Promise<Uint8Array | null> {
  try {
    const data = await invoke<number[]>("cms_read_profile", { path });
    const bytes = Uint8Array.from(data);
    return bytes.length >= 128 ? bytes : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------- ICC 描述文本真解析 */

/** 大端 uint32（越界读按 0 处理，容错残缺字节）。 */
function beU32(b: Uint8Array, o: number): number {
  return (
    (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0
  );
}

function asciiAt(b: Uint8Array, o: number, n: number): string {
  let s = "";
  for (let i = 0; i < n; i += 1) s += String.fromCharCode(b[o + i] ?? 0);
  return s;
}

/**
 * 按 ICC 规范解析 `desc`（description）tag 的文本，支持 v2 的 `desc` 与
 * v4 的 `mluc` 两种 tag 类型。这是 profile 名称的正规来源，比「扫前 4KB
 * 找关键词」可靠：只认 tag table 里 desc 指向的数据，不会把原色矩阵里
 * 碰巧出现的字节误判成关键词。解析不出来（残缺 / 无 desc）返回 null。
 * 纯函数，node 环境可直接单测。
 */
export function parseIccDescription(bytes: Uint8Array): string | null {
  if (bytes.length < 132) return null; // 至少要有 128B header + 4B tag count
  const tagCount = beU32(bytes, 128);
  if (tagCount === 0 || tagCount > 4096) return null;
  let descOff = -1;
  for (let i = 0; i < tagCount; i += 1) {
    const rec = 132 + i * 12;
    if (rec + 12 > bytes.length) break;
    if (asciiAt(bytes, rec, 4) === "desc") {
      descOff = beU32(bytes, rec + 4);
      break;
    }
  }
  if (descOff < 0 || descOff + 12 > bytes.length) return null;
  const type = asciiAt(bytes, descOff, 4);
  if (type === "mluc") {
    const count = beU32(bytes, descOff + 8);
    if (count === 0 || count > 64) return null;
    // 取第一条记录：language(2)+country(2)+len(4)+offset(4)，offset 相对 tag 起点
    const r = descOff + 16;
    if (r + 12 > bytes.length) return null;
    const strLen = beU32(bytes, r + 4);
    const strOff = beU32(bytes, r + 8);
    const start = descOff + strOff;
    if (strLen === 0 || strLen > 4096 || start + strLen > bytes.length) return null;
    let s = "";
    for (let k = 0; k + 1 < strLen; k += 2) {
      const code = ((bytes[start + k] ?? 0) << 8) | (bytes[start + k + 1] ?? 0);
      if (code !== 0) s += String.fromCharCode(code);
    }
    return s || null;
  }
  if (type === "desc") {
    const count = beU32(bytes, descOff + 8); // ASCII 字节数，含结尾 null
    if (count === 0 || count > 4096 || descOff + 12 + count > bytes.length) return null;
    let s = "";
    for (let k = 0; k < count; k += 1) {
      const c = bytes[descOff + 12 + k] ?? 0;
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s || null;
  }
  return null;
}

/** 从规范化描述文本匹配 ProfileId（匹配顺序与旧猜标签一致，避免行为跳变）。 */
function matchProfileText(s: string): ProfileId | null {
  if (/display\s*p3|dci[- ]?p3/i.test(s)) return "display-p3";
  if (/adobe\s*rgb/i.test(s)) return "adobe-rgb";
  if (/srgb|iec\s*61966/i.test(s)) return "srgb";
  if (/gray|grey/i.test(s)) return "gray";
  return null;
}

/** 真解析：按 ICC 规范读 desc tag，再按名称匹配 ProfileId。 */
export function profileIdFromIccStructured(bytes: Uint8Array): ProfileId | null {
  const desc = parseIccDescription(bytes);
  return desc ? matchProfileText(desc) : null;
}

/** 兜底猜测：扫前 4KB 描述区找关键词（旧 profileIdFromIcc 的实现，仅作兜底）。 */
function guessProfileIdFromIcc(bytes: Uint8Array): ProfileId | null {
  let text = "";
  const end = Math.min(bytes.length, 4096);
  for (let i = 0; i < end; i += 1) text += String.fromCharCode(bytes[i]);
  // 部分 profile 用 UTF-16BE 写 desc，去掉零字节再扫一遍
  const utf16 = text.replace(/\0/g, "");
  return matchProfileText(`${text}\n${utf16}`);
}

/**
 * 从 ICC 字节识别 ProfileId：能按 ICC 规范解析出 desc 就优先用真解析，
 * 解析不出来（残缺 / 非标准 profile）才退回扫文本猜标签。签名保持不变，
 * 这样旧的调用点无需改动即可用上更可靠的识别。
 */
export function profileIdFromIcc(bytes: Uint8Array): ProfileId | null {
  return profileIdFromIccStructured(bytes) ?? guessProfileIdFromIcc(bytes);
}

/** 只对这些位图格式读嵌入 ICC（与 EditorShell 的白名单一致）。 */
const ICC_READ_EXTS = new Set(["png", "jpg", "jpeg", "webp", "tif", "tiff"]);

/**
 * 共用入口：读嵌入 ICC → 识别成 ProfileId。
 * 打开文件的各条路径（openFileToDoc / EditorShell.openPath）都调它，
 * 保证「打标签」和「转换为配置文件」（convertDocumentIcc）用同一套
 * 真字节 + 同一个 profileIdFromIcc，不再各写一套。没有嵌入 profile 或
 * 引擎不可用（纯网页版）时返回 null，不抛错。
 */
export async function readEmbeddedProfileId(path: string): Promise<ProfileId | null> {
  const tail = path.split(/[\\/]/).pop() ?? "";
  const dot = tail.lastIndexOf(".");
  const ext = dot >= 0 ? tail.slice(dot + 1).toLowerCase() : "";
  if (!ICC_READ_EXTS.has(ext)) return null;
  const bytes = await readEmbeddedProfile(path);
  return bytes ? profileIdFromIcc(bytes) : null;
}

/** 调 Rust 侧真 ICC transform；输入输出都是 RGBA8，alpha 原样保留。 */
export async function iccTransform(
  pixels: Uint8Array | Uint8ClampedArray,
  srcProfile: Uint8Array,
  dstProfile: Uint8Array,
  intent: RenderingIntent = 1,
  bpc = true,
): Promise<Uint8Array> {
  const out = await invoke<number[]>("cms_transform", {
    pixels: Array.from(pixels),
    srcProfile: Array.from(srcProfile),
    dstProfile: Array.from(dstProfile),
    intent,
    bpc,
  });
  if (!Array.isArray(out) || out.length !== pixels.length) {
    throw new Error("色彩转换返回的像素数不对，已回退到矩阵算法");
  }
  return Uint8Array.from(out);
}

/** 逐像素层把文档从当前 profile 真转换到目标 profile。 */
export async function convertDocumentIcc(
  doc: StrataDoc,
  target: ProfileId,
  intent: RenderingIntent = 1,
  bpc = true,
): Promise<StrataDoc> {
  // 有原始文件且带嵌入 profile 时拿真字节：既作 transform 的源，也用来
  // 识别源空间（与 profileIdFromIcc / readEmbeddedProfileId 统一到同一套逻辑）。
  const embedded = doc.sourcePath ? await readEmbeddedProfile(doc.sourcePath) : null;
  const embeddedId = embedded ? profileIdFromIcc(embedded) : null;
  const from: ProfileId = doc.profile ?? embeddedId ?? "srgb";
  if (from === target) return doc;
  // 真字节优先：拿得到嵌入字节就用它作源，否则退回内建的标称 profile。
  const srcBytes = embedded ?? (await builtinProfile(from));
  const dstBytes = await builtinProfile(target);
  const layers = [];
  for (const l of doc.layers) {
    if (l.kind !== "pixel") {
      layers.push(l);
      continue;
    }
    const img = readPixels(l.surface);
    const out = await iccTransform(img.data, srcBytes, dstBytes, intent, bpc);
    const next = createSurface(img.width, img.height);
    writePixels(next, new ImageData(new Uint8ClampedArray(out), img.width, img.height));
    layers.push({ ...l, surface: next });
  }
  return { ...doc, layers, profile: target, dirty: true };
}

/** 真 ICC 优先、矩阵近似兜底；icc 字段告诉 UI 这次到底走了哪条路。 */
export async function convertDocumentBestEffort(
  doc: StrataDoc,
  target: ProfileId,
  intent: RenderingIntent = 1,
  bpc = true,
): Promise<{ doc: StrataDoc; icc: boolean }> {
  try {
    return { doc: await convertDocumentIcc(doc, target, intent, bpc), icc: true };
  } catch {
    return { doc: convertToProfile(doc, target), icc: false };
  }
}

/** ICC 软打样结果：校样颜色 + 超色域掩码（每像素 0 / 255）。 */
export interface IccProofResult {
  proof: Uint8Array;
  outOfGamut: Uint8Array;
}

/**
 * 软打样：src → 输出 profile（按 intent）得到校样颜色，再转回 src，
 * 往返误差大的像素就是超出目标色域的像素。这是标准的 gamut check 近似，
 * 不依赖 ICC 里的私有 gamut tag，对 matrix/TRC 与 LUT profile 都成立。
 */
export async function iccSoftProof(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  from: ProfileId,
  output: ProfileId,
  intent: RenderingIntent = 1,
  bpc = true,
  threshold = 6,
): Promise<IccProofResult> {
  const src = await builtinProfile(from);
  const dst = await builtinProfile(output);
  const proof = await iccTransform(pixels, src, dst, intent, bpc);
  const back = await iccTransform(proof, dst, src, 1, true);
  const mask = new Uint8Array(width * height);
  for (let p = 0; p < mask.length; p += 1) {
    const o = p * 4;
    const d =
      Math.abs(back[o] - pixels[o]) +
      Math.abs(back[o + 1] - pixels[o + 1]) +
      Math.abs(back[o + 2] - pixels[o + 2]);
    mask[p] = d > threshold * 3 ? 255 : 0;
  }
  return { proof, outOfGamut: mask };
}

/* ================================================================
 * 实时预览管线用的稳定 API（把上面那份死代码 iccSoftProof 接活）。
 * 保留 iccSoftProof 导出不动，只做新增。
 * ================================================================ */

/** iccSoftProofBestEffort 的结果：校样像素 + 超色域掩码 + 是否走了真 ICC。 */
export interface IccSoftProofBestEffortResult {
  /** 校样后的 RGBA8 像素，长度 = width * height * 4 */
  proofPixels: Uint8ClampedArray;
  /** 超色域掩码，每像素 0 / 255，长度 = width * height */
  outOfGamutMask: Uint8Array;
  /** true = 真 ICC（iccTransform / cms_transform）；false = 已回退矩阵近似 */
  usedIcc: boolean;
  /** usedIcc=false 时的回退原因（明确回退，绝不静默） */
  fallbackReason?: string;
  intent: RenderingIntent;
  bpc: boolean;
}

export interface IccSoftProofOptions {
  /** 往返误差阈值（0-255 / 通道），默认 6；与原 iccSoftProof 一致 */
  threshold?: number;
  /**
   * 源端嵌入 ICC 字节。给了就优先用真字节作源（与 convertDocumentIcc 统一，
   * 也方便在测试里注入而不依赖 Tauri）；不给则取内建标称 profile。
   */
  srcIccBytes?: Uint8Array | null;
}

/** 往返误差法生成超色域掩码（与原 iccSoftProof 同一套判定）。 */
function gamutMask(
  orig: Uint8Array | Uint8ClampedArray,
  back: Uint8Array | Uint8ClampedArray,
  threshold: number,
): Uint8Array {
  const n = Math.floor(orig.length / 4);
  const mask = new Uint8Array(n);
  for (let p = 0; p < n; p += 1) {
    const o = p * 4;
    const d =
      Math.abs((back[o] ?? 0) - (orig[o] ?? 0)) +
      Math.abs((back[o + 1] ?? 0) - (orig[o + 1] ?? 0)) +
      Math.abs((back[o + 2] ?? 0) - (orig[o + 2] ?? 0));
    mask[p] = d > threshold * 3 ? 255 : 0;
  }
  return mask;
}

/** 矩阵近似：把像素从 from 换算到 to（纯函数，无 Tauri / DOM 依赖）。 */
function matrixProof(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  from: ProfileId,
  to: ProfileId,
): Uint8ClampedArray {
  const buf = { data: new Uint8ClampedArray(pixels), width, height };
  return convertProfile(buf, from, to).data;
}

/**
 * 软打样 / 色域检查的稳定入口，可直接接进实时预览管线。
 *
 * 输入 RGBA 像素 + 源 / 目标 profile + intent + bpc，输出校样像素与
 * 超色域掩码；输出形态可由 proof.ts 的 IccProofContext 直接消费
 * （proofPixels 包成 transform 回调、outOfGamutMask 传给 gamutWarning）。
 *
 * 策略：**真 ICC 优先**（builtinProfile / iccTransform），任何一步失败
 * （无 Tauri、命令异常、像素数不对）就 catch，明确回退到矩阵近似
 * （convertProfile 往返）并把 usedIcc 置 false、写明 fallbackReason，
 * 绝不静默降级。from === output 且无自定义源字节时直接短路为恒等。
 */
export async function iccSoftProofBestEffort(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  from: ProfileId,
  output: ProfileId,
  intent: RenderingIntent = 1,
  bpc = true,
  options: IccSoftProofOptions = {},
): Promise<IccSoftProofBestEffortResult> {
  const threshold = options.threshold ?? 6;

  // 同空间且没有自定义源字节：无需变换（掩码全 0），算一次明确回退。
  if (from === output && !options.srcIccBytes) {
    return {
      proofPixels: new Uint8ClampedArray(pixels),
      outOfGamutMask: new Uint8Array(width * height),
      usedIcc: false,
      fallbackReason: "源与目标色彩空间一致，无需软打样变换",
      intent,
      bpc,
    };
  }

  try {
    const src = options.srcIccBytes ?? (await builtinProfile(from));
    const dst = await builtinProfile(output);
    const proof = await iccTransform(pixels, src, dst, intent, bpc);
    const back = await iccTransform(proof, dst, src, 1, true);
    return {
      proofPixels: new Uint8ClampedArray(proof),
      outOfGamutMask: gamutMask(pixels, back, threshold),
      usedIcc: true,
      intent,
      bpc,
    };
  } catch (e) {
    // 明确回退到矩阵近似，并带上标记与原因。
    const proof = matrixProof(pixels, width, height, from, output);
    const back = matrixProof(proof, width, height, output, from);
    return {
      proofPixels: proof,
      outOfGamutMask: gamutMask(pixels, back, threshold),
      usedIcc: false,
      fallbackReason: `真 ICC 校样不可用（${e instanceof Error ? e.message : String(e)}），已回退矩阵近似`,
      intent,
      bpc,
    };
  }
}
