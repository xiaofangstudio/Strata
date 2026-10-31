/**
 * 四点变形（斜切 / 透视 / 扭曲 / 变形）的栅格化。
 *
 * 做法：取源图层内容的包围盒，把「包围盒四角 → 目标四边形」的单应矩阵求逆，
 * 对目标四边形外接矩形内的每个像素反查 (u,v)，再在源图上双线性采样。
 * 这是真正的透视变换（不是仿射近似）。
 */
import { createSurface, mustCtx } from "./surface";
import { applyMat3, invertMat3, unitSquareToQuad, type Pt } from "../core/homography";

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 非透明像素的包围盒；全透明返回 null。 */
export function contentBounds(src: HTMLCanvasElement): Bounds | null {
  const w = src.width;
  const h = src.height;
  const { data } = mustCtx(src).getImageData(0, 0, w, h);
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (data[(y * w + x) * 4 + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * 灭点 / 平面矫正：把「四点围出的平面」拉正成矩形。
 *
 * 与 warpQuadSurface 正好相反 —— 后者是矩形内容贴到目标四边形（加透视），
 * 这里是四边形内容展平成矩形（去透视）。做法：单位正方形 → 四边形的单应
 * 矩阵正着用，对输出矩形的每个像素反解 (u,v) 再回到源图采样。
 * 施工照、翻拍文档、建筑立面的校正都靠这个。
 */
export function rectifyQuadSurface(
  src: HTMLCanvasElement,
  quad: readonly Pt[],
  outW: number,
  outH: number,
): HTMLCanvasElement {
  const out = createSurface(outW, outH);
  const m = unitSquareToQuad(quad);
  const srcCtx = mustCtx(src);
  const region = srcCtx.getImageData(0, 0, src.width, src.height);
  const sw = src.width;
  const sh = src.height;
  const outCtx = mustCtx(out);
  const outImg = outCtx.createImageData(outW, outH);
  const od = outImg.data;
  for (let y = 0; y < outH; y += 1) {
    const v = (y + 0.5) / outH;
    for (let x = 0; x < outW; x += 1) {
      const u = (x + 0.5) / outW;
      const p = applyMat3(m, u, v);
      if (!p) continue;
      const fx = p.x - 0.5;
      const fy = p.y - 0.5;
      if (fx < -1 || fy < -1 || fx > sw || fy > sh) continue;
      const ix = Math.min(sw - 2, Math.max(0, Math.floor(fx)));
      const iy = Math.min(sh - 2, Math.max(0, Math.floor(fy)));
      const tx = Math.min(1, Math.max(0, fx - ix));
      const ty = Math.min(1, Math.max(0, fy - iy));
      const o = (y * outW + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        const p00 = region.data[(iy * sw + ix) * 4 + c];
        const p10 = region.data[(iy * sw + ix + 1) * 4 + c];
        const p01 = region.data[((iy + 1) * sw + ix) * 4 + c];
        const p11 = region.data[((iy + 1) * sw + ix + 1) * 4 + c];
        od[o + c] = (p00 * (1 - tx) + p10 * tx) * (1 - ty) + (p01 * (1 - tx) + p11 * tx) * ty;
      }
    }
  }
  outCtx.putImageData(outImg, 0, 0);
  return out;
}

/**
 * 把 src 的 bbox 区域按四点单应变形，铺到 outW×outH 的画布上。
 * quad 为文档坐标下的目标四边形（左上、右上、右下、左下）。
 */
export function warpQuadSurface(
  src: HTMLCanvasElement,
  bbox: Bounds,
  quad: readonly Pt[],
  outW: number,
  outH: number,
): HTMLCanvasElement {
  const out = createSurface(outW, outH);
  if (bbox.w < 1 || bbox.h < 1) return out;
  const region = mustCtx(src).getImageData(bbox.x, bbox.y, bbox.w, bbox.h);
  const rw = bbox.w;
  const rh = bbox.h;
  const inv = invertMat3(unitSquareToQuad(quad));
  if (!inv) return out;

  const outCtx = mustCtx(out);
  const outImg = outCtx.createImageData(outW, outH);
  const od = outImg.data;

  let qx0 = Infinity;
  let qy0 = Infinity;
  let qx1 = -Infinity;
  let qy1 = -Infinity;
  for (const p of quad) {
    qx0 = Math.min(qx0, p.x);
    qy0 = Math.min(qy0, p.y);
    qx1 = Math.max(qx1, p.x);
    qy1 = Math.max(qy1, p.y);
  }
  const x0 = Math.max(0, Math.floor(qx0));
  const y0 = Math.max(0, Math.floor(qy0));
  const x1 = Math.min(outW - 1, Math.ceil(qx1));
  const y1 = Math.min(outH - 1, Math.ceil(qy1));

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const uv = applyMat3(inv, x + 0.5, y + 0.5);
      if (!uv || uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) continue;
      const fx = uv.x * (rw - 1);
      const fy = uv.y * (rh - 1);
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const ix1 = Math.min(rw - 1, ix + 1);
      const iy1 = Math.min(rh - 1, iy + 1);
      const tx = fx - ix;
      const ty = fy - iy;
      const o = (y * outW + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        const p00 = region.data[(iy * rw + ix) * 4 + c];
        const p10 = region.data[(iy * rw + ix1) * 4 + c];
        const p01 = region.data[(iy1 * rw + ix) * 4 + c];
        const p11 = region.data[(iy1 * rw + ix1) * 4 + c];
        od[o + c] =
          (p00 * (1 - tx) + p10 * tx) * (1 - ty) +
          (p01 * (1 - tx) + p11 * tx) * ty;
      }
    }
  }
  outCtx.putImageData(outImg, 0, 0);
  return out;
}
