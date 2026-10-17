/**
 * 选区。
 *
 * 选区就是一张与文档同尺寸的单通道遮罩画布：**alpha 分量即选中程度**。
 * 0 表示未选中、255 表示完全选中、中间值用来承载羽化边缘与抗锯齿 ——
 * 这样后续「按选区限制绘制」「裁切到选区」都只需一句 `destination-in`，
 * 不必再写一套独立的位图运算。
 *
 * 之所以沿用 canvas 而不是裸位图：形状工具画出的路径可以一次性栅格化，
 * 并集 / 差集 / 交集直接吃 Canvas2D 的合成算子，省事且不会出错。
 *
 * 与蒙版的区别：蒙版属于某一层、用 alpha 表示「该层显示多少」；选区属于
 * 整份文档、是一段临时范围，用完即弃（可撤销）。两者数值语义相同，但
 * 生命周期与归属完全不同，因此各存一份。
 */
import { cloneSurface, createSurface, mustCtx, readPixels } from "../engine/surface";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 选区遮罩：与文档同尺寸的单通道画布，alpha 分量即「选中程度」。 */
export type SelectionMask = HTMLCanvasElement;

/** 新选区与既有选区的组合方式，对齐 PS 工具选项条的四态。 */
export type SelectionMode = "new" | "add" | "subtract" | "intersect";

/* ------------------------------------------------------------ 基础构造 */

/** 一张完全空白的选区遮罩（全部未选中）。 */
export function createSelectionMask(width: number, height: number): HTMLCanvasElement {
  return createSurface(width, height);
}

/** 全选：整张画布都是选中态。 */
export function selectAllMask(width: number, height: number): HTMLCanvasElement {
  return createSurface(width, height, "#ffffff");
}

/** 深拷贝一张选区遮罩（撤销栈与布尔运算都靠它）。 */
export function cloneSelection(mask: HTMLCanvasElement): HTMLCanvasElement {
  return cloneSurface(mask);
}

/* ------------------------------------------------------------ 形状构造 */

/**
 * 把一段绘制指令栅格化成选区遮罩。
 *
 * 羽化直接用 canvas 的 `blur()` 滤镜：边缘向内向外各糊一半，视觉上与
 * PS 的羽化一致，且不必手写高斯核。
 */
function paintShape(
  width: number,
  height: number,
  feather: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): HTMLCanvasElement {
  const mask = createSurface(width, height);
  const ctx = mustCtx(mask);
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#ffffff";
  const r = Math.max(0, feather);
  if (r > 0) ctx.filter = `blur(${r}px)`;
  draw(ctx);
  ctx.filter = "none";
  return mask;
}

/** 由任意两点围出的矩形选框（不要求左上在左下之前）。 */
export function rectMask(
  width: number,
  height: number,
  a: Point,
  b: Point,
  feather = 0,
): HTMLCanvasElement {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  return paintShape(width, height, feather, (ctx) => {
    ctx.fillRect(x, y, w, h);
  });
}

/** 由包围盒决定的内切椭圆选框。 */
export function ellipseMask(
  width: number,
  height: number,
  a: Point,
  b: Point,
  feather = 0,
): HTMLCanvasElement {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  return paintShape(width, height, feather, (ctx) => {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  });
}

/** 套索：自由手绘折线闭合成多边形。少于 3 个点时不产生选区。 */
export function lassoMask(
  width: number,
  height: number,
  points: Point[],
  feather = 0,
): HTMLCanvasElement {
  return paintShape(width, height, feather, (ctx) => {
    if (points.length < 3) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    ctx.fill();
  });
}

/* ------------------------------------------------------------ 魔棒 */

/**
 * 魔棒：按容差把颜色相近的区域抠成选区。
 *
 * 判定沿用油漆桶的写法（四通道距离平方 ≤ 容差²×4），保证「同容差下魔棒
 * 选中的范围」与「油漆桶填充的范围」完全一致 —— 否则用户会觉得两者对不上。
 *
 * `contiguous` 为 true 时只取与落点相连的一片（四邻域扫描线洪水），
 * 为 false 时全图同色一并选中（PS 的「连续」复选框）。
 */
export function wandMask(
  surface: HTMLCanvasElement,
  seed: Point,
  tolerance: number,
  contiguous = true,
): HTMLCanvasElement | null {
  const w = surface.width;
  const h = surface.height;
  const x0 = Math.floor(seed.x);
  const y0 = Math.floor(seed.y);
  if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return null;

  const d = readPixels(surface).data;
  const at = (x: number, y: number) => (y * w + x) * 4;
  const s = at(x0, y0);
  const sr = d[s];
  const sg = d[s + 1];
  const sb = d[s + 2];
  const sa = d[s + 3];
  const tol = tolerance * tolerance * 4;
  const near = (i: number) => {
    const dr = d[i] - sr;
    const dg = d[i + 1] - sg;
    const db = d[i + 2] - sb;
    const da = d[i + 3] - sa;
    return dr * dr + dg * dg + db * db + da * da <= tol;
  };

  const mask = createSurface(w, h);
  const out = readPixels(mask);
  const od = out.data;

  if (!contiguous) {
    for (let p = 0; p < w * h; p += 1) {
      if (near(at(p % w, Math.floor(p / w)))) {
        const i = p * 4;
        od[i] = 255;
        od[i + 1] = 255;
        od[i + 2] = 255;
        od[i + 3] = 255;
      }
    }
    mustCtx(mask).putImageData(out, 0, 0);
    return mask;
  }

  const visited = new Uint8Array(w * h);
  const stack: number[] = [x0, y0];
  while (stack.length > 0) {
    const y = stack.pop() as number;
    const x = stack.pop() as number;
    let left = x;
    while (left >= 0 && !visited[y * w + left] && near(at(left, y))) left -= 1;
    left += 1;
    let right = x;
    while (right < w && !visited[y * w + right] && near(at(right, y))) right += 1;
    right -= 1;
    for (let i = left; i <= right; i += 1) {
      visited[y * w + i] = 1;
      const p = (y * w + i) * 4;
      od[p] = 255;
      od[p + 1] = 255;
      od[p + 2] = 255;
      od[p + 3] = 255;
      if (y > 0 && !visited[(y - 1) * w + i] && near(at(i, y - 1))) stack.push(i, y - 1);
      if (y < h - 1 && !visited[(y + 1) * w + i] && near(at(i, y + 1))) stack.push(i, y + 1);
    }
  }
  mustCtx(mask).putImageData(out, 0, 0);
  return mask;
}

/* ------------------------------------------------------------ 布尔运算 */

/** 把新选区按 `mode` 合进既有选区。base 为空时一律视作「新建」。 */
export function combineSelection(
  base: SelectionMask | null | undefined,
  shape: SelectionMask,
  mode: SelectionMode,
): HTMLCanvasElement {
  if (!base || mode === "new" || base.width !== shape.width || base.height !== shape.height) {
    return cloneSelection(shape);
  }
  const out = cloneSelection(base);
  const ctx = mustCtx(out);
  if (mode === "add") {
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(shape, 0, 0);
  } else if (mode === "subtract") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(shape, 0, 0);
  } else {
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(shape, 0, 0);
  }
  ctx.globalCompositeOperation = "source-over";
  return out;
}

/** 反选（选中程度取补）。 */
export function invertSelection(mask: HTMLCanvasElement): HTMLCanvasElement {
  const out = cloneSelection(mask);
  const ctx = mustCtx(out);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = 255 - d[i];
  ctx.putImageData(img, 0, 0);
  return out;
}

/* ------------------------------------------------------------ 查询与限制 */

/** 选区是否完全为空（没有任何像素被选中）。 */
export function isSelectionEmpty(mask: SelectionMask | null | undefined): boolean {
  if (!mask) return true;
  const d = readPixels(mask).data;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] !== 0) return false;
  }
  return true;
}

/** 被选中像素的包围盒（忽略全透明的行与列）；全空时返回 null。 */
export function selectionBounds(mask: SelectionMask | null | undefined): Rect | null {
  if (!mask) return null;
  const w = mask.width;
  const h = mask.height;
  const d = readPixels(mask).data;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (d[(y * w + x) * 4 + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * 把选区裁到某层像素上，返回一张「只保留选中部分」的新画布。
 *
 * 拿到的其实还是原图（尺寸不变、只在选区外变透明），因为按选区限制绘制
 * 本来就是「先把绘制结果画出来，再按选区抠一刀」，保留原尺寸才能原地贴回。
 */
export function applySelection(
  surface: HTMLCanvasElement,
  mask: HTMLCanvasElement | null,
): HTMLCanvasElement {
  const out = cloneSurface(surface);
  if (!mask) return out;
  const ctx = mustCtx(out);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(mask, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  return out;
}

/* ------------------------------------------------------- 修改已有选区 */

/**
 * 羽化：把选区边缘由实变虚。
 *
 * 直接借 Canvas2D 的 `blur()` 滤镜再画一遍 —— 与形状构造里的羽化同一套办法，
 * 视觉上就是 PS 的「选择 > 修改 > 羽化」。
 */
export function featherSelection(mask: SelectionMask, radius: number): SelectionMask {
  if (radius <= 0) return cloneSelection(mask);
  const out = createSurface(mask.width, mask.height);
  const ctx = mustCtx(out);
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(mask, 0, 0);
  ctx.filter = "none";
  return out;
}

/**
 * 扩展 / 收缩共用的形态学运算。
 *
 * 用一个「圆盘」结构元：在半径内取一圈方向，把遮罩按这些方向逐个偏移叠印，
 * 取并集即向外长出 radius 像素（膨胀）。收缩是它的对偶 —— 先把遮罩取反、
 * 膨胀、再取反（腐蚀），这也是形态学的标准做法，不必另写一套遍历像素的内核。
 */
function morphSelection(
  mask: SelectionMask,
  radius: number,
  outward: boolean,
): SelectionMask {
  const out = createSurface(mask.width, mask.height);
  const ctx = mustCtx(out);
  const src = outward ? mask : invertSelection(mask);
  const steps = Math.max(8, Math.ceil(radius * 4));
  // 叠印取并集：alpha 相加（lighter）后自动饱和到 255，正合遮罩语义
  ctx.globalCompositeOperation = "lighter";
  ctx.drawImage(src, 0, 0);
  for (let i = 0; i < steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    ctx.drawImage(src, Math.round(Math.cos(a) * radius), Math.round(Math.sin(a) * radius));
  }
  ctx.globalCompositeOperation = "source-over";
  return outward ? out : invertSelection(out);
}

/** 扩展：把选区边界向外推 radius 像素。 */
export function expandSelection(mask: SelectionMask, radius: number): SelectionMask {
  if (radius <= 0) return cloneSelection(mask);
  return morphSelection(mask, radius, true);
}

/** 收缩：把选区边界向内收 radius 像素。 */
export function contractSelection(mask: SelectionMask, radius: number): SelectionMask {
  if (radius <= 0) return cloneSelection(mask);
  return morphSelection(mask, radius, false);
}
