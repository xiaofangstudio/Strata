/**
 * 图层文档（Mark 4：插画排版）。
 *
 * 之前的管线只能对「一张图」做像素运算，而真实甲方需求是**分层的工作流**：
 * 背景一层、主体一层、阴影一层、文字一层、边框一层，各自还能单独调色。
 * 这里就是那套最薄的文档模型：
 *
 *   doc = { width, height, layers: [{ name, img, x, y, blend, opacity, visible }] }
 *
 * 约定：
 *  · 图层 img 是带 alpha 的 RGBA，坐标为图层左上角 (x, y)；
 *  · flatten 时自下而上逐层合成，支持常用混合模式（正片叠底 / 滤色 / 叠加 / 柔光…）；
 *  · 一切纯函数，输入 document 不就地改（返回新 doc），便于反复试版。
 */

/** 支持的混合模式（与 Photoshop 常用集合对齐，够插画用）。 */
export const BLEND_MODES = {
  normal: "正常",
  multiply: "正片叠底",
  screen: "滤色",
  overlay: "叠加",
  softLight: "柔光",
  darken: "变暗",
  lighten: "变亮",
  add: "线性减淡",
};

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** 单通道混合函数，输入输出均为 0–1。 */
function blendChannel(mode, d, s) {
  switch (mode) {
    case "multiply":
      return d * s;
    case "screen":
      return 1 - (1 - d) * (1 - s);
    case "overlay":
      return d < 0.5 ? 2 * d * s : 1 - 2 * (1 - d) * (1 - s);
    case "softLight": {
      // W3C 柔光近似式：以 d 为底、s 控方向
      const g = d <= 0.25 ? ((16 * d - 12) * d + 4) * d : Math.sqrt(d);
      return s <= 0.5 ? d - (1 - 2 * s) * d * (1 - d) : d + (2 * s - 1) * (g - d);
    }
    case "darken":
      return Math.min(d, s);
    case "lighten":
      return Math.max(d, s);
    case "add":
      return Math.min(1, d + s);
    default:
      return s;
  }
}

/** 新建文档。background 传 [r,g,b] 铺底，传 null/省略则透明。 */
export function createDoc(width, height, background = null) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const doc = { width: w, height: h, layers: [] };
  if (background) {
    const img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let i = 0; i < w * h; i += 1) {
      img.data[i * 4] = background[0];
      img.data[i * 4 + 1] = background[1];
      img.data[i * 4 + 2] = background[2];
      img.data[i * 4 + 3] = background[3] ?? 255;
    }
    doc.layers.push({
      name: "背景",
      img,
      x: 0,
      y: 0,
      blend: "normal",
      opacity: 1,
      visible: true,
    });
  }
  return doc;
}

/** 加一层（不就地改 doc）。 */
export function addLayer(doc, img, opts = {}) {
  const layer = {
    name: opts.name ?? `图层 ${doc.layers.length}`,
    img,
    x: Math.round(opts.x ?? 0),
    y: Math.round(opts.y ?? 0),
    blend: opts.blend && BLEND_MODES[opts.blend] ? opts.blend : "normal",
    opacity: typeof opts.opacity === "number" ? Math.max(0, Math.min(1, opts.opacity)) : 1,
    visible: opts.visible !== false,
  };
  return { ...doc, layers: [...doc.layers, layer] };
}

/** 替换某一层（按序号或名字）；返回新 doc。 */
export function replaceLayer(doc, target, img) {
  const i = layerIndex(doc, target);
  if (i < 0) throw new Error(`找不到图层：${target}`);
  const layers = doc.layers.slice();
  layers[i] = { ...layers[i], img };
  return { ...doc, layers };
}

/** 找图层序号，支持序号或名字。 */
export function layerIndex(doc, target) {
  if (typeof target === "number") {
    return target >= 0 && target < doc.layers.length ? target : -1;
  }
  const name = String(target);
  const byName = doc.layers.findIndex((l) => l.name === name);
  if (byName >= 0) return byName;
  const n = Number(name);
  return Number.isInteger(n) && n >= 0 && n < doc.layers.length ? n : -1;
}

/** 某层的尺寸（越界部分由 flatten 裁）。 */
export function layerSize(layer) {
  return { width: layer.img.width, height: layer.img.height };
}

/** 把 doc 压平成一张 RGBA 图。 */
export function flatten(doc) {
  const { width: w, height: h } = doc;
  const out = new Uint8ClampedArray(w * h * 4);
  for (const layer of doc.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const { img, x: ox, y: oy, blend, opacity } = layer;
    const sw = img.width;
    const sh = img.height;
    for (let sy = 0; sy < sh; sy += 1) {
      const dy = oy + sy;
      if (dy < 0 || dy >= h) continue;
      for (let sx = 0; sx < sw; sx += 1) {
        const dx = ox + sx;
        if (dx < 0 || dx >= w) continue;
        const si = (sy * sw + sx) * 4;
        const sa0 = img.data[si + 3] / 255;
        if (sa0 <= 0) continue;
        const sa = sa0 * opacity;
        const di = (dy * w + dx) * 4;
        const da = out[di + 3] / 255;
        if (da <= 0) {
          // 底是空的：直接放上去（混合模式没有可混的对象）
          out[di] = img.data[si];
          out[di + 1] = img.data[si + 1];
          out[di + 2] = img.data[si + 2];
          out[di + 3] = Math.round(sa * 255);
          continue;
        }
        const outA = sa + da * (1 - sa);
        for (let c = 0; c < 3; c += 1) {
          const d = out[di + c] / 255;
          const s = img.data[si + c] / 255;
          const b = blendChannel(blend, d, s);
          // 结果 = (混合色 × sa + 底色 × da(1-sa)) / outA
          const v = (b * sa + d * da * (1 - sa)) / outA;
          out[di + c] = clamp255(v * 255);
        }
        out[di + 3] = clamp255(outA * 255);
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** doc 摘要（给 MCP 返回用，不带像素）。 */
export function summarizeDoc(doc) {
  return {
    width: doc.width,
    height: doc.height,
    layers: doc.layers.map((l, i) => ({
      index: i,
      name: l.name,
      size: `${l.img.width}×${l.img.height}`,
      at: [l.x, l.y],
      blend: l.blend,
      blendLabel: BLEND_MODES[l.blend] ?? l.blend,
      opacity: Number(l.opacity.toFixed(2)),
      visible: l.visible,
    })),
  };
}

/* ------------------------------------------------------------ 区域蒙版 */

/**
 * 造一张区域蒙版：矩形 / 椭圆，带羽化。
 *
 * 「分区调色」就是拿它把调整结果与原图按位置混合 —— 比如只给猫脸加暖调、
 * 只给背景压暗。羽化让边界不会出现硬边切痕。
 */
export function regionMask(doc, region) {
  const { width: w, height: h } = doc;
  const mask = new Float32Array(w * h);
  if (!region) {
    mask.fill(1);
    return mask;
  }
  const feather = Math.max(0, region.feather ?? 0);
  const type = region.type ?? "rect";
  if (type === "ellipse") {
    const cx = region.cx ?? w / 2;
    const cy = region.cy ?? h / 2;
    const rx = Math.max(1, region.rx ?? w / 2);
    const ry = Math.max(1, region.ry ?? h / 2);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        const d = Math.sqrt(nx * nx + ny * ny); // 1 = 边缘
        // 羽化按归一化半径折算成像素
        const f = feather > 0 ? feather / Math.min(rx, ry) : 0;
        let v = 1;
        if (f > 0) v = 1 - smoothstep(1 - f, 1, d);
        else v = d <= 1 ? 1 : 0;
        mask[y * w + x] = v;
      }
    }
    return mask;
  }
  const x0 = region.x ?? 0;
  const y0 = region.y ?? 0;
  const rw = region.width ?? w;
  const rh = region.height ?? h;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dxIn = x - x0;
      const dyIn = y - y0;
      const inside =
        dxIn >= 0 && dxIn < rw && dyIn >= 0 && dyIn < rh
          ? Math.min(dxIn, rw - 1 - dxIn, dyIn, rh - 1 - dyIn)
          : -1;
      let v;
      if (inside < 0) v = 0;
      else if (feather <= 0) v = 1;
      else v = smoothstep(0, feather, inside);
      mask[y * w + x] = v;
    }
  }
  return mask;
}

function smoothstep(a, b, x) {
  if (b <= a) return x >= b ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** 按蒙版把 adjusted 混回 orig（m=1 全取新、m=0 保留旧）。 */
export function mixByMask(orig, adjusted, mask) {
  const out = { width: orig.width, height: orig.height, data: new Uint8ClampedArray(orig.data) };
  for (let i = 0, p = 0; p < mask.length; p += 1, i += 4) {
    const m = mask[p];
    if (m <= 0) continue;
    if (m >= 1) {
      out.data[i] = adjusted.data[i];
      out.data[i + 1] = adjusted.data[i + 1];
      out.data[i + 2] = adjusted.data[i + 2];
      out.data[i + 3] = adjusted.data[i + 3];
      continue;
    }
    for (let c = 0; c < 4; c += 1) {
      out.data[i + c] = orig.data[i + c] + (adjusted.data[i + c] - orig.data[i + c]) * m;
    }
  }
  return out;
}
