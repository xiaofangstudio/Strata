/**
 * 校样（Proof）与显示变换。
 *
 * 校样是**只影响显示、不动像素**的一层后处理：把合成结果按目标印刷条件/色彩
 * 空间重算一遍再画到屏幕上。这里全部是纯函数（RgbaBuffer 进、出），
 * 与应用内其他像素算法同一套写法，可直接单测。
 *
 * 支持的校样：
 * - **工作 CMYK**：RGB→CMYK→RGB（含油墨总量与 UCR），看得到印刷后的闷与掉饱和
 * - **分色版**（青/品红/黄/黑/CMY）：把对应油墨量画成灰度，墨多的地方深
 * - **色彩配置文件**：sRGB / Display P3 / Adobe RGB / 灰度 的矩阵换算
 * - **色域警告**：CMYK 往返误差超过阈值的像素刷成警示色
 * - **32 位预览**：曝光 / 伽马（PS 里 32 位文档的显示补偿，这里对任意文档都可用来校色）
 *
 * 「监视器 RGB / Internet 标准 RGB」在一条 sRGB 管线上等价于不改变 —— 这类
 * 如实返回原图，不假装有变化。
 */
import { makeBuffer, type RgbaBuffer } from "../engine/filters/kernels";
import { convertProfile, type ProfileId } from "./colorProfile";
import { toCmyk } from "./colorMode";

export type ProofKind =
  | "none"
  | "workingCmyk"
  | "plateCyan"
  | "plateMagenta"
  | "plateYellow"
  | "plateBlack"
  | "plateCmy"
  | "legacyMacintoshRgb"
  | "internetStandardRgb"
  | "monitorRgb"
  | "custom";

export interface ProofSettings {
  kind: ProofKind;
  /** custom 用的目标空间 */
  customSpace?: ProfileId;
  /** CMYK 油墨总量 / UCR */
  inkLimit: number;
  ucr: number;
  /** 色域警告色 */
  warningColor: [number, number, number];
  /** 色域警告阈值（0-255 的往返误差） */
  warningThreshold: number;
}

export const DEFAULT_PROOF: ProofSettings = {
  kind: "none",
  customSpace: "display-p3",
  inkLimit: 300,
  ucr: 40,
  warningColor: [255, 0, 144],
  warningThreshold: 18,
};

/**
 * 可选的 ICC 接入参数 —— 让 applyProof / gamutWarning 能消费真 ICC 结果，
 * 但本模块仍是纯函数：不 import 任何 Tauri / DOM API，测试不会因此崩溃。
 *
 * 真 ICC transform 在 cms.ts 的 iccSoftProofBestEffort 里异步完成，这里只
 * 接收「已经算好的结果」：一个同步 transform 回调（返回校样像素）或一张
 * 预计算的超色域掩码。没传这个参数时，两个函数的行为与旧版完全一致。
 *
 * iccBytes / intent / bpc / srcProfile / dstProfile 是随结果带来的上下文
 * 元数据（供调用方记录、断言，以及把同一对象复用到 cms.ts 的 API），
 * proof.ts 本身不会用它们去触发任何浏览器 / Tauri 调用。
 */
export interface IccProofContext {
  srcProfile?: ProfileId;
  dstProfile?: ProfileId;
  intent?: number;
  bpc?: boolean;
  iccBytes?: Uint8Array;
  /** 同步应用校样变换；返回 null 表示本次 ICC 不可用，应回退到矩阵近似 */
  transform?: (pixels: Uint8ClampedArray) => Uint8ClampedArray | null;
  /** 预计算超色域掩码（每像素 0 / 255），长度须 = width * height */
  outOfGamutMask?: Uint8Array;
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** 单色分色版：把某个油墨量画成灰度（墨多 = 深）。 */
export function plateView(src: RgbaBuffer, ink: -1 | 0 | 1 | 2 | 3): RgbaBuffer {
  const out = makeBuffer(src.width, src.height);
  const d = src.data;
  for (let p = 0; p < src.width * src.height; p += 1) {
    const o = p * 4;
    const r = d[o] / 255;
    const g = d[o + 1] / 255;
    const b = d[o + 2] / 255;
    const k = 1 - Math.max(r, g, b);
    let amount: number;
    if (ink === -1) {
      // CMY 合版：三色油墨的均值
      const denom = Math.max(1e-6, 1 - k);
      amount = ((1 - r - k) / denom + (1 - g - k) / denom + (1 - b - k) / denom) / 3;
    } else if (ink === 3) {
      amount = k;
    } else if (ink === 0) {
      amount = k >= 1 ? 0 : (1 - r - k) / (1 - k);
    } else if (ink === 1) {
      amount = k >= 1 ? 0 : (1 - g - k) / (1 - k);
    } else {
      amount = k >= 1 ? 0 : (1 - b - k) / (1 - k);
    }
    // 油墨越多越深（与印张上看到的一致）
    const v = clamp255((1 - Math.max(0, Math.min(1, amount))) * 255);
    out.data[o] = v;
    out.data[o + 1] = v;
    out.data[o + 2] = v;
    out.data[o + 3] = d[o + 3];
  }
  return out;
}

/**
 * 该颜色是否超出 CMYK 印刷色域。
 *
 * 判定依据不是「往返误差」—— 我们这套 CMYK 是无损往返，饱和色跑一圈还会回来，
 * 那样永远标不出来。真正卡住饱和色的是**油墨能还原的彩度上限**：
 * 把颜色换到 Lab，看它离中性轴多远（C*ab）。印刷常用油墨的安全彩度大约
 * 60–85（随色相浮动），超过就印不出来。
 *
 * 同时保留「油墨总量被压缩后的误差」作为第二个信号 —— 暗部高饱和色在
 * 限墨后确实会偏。
 */
function outOfCmykGamut(r: number, g: number, b: number, maxChroma: number): boolean {
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const rl = lin(r);
  const gl = lin(g);
  const bl = lin(b);
  const X = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047;
  const Y = 0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl;
  const Z = (0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);
  const a = 500 * (fx - fy);
  const bb = 200 * (fy - fz);
  return Math.hypot(a, bb) > maxChroma;
}

/** 色域警告：超出印刷色域（彩度或限墨误差超阈值）的像素刷成警示色。 */
export function gamutWarning(
  src: RgbaBuffer,
  settings: ProofSettings,
  icc?: IccProofContext,
): { buf: RgbaBuffer; coverage: number } {
  const total = src.width * src.height;
  const [wr, wg, wb] = settings.warningColor;
  const mask = icc?.outOfGamutMask;
  // ICC 掩码路径：真 ICC 已算好超色域掩码时直接按掩码刷警示色，
  // 跳过 CMYK 往返 + Lab 彩度近似，避免两套判定打架。
  if (mask && mask.length === total) {
    const out = makeBuffer(src.width, src.height);
    let hit = 0;
    for (let p = 0; p < total; p += 1) {
      const o = p * 4;
      if (mask[p] !== 0) {
        out.data[o] = wr;
        out.data[o + 1] = wg;
        out.data[o + 2] = wb;
        out.data[o + 3] = src.data[o + 3];
        hit += 1;
      } else {
        out.data[o] = src.data[o];
        out.data[o + 1] = src.data[o + 1];
        out.data[o + 2] = src.data[o + 2];
        out.data[o + 3] = src.data[o + 3];
      }
    }
    return { buf: out, coverage: hit / total };
  }
  // ——以下为原有实现：未传 icc / 掩码长度不符时行为完全不变——
  const round = toCmyk(src, settings.inkLimit, settings.ucr);
  const out = makeBuffer(src.width, src.height);
  // 阈值 18 → 约 78 的彩度上限；阈值越小，标记越严格
  const maxChroma = Math.max(30, 96 - settings.warningThreshold);
  let hit = 0;
  for (let p = 0; p < src.width * src.height; p += 1) {
    const o = p * 4;
    const dr = Math.abs(src.data[o] - round.data[o]);
    const dg = Math.abs(src.data[o + 1] - round.data[o + 1]);
    const db = Math.abs(src.data[o + 2] - round.data[o + 2]);
    const err = Math.max(dr, dg, db);
    const outOfGamut =
      outOfCmykGamut(src.data[o], src.data[o + 1], src.data[o + 2], maxChroma) ||
      err > settings.warningThreshold;
    if (outOfGamut) {
      out.data[o] = wr;
      out.data[o + 1] = wg;
      out.data[o + 2] = wb;
      out.data[o + 3] = src.data[o + 3];
      hit += 1;
    } else {
      out.data[o] = src.data[o];
      out.data[o + 1] = src.data[o + 1];
      out.data[o + 2] = src.data[o + 2];
      out.data[o + 3] = src.data[o + 3];
    }
  }
  return { buf: out, coverage: hit / (src.width * src.height) };
}

/** 旧版 Macintosh RGB：把 sRGB 的伽马 2.2 换成 1.8（苹果老显示器的观感）。 */
export function legacyMacGamma(src: RgbaBuffer): RgbaBuffer {
  const out = makeBuffer(src.width, src.height);
  for (let i = 0; i < src.data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const v = src.data[i + c] / 255;
      out.data[i + c] = clamp255(Math.pow(v, 1.8 / 2.2) * 255);
    }
    out.data[i + 3] = src.data[i + 3];
  }
  return out;
}

/** 32 位预览的显示补偿：曝光（档）+ 伽马。纯显示，不改数据。 */
export function previewTone(src: RgbaBuffer, exposure: number, gamma: number): RgbaBuffer {
  const out = makeBuffer(src.width, src.height);
  const k = Math.pow(2, exposure);
  const g = 1 / Math.max(0.05, gamma);
  for (let i = 0; i < src.data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const v = Math.min(1, (src.data[i + c] / 255) * k);
      out.data[i + c] = clamp255(Math.pow(v, g) * 255);
    }
    out.data[i + 3] = src.data[i + 3];
  }
  return out;
}

/**
 * 按校样设置变换一张图。kind=none 时原样返回。
 * `extra` 里可以叠加 32 位预览的曝光/伽马（两者可同时生效）。
 * `icc` 是可选的 ICC 接入参数：传了就用真 ICC 校样结果（custom 分支），
 * 不传时行为与旧版完全一致，且本文件不因此引入任何 Tauri / DOM 依赖。
 */
export function applyProof(
  src: RgbaBuffer,
  settings: ProofSettings,
  extra?: { exposure?: number; gamma?: number },
  icc?: IccProofContext,
): RgbaBuffer {
  let out = src;
  switch (settings.kind) {
    case "workingCmyk":
      out = toCmyk(src, settings.inkLimit, settings.ucr);
      break;
    case "plateCyan":
      out = plateView(src, 0);
      break;
    case "plateMagenta":
      out = plateView(src, 1);
      break;
    case "plateYellow":
      out = plateView(src, 2);
      break;
    case "plateBlack":
      out = plateView(src, 3);
      break;
    case "plateCmy":
      out = plateView(src, -1);
      break;
    case "legacyMacintoshRgb":
      out = legacyMacGamma(src);
      break;
    case "custom":
      // 传了 ICC transform 就优先用真 ICC 校样像素（外层把异步 ICC 结果
      // 包成同步回调）；返回 null / 长度不符则明确回退到原来的矩阵近似。
      if (icc?.transform) {
        const t = icc.transform(src.data);
        if (t && t.length === src.data.length) {
          out = { data: t, width: src.width, height: src.height };
          break;
        }
      }
      out = settings.customSpace ? convertProfile(src, "srgb", settings.customSpace) : src;
      break;
    case "internetStandardRgb":
    case "monitorRgb":
    case "none":
      // 这两个在 sRGB 管线上就是「不改变」—— 如实返回，不假装有效果
      out = src;
      break;
    default:
      out = src;
  }
  const exposure = extra?.exposure ?? 0;
  const gamma = extra?.gamma ?? 1;
  if (exposure !== 0 || gamma !== 1) out = previewTone(out, exposure, gamma);
  return out;
}

/* ---------------------------------------------------------------- 每帧缓存 */

/**
 * 预览管线每帧都会调 applyProof / gamutWarning，而校样结果只取决于
 * 「内容版本 + 尺寸 + proofSet + tone」，逐帧重算是纯浪费。这里给两个纯函数
 * 各挂一条小型 LRU 缓存（上限 3 条，防内存膨胀），全部仍是纯同步逻辑，
 * 不碰 Tauri / DOM，可直接单测。
 */

/** 缓存条数上限：够覆盖「当前文档 + 参考图对比」几个视图，又不至于吃内存 */
const PROOF_CACHE_LIMIT = 3;

interface ProofCacheEntry {
  buf: RgbaBuffer;
  signature: string;
  /** gamutWarning 专有：色域命中率随缓存一起存 */
  coverage?: number;
}

const applyProofCache = new Map<string, ProofCacheEntry>();
const gamutWarningCache = new Map<string, ProofCacheEntry>();

/** 命中即触碰（删了重插到 Map 尾部），保持 LRU 语义 */
function proofCacheGet(map: Map<string, ProofCacheEntry>, key: string, signature: string): ProofCacheEntry | undefined {
  const hit = map.get(key);
  if (!hit || hit.signature !== signature) return undefined;
  map.delete(key);
  map.set(key, hit);
  return hit;
}

/** 写入并按上限淘汰最旧条目 */
function proofCachePut(map: Map<string, ProofCacheEntry>, key: string, entry: ProofCacheEntry): void {
  map.delete(key);
  map.set(key, entry);
  while (map.size > PROOF_CACHE_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * 缓存签名：宽高 + proofSet JSON + tone JSON。
 * 轻量比对，不逐像素 hash —— proofSet / tone 变了必然失效；**像素内容变化
 * 由调用方通过 key 里的内容版本号（绘制代数 / 修订号）体现**。
 */
function proofCacheSignature(
  src: RgbaBuffer,
  settings: ProofSettings,
  extra?: { exposure?: number; gamma?: number },
): string {
  return `${src.width}x${src.height}|${JSON.stringify(settings)}|${JSON.stringify(extra ?? null)}`;
}

/**
 * 清空全部校样缓存。
 *
 * 主线程必须在 **ICC 异步结果回来并接好新的 transform / 掩码之后**调用它：
 * 缓存里可能还压着矩阵近似（或上一轮 ICC）的旧结果，不清掉的话下一帧
 * 会继续命中过期画面。
 */
export function invalidateProofCache(): void {
  applyProofCache.clear();
  gamutWarningCache.clear();
}

/**
 * applyProof 的每帧缓存版：key 命中且「宽高 + proofSet + tone」签名一致时
 * 直接返回缓存结果（**同一引用**，零重算）。
 *
 * 用法约定：
 * - key 由调用方组合，如 `${docId}:${contentRev}:${width}x${height}`；
 *   **必须包含内容版本**，否则画了一笔之后 key 不变，会拿到过期预览。
 * - 命中返回的是缓存引用，调用方只读（画到画布 / ImageData）安全，
 *   不要直接改写它的像素。
 * - **ICC 异步路径不走缓存**：传了带 transform 的 icc 时直接透传实时计算。
 *   cms.ts 的 iccSoftProofBestEffort 是异步 invoke，它的结果随时可能刷新；
 *   正确接法是 —— 每帧同步路径用本函数，ICC 结果回来后更新 icc 上下文并调
 *   invalidateProofCache()，下一帧自然用真 ICC 像素重算并重建缓存。
 */
export function applyProofCached(
  src: RgbaBuffer,
  key: string,
  settings: ProofSettings,
  extra?: { exposure?: number; gamma?: number },
  icc?: IccProofContext,
): RgbaBuffer {
  if (icc?.transform) return applyProof(src, settings, extra, icc);
  const signature = proofCacheSignature(src, settings, extra);
  const hit = proofCacheGet(applyProofCache, key, signature);
  if (hit) return hit.buf;
  const buf = applyProof(src, settings, extra, icc);
  proofCachePut(applyProofCache, key, { buf, signature });
  return buf;
}

/**
 * gamutWarning 的每帧缓存版：思路同 applyProofCached（LRU 3 条、命中返回
 * 同一 buf 引用、coverage 随缓存一起返回）。
 *
 * **ICC 掩码路径不走缓存**：传了 outOfGamutMask 时直接透传实时计算——
 * 掩码由异步 ICC 生成、随时可能刷新。异步结果回来后同样先
 * invalidateProofCache() 再继续用同步路径。
 */
export function gamutWarningCached(
  src: RgbaBuffer,
  key: string,
  settings: ProofSettings,
  icc?: IccProofContext,
): { buf: RgbaBuffer; coverage: number } {
  if (icc?.outOfGamutMask) return gamutWarning(src, settings, icc);
  const signature = proofCacheSignature(src, settings);
  const hit = proofCacheGet(gamutWarningCache, key, signature);
  if (hit && hit.coverage !== undefined) {
    return { buf: hit.buf, coverage: hit.coverage };
  }
  const res = gamutWarning(src, settings, icc);
  proofCachePut(gamutWarningCache, key, { buf: res.buf, signature, coverage: res.coverage });
  return res;
}

/* ---------------------------------------------------------- 重算节流判定 */

/**
 * 「平移 / 缩放停止后重算」的推荐间隔（毫秒）。比一帧慢一个数量级，
 * 交互过程中最多 8 次/秒的节流重算，停止后最多再等一个间隔就收敛。
 */
export const PROOF_RECOMPUTE_INTERVAL_MS = 120;

/** shouldRecomputeProof 的输入状态：由主线程持有并逐帧回传 */
export interface ProofRecomputeState {
  /** 上次真正重算的时间戳（performance.now()）；从未算过传 0 */
  lastRunAt: number;
  /** 上次重算时的状态签名；从未算过传空字符串 */
  lastSignature: string;
}

/**
 * 是否该在这一帧重算校样（纯函数，主线程每帧问一次）。
 *
 * 判定规则：
 * - 从未算过（lastSignature 为空）→ 立即算，不等间隔；
 * - 状态签名没变 → 画旧结果即可，不算；
 * - 签名变了且距上次重算已到间隔 → 算（这就是节流：拖动过程中最多
 *   每 120ms 收敛一次，停止后最多再等一个间隔就重算到位）。
 *
 * signature 由调用方组合视口/文档状态，如
 * `${docId}:${contentRev}:${zoom}:${panX}:${panY}` —— 平移缩放会改变它，
 * 纯重绘（同一视口再来一帧）不会。
 */
export function shouldRecomputeProof(
  state: ProofRecomputeState,
  now: number,
  signature: string,
  intervalMs: number = PROOF_RECOMPUTE_INTERVAL_MS,
): boolean {
  if (state.lastSignature === "") return true;
  if (signature === state.lastSignature) return false;
  return now - state.lastRunAt >= intervalMs;
}
