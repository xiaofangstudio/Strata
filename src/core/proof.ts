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
): { buf: RgbaBuffer; coverage: number } {
  const round = toCmyk(src, settings.inkLimit, settings.ucr);
  const out = makeBuffer(src.width, src.height);
  // 阈值 18 → 约 78 的彩度上限；阈值越小，标记越严格
  const maxChroma = Math.max(30, 96 - settings.warningThreshold);
  let hit = 0;
  const [wr, wg, wb] = settings.warningColor;
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
 */
export function applyProof(
  src: RgbaBuffer,
  settings: ProofSettings,
  extra?: { exposure?: number; gamma?: number },
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
