/**
 * 逐通道混合（软件合成）。
 *
 * Canvas2D 的 globalCompositeOperation 只认 seperable 的一部分：正片叠底、
 * 滤色、叠加这类。PS 里剩下的「线性加深 / 线性减淡 / 亮光 / 线性光 / 点光 /
 * 实色混合 / 深色 / 浅色 / 减去 / 划分 / 溶解」它一个都不给 —— 这也是为什么
 * 早期版本只列了 16 种混合模式。
 *
 * 这一层补的就是那 11 种：不依赖任何浏览器能力，直接在 ImageData 上按公式
 * 逐像素算。代价是慢（要走一次 getImageData / putImageData），所以只在图层
 * 真的选了这些模式时才启用，其余模式仍然走 GPU 路径。
 *
 * 公式全部取自 W3C Compositing and Blending Level 1 规范里给出的
 * separable / non-separable 定义，与 PS 的可视结果一致。
 */
import { mustCtx } from "./surface";
import type { BlendId } from "../core/layer";

/* ---------------------------------------------------------------- 公式 */

export type RGB = readonly [number, number, number];

/** 分离式混合：每个通道各自独立算，b = 底层（已合成结果），s = 上层。 */
export type ChannelBlend = (b: number, s: number) => number;

/** 非分离式混合：三个通道耦合，必须整像素一起算。 */
export type PixelBlend = (b: RGB, s: RGB) => RGB;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 颜色加深：底层除以（1 - 上层）的倒数，上层为 0 时结果 0。 */
const colorBurn: ChannelBlend = (b, s) =>
  s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s);

/** 颜色减淡：底层除以上层，上层为 1 时结果 1。 */
const colorDodge: ChannelBlend = (b, s) =>
  s >= 1 ? 1 : Math.min(1, b / (1 - s));

/** 把一个逐通道公式提升成整像素公式。 */
function sep(fn: ChannelBlend): PixelBlend {
  return (b, s) => [fn(b[0], s[0]), fn(b[1], s[1]), fn(b[2], s[2])];
}

/** 视亮度（非分离模式用来比较两个颜色谁更亮）。 */
const luma = (c: RGB): number => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

/**
 * 11 种软件混合模式。
 *
 * 前 9 种是分离式，最后 2 种（深色 / 浅色）按视亮度整体二选一，属于
 * non-separable —— 单独写，不能逐通道套公式。
 */
export const SOFT_BLENDS: Record<string, PixelBlend> = {
  /* 线性加深：b + s - 1，压暗得比「颜色加深」更硬 */
  "linear-burn": sep((b, s) => clamp01(b + s - 1)),
  /* 线性减淡（添加）：b + s，只会变亮 */
  "linear-dodge": sep((b, s) => clamp01(b + s)),
  /* 亮光：上层暗于中灰时用颜色加深，亮于中灰时用颜色减淡 */
  "vivid-light": sep((b, s) =>
    s <= 0.5 ? colorBurn(b, 2 * s) : colorDodge(b, 2 * s - 1),
  ),
  /* 线性光：b + 2s - 1，两个分支的公式恰好同一个 */
  "linear-light": sep((b, s) => clamp01(b + 2 * s - 1)),
  /* 点光：按上层与原图的大小关系取替代 / 交换 */
  "pin-light": sep((b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1))),
  /* 实色混合：先线性光再二值化，只剩纯色块 */
  "hard-mix": sep((b, s) => (b + s >= 1 ? 1 : 0)),
  /* 减去：b - s */
  subtract: sep((b, s) => clamp01(b - s)),
  /* 划分：b / s */
  divide: sep((b, s) => (s <= 0 ? 1 : clamp01(b / s))),
  /* 深色：整体取视亮度更低的一方 */
  "darker-color": (b, s) => (luma(b) <= luma(s) ? b : s),
  /* 浅色：整体取视亮度更高的一方 */
  "lighter-color": (b, s) => (luma(b) >= luma(s) ? b : s),
};

/** 溶解不属于颜色混合 —— 它只是按不透明度随机丢弃像素，单独一条路径。 */
export const SOFT_DISSOLVE = "dissolve";

/** 这个混合模式是否需要走软件合成。 */
export function isSoft(mode: BlendId): boolean {
  return mode === SOFT_DISSOLVE || mode in SOFT_BLENDS;
}

/* ---------------------------------------------------------------- 合成 */

/** 全画布读回用的暂存画布，固定一张，避免每次 new 出 24MP 的缓冲。 */
let scratch: HTMLCanvasElement | null = null;

function scratchOf(w: number, h: number): HTMLCanvasElement {
  let c = scratch;
  if (!c) {
    c = document.createElement("canvas");
    scratch = c;
  }
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return c;
}

/** 溶解用的确定性伪随机：同一坐标永远得到同一个值，因此重绘不会闪。 */
function dither(x: number, y: number): number {
  const n = (x * 374761393 + y * 668265263) | 0;
  const m = (n ^ (n >>> 13)) * 1274126177;
  return (((m ^ (m >>> 16)) >>> 8) & 0xffff) / 65536;
}

/**
 * 把 src 按 mode / opacity 软件合成到 ctx 当前内容之上。
 *
 * 用的是规范里的完整 alpha 合成式（而不是简单的 lerp），因此底层半透明、
 * 上层带羽化边缘时结果都正确：
 *   C = ((1-as)·Cb + as·((1-ab)·Cs + ab·B(Cb,Cs))) / ar
 *   ar = as + ab·(1-as)
 * 其中 as 已含图层不透明度，ab 为底层已有 alpha。
 */
export function blendInto(
  ctx: CanvasRenderingContext2D,
  src: HTMLCanvasElement,
  opacity: number,
  mode: BlendId,
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const aMul = clamp01(opacity);
  if (aMul <= 0) return;

  const fn = SOFT_BLENDS[mode];
  const dissolve = mode === SOFT_DISSOLVE;
  if (!fn && !dissolve) return;

  const tmp = scratchOf(w, h);
  const tc = mustCtx(tmp);
  tc.setTransform(1, 0, 0, 1, 0, 0);
  tc.globalAlpha = 1;
  tc.globalCompositeOperation = "source-over";
  tc.clearRect(0, 0, w, h);
  tc.drawImage(src, 0, 0);

  const top = tc.getImageData(0, 0, w, h).data;
  const frame = ctx.getImageData(0, 0, w, h);
  const bot = frame.data;

  for (let i = 0, p = 0; i < bot.length; i += 4, p += 1) {
    let sa = (top[i + 3] / 255) * aMul;
    if (sa <= 0) continue;
    if (dissolve) {
      const x = p % w;
      const y = (p - x) / w;
      if (dither(x, y) >= aMul) continue;
      sa = 1;
    }

    const ba = bot[i + 3] / 255;
    const ar = sa + ba * (1 - sa);
    if (ar <= 0) {
      bot[i + 3] = 0;
      continue;
    }

    const sr = top[i] / 255;
    const sg = top[i + 1] / 255;
    const sb = top[i + 2] / 255;
    const br = bot[i] / 255;
    const bg = bot[i + 1] / 255;
    const bb = bot[i + 2] / 255;

    let mr = sr;
    let mg = sg;
    let mb = sb;
    if (fn) {
      const out = fn([br, bg, bb], [sr, sg, sb]);
      mr = out[0];
      mg = out[1];
      mb = out[2];
    }

    bot[i] = Math.round(255 * mix(br, sr, mr, sa, ba, ar));
    bot[i + 1] = Math.round(255 * mix(bg, sg, mg, sa, ba, ar));
    bot[i + 2] = Math.round(255 * mix(bb, sb, mb, sa, ba, ar));
    bot[i + 3] = Math.round(255 * ar);
  }

  ctx.putImageData(frame, 0, 0);
}

/** 单个通道的混合结果（已归一化到 0..1）。 */
function mix(
  cb: number,
  cs: number,
  blended: number,
  sa: number,
  ba: number,
  ar: number,
): number {
  return ((1 - sa) * cb + sa * ((1 - ba) * cs + ba * blended)) / ar;
}
