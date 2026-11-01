/**
 * 局部调色（Power Window）的 Node 侧实现。
 *
 * 应用里的范围蒙版是 `src/core/gradeWindow.ts` 生成的，但那段代码要浏览器画布，
 * MCP 进程里没有。这里用 `@napi-rs/canvas` 重做一份，**几何规则与界面完全一致**：
 *   · 线性 —— 沿法线一条渐变（一侧全调、一侧全不调）
 *   · 椭圆 / 钢笔 —— 画实心形状，再把 alpha 模糊出羽化
 *   · 四边形 —— 四条边各一条渐变再连乘（每条边羽化宽度可不同）
 *
 * 一个已知差异：@napi-rs/canvas 的 `ctx.filter = "blur()"` 设得进去但不生效
 * （实测远处 alpha 完全没晕开），所以羽化用**三次盒式模糊**自己算 —— 三次盒式
 * 已经足够接近高斯，肉眼看不出与界面版本的差别。
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCanvas } = require("@napi-rs/canvas");

/* ------------------------------------------------------------ 基础工具 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, def = 0) => (typeof v === "number" && Number.isFinite(v) ? v : def);

/** 围绕 (cx,cy) 旋转点（用于四边形各边法线判断）。 */
function centroid(points) {
  const n = Math.max(1, points.length);
  return {
    x: points.reduce((s, p) => s + num(p.x), 0) / n,
    y: points.reduce((s, p) => s + num(p.y), 0) / n,
  };
}

/** 边的外法线（背离质心一侧）。 */
function outwardNormal(a, b, center) {
  let nx = -(b.y - a.y);
  let ny = b.x - a.x;
  const len = Math.hypot(nx, ny) || 1;
  nx /= len;
  ny /= len;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  if ((center.x - mx) * nx + (center.y - my) * ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  return { x: nx, y: ny };
}

/** 三点盒式模糊近似高斯（只作用于 alpha 通道）。 */
function blurAlpha(alpha, w, h, radius) {
  // 两段盒式、半径取一半：柔边总宽度仍约等于 feather，
  // 但比"三段满半径"温和得多（后者会把小形状的中心也压暗）
  const r = Math.max(1, Math.round(radius / 2));
  if (radius <= 0) return alpha;
  let src = Float32Array.from(alpha);
  let dst = new Float32Array(src.length);
  const passes = 2;
  for (let p = 0; p < passes; p += 1) {
    // 横向
    for (let y = 0; y < h; y += 1) {
      const row = y * w;
      let sum = 0;
      for (let x = -r; x <= r; x += 1) sum += src[row + clamp(x, 0, w - 1)];
      for (let x = 0; x < w; x += 1) {
        dst[row + x] = sum / (r * 2 + 1);
        sum += src[row + clamp(x + r + 1, 0, w - 1)] - src[row + clamp(x - r, 0, w - 1)];
      }
    }
    // 纵向
    for (let x = 0; x < w; x += 1) {
      let sum = 0;
      for (let y = -r; y <= r; y += 1) sum += dst[clamp(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y += 1) {
        src[y * w + x] = sum / (r * 2 + 1);
        sum += dst[clamp(y + r + 1, 0, h - 1) * w + x] - dst[clamp(y - r, 0, h - 1) * w + x];
      }
    }
  }
  return src;
}

/** 反相 alpha。 */
function invertAlpha(data) {
  for (let i = 3; i < data.length; i += 4) data[i] = 255 - data[i];
}

/* ------------------------------------------------------------ 蒙版生成 */

/**
 * 由范围几何生成蒙版（返回 {width,height,alpha:Float32Array(0..255)}）。
 *
 * 只算「包围盒」那一块，再按偏移写回整幅 —— 大图上圈一小块时不会白算全图。
 */
export function buildWindowMask(w, h, win) {
  const alpha = new Float32Array(w * h);
  const feather = Math.max(0, num(win.feather));

  if (win.kind === "line") {
    const x1 = num(win.x1);
    const y1 = num(win.y1);
    const x2 = num(win.x2);
    const y2 = num(win.y2);
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const band = Math.max(0.5, feather);
    const g = ctx.createLinearGradient(mx - nx * band, my - ny * band, mx + nx * band, my + ny * band);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    for (let i = 0, k = 0; i < alpha.length; i += 1, k += 4) alpha[i] = d[k + 3];
    if (win.invert) for (let i = 0; i < alpha.length; i += 1) alpha[i] = 255 - alpha[i];
    return { width: w, height: h, alpha };
  }

  if (win.kind === "quad") {
    const pts = (win.points ?? []).slice(0, 4);
    if (pts.length < 4) return { width: w, height: h, alpha };
    const edges = [0, 1, 2, 3].map((i) => {
      const v = Array.isArray(win.edges) ? Number(win.edges[i]) : Number.NaN;
      return Number.isFinite(v) ? Math.max(0, v) : feather;
    });
    const base = createCanvas(w, h);
    const ctx = base.getContext("2d");
    // 底：全白（多边形内部默认全调），随后逐边乘软边
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fill();
    const c = centroid(pts);
    const edgeCanvas = createCanvas(w, h);
    const ectx = edgeCanvas.getContext("2d");
    for (let i = 0; i < 4; i += 1) {
      const f = edges[i];
      if (f < 0.5) continue; // 这条边不羽化
      const a = pts[i];
      const b = pts[(i + 1) % 4];
      const n = outwardNormal(a, b, c);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      // ① 这一条边的软边：从边外侧 f 处 alpha=0，到边上 alpha=1
      ectx.globalCompositeOperation = "source-over";
      ectx.clearRect(0, 0, w, h);
      const g = ectx.createLinearGradient(mx + n.x * f, my + n.y * f, mx, my);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(1, "rgba(255,255,255,1)");
      ectx.fillStyle = g;
      ectx.fillRect(0, 0, w, h);
      // ② 只保留多边形内部（外部本来就不该被调色）
      ectx.globalCompositeOperation = "destination-in";
      ectx.beginPath();
      ectx.moveTo(pts[0].x, pts[0].y);
      for (let k = 1; k < 4; k += 1) ectx.lineTo(pts[k].x, pts[k].y);
      ectx.closePath();
      ectx.fill();
      ectx.globalCompositeOperation = "source-over";
      // ③ 乘进底图：四条边连乘 → 每条边的羽化互不影响
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(edgeCanvas, 0, 0);
      ctx.globalCompositeOperation = "source-over";
    }
    const d = ctx.getImageData(0, 0, w, h).data;
    for (let i = 0, k = 0; i < alpha.length; i += 1, k += 4) alpha[i] = d[k + 3];
    if (win.invert) for (let i = 0; i < alpha.length; i += 1) alpha[i] = 255 - alpha[i];
    return { width: w, height: h, alpha };
  }

  // 椭圆 / 钢笔：实心形状 + alpha 模糊
  const shape = createCanvas(w, h);
  const sctx = shape.getContext("2d");
  sctx.fillStyle = "#ffffff";
  sctx.beginPath();
  if (win.kind === "ellipse") {
    const cx = num(win.cx);
    const cy = num(win.cy);
    const rx = Math.max(0.5, num(win.rx));
    const ry = Math.max(0.5, num(win.ry));
    const rot = num(win.rot);
    if (rot) {
      sctx.translate(cx, cy);
      sctx.rotate(rot);
      sctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    } else {
      sctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    }
  } else {
    const pts = win.points ?? [];
    if (pts.length < 3) return { width: w, height: h, alpha };
    sctx.moveTo(num(pts[0].x), num(pts[0].y));
    for (let i = 1; i < pts.length; i += 1) sctx.lineTo(num(pts[i].x), num(pts[i].y));
    sctx.closePath();
  }
  sctx.fill();

  const raw = sctx.getImageData(0, 0, w, h).data;
  const src = new Float32Array(w * h);
  for (let i = 0, k = 0; i < src.length; i += 1, k += 4) src[i] = raw[k + 3];
  const blurred = feather > 0 ? blurAlpha(src, w, h, feather) : src;
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = clamp(blurred[i], 0, 255);
  if (win.invert) for (let i = 0; i < alpha.length; i += 1) alpha[i] = 255 - alpha[i];
  return { width: w, height: h, alpha };
}

/* ------------------------------------------------------------ 合成 */

/**
 * 把"全局调色结果"按范围蒙版混回原图。
 *
 * 公式与应用内合成器一致：out = 原图 × (1−a) + 调色后 × a，
 * 羽化处 a 是渐变，所以过渡是平滑的。
 *
 * @param img    原图 {width,height,data}
 * @param graded 调色后的同尺寸图
 * @param alpha  蒙版 alpha（0..255）
 */
export function blendByMask(img, graded, alpha) {
  const out = new Uint8ClampedArray(img.data.length);
  let touched = 0;
  for (let i = 0, k = 0; i < alpha.length; i += 1, k += 4) {
    const a = alpha[i] / 255;
    if (a <= 0) {
      out[k] = img.data[k];
      out[k + 1] = img.data[k + 1];
      out[k + 2] = img.data[k + 2];
      out[k + 3] = img.data[k + 3];
      continue;
    }
    if (a >= 1) touched += 1;
    const inv = 1 - a;
    out[k] = img.data[k] * inv + graded.data[k] * a;
    out[k + 1] = img.data[k + 1] * inv + graded.data[k + 1] * a;
    out[k + 2] = img.data[k + 2] * inv + graded.data[k + 2] * a;
    out[k + 3] = img.data[k + 3];
  }
  return { width: img.width, height: img.height, data: out, fullyAffected: touched };
}

/** 校验范围对象，返回清洗后的几何；结构不对时抛出可读错误。 */
export function normalizeWindow(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("window 必须是一个对象，例如 { kind: 'ellipse', cx, cy, rx, ry, feather }");
  }
  const feather = clamp(num(raw.feather, 40), 0, 400);
  const invert = raw.invert === true ? { invert: true } : {};
  const p = (v) => clamp(num(v), -1e6, 1e6);
  switch (raw.kind) {
    case "ellipse": {
      const rx = num(raw.rx);
      const ry = num(raw.ry);
      if (rx <= 0 || ry <= 0) throw new Error("椭圆需要 rx / ry 都大于 0");
      return {
        kind: "ellipse",
        cx: p(raw.cx),
        cy: p(raw.cy),
        rx,
        ry,
        rot: num(raw.rot),
        feather,
        ...invert,
      };
    }
    case "quad": {
      const pts = Array.isArray(raw.points) ? raw.points : [];
      if (pts.length !== 4) throw new Error("四边形需要 points 恰好 4 个点");
      const points = pts.map((q) => ({ x: p(q?.x), y: p(q?.y) }));
      const edges = Array.isArray(raw.edges)
        ? raw.edges.slice(0, 4).map((v) => clamp(num(v, feather), 0, 400))
        : undefined;
      return { kind: "quad", points, edges, feather, ...invert };
    }
    case "line": {
      return {
        kind: "line",
        x1: p(raw.x1),
        y1: p(raw.y1),
        x2: p(raw.x2),
        y2: p(raw.y2),
        feather,
        ...invert,
      };
    }
    case "poly": {
      const pts = Array.isArray(raw.points) ? raw.points : [];
      if (pts.length < 3) throw new Error("多边形至少需要 3 个点");
      return {
        kind: "poly",
        points: pts.map((q) => ({ x: p(q?.x), y: p(q?.y) })),
        feather,
        ...invert,
      };
    }
    default:
      throw new Error(
        `未知范围类型：${raw.kind}。支持 ellipse / quad / line / poly`,
      );
  }
}
