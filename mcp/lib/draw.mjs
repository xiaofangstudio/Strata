/**
 * 文字与形状渲染（Mark 4）。
 *
 * 插画排版绕不开「真的把字画出来」：中文、字重、字距、阴影、虚线框。
 * 自己写字形栅格化不现实，这里用 @napi-rs/canvas（预编译原生绑定，MIT）——
 * 它直接调用系统字体（微软雅黑 / 黑体 / 思源黑都在），画完把像素读回 RGBA，
 * 交给 doc.mjs 的图层栈管理。
 *
 * 所有函数都返回 { width, height, data }，与 imageOps 的图格式一致。
 */
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

/** 中文字体回退链：优先思源/雅黑，再退黑体，最后 sans-serif。 */
const ZH_STACK = '"Noto Sans SC","Microsoft YaHei","SimHei",sans-serif';
const EN_STACK = '"Inter","Segoe UI",Arial,sans-serif';

/** 是否装了中文字体（决定默认字体栈）。 */
let zhProbe = null;
function hasChineseFont() {
  if (zhProbe !== null) return zhProbe;
  try {
    zhProbe = GlobalFonts.families.some((f) =>
      /Noto Sans SC|Microsoft YaHei|SimHei|SimSun/i.test(f.family),
    );
  } catch {
    zhProbe = false;
  }
  return zhProbe;
}

/** 从 canvas 读回 RGBA（带 alpha）。 */
function readCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: img.data };
}

/** 十六进制色 → rgba() 字符串，支持 #rgb / #rrggbb / #rrggbbaa。 */
export function toCssColor(color, alpha = 1) {
  if (Array.isArray(color)) {
    return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3] ?? alpha * 255})`;
  }
  const s = String(color ?? "#ffffff").trim();
  if (s.startsWith("#")) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    const r = parseInt(hex.slice(0, 2), 16) || 0;
    const g = parseInt(hex.slice(2, 4), 16) || 0;
    const b = parseInt(hex.slice(4, 6), 16) || 0;
    const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return `rgba(${r}, ${g}, ${b}, ${a * alpha})`;
  }
  return s;
}

/**
 * 渲染一行/多行文字，返回紧贴文字的透明底图层。
 *
 * 参数对齐排版习惯：size 字号、weight 字重、letterSpacing 字距（像素）、
 * lineHeight 行高倍数、align 对齐、shadow 阴影（{color, blur, x, y}）。
 */
export function renderText({
  text = "",
  size = 64,
  weight = 700,
  color = "#ffffff",
  font = null,
  letterSpacing = 0,
  lineHeight = 1.25,
  align = "left",
  padding = 8,
  shadow = null,
  stroke = null,
  strokeWidth = 0,
  italic = false,
}) {
  const lines = String(text).split("\n");
  const fontFamily = font || (hasChineseFont() ? ZH_STACK : EN_STACK);
  // 先用一个够大的画布量文字
  const probe = createCanvas(16, 16);
  const pctx = probe.getContext("2d");
  const fontSpec = `${italic ? "italic " : ""}${weight} ${size}px ${fontFamily}`;
  pctx.font = fontSpec;

  let maxW = 0;
  for (const line of lines) {
    const m = pctx.measureText(line);
    const w = m.width + Math.max(0, line.length - 1) * letterSpacing;
    if (w > maxW) maxW = w;
  }
  const lh = Math.round(size * lineHeight);
  const pad = padding + (shadow ? Math.ceil(shadow.blur ?? 0) + Math.abs(shadow.x ?? 0) : 0);
  const w = Math.max(1, Math.ceil(maxW) + pad * 2);
  const h = Math.max(1, Math.ceil(lh * lines.length) + pad * 2);

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.font = fontSpec;
  ctx.textBaseline = "top";
  ctx.textAlign = align === "center" ? "center" : align === "right" ? "right" : "left";

  const x0 = align === "center" ? w / 2 : align === "right" ? w - pad : pad;
  if (shadow) {
    ctx.shadowColor = toCssColor(shadow.color ?? "#000000", shadow.alpha ?? 0.6);
    ctx.shadowBlur = shadow.blur ?? 12;
    ctx.shadowOffsetX = shadow.x ?? 0;
    ctx.shadowOffsetY = shadow.y ?? 6;
  }

  lines.forEach((line, i) => {
    const y = pad + i * lh;
    if (letterSpacing === 0) {
      if (stroke && strokeWidth > 0) {
        ctx.lineWidth = strokeWidth;
        ctx.strokeStyle = toCssColor(stroke);
        ctx.strokeText(line, x0, y);
      }
      ctx.fillStyle = toCssColor(color);
      ctx.fillText(line, x0, y);
      return;
    }
    // 有字距时逐字画（canvas 没有原生 letter-spacing）
    const chars = Array.from(line);
    const total =
      chars.reduce((s, ch) => s + ctx.measureText(ch).width, 0) +
      Math.max(0, chars.length - 1) * letterSpacing;
    let cx = align === "center" ? (w - total) / 2 : align === "right" ? w - pad - total : pad;
    for (const ch of chars) {
      if (stroke && strokeWidth > 0) {
        ctx.lineWidth = strokeWidth;
        ctx.strokeStyle = toCssColor(stroke);
        ctx.strokeText(ch, cx, y);
      }
      ctx.fillStyle = toCssColor(color);
      ctx.fillText(ch, cx, y);
      cx += ctx.measureText(ch).width + letterSpacing;
    }
  });

  return readCanvas(canvas);
}

/**
 * 渲染虚线框 / 实线框 / 圆角框。
 *
 * dash=[on, off] 就是「猫周围那圈虚线」。也可以画椭圆框。
 */
export function renderRect({
  width = 400,
  height = 300,
  stroke = "#ffffff",
  strokeWidth = 4,
  dash = null,
  radius = 0,
  fill = null,
  inset = 0,
}) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const sw = Math.max(0.5, strokeWidth);
  const half = sw / 2 + inset;
  ctx.lineWidth = sw;
  ctx.strokeStyle = toCssColor(stroke);
  if (dash && dash.length) ctx.setLineDash(dash);
  if (fill) {
    ctx.fillStyle = toCssColor(fill);
    roundRect(ctx, half, half, w - half * 2, h - half * 2, Math.max(0, radius));
    ctx.fill();
  }
  if (strokeWidth > 0) {
    roundRect(ctx, half, half, w - half * 2, h - half * 2, Math.max(0, radius));
    ctx.stroke();
  }
  return readCanvas(canvas);
}

/** 椭圆（描边 / 填充），用来做光环、椭圆虚线框。 */
export function renderEllipse({
  width = 300,
  height = 300,
  stroke = "#ffffff",
  strokeWidth = 4,
  dash = null,
  fill = null,
}) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const half = Math.max(0.5, strokeWidth) / 2;
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2, w / 2 - half, h / 2 - half, 0, 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = toCssColor(fill);
    ctx.fill();
  }
  if (strokeWidth > 0) {
    ctx.lineWidth = Math.max(0.5, strokeWidth);
    ctx.strokeStyle = toCssColor(stroke);
    if (dash && dash.length) ctx.setLineDash(dash);
    ctx.stroke();
  }
  return readCanvas(canvas);
}

/** 线性渐变块（做色卡、渐变遮罩背景）。 */
export function renderGradient({ width, height, stops, angle = 90 }) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const rad = (angle * Math.PI) / 180;
  const cx = w / 2;
  const cy = h / 2;
  const len = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
  const g = ctx.createLinearGradient(
    cx - (Math.cos(rad) * len) / 2,
    cy - (Math.sin(rad) * len) / 2,
    cx + (Math.cos(rad) * len) / 2,
    cy + (Math.sin(rad) * len) / 2,
  );
  for (const s of stops) g.addColorStop(Math.max(0, Math.min(1, s.at)), toCssColor(s.color));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  return readCanvas(canvas);
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  if (rr === 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/* ==================================================== 相册套件（Mark 5） */

/** hex/数组色 → [r,g,b]。 */
function toRgb(color) {
  if (Array.isArray(color)) return [color[0], color[1], color[2]];
  const s = String(color ?? "#ffffff").replace("#", "");
  const hex = s.length === 3 ? s.split("").map((c) => c + c).join("") : s.slice(0, 6);
  return [
    parseInt(hex.slice(0, 2), 16) || 0,
    parseInt(hex.slice(2, 4), 16) || 0,
    parseInt(hex.slice(4, 6), 16) || 0,
  ];
}

/**
 * 矢量路径渲染：挂钩、链子、任何手绘图形都从这里出。
 *
 * commands 是绘图指令序列（SVG 心智模型）：
 *   {op:"M", x,y} 落笔 / {op:"L", x,y} 直线 /
 *   {op:"C", x1,y1,x2,y2,x,y} 三次贝塞尔 / {op:"Q", x1,y1,x,y} 二次 /
 *   {op:"A", rx,ry,rot,large,sweep,x,y} 椭圆弧 / {op:"Z"} 闭合
 * stroke/fill 同 HTML 颜色；dash=[on,off] 虚线；画布自动按路径包围盒裁。
 */
export function renderPath({
  commands = [],
  stroke = "#ffffff",
  strokeWidth = 6,
  dash = null,
  fill = null,
  lineCap = "round",
  lineJoin = "round",
} = {}) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (x, y) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const c of commands) {
    if (c.op === "M" || c.op === "L") visit(c.x, c.y);
    else if (c.op === "C") {
      visit(c.x1, c.y1);
      visit(c.x2, c.y2);
      visit(c.x, c.y);
    } else if (c.op === "Q") {
      visit(c.x1, c.y1);
      visit(c.x, c.y);
    } else if (c.op === "A") {
      visit(c.x - Math.abs(c.rx), c.y - Math.abs(c.ry));
      visit(c.x + Math.abs(c.rx), c.y + Math.abs(c.ry));
    }
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 10;
    maxY = 10;
  }
  const pad = Math.ceil(strokeWidth) + 2;
  const w = Math.max(1, Math.ceil(maxX - minX) + pad * 2);
  const h = Math.max(1, Math.ceil(maxY - minY) + pad * 2);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const ox = -minX + pad;
  const oy = -minY + pad;
  ctx.lineWidth = Math.max(0.5, strokeWidth);
  ctx.strokeStyle = toCssColor(stroke);
  ctx.fillStyle = toCssColor(fill ?? "#00000000");
  ctx.lineCap = lineCap;
  ctx.lineJoin = lineJoin;
  if (dash && dash.length) ctx.setLineDash(dash);
  ctx.beginPath();
  for (const c of commands) {
    if (c.op === "M") ctx.moveTo(c.x + ox, c.y + oy);
    else if (c.op === "L") ctx.lineTo(c.x + ox, c.y + oy);
    else if (c.op === "C")
      ctx.bezierCurveTo(c.x1 + ox, c.y1 + oy, c.x2 + ox, c.y2 + oy, c.x + ox, c.y + oy);
    else if (c.op === "Q") ctx.quadraticCurveTo(c.x1 + ox, c.y1 + oy, c.x + ox, c.y + oy);
    else if (c.op === "A")
      ctx.ellipse(
        c.x + ox,
        c.y + oy,
        Math.abs(c.rx),
        Math.abs(c.ry),
        ((c.rot ?? 0) * Math.PI) / 180,
        0,
        Math.PI * 2,
      );
    else if (c.op === "Z") ctx.closePath();
  }
  if (fill) ctx.fill();
  if (strokeWidth > 0) ctx.stroke();
  const out = readCanvas(canvas);
  // 原点信息：图层应摆放在「路径坐标系原点」的什么位置才能还原文档坐标。
  // 工具层用 x + originX / y + originY 定位，路径坐标就能直接写文档坐标。
  out.originX = minX - pad;
  out.originY = minY - pad;
  return out;
}

/**
 * 径向光晕（透明底）：加进文档就是一层「打光」。
 * 与 imageOps.radialGlow 的区别：它直接改底图像素，这个产出独立图层，
 * 可以用任何混合模式（screen/overlay/add）叠在文档任意高度。
 */
export function renderRadialGlow({
  width,
  height,
  cx,
  cy,
  radius,
  color = "#ffe0a0",
  strength = 0.5,
  falloff = 2,
}) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const [r, g, b] = toRgb(color);
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, radius));
  const steps = 24;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const v = Math.pow(1 - t, falloff) * strength;
    grad.addColorStop(t, `rgba(${r},${g},${b},${Math.max(0, Math.min(1, v)).toFixed(4)})`);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  return readCanvas(canvas);
}

/**
 * 玻璃膜（明玻璃质感）：盖在全图最上面的那层。
 *
 * 三个视觉线索：整体极淡的冷色底（玻璃的体积感）、两三道斜向白色反光带
 * （光在玻璃面反射的「高光条」）、四边一圈更亮的边（玻璃厚度）。
 * 拿 screen / overlay 混合叠上去，下面内容透出来，上面浮着反光。
 */
export function renderGlass({
  width,
  height,
  tint = "#dceef8",
  strength = 0.22,
  streaks = 3,
} = {}) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  // 1) 冷色薄底
  const [tr, tg, tb] = toRgb(tint);
  ctx.fillStyle = `rgba(${tr},${tg},${tb},${(strength * 0.35).toFixed(3)})`;
  ctx.fillRect(0, 0, w, h);
  // 2) 斜向反光带（从左下到右上，宽窄不一）
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  const bands = [
    { p: 0.08, wd: 0.1, a: 0.07 },
    { p: 0.34, wd: 0.16, a: 0.05 },
    { p: 0.72, wd: 0.06, a: 0.08 },
  ].slice(0, Math.max(0, streaks));
  for (const bd of bands) {
    const cx = w * bd.p;
    ctx.strokeStyle = `rgba(255,255,255,${bd.a})`;
    ctx.lineWidth = w * bd.wd;
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.25, h * 1.05);
    ctx.lineTo(cx + w * 0.55, -h * 0.05);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
  // 3) 四边玻璃厚度高光
  ctx.strokeStyle = `rgba(255,255,255,${(strength * 0.8).toFixed(3)})`;
  ctx.lineWidth = Math.max(2, Math.round(Math.min(w, h) * 0.004));
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
  return readCanvas(canvas);
}
