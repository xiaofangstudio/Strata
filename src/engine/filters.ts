/**
 * SVG 滤镜基础设施。
 *
 * Canvas2D 自带的 filter 只覆盖亮度、对比度、模糊这一类线性或卷积效果；
 * 色阶、曲线、色彩平衡、渐变映射属于「逐通道重映射」，必须靠
 * feComponentTransfer 表达；颗粒与噪点则是程序化噪声。
 *
 * 这里在文档里挂一份隐藏的 <svg>，按图层 id 注册 filter，再把 ctx.filter
 * 指向 url(#id) —— 合成路径一行不改，屏幕显示与导出依旧走同一条代码。
 *
 * 之所以不用「逐像素 getImageData/putImageData」：24MP 文档上那是几十毫秒
 * 一次的全量拷贝，拖动滑杆会直接卡死；feComponentTransfer 在 GPU 上做，
 * 只提交一条 LUT。
 */
const NS = "http://www.w3.org/2000/svg";
let root: SVGSVGElement | null = null;
/** id → 参数签名。签名不变就不重写 DOM，拖动滑杆时省下大量解析开销。 */
const sigs = new Map<string, string>();

function ensureRoot(): SVGSVGElement {
  if (root && root.isConnected) return root;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("id", "strata-fx");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  // 必须真实存在于布局里（不能用 display:none），否则 Canvas2D 解析不到 url()
  svg.style.cssText =
    "position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none";
  document.body.appendChild(svg);
  root = svg;
  sigs.clear();
  return svg;
}

/** 注册（或更新）一个 filter，返回可直接赋给 ctx.filter 的 url()。
 *
 *  `margin` 是外扩比例（0.1 = 上下左右各留 10%），模糊、描边一类会溢出
 *  边界的原语靠它才不会被切掉；描边越粗，调用方要给的 margin 越大。
 */
export function svgFilter(
  id: string,
  sig: string,
  markup: string,
  margin = 0.1,
): string {
  if (sigs.get(id) !== sig) {
    const host = ensureRoot();
    let el = document.getElementById(id) as SVGFilterElement | null;
    if (!el || el.namespaceURI !== NS || el.tagName.toLowerCase() !== "filter") {
      if (el) el.remove();
      el = document.createElementNS(NS, "filter") as SVGFilterElement;
      el.setAttribute("id", id);
      host.appendChild(el);
    }
    const m = Math.max(0, margin);
    const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
    el.setAttribute("x", pct(-m));
    el.setAttribute("y", pct(-m));
    el.setAttribute("width", pct(1 + 2 * m));
    el.setAttribute("height", pct(1 + 2 * m));
    // 关键：默认的 linearRGB 会让同一组参数在屏幕与导出上出现色差
    el.setAttribute("color-interpolation-filters", "sRGB");
    el.innerHTML = markup;
    sigs.set(id, sig);
  }
  return `url(#${id})`;
}

/** 删掉某个 filter（图层被删时调用，避免 DOM 里堆死节点）。 */
export function dropFilter(id: string): void {
  const el = document.getElementById(id);
  if (el && el.namespaceURI === NS) el.remove();
  sigs.delete(id);
}

/* ---------------------------------------------------------------- 传递函数 */

/** 夹到 0–1。 */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 把 0–1 上的函数采样成 feFunc* 的 tableValues。
 *
 * 33 级已经足够平滑：table 型在采样点之间线性插值，33 级对应每级约 8 个
 * 色阶，肉眼与 256 级 LUT 无差别。
 */
export function tableOf(fn: (x: number) => number, n = 33): string {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) out.push(clamp01(fn(i / (n - 1))).toFixed(5));
  return out.join(" ");
}

function transfer(
  kind: "table" | "discrete",
  r: string,
  g: string,
  b: string,
  inRef?: string,
): string {
  const src = inRef ? ` in="${inRef}"` : "";
  return (
    `<feComponentTransfer${src}>` +
    `<feFuncR type="${kind}" tableValues="${r}"/>` +
    `<feFuncG type="${kind}" tableValues="${g}"/>` +
    `<feFuncB type="${kind}" tableValues="${b}"/>` +
    "</feComponentTransfer>"
  );
}

/** 三通道共用一条传递函数（table 型，采样点之间线性插值）。 */
export function uniTransfer(table: string, inRef?: string): string {
  return transfer("table", table, table, table, inRef);
}

/** 三通道各走一条传递函数。inRef 用于接在其它原语之后（渐变映射要先用亮度）。 */
export function rgbTransfer(r: string, g: string, b: string, inRef?: string): string {
  return transfer("table", r, g, b, inRef);
}

/**
 * 离散型传递函数（色调分离用）。
 *
 * discrete 的取值是 floor(x·n)，n 就是台阶数 —— 用 table 型表达台阶会被
 * 33 级采样抹成斜坡，只有 discrete 能得到干净的色阶分离。
 */
export function uniDiscrete(steps: number): string {
  const list: string[] = [];
  const n = Math.max(2, Math.round(steps));
  for (let i = 0; i < n; i += 1) list.push((i / (n - 1)).toFixed(5));
  const values = list.join(" ");
  return transfer("discrete", values, values, values);
}

/**
 * 线性型传递函数：C' = slope·C + intercept（自动夹到 0–1）。
 *
 * 阈值（二值化）靠它实现：斜率给大数、截距给 −斜率×阈值，就得到一个
 * 干净的硬边台阶，比采样成斜坡准得多。
 */
export function uniLinear(slope: number, intercept: number): string {
  const s = slope.toFixed(4);
  const i = intercept.toFixed(4);
  return (
    "<feComponentTransfer>" +
    `<feFuncR type="linear" slope="${s}" intercept="${i}"/>` +
    `<feFuncG type="linear" slope="${s}" intercept="${i}"/>` +
    `<feFuncB type="linear" slope="${s}" intercept="${i}"/>` +
    "</feComponentTransfer>"
  );
}

/**
 * 色彩矩阵（通道混合器用）。
 *
 * 通道混合器要把三个源通道按权重混到输出通道上，这不是「逐通道重映射」
 * 能表达的，必须交给 feColorMatrix：按行给 20 个数（4×5 矩阵）。
 */
export function colorMatrixMarkup(rows: readonly number[]): string {
  const values = rows.map((v) => v.toFixed(5)).join(" ");
  return `<feColorMatrix type="matrix" values="${values}"/>`;
}

/**
 * 3×3 卷积（锐化用）。
 *
 * 核与除数分开传，便于把「总量」这一条参数直接映射成核的强度：
 * 中心 1+4k、四邻 −k 的核，和恒为 1，因此除数固定为 1，亮度不会漂。
 */
export function convolveMarkup(kernel: readonly number[], divisor = 1): string {
  const order = Math.max(3, Math.round(Math.sqrt(kernel.length)));
  const values = kernel.map((v) => v.toFixed(4)).join(" ");
  return (
    `<feConvolveMatrix order="${order}" kernelMatrix="${values}" ` +
    `divisor="${divisor.toFixed(4)}" bias="0" edgeMode="duplicate" preserveAlpha="true"/>`
  );
}

/**
 * 程序化噪声（颗粒 / 添加杂色用）。
 *
 * 走 feTurbulence 而不是外挂一张噪声位图：feImage 不会平铺，要做一张
 * 24MP 的噪点图光生成就要几百毫秒；feTurbulence 的 seed 是确定性的，
 * 同一组参数每次结果完全一致，导出与屏幕不会有差异。
 *
 * 强度用「把噪声的 alpha 压到 amount」表达 —— SVG 的 linear 传递函数会
 * 自动夹到 0–1，因此这一步天然安全，之后一次 feBlend 就是「原图与
 * 噪声按 amount 混合」。
 */
export interface NoiseSpec {
  /** 颗粒尺寸（像素），越大越粗 */
  size: number;
  /** 强度 0–1 */
  amount: number;
  /** 单色（胶片颗粒）还是彩色 */
  mono: boolean;
  /** 与底图的混合方式 */
  mode: "soft-light" | "overlay" | "screen";
  /** true 用 turbulence（更硬，像数字噪点），false 用 fractalNoise（更像胶片） */
  sharp: boolean;
  seed?: number;
}

export function noiseMarkup(spec: NoiseSpec): string {
  const f = 1 / Math.max(1, spec.size);
  const amount = clamp01(spec.amount).toFixed(4);
  const parts: string[] = [
    `<feTurbulence type="${spec.sharp ? "turbulence" : "fractalNoise"}" ` +
      `baseFrequency="${f.toFixed(4)}" numOctaves="${spec.sharp ? 1 : 2}" ` +
      `seed="${Math.round(spec.seed ?? 7)}" result="nz"/>`,
  ];
  if (spec.mono) {
    parts.push('<feColorMatrix in="nz" type="saturate" values="0" result="nzs"/>');
  }
  parts.push(
    `<feComponentTransfer in="${spec.mono ? "nzs" : "nz"}" result="nza">` +
      `<feFuncA type="linear" slope="0" intercept="${amount}"/>` +
      "</feComponentTransfer>",
  );
  parts.push(`<feBlend in="nza" in2="SourceGraphic" mode="${spec.mode}"/>`);
  return parts.join("");
}

/**
 * 亮度矩阵：把彩色压成三通道相等的灰度（Rec.709），结果命名为 result。
 *
 * 渐变映射的实现分两步：先用这条把画面变成亮度，再用逐通道 LUT 把亮度
 * 映射到渐变色。若省掉这一步、直接拿每个通道自己的值去查渐变，饱和色的
 * 结果会和 PS 差出一整截。
 */
export function lumaMatrixMarkup(result: string): string {
  const row = "0.2126 0.7152 0.0722 0 0";
  const values = `${row} ${row} ${row} 0 0 0 1 0`;
  return `<feColorMatrix type="matrix" values="${values}" result="${result}"/>`;
}

/* ---------------------------------------------------------------- 曲线插值 */

export interface CurvePoint {
  x: number;
  y: number;
}

/**
 * 单调三次插值（Fritsch–Carlson）。
 *
 * 直接用 Catmull-Rom 会在控制点附近过冲 —— 曲线一过冲，画面里就会冒出
 * 本来没有的亮边和暗边。单调三次保证「控制点往哪边走，曲线就往哪边走」，
 * 与 PS 曲线的观感一致。
 */
export function monotoneAt(points: readonly CurvePoint[], x: number): number {
  const n = points.length;
  if (n === 0) return x;
  if (n === 1) return points[0].y;
  if (x <= points[0].x) return points[0].y;
  if (x >= points[n - 1].x) return points[n - 1].y;

  const d: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    d.push((points[i + 1].y - points[i].y) / Math.max(1e-6, points[i + 1].x - points[i].x));
  }
  const m: number[] = [d[0]];
  for (let i = 1; i < n - 1; i += 1) {
    m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  }
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i += 1) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }

  let k = 0;
  while (k < n - 2 && x > points[k + 1].x) k += 1;
  const h = points[k + 1].x - points[k].x;
  const t = (x - points[k].x) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * points[k].y +
    (t3 - 2 * t2 + t) * h * m[k] +
    (-2 * t3 + 3 * t2) * points[k + 1].y +
    (t3 - t2) * h * m[k + 1]
  );
}

/** 曲线控制点 → feFunc 的 tableValues。 */
export function curveTable(points: readonly CurvePoint[]): string {
  return tableOf((x) => monotoneAt(points, x));
}

/** 动感模糊：把各向标准差按角度摊开，就是一条直线拖尾。 */
export function motionMarkup(angleDeg: number, distance: number): string {
  const rad = (angleDeg * Math.PI) / 180;
  const s = Math.max(0, distance) / 2.2;
  const dx = (Math.cos(rad) * s).toFixed(3);
  const dy = (Math.sin(rad) * s).toFixed(3);
  return `<feGaussianBlur in="SourceGraphic" stdDeviation="${dx} ${dy}"/>`;
}

/* ---------------------------------------------------------------- 回收 */

/**
 * 删掉不再需要的 filter（图层被删 / 关档时调用）。
 *
 * filter 的 id 形如 `sfx-<图层 id>`，因此只要给一份「当前还活着的图层 id」，
 * 就能把 DOM 里堆下的死节点清干净 —— 合成时顺手调用，开销可以忽略。
 */
export function pruneFilters(live: ReadonlySet<string>): void {
  if (!root || !root.isConnected) return;
  const dead: Element[] = [];
  for (const el of Array.from(root.children)) {
    if (!el.id.startsWith("sfx-")) continue;
    if (!live.has(el.id.slice(4))) dead.push(el);
  }
  for (const el of dead) {
    el.remove();
    sigs.delete(el.id);
  }
}

/** 清空全部 filter（关闭文档时用）。 */
export function clearFilters(): void {
  root?.replaceChildren();
  sigs.clear();
}

/* ---------------------------------------------------------------- 颜色工具 */

/** #rrggbb → [r, g, b]（各 0–1）。非法输入退回中性灰。 */
export function hexToRgb01(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.5, 0.5, 0.5];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** [r, g, b]（各 0–1）→ #rrggbb。 */
export function rgb01ToHex(rgb: readonly number[]): string {
  let out = "#";
  for (let i = 0; i < 3; i += 1) {
    const v = Math.round(clamp01(rgb[i] ?? 0) * 255);
    out += v.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * sRGB 传递函数（编码方向）：线性光 → 显示值。
 *
 * 曝光、灰度这类「先算光再回写」的调整必须在 0–1 的显示值上先还原成光强，
 * 否则中间调会被算歪 —— 直接把 sRGB 数值乘 2 得到的曝光，和 PS 的观感差
 * 得很远。
 */
export function linearToSrgb(v: number): number {
  const x = clamp01(v);
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** sRGB 传递函数（解码方向）：显示值 → 线性光。 */
export function srgbToLinear(v: number): number {
  const x = clamp01(v);
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/** Rec.709 相对亮度。 */
export function luma01(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
