/**
 * 自动生成 —— 请勿手改！
 *
 * 由 scripts/build-mcp-engines.mjs 从 scripts/mcp-engines-entry.ts 打包而来。
 * 改算法请改 src/，然后执行：npm run mcp:engines
 *
 * 内容：滤镜注册表（FILTER_DEFS）、颜色模式、接缝雕刻、MLS 变形、
 * 智能选区判定、自动对齐、色彩配置文件换算。
 * 全部是「RGBA 字节数组进 / 出」的纯函数，界面与 MCP 共用同一份实现。
 */


// src/engine/filters/kernels.ts
function makeBuffer(width, height) {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}
function cloneBuffer(src) {
  return { data: new Uint8ClampedArray(src.data), width: src.width, height: src.height };
}
function premultiply(src) {
  const { data } = src;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    out[i] = data[i] * a;
    out[i + 1] = data[i + 1] * a;
    out[i + 2] = data[i + 2] * a;
    out[i + 3] = data[i + 3];
  }
  return out;
}
function unpremultiplyInto(dst, p) {
  for (let i = 0; i < p.length; i += 4) {
    const a = p[i + 3];
    if (a <= 0) {
      dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 0;
      continue;
    }
    const inv = 255 / a;
    dst[i] = p[i] * inv;
    dst[i + 1] = p[i + 1] * inv;
    dst[i + 2] = p[i + 2] * inv;
    dst[i + 3] = a;
  }
}
function boxPassLine(src, dst, count, channels, r) {
  const win = 2 * r + 1;
  const norm = 1 / win;
  for (let i = 0; i < count; i += 1) {
    const o = i * channels;
    for (let c = 0; c < channels; c += 1) dst[o + c] = 0;
    for (let k = 0; k < win; k += 1) {
      const idx = Math.min(count - 1, Math.max(0, i + k - r)) * channels;
      for (let c = 0; c < channels; c += 1) dst[o + c] += src[idx + c];
    }
    for (let c = 0; c < channels; c += 1) dst[o + c] *= norm;
  }
}
function boxBlurPass(p, w, h, r) {
  if (r <= 0) return p;
  const tmp = new Float32Array(p.length);
  for (let y = 0; y < h; y += 1) {
    boxPassLine(
      p.subarray(y * w * 4, (y + 1) * w * 4),
      tmp.subarray(y * w * 4, (y + 1) * w * 4),
      w,
      4,
      r
    );
  }
  const out = new Float32Array(p.length);
  const col = new Float32Array(h * 4);
  const acc = new Float32Array(h * 4);
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) {
      const o = (y * w + x) * 4;
      col[y * 4] = tmp[o];
      col[y * 4 + 1] = tmp[o + 1];
      col[y * 4 + 2] = tmp[o + 2];
      col[y * 4 + 3] = tmp[o + 3];
    }
    boxPassLine(col, acc, h, 4, r);
    for (let y = 0; y < h; y += 1) {
      const o = (y * w + x) * 4;
      out[o] = acc[y * 4];
      out[o + 1] = acc[y * 4 + 1];
      out[o + 2] = acc[y * 4 + 2];
      out[o + 3] = acc[y * 4 + 3];
    }
  }
  return out;
}
function boxesForGauss(sigma, n) {
  const wIdeal = Math.sqrt(12 * sigma * sigma / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl -= 1;
  wl = Math.max(1, wl);
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * (wl * wl) - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.min(n, Math.max(0, Math.round(mIdeal)));
  return Array.from({ length: n }, (_, i) => i < m ? wl : wu);
}
function boxBlur(src, radius) {
  const r = Math.max(0, Math.round(radius));
  const out = cloneBuffer(src);
  if (r === 0) return out;
  let p = premultiply(src);
  p = boxBlurPass(p, src.width, src.height, r);
  unpremultiplyInto(out.data, p);
  return out;
}
function gaussianKernel(sigma) {
  if (sigma < 0.05) return [1];
  const r = Math.ceil(sigma * 3);
  const k = [];
  for (let i = -r; i <= r; i += 1) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const s = k.reduce((a, b) => a + b, 0);
  return k.map((v) => v / s);
}
function convSep(p, w, h, kx, ky) {
  const rx = kx.length / 2 | 0;
  const ry = ky.length / 2 | 0;
  const tmp = new Float32Array(p.length);
  const out = new Float32Array(p.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let acc = 0;
        for (let i = -rx; i <= rx; i += 1) {
          const xi = Math.min(w - 1, Math.max(0, x + i));
          acc += p[(y * w + xi) * 4 + c] * kx[i + rx];
        }
        tmp[(y * w + x) * 4 + c] = acc;
      }
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let acc = 0;
        for (let i = -ry; i <= ry; i += 1) {
          const yi = Math.min(h - 1, Math.max(0, y + i));
          acc += tmp[(yi * w + x) * 4 + c] * ky[i + ry];
        }
        out[(y * w + x) * 4 + c] = acc;
      }
    }
  }
  return out;
}
function gaussianBlur(src, radius) {
  const sigma = Math.max(0, radius) / 2;
  const out = cloneBuffer(src);
  if (sigma < 0.05) return out;
  let p;
  if (sigma > 4) {
    const boxes = boxesForGauss(sigma, 3);
    p = premultiply(src);
    for (const b of boxes) {
      const r = Math.max(0, (b - 1) / 2);
      p = boxBlurPass(p, src.width, src.height, r);
    }
  } else {
    const k = gaussianKernel(sigma);
    p = convSep(premultiply(src), src.width, src.height, k, k);
  }
  unpremultiplyInto(out.data, p);
  return out;
}
function motionBlur(src, angleDeg, distance) {
  const d = Math.max(0, Math.round(distance));
  if (d === 0) return cloneBuffer(src);
  const { width: w, height: h } = src;
  const theta = angleDeg * Math.PI / 180;
  const dx = Math.cos(theta);
  const dy = -Math.sin(theta);
  const p = premultiply(src);
  const out = new Float32Array(p.length);
  const steps = d * 2 + 1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        let acc = 0;
        for (let s = -d; s <= d; s += 1) {
          const xi = Math.min(w - 1, Math.max(0, Math.round(x + dx * s)));
          const yi = Math.min(h - 1, Math.max(0, Math.round(y + dy * s)));
          acc += p[(yi * w + xi) * 4 + c];
        }
        out[o + c] = acc / steps;
      }
    }
  }
  const res = cloneBuffer(src);
  unpremultiplyInto(res.data, out);
  return res;
}
function sharpenKernel(strength) {
  const s = Math.max(1, strength);
  return [0, -s, 0, -s, 1 + 4 * s, -s, 0, -s, 0];
}
function convolve3x3(src, k, divisor = 0, bias = 0) {
  const { width: w, height: h } = src;
  const div = divisor || k.reduce((a, b) => a + b, 0) || 1;
  const p = premultiply(src);
  const out = new Float32Array(p.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let acc = bias;
        for (let ky = -1; ky <= 1; ky += 1) {
          const yi = Math.min(h - 1, Math.max(0, y + ky));
          for (let kx = -1; kx <= 1; kx += 1) {
            const xi = Math.min(w - 1, Math.max(0, x + kx));
            acc += p[(yi * w + xi) * 4 + c] * k[(ky + 1) * 3 + (kx + 1)];
          }
        }
        out[(y * w + x) * 4 + c] = acc / div;
      }
    }
  }
  const res = cloneBuffer(src);
  unpremultiplyInto(res.data, out);
  return res;
}
function unsharpMask(src, radius, amount, threshold) {
  const blurred = gaussianBlur(src, radius);
  const a = amount / 100;
  const t = Math.max(0, threshold);
  const out = cloneBuffer(src);
  const { data } = out;
  for (let i = 0; i < data.length; i += 4) {
    const sa = data[i + 3] / 255;
    for (let c = 0; c < 3; c += 1) {
      const diff = src.data[i + c] - blurred.data[i + c];
      if (Math.abs(diff) >= t) {
        data[i + c] = src.data[i + c] + a * diff * sa;
      }
    }
  }
  return out;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function addNoise(src, amount, monochrome, seed = 20261024) {
  const out = cloneBuffer(src);
  const { data } = out;
  const rand = rng(seed);
  const amp = Math.max(0, amount) / 100 * 255;
  const once = monochrome ? new Float32Array(3) : null;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    if (once) {
      const v = (rand() - 0.5) * amp;
      once[0] = once[1] = once[2] = v;
      for (let c = 0; c < 3; c += 1) data[i + c] += once[c];
    } else {
      for (let c = 0; c < 3; c += 1) data[i + c] += (rand() - 0.5) * amp;
    }
  }
  return out;
}
function median(src, radius) {
  const r = Math.max(1, Math.round(radius));
  const { width: w, height: h, data } = src;
  const out = cloneBuffer(src);
  const win = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < 3; c += 1) {
        win.length = 0;
        for (let dy = -r; dy <= r; dy += 1) {
          const yi = Math.min(h - 1, Math.max(0, y + dy));
          for (let dx = -r; dx <= r; dx += 1) {
            const xi = Math.min(w - 1, Math.max(0, x + dx));
            win.push(data[(yi * w + xi) * 4 + c]);
          }
        }
        win.sort((a, b) => a - b);
        out.data[(y * w + x) * 4 + c] = win[win.length >> 1];
      }
    }
  }
  return out;
}
function dustAndScratch(src, radius, threshold) {
  const r = Math.max(1, Math.round(radius));
  const t = Math.max(0, threshold);
  const med = median(src, r);
  const { width: w, height: h, data } = src;
  const out = cloneBuffer(src);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      let diff = 0;
      for (let c = 0; c < 3; c += 1) diff = Math.max(diff, Math.abs(data[o + c] - med.data[o + c]));
      if (diff < t) {
        for (let c = 0; c < 3; c += 1) out.data[o + c] = med.data[o + c];
      }
    }
  }
  return out;
}
function reduceNoise(src, strength) {
  const med = median(src, 1);
  const k = Math.min(100, Math.max(0, strength)) / 100;
  const out = cloneBuffer(src);
  for (let i = 0; i < src.data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      out.data[i + c] = src.data[i + c] * (1 - k) + med.data[i + c] * k;
    }
  }
  return out;
}
function surfaceBlur(src, radius, threshold) {
  const r = Math.max(1, Math.round(radius));
  const t = Math.max(1, threshold);
  const { width: w, height: h, data } = src;
  const out = cloneBuffer(src);
  const luma2 = new Float32Array(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 1) {
    luma2[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const lc = luma2[y * w + x];
      let wsum = 0;
      const acc = [0, 0, 0];
      for (let dy = -r; dy <= r; dy += 1) {
        const yi = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx += 1) {
          const xi = Math.min(w - 1, Math.max(0, x + dx));
          const j = yi * w + xi;
          const diff = Math.abs(luma2[j] - lc);
          if (diff > t) continue;
          const wgt = 1 - (diff / t) ** 2;
          wsum += wgt;
          const p = j * 4;
          acc[0] += data[p] * wgt;
          acc[1] += data[p + 1] * wgt;
          acc[2] += data[p + 2] * wgt;
        }
      }
      if (wsum > 0) {
        out.data[o] = acc[0] / wsum;
        out.data[o + 1] = acc[1] / wsum;
        out.data[o + 2] = acc[2] / wsum;
      }
    }
  }
  return out;
}
function radialSpin(src, angleDeg, steps) {
  const { width: w, height: h } = src;
  const p = premultiply(src);
  const out = new Float32Array(p.length);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const n = Math.max(2, Math.round(steps));
  const rad = angleDeg * Math.PI / 180 / n;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const cos0 = Math.cos(rad);
      const sin0 = Math.sin(rad);
      for (let c = 0; c < 4; c += 1) {
        let acc = 0;
        let sx = x;
        let sy = y;
        for (let s = 0; s < n; s += 1) {
          const xi = Math.min(w - 1, Math.max(0, Math.round(sx)));
          const yi = Math.min(h - 1, Math.max(0, Math.round(sy)));
          acc += p[(yi * w + xi) * 4 + c];
          const nx = (sx - cx) * cos0 - (sy - cy) * sin0;
          const ny = (sx - cx) * sin0 + (sy - cy) * cos0;
          sx = nx + cx;
          sy = ny + cy;
        }
        out[(y * w + x) * 4 + c] = acc / n;
      }
    }
  }
  const res = cloneBuffer(src);
  unpremultiplyInto(res.data, out);
  return res;
}
function radialZoom(src, amount, steps) {
  const { width: w, height: h } = src;
  const p = premultiply(src);
  const out = new Float32Array(p.length);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const n = Math.max(2, Math.round(steps));
  const k = Math.max(0, amount) / 100 / n;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let acc = 0;
        for (let s = 0; s < n; s += 1) {
          const f2 = 1 + k * s;
          const xi = Math.min(w - 1, Math.max(0, Math.round(cx + (x - cx) * f2)));
          const yi = Math.min(h - 1, Math.max(0, Math.round(cy + (y - cy) * f2)));
          acc += p[(yi * w + xi) * 4 + c];
        }
        out[(y * w + x) * 4 + c] = acc / n;
      }
    }
  }
  const res = cloneBuffer(src);
  unpremultiplyInto(res.data, out);
  return res;
}
function mosaic(src, size) {
  const s = Math.max(1, Math.round(size));
  const { width: w, height: h, data } = src;
  const out = cloneBuffer(src);
  for (let by = 0; by < h; by += s) {
    for (let bx = 0; bx < w; bx += s) {
      const acc = [0, 0, 0, 0];
      let n = 0;
      for (let y = by; y < Math.min(h, by + s); y += 1) {
        for (let x = bx; x < Math.min(w, bx + s); x += 1) {
          const o = (y * w + x) * 4;
          acc[0] += data[o];
          acc[1] += data[o + 1];
          acc[2] += data[o + 2];
          acc[3] += data[o + 3];
          n += 1;
        }
      }
      for (let y = by; y < Math.min(h, by + s); y += 1) {
        for (let x = bx; x < Math.min(w, bx + s); x += 1) {
          const o = (y * w + x) * 4;
          out.data[o] = acc[0] / n;
          out.data[o + 1] = acc[1] / n;
          out.data[o + 2] = acc[2] / n;
          out.data[o + 3] = acc[3] / n;
        }
      }
    }
  }
  return out;
}
function crystallize(src, size, seed = 7) {
  const s = Math.max(2, Math.round(size));
  const { width: w, height: h, data } = src;
  const out = cloneBuffer(src);
  const rand = rng(seed);
  const jx = new Float32Array(Math.ceil(w / s) + 2);
  const jy = new Float32Array(Math.ceil(h / s) + 2);
  for (let i = 0; i < jx.length; i += 1) jx[i] = (rand() - 0.5) * s * 0.8;
  for (let i = 0; i < jy.length; i += 1) jy[i] = (rand() - 0.5) * s * 0.8;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const gx = Math.floor(x / s);
      const gy = Math.floor(y / s);
      const cx = Math.min(w - 1, Math.max(0, Math.round(gx * s + s / 2 + jx[gx])));
      const cy = Math.min(h - 1, Math.max(0, Math.round(gy * s + s / 2 + jy[gy])));
      const so = (cy * w + cx) * 4;
      const o = (y * w + x) * 4;
      out.data[o] = data[so];
      out.data[o + 1] = data[so + 1];
      out.data[o + 2] = data[so + 2];
      out.data[o + 3] = data[so + 3];
    }
  }
  return out;
}
function fragment(src, offset2) {
  const d = Math.max(1, Math.round(offset2));
  const { width: w, height: h, data } = src;
  const out = cloneBuffer(src);
  const dirs = [
    [-d, -d],
    [d, -d],
    [-d, d],
    [d, d]
  ];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        let acc = 0;
        for (const [dx, dy] of dirs) {
          const xi = Math.min(w - 1, Math.max(0, x + dx));
          const yi = Math.min(h - 1, Math.max(0, y + dy));
          acc += data[(yi * w + xi) * 4 + c];
        }
        out.data[o + c] = acc / 4;
      }
    }
  }
  return out;
}
function mezzotint(src, density, seed = 99) {
  const out = cloneBuffer(src);
  const { data, width: w, height: h } = out;
  const rand = rng(seed);
  const p = Math.min(100, Math.max(0, density)) / 100;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (rand() < p) {
        const o = (y * w + x) * 4;
        const v = rand() < 0.5 ? 0 : 255;
        data[o] = data[o + 1] = data[o + 2] = v;
      }
    }
  }
  return out;
}
function sampleBilinear(src, x, y, out, o) {
  const { width: w, height: h, data } = src;
  const cx = Math.min(w - 1, Math.max(0, x));
  const cy = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  for (let c = 0; c < 4; c += 1) {
    const p00 = data[(y0 * w + x0) * 4 + c];
    const p10 = data[(y0 * w + x1) * 4 + c];
    const p01 = data[(y1 * w + x0) * 4 + c];
    const p11 = data[(y1 * w + x1) * 4 + c];
    out[o + c] = (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy;
  }
}
function twirl(src, angleDeg, radiusPct) {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const R = Math.max(1, Math.min(w, h) / 2 * Math.min(100, Math.max(1, radiusPct)) / 100);
  const ang = angleDeg * Math.PI / 180;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      const o = (y * w + x) * 4;
      if (r >= R) {
        sampleBilinear(src, x, y, out.data, o);
        continue;
      }
      const t = ang * (1 - r / R) ** 2;
      const cos = Math.cos(t);
      const sin = Math.sin(t);
      sampleBilinear(src, cx + dx * cos - dy * sin, cy + dx * sin + dy * cos, out.data, o);
    }
  }
  return out;
}
function wave(src, amplitude, wavelength) {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const len = Math.max(2, wavelength);
  const amp = Math.max(0, amplitude);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const dx = amp * Math.sin(y / len * Math.PI * 2);
      const dy = amp * Math.sin(x / len * Math.PI * 2);
      sampleBilinear(src, x + dx, y + dy, out.data, o);
    }
  }
  return out;
}
function ripple(src, amount, size) {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const len = Math.max(2, size);
  const amp = Math.max(0, amount);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      const dr = amp * Math.sin(r / len * Math.PI * 2);
      const rr = r === 0 ? 0 : (r + dr) / r;
      const o = (y * w + x) * 4;
      sampleBilinear(src, cx + dx * rr, cy + dy * rr, out.data, o);
    }
  }
  return out;
}
function pinch(src, amount) {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const R = Math.min(w, h) / 2;
  const a = Math.max(-100, Math.min(100, amount)) / 100;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      const o = (y * w + x) * 4;
      if (r >= R || r === 0) {
        sampleBilinear(src, x, y, out.data, o);
        continue;
      }
      const k = 1 + a * (1 - r / R) ** 2;
      sampleBilinear(src, cx + dx * k, cy + dy * k, out.data, o);
    }
  }
  return out;
}
function findEdges(src) {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const o = i * 4;
    lum[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(w - 1, x + 1);
      const ym = Math.max(0, y - 1);
      const yp = Math.min(h - 1, y + 1);
      const gx = -lum[ym * w + xm] - 2 * lum[y * w + xm] - lum[yp * w + xm] + lum[ym * w + xp] + 2 * lum[y * w + xp] + lum[yp * w + xp];
      const gy = -lum[ym * w + xm] - 2 * lum[ym * w + x] - lum[ym * w + xp] + lum[yp * w + xm] + 2 * lum[yp * w + x] + lum[yp * w + xp];
      const g = Math.min(255, Math.hypot(gx, gy));
      const v = 255 - g;
      const o = (y * w + x) * 4;
      out.data[o] = out.data[o + 1] = out.data[o + 2] = v;
      out.data[o + 3] = data[o + 3];
    }
  }
  return out;
}
function emboss(src, angleDeg, height, amount) {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  const rad = angleDeg * Math.PI / 180;
  const dx = Math.cos(rad);
  const dy = -Math.sin(rad);
  const k = amount / 100;
  const at = (x, y) => {
    const xi = Math.min(w - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(h - 1, Math.max(0, Math.round(y)));
    const o = (yi * w + xi) * 4;
    return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const v = 128 + (at(x - dx * height, y - dy * height) - at(x + dx * height, y + dy * height)) * k;
      const o = (y * w + x) * 4;
      out.data[o] = out.data[o + 1] = out.data[o + 2] = v;
      out.data[o + 3] = data[o + 3];
    }
  }
  return out;
}
function solarize(src) {
  const out = cloneBuffer(src);
  const { data } = out;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      if (data[i + c] > 128) data[i + c] = 255 - data[i + c];
    }
  }
  return out;
}
function wind(src, strength, seed = 7) {
  const blurred = motionBlur(src, 0, Math.max(1, Math.round(strength)));
  const out = cloneBuffer(blurred);
  const { data, width: w, height: h } = out;
  const rand = rng(seed);
  const d0 = src.data;
  for (let i = 0; i < w * h; i += 1) {
    if (rand() < 0.45) {
      const o = i * 4;
      data[o] = d0[o];
      data[o + 1] = d0[o + 1];
      data[o + 2] = d0[o + 2];
    }
  }
  return out;
}
function oilPaint(src, radius) {
  const r = Math.max(1, Math.min(6, Math.round(radius)));
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const o = i * 4;
    lum[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }
  const quad = (x, y, sx, sy) => {
    let n = 0;
    let sl = 0;
    let sl2 = 0;
    let r0 = 0;
    let g0 = 0;
    let b0 = 0;
    for (let j = 0; j <= r; j += 1) {
      const yi = Math.min(h - 1, Math.max(0, y + sy * j));
      for (let i = 0; i <= r; i += 1) {
        const xi = Math.min(w - 1, Math.max(0, x + sx * i));
        const k = yi * w + xi;
        const l = lum[k];
        n += 1;
        sl += l;
        sl2 += l * l;
        const o = k * 4;
        r0 += data[o];
        g0 += data[o + 1];
        b0 += data[o + 2];
      }
    }
    const mean = sl / n;
    return [sl2 / n - mean * mean, r0 / n, g0 / n, b0 / n];
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let best = quad(x, y, 1, 1);
      for (const [sx, sy] of [[-1, 1], [1, -1], [-1, -1]]) {
        const q = quad(x, y, sx, sy);
        if (q[0] < best[0]) best = q;
      }
      const o = (y * w + x) * 4;
      out.data[o] = best[1];
      out.data[o + 1] = best[2];
      out.data[o + 2] = best[3];
      out.data[o + 3] = data[o + 3];
    }
  }
  return out;
}
function grain(src, amount, seed = 21) {
  const out = cloneBuffer(src);
  const { data } = out;
  const rand = rng(seed);
  const a = Math.max(0, amount) / 2;
  for (let i = 0; i < data.length; i += 4) {
    const n = (rand() - 0.5) * 2 * a;
    data[i] += n;
    data[i + 1] += n;
    data[i + 2] += n;
  }
  return out;
}
function patchwork(src, size) {
  const s = Math.max(2, Math.round(size));
  const { width: w, height: h } = src;
  const gw = Math.ceil(w / s);
  const gh = Math.ceil(h / s);
  const mean = [];
  for (let gy = 0; gy < gh; gy += 1) {
    for (let gx = 0; gx < gw; gx += 1) {
      let acc = 0;
      let n = 0;
      for (let y = gy * s; y < Math.min(h, (gy + 1) * s); y += 1) {
        for (let x = gx * s; x < Math.min(w, (gx + 1) * s); x += 1) {
          const o = (y * w + x) * 4;
          acc += 0.299 * src.data[o] + 0.587 * src.data[o + 1] + 0.114 * src.data[o + 2];
          n += 1;
        }
      }
      mean[gy * gw + gx] = n ? acc / n : 0;
    }
  }
  const out = makeBuffer(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const gx = Math.floor(x / s);
      const gy = Math.floor(y / s);
      const l = mean[gy * gw + gx];
      const lr = mean[gy * gw + Math.min(gw - 1, gx + 1)];
      const lb = mean[Math.min(gh - 1, gy + 1) * gw + gx];
      const shade = 1 + Math.max(-0.6, Math.min(0.6, (l - (lr + lb) / 2) / 128));
      const o = (y * w + x) * 4;
      const so = (Math.min(h - 1, gy * s + (s >> 1)) * w + Math.min(w - 1, gx * s + (s >> 1))) * 4;
      out.data[o] = src.data[so] * shade;
      out.data[o + 1] = src.data[so + 1] * shade;
      out.data[o + 2] = src.data[so + 2] * shade;
      out.data[o + 3] = src.data[o + 3];
    }
  }
  return out;
}
function halftone(src, size) {
  const s = Math.max(2, Math.round(size));
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      out.data[o] = out.data[o + 1] = out.data[o + 2] = 255;
      out.data[o + 3] = src.data[o + 3];
    }
  }
  for (let gy = 0; gy < Math.ceil(h / s); gy += 1) {
    for (let gx = 0; gx < Math.ceil(w / s); gx += 1) {
      let acc = 0;
      let n = 0;
      for (let y = gy * s; y < Math.min(h, (gy + 1) * s); y += 1) {
        for (let x = gx * s; x < Math.min(w, (gx + 1) * s); x += 1) {
          const o = (y * w + x) * 4;
          acc += 0.299 * src.data[o] + 0.587 * src.data[o + 1] + 0.114 * src.data[o + 2];
          n += 1;
        }
      }
      const lum = n ? acc / n : 255;
      const cx = gx * s + s / 2;
      const cy = gy * s + s / 2;
      const rad = (255 - lum) / 255 * (s / 2);
      if (rad <= 0.4) continue;
      const r2 = rad * rad;
      for (let y = Math.max(0, Math.floor(cy - rad)); y < Math.min(h, Math.ceil(cy + rad)); y += 1) {
        for (let x = Math.max(0, Math.floor(cx - rad)); x < Math.min(w, Math.ceil(cx + rad)); x += 1) {
          const dx = x + 0.5 - cx;
          const dy = y + 0.5 - cy;
          if (dx * dx + dy * dy <= r2) {
            const o = (y * w + x) * 4;
            out.data[o] = out.data[o + 1] = out.data[o + 2] = 0;
          }
        }
      }
    }
  }
  return out;
}
function watercolor(src, smoothing) {
  const base = median(src, Math.max(1, Math.round(smoothing)));
  const out = cloneBuffer(base);
  const { data } = out;
  const sat = 1.25;
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    data[i] = l + (data[i] - l) * sat;
    data[i + 1] = l + (data[i + 1] - l) * sat;
    data[i + 2] = l + (data[i + 2] - l) * sat;
  }
  return out;
}
function average(src) {
  const { data, width: w, height: h } = src;
  const n = Math.max(1, w * h);
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    a += data[i + 3];
  }
  r /= n;
  g /= n;
  b /= n;
  a /= n;
  const out = makeBuffer(w, h);
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = r;
    out.data[i + 1] = g;
    out.data[i + 2] = b;
    out.data[i + 3] = a;
  }
  return out;
}
function highPass(src, radius) {
  const blur = gaussianBlur(src, Math.max(0.1, radius));
  const out = cloneBuffer(src);
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 128 + (src.data[i] - blur.data[i]);
    out.data[i + 1] = 128 + (src.data[i + 1] - blur.data[i + 1]);
    out.data[i + 2] = 128 + (src.data[i + 2] - blur.data[i + 2]);
    out.data[i + 3] = src.data[i + 3];
  }
  return out;
}
function rankFilter(src, radius, pick) {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return cloneBuffer(src);
  const { width: w, height: h } = src;
  const tmp = makeBuffer(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        let v = src.data[o + c];
        for (let k = -r; k <= r; k += 1) {
          const xi = Math.min(w - 1, Math.max(0, x + k));
          v = pick(v, src.data[(y * w + xi) * 4 + c]);
        }
        tmp.data[o + c] = v;
      }
    }
  }
  const out = makeBuffer(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        let v = tmp.data[o + c];
        for (let k = -r; k <= r; k += 1) {
          const yi = Math.min(h - 1, Math.max(0, y + k));
          v = pick(v, tmp.data[(yi * w + x) * 4 + c]);
        }
        out.data[o + c] = v;
      }
    }
  }
  return out;
}
function maximum(src, radius) {
  return rankFilter(src, radius, (a, b) => a > b ? a : b);
}
function minimum(src, radius) {
  return rankFilter(src, radius, (a, b) => a < b ? a : b);
}
function offset(src, dx, dy) {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const ox = (Math.round(dx) % w + w) % w;
  const oy = (Math.round(dy) % h + h) % h;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const sx = (x - ox + w) % w;
      const sy = (y - oy + h) % h;
      const so = (sy * w + sx) * 4;
      const o = (y * w + x) * 4;
      out.data[o] = src.data[so];
      out.data[o + 1] = src.data[so + 1];
      out.data[o + 2] = src.data[so + 2];
      out.data[o + 3] = src.data[so + 3];
    }
  }
  return out;
}
function tiles(src, size, offsetAmount) {
  const s = Math.max(2, Math.round(size));
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const off = Math.round(offsetAmount);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const tx = Math.floor(x / s);
      const ty = Math.floor(y / s);
      const sx = ((x - tx * off) % w + w) % w;
      const sy = ((y - ty * off) % h + h) % h;
      const so = (sy * w + sx) * 4;
      const o = (y * w + x) * 4;
      out.data[o] = src.data[so];
      out.data[o + 1] = src.data[so + 1];
      out.data[o + 2] = src.data[so + 2];
      out.data[o + 3] = src.data[so + 3];
    }
  }
  return out;
}
function facet(src, threshold) {
  const { width: w, height: h, data } = src;
  const out = cloneBuffer(src);
  const t = Math.max(0, threshold);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let ky = -1; ky <= 1; ky += 1) {
        for (let kx = -1; kx <= 1; kx += 1) {
          const xi = Math.min(w - 1, Math.max(0, x + kx));
          const yi = Math.min(h - 1, Math.max(0, y + ky));
          const so = (yi * w + xi) * 4;
          if (Math.abs(data[so] - data[o]) <= t && Math.abs(data[so + 1] - data[o + 1]) <= t && Math.abs(data[so + 2] - data[o + 2]) <= t) {
            r += data[so];
            g += data[so + 1];
            b += data[so + 2];
            a += data[so + 3];
            n += 1;
          }
        }
      }
      if (n > 0) {
        out.data[o] = r / n;
        out.data[o + 1] = g / n;
        out.data[o + 2] = b / n;
        out.data[o + 3] = a / n;
      }
    }
  }
  return out;
}
function pointillize(src, size, seed = 13) {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 255;
    out.data[i + 1] = 255;
    out.data[i + 2] = 255;
    out.data[i + 3] = 255;
  }
  const s = Math.max(2, Math.round(size));
  const rand = rng(seed);
  const rad = Math.max(1, s * 0.5);
  for (let cy = 0; cy < h + s; cy += s) {
    for (let cx = 0; cx < w + s; cx += s) {
      const px = cx + (rand() - 0.5) * s;
      const py = cy + (rand() - 0.5) * s;
      const sx = Math.min(w - 1, Math.max(0, Math.round(px)));
      const sy = Math.min(h - 1, Math.max(0, Math.round(py)));
      const so = (sy * w + sx) * 4;
      const rr = data[so];
      const gg = data[so + 1];
      const bb = data[so + 2];
      const x0 = Math.max(0, Math.floor(px - rad));
      const x1 = Math.min(w - 1, Math.ceil(px + rad));
      const y0 = Math.max(0, Math.floor(py - rad));
      const y1 = Math.min(h - 1, Math.ceil(py + rad));
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const ddx = x - px;
          const ddy = y - py;
          if (ddx * ddx + ddy * ddy <= rad * rad) {
            const o = (y * w + x) * 4;
            out.data[o] = rr;
            out.data[o + 1] = gg;
            out.data[o + 2] = bb;
            out.data[o + 3] = 255;
          }
        }
      }
    }
  }
  return out;
}
function zigZag(src, amount, ridges) {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const maxR = Math.hypot(cx, cy) || 1;
  const amp = Math.max(0, amount);
  const k = Math.max(1, Math.round(ridges));
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      const o = (y * w + x) * 4;
      const nr = r + amp * Math.sin(r / maxR * Math.PI * 2 * k);
      const scale = r > 0 ? nr / r : 1;
      sampleBilinear(src, cx + dx * scale, cy + dy * scale, out.data, o);
    }
  }
  return out;
}
function shear(src, amount, phaseDeg) {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const amp = Math.max(0, amount);
  const ph = phaseDeg * Math.PI / 180;
  const denom = h - 1 || 1;
  for (let y = 0; y < h; y += 1) {
    const shift = amp * Math.sin(y / denom * Math.PI * 2 + ph);
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      sampleBilinear(src, x - shift, y, out.data, o);
    }
  }
  return out;
}
function polarCoordinates(src, mode) {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const maxR = Math.max(1, Math.min(w, h) / 2);
  const denomX = w - 1 || 1;
  const denomY = h - 1 || 1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      if (mode === 1) {
        const ang = y / denomY * Math.PI * 2;
        const rad = x / denomX * maxR;
        sampleBilinear(src, cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad, out.data, o);
      } else {
        const dx = x - cx;
        const dy = y - cy;
        const ang = Math.atan2(dy, dx);
        const rad = Math.hypot(dx, dy);
        const u = (ang + Math.PI) / (Math.PI * 2) * w;
        const v = rad / maxR * h;
        sampleBilinear(src, u, v, out.data, o);
      }
    }
  }
  return out;
}
function diffuse(src, amount, mode, seed = 31) {
  const { width: w, height: h, data } = src;
  const out = cloneBuffer(src);
  const r = Math.max(1, Math.round(amount));
  const rand = rng(seed);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      if (mode === 0) {
        const xi = Math.min(w - 1, Math.max(0, x + Math.round((rand() * 2 - 1) * r)));
        const yi = Math.min(h - 1, Math.max(0, y + Math.round((rand() * 2 - 1) * r)));
        const so = (yi * w + xi) * 4;
        out.data[o] = data[so];
        out.data[o + 1] = data[so + 1];
        out.data[o + 2] = data[so + 2];
      } else {
        let vr = data[o];
        let vg = data[o + 1];
        let vb = data[o + 2];
        const pick = mode === 1 ? Math.min : Math.max;
        for (let s = 0; s < 4; s += 1) {
          const xi = Math.min(w - 1, Math.max(0, x + Math.round((rand() * 2 - 1) * r)));
          const yi = Math.min(h - 1, Math.max(0, y + Math.round((rand() * 2 - 1) * r)));
          const so = (yi * w + xi) * 4;
          vr = pick(vr, data[so]);
          vg = pick(vg, data[so + 1]);
          vb = pick(vb, data[so + 2]);
        }
        out.data[o] = vr;
        out.data[o + 1] = vg;
        out.data[o + 2] = vb;
      }
    }
  }
  return out;
}
function traceContour(src, level) {
  const { width: w, height: h, data } = src;
  const out = cloneBuffer(src);
  const lv = Math.min(255, Math.max(0, level));
  const lumAt = (o) => 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const xl = lumAt((y * w + Math.max(0, x - 1)) * 4);
      const xr = lumAt((y * w + Math.min(w - 1, x + 1)) * 4);
      const yu = lumAt((Math.max(0, y - 1) * w + x) * 4);
      const yd = lumAt((Math.min(h - 1, y + 1) * w + x) * 4);
      const edge = xl < lv && xr > lv || xl > lv && xr < lv || yu < lv && yd > lv || yu > lv && yd < lv;
      const v = edge ? 0 : 255;
      out.data[o] = v;
      out.data[o + 1] = v;
      out.data[o + 2] = v;
      out.data[o + 3] = 255;
    }
  }
  return out;
}
function valueNoise(x, y, seed) {
  const hash = (i, j) => {
    let n = i * 374761393 + j * 668265263 + seed * 1442695041 | 0;
    n = Math.imul(n ^ n >>> 13, 1274126177);
    return ((n ^ n >>> 16) >>> 0) / 4294967295;
  };
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function clouds(src, scale, seed = 5) {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const s = Math.max(1, scale) * 8;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let v = 0;
      let amp = 0.5;
      let freq = 1;
      let tot = 0;
      for (let o2 = 0; o2 < 5; o2 += 1) {
        v += valueNoise(x / s * freq, y / s * freq, seed + o2 * 17) * amp;
        tot += amp;
        amp *= 0.5;
        freq *= 2;
      }
      const c = Math.round(255 * v / tot);
      const o = (y * w + x) * 4;
      out.data[o] = c;
      out.data[o + 1] = c;
      out.data[o + 2] = c;
      out.data[o + 3] = 255;
    }
  }
  return out;
}
function differenceClouds(src, scale, seed = 5) {
  const cl = clouds(src, scale, seed);
  const out = cloneBuffer(src);
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = Math.abs(src.data[i] - cl.data[i]);
    out.data[i + 1] = Math.abs(src.data[i + 1] - cl.data[i + 1]);
    out.data[i + 2] = Math.abs(src.data[i + 2] - cl.data[i + 2]);
    out.data[i + 3] = src.data[i + 3];
  }
  return out;
}
function fibers(src, strength, variance, seed = 9) {
  const { width: w, height: h } = src;
  const out = cloneBuffer(src);
  const rand = rng(seed);
  const s = Math.min(200, Math.max(0, strength)) / 100;
  const varc = Math.max(0, variance);
  const col = new Float32Array(w);
  for (let x = 0; x < w; x += 1) col[x] = (rand() * 2 - 1) * varc;
  for (let y = 0; y < h; y += 1) {
    const rowNoise = (rand() * 2 - 1) * 0.5;
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const n = (col[x] + rowNoise) * s * 255 * 0.25;
      out.data[o] = src.data[o] + n;
      out.data[o + 1] = src.data[o + 1] + n;
      out.data[o + 2] = src.data[o + 2] + n;
    }
  }
  return out;
}
function ntscColors(src) {
  const out = cloneBuffer(src);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i];
    let g = d[i + 1];
    let b = d[i + 2];
    const min = Math.min(r, g, b);
    const max = Math.max(r, g, b);
    if (max - min > 200) {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      r = l + (r - l) * 0.9;
      g = l + (g - l) * 0.9;
      b = l + (b - l) * 0.9;
    }
    d[i] = Math.max(0, Math.min(255, r));
    d[i + 1] = Math.max(0, Math.min(255, g));
    d[i + 2] = Math.max(0, Math.min(255, b));
  }
  return out;
}
function deInterlace(src, field) {
  const { width: w, height: h } = src;
  const out = cloneBuffer(src);
  const keepEven = field === 0;
  for (let y = 0; y < h; y += 1) {
    if (y % 2 === 0 === keepEven) continue;
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const a = (y0 * w + x) * 4;
      const b2 = (y1 * w + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        out.data[o + c] = (src.data[a + c] + src.data[b2 + c]) / 2;
      }
    }
  }
  return out;
}
function extrude(src, size, depth, seed = 17) {
  const s = Math.max(2, Math.round(size));
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const rand = rng(seed);
  const blocksX = Math.ceil(w / s);
  const blocksY = Math.ceil(h / s);
  const offs = new Float32Array(blocksX * blocksY * 2);
  for (let i = 0; i < offs.length; i += 1) offs[i] = (rand() * 2 - 1) * depth;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const bx = Math.floor(x / s);
      const by = Math.floor(y / s);
      const bi = (by * blocksX + bx) * 2;
      const o = (y * w + x) * 4;
      sampleBilinear(src, x + offs[bi], y + offs[bi + 1], out.data, o);
    }
  }
  return out;
}

// src/engine/filters/gallery.ts
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function lumaAt(d, o) {
  return 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
}
function iterativeVariableBlur(src, amount, maxRadius) {
  const { width: w, height: h } = src;
  const out = cloneBuffer(src);
  if (maxRadius <= 0.4) return out;
  const steps = Math.min(10, Math.max(1, Math.round(maxRadius / 1.5)));
  const stepR = Math.max(1, Math.round(maxRadius / steps));
  let p = premultiply(src);
  for (let i = 1; i <= steps; i += 1) {
    const b = boxBlurPass(p, w, h, stepR);
    const prev = i - 1;
    for (let idx = 0; idx < w * h; idx += 1) {
      let alpha = clamp01(amount[idx]) * steps - prev;
      if (alpha <= 0) continue;
      if (alpha > 1) alpha = 1;
      const o = idx * 4;
      for (let c = 0; c < 4; c += 1) p[o + c] += (b[o + c] - p[o + c]) * alpha;
    }
  }
  unpremultiplyInto(out.data, p);
  p = new Float32Array(0);
  return out;
}
function fieldBlur(src, amount, startPct, dir) {
  const { width: w, height: h } = src;
  const map = new Float32Array(w * h);
  const g = clamp01(startPct / 100);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const t = dir === 1 ? x / Math.max(1, w - 1) : y / Math.max(1, h - 1);
      map[y * w + x] = g + (1 - g) * t;
    }
  }
  return iterativeVariableBlur(src, map, Math.max(0.5, amount));
}
function tiltShift(src, radius, centerPct, keepPct, featherPct) {
  const { width: w, height: h } = src;
  const map = new Float32Array(w * h);
  const cy = (h - 1) * centerPct / 100;
  const keep = Math.max(0, keepPct / 100 * (h / 2));
  const feather = Math.max(1, featherPct / 100 * (h / 2));
  for (let y = 0; y < h; y += 1) {
    const a = clamp01((Math.abs(y - cy) - keep) / feather);
    for (let x = 0; x < w; x += 1) map[y * w + x] = a;
  }
  return iterativeVariableBlur(src, map, Math.max(0.5, radius));
}
function irisBlur(src, radius, cxPct, cyPct, irisPct, featherPct) {
  const { width: w, height: h } = src;
  const map = new Float32Array(w * h);
  const cx = (w - 1) * cxPct / 100;
  const cy = (h - 1) * cyPct / 100;
  const rx = Math.max(1, irisPct / 100 * (w / 2));
  const ry = Math.max(1, irisPct / 100 * (h / 2));
  const feather = Math.max(0.02, featherPct / 100);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const len = Math.hypot(dx, dy);
      map[y * w + x] = clamp01((len - 1) / feather);
    }
  }
  return iterativeVariableBlur(src, map, Math.max(0.5, radius));
}
function pxAt(src, x, y, wrap, tmp) {
  const { width: w, height: h, data } = src;
  let xx = Math.round(x);
  let yy = Math.round(y);
  if (wrap) {
    xx = (xx % w + w) % w;
    yy = (yy % h + h) % h;
  } else {
    xx = xx < 0 ? 0 : xx > w - 1 ? w - 1 : xx;
    yy = yy < 0 ? 0 : yy > h - 1 ? h - 1 : yy;
  }
  const o = (yy * w + xx) * 4;
  tmp[0] = data[o];
  tmp[1] = data[o + 1];
  tmp[2] = data[o + 2];
  tmp[3] = data[o + 3];
}
function accumulate(src, x, y, wrap, wgt, acc, tmp) {
  pxAt(src, x, y, wrap, tmp);
  const a = tmp[3] / 255 * wgt;
  acc[0] += tmp[0] * a;
  acc[1] += tmp[1] * a;
  acc[2] += tmp[2] * a;
  acc[3] += a;
  acc[4] += wgt;
}
function flushAcc(out, o, acc) {
  const accA = acc[3];
  if (accA <= 1e-4) return;
  out[o] = acc[0] / accA;
  out[o + 1] = acc[1] / accA;
  out[o + 2] = acc[2] / accA;
  out[o + 3] = accA / acc[4] * 255;
}
function pathBlur(src, distance, angleDeg, curvatureDeg, taperPct) {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const n = 24;
  const base = angleDeg * Math.PI / 180;
  const curv = curvatureDeg * Math.PI / 180;
  const taper = clamp01(taperPct / 100);
  const acc = new Float32Array(5);
  const tmp = new Float32Array(4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      acc.fill(0);
      for (let i = 0; i < n; i += 1) {
        const t = i / (n - 1) - 0.5;
        const wgt = 1 - Math.abs(t) * 2 * taper;
        if (wgt <= 0) continue;
        const ang = base + curv * t;
        const d = distance * t;
        accumulate(src, x + Math.cos(ang) * d, y + Math.sin(ang) * d, false, wgt, acc, tmp);
      }
      flushAcc(out.data, (y * w + x) * 4, acc);
    }
  }
  return out;
}
function spinBlur(src, angleDeg, cxPct, cyPct) {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const n = 36;
  const cx = (w - 1) * cxPct / 100;
  const cy = (h - 1) * cyPct / 100;
  const total = angleDeg * Math.PI / 180;
  const acc = new Float32Array(5);
  const tmp = new Float32Array(4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      acc.fill(0);
      const dx = x - cx;
      const dy = y - cy;
      for (let i = 0; i < n; i += 1) {
        const t = (i / (n - 1) - 0.5) * total;
        const cos = Math.cos(t);
        const sin = Math.sin(t);
        accumulate(src, cx + dx * cos - dy * sin, cy + dx * sin + dy * cos, false, 1, acc, tmp);
      }
      flushAcc(out.data, (y * w + x) * 4, acc);
    }
  }
  return out;
}
function lensBlur(src, radius, threshold, boost) {
  const { width: w, height: h, data } = src;
  const base = gaussianBlur(src, Math.max(0.4, radius));
  const hl = makeBuffer(w, h);
  const th = Math.min(254, Math.max(0, threshold));
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const lum = lumaAt(data, o);
      if (lum <= th) continue;
      const k2 = (lum - th) / (255 - th);
      const a = data[o + 3] / 255 * k2 * k2;
      hl.data[o] = data[o];
      hl.data[o + 1] = data[o + 1];
      hl.data[o + 2] = data[o + 2];
      hl.data[o + 3] = a * 255;
    }
  }
  let b = hl;
  for (let i = 0; i < 3; i += 1) b = boxBlur(b, Math.max(1, radius * 0.45));
  const k = boost / 100;
  const out = cloneBuffer(base);
  for (let i = 0; i < w * h * 4; i += 4) {
    const cov = b.data[i + 3] / 255 * k;
    if (cov <= 0) continue;
    for (let c = 0; c < 3; c += 1) {
      const v = out.data[i + c] + b.data[i + c] * cov;
      out.data[i + c] = v > 255 ? 255 : v;
    }
  }
  return out;
}
function inShape(shape, dx, dy, r) {
  if (shape === 2) return true;
  if (shape === 1) return Math.abs(dx) + Math.abs(dy) <= r;
  if (shape === 3) {
    const s3 = Math.sqrt(3) / 2;
    return Math.abs(dy) <= r * s3 && Math.abs(dx) * s3 + Math.abs(dy) * 0.5 <= r * s3;
  }
  return dx * dx + dy * dy <= r * r;
}
function shapeBlur(src, radius, iterations, shape) {
  const { width: w, height: h } = src;
  const r = Math.max(1, Math.round(radius));
  const offs = [];
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      if (inShape(shape, dx, dy, r)) offs.push(dx, dy);
    }
  }
  const budget = w * h > 1e6 ? 40 : 96;
  const stride = Math.max(1, Math.ceil(offs.length / 2 / budget));
  const kern = [];
  for (let i = 0; i < offs.length; i += stride * 2) kern.push(offs[i], offs[i + 1]);
  let cur = cloneBuffer(src);
  const acc = new Float32Array(5);
  const tmp = new Float32Array(4);
  for (let it = 0; it < Math.max(1, Math.round(iterations)); it += 1) {
    const out = makeBuffer(w, h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        acc.fill(0);
        for (let i = 0; i < kern.length; i += 2) {
          accumulate(cur, x + kern[i], y + kern[i + 1], false, 1, acc, tmp);
        }
        flushAcc(out.data, (y * w + x) * 4, acc);
      }
    }
    cur = out;
  }
  return cur;
}
function smartBlur(src, radius, threshold, quality, mode) {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  const r = Math.max(1, radius);
  const perRing = quality >= 2 ? 16 : quality >= 1 ? 12 : 8;
  const rings = quality >= 2 ? 3 : 2;
  const th = Math.max(1, threshold);
  const acc = new Float32Array(5);
  const tmp = new Float32Array(4);
  const ang355 = Math.PI * 2;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const l0 = lumaAt(data, o);
      acc.fill(0);
      accumulate(src, x, y, false, 1, acc, tmp);
      for (let ring = 1; ring <= rings; ring += 1) {
        const rad = r * ring / rings;
        for (let i = 0; i < perRing; i += 1) {
          const a = ang355 * i / perRing + ring * 0.31;
          const sx = x + Math.cos(a) * rad;
          const sy = y + Math.sin(a) * rad;
          const sxx = Math.min(w - 1, Math.max(0, Math.round(sx)));
          const syy = Math.min(h - 1, Math.max(0, Math.round(sy)));
          const so = (syy * w + sxx) * 4;
          const dl = Math.abs(lumaAt(data, so) - l0);
          let wgt = mode === 1 ? Math.exp(-(dl / th * (dl / th))) : dl <= th ? 1 : 0;
          if (wgt <= 1e-3) continue;
          if (wgt > 1) wgt = 1;
          accumulate(src, sx, sy, false, wgt, acc, tmp);
        }
      }
      flushAcc(out.data, o, acc);
    }
  }
  return out;
}
function map1(mode, x, y, w, h) {
  if (mode === 1) {
    return valueNoise(x / 24, y / 24, 3) - 0.5;
  }
  if (mode === 2) {
    const dx = x / Math.max(1, w - 1) - 0.5;
    const dy = y / Math.max(1, h - 1) - 0.5;
    const d = Math.hypot(dx, dy);
    return (Math.sin(d * Math.PI * 4) * 0.5 - 0.5) * -1;
  }
  const cell = 32;
  const cx = Math.floor(x / cell);
  const cy = Math.floor(y / cell);
  return (cx + cy) % 2 === 0 ? 0.5 : -0.5;
}
function displace(src, hAmount, vAmount, mode, edge) {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const wrap = edge === 1;
  const acc = new Float32Array(5);
  const tmp = new Float32Array(4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const m = map1(mode, x, y, w, h);
      acc.fill(0);
      accumulate(src, x + m * hAmount, y + m * vAmount, wrap, 1, acc, tmp);
      flushAcc(out.data, (y * w + x) * 4, acc);
    }
  }
  return out;
}
function colorHalftone(src, size) {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  const period = Math.max(2, size);
  const scr = [
    { angle: 15 * Math.PI / 180, ink: 0 },
    { angle: 75 * Math.PI / 180, ink: 0 },
    { angle: 0, ink: 0 },
    { angle: 45 * Math.PI / 180, ink: 0 }
  ];
  const cos = scr.map((s) => Math.cos(s.angle));
  const sin = scr.map((s) => Math.sin(s.angle));
  const k = Math.PI / period;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const cInk = 1 - data[o] / 255;
      const mInk = 1 - data[o + 1] / 255;
      const yInk = 1 - data[o + 2] / 255;
      const kInk = Math.min(cInk, mInk, yInk);
      const denom = Math.max(1e-4, 1 - kInk);
      const levels = [(cInk - kInk) / denom, (mInk - kInk) / denom, (yInk - kInk) / denom, kInk];
      const dots = [0, 0, 0, 0];
      for (let i = 0; i < 4; i += 1) {
        const sx = x * cos[i] - y * sin[i];
        const sy = x * sin[i] + y * cos[i];
        const pattern = Math.sin(sx * k) * Math.sin(sy * k);
        if (pattern + 2 * levels[i] - 1 >= 0) dots[i] = 1;
      }
      const rr = Math.min(1, dots[0] + dots[3]);
      const gg = Math.min(1, dots[1] + dots[3]);
      const bb = Math.min(1, dots[2] + dots[3]);
      out.data[o] = (1 - rr) * 255;
      out.data[o + 1] = (1 - gg) * 255;
      out.data[o + 2] = (1 - bb) * 255;
      out.data[o + 3] = data[o + 3];
    }
  }
  return out;
}
function rgbToHsb(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = (g - b) / d % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h *= 60;
  if (h < 0) h += 360;
  return [h, max === 0 ? 0 : d / max, max / 255];
}
function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r / 255) h = (g / 255 - b / 255) / d % 6;
  else if (max === g / 255) h = (b / 255 - r / 255) / d + 2;
  else h = (r / 255 - g / 255) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}
function hsbHsl(src, mode) {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const triple = mode === 1 ? rgbToHsl(data[o], data[o + 1], data[o + 2]) : rgbToHsb(data[o], data[o + 1], data[o + 2]);
      out.data[o] = triple[0] / 360 * 255;
      out.data[o + 1] = triple[1] * 255;
      out.data[o + 2] = triple[2] * 255;
      out.data[o + 3] = data[o + 3];
    }
  }
  return out;
}

// src/engine/filters/renderFx.ts
function blendPixel(d, o, r, g, b, a) {
  if (a <= 0) return;
  const ia = 1 - a;
  d[o] = r * a + d[o] * ia;
  d[o + 1] = g * a + d[o + 1] * ia;
  d[o + 2] = b * a + d[o + 2] * ia;
  d[o + 3] = a * 255 + d[o + 3] * ia;
}
function paintDisc(d, w, h, cx, cy, radius, rgb, soft) {
  const r = Math.max(0.5, radius);
  const x0 = Math.max(0, Math.floor(cx - r - soft));
  const x1 = Math.min(w - 1, Math.ceil(cx + r + soft));
  const y0 = Math.max(0, Math.floor(cy - r - soft));
  const y1 = Math.min(h - 1, Math.ceil(cy + r + soft));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dist = Math.hypot(x - cx, y - cy);
      if (dist > r + soft) continue;
      const edge = soft <= 0 ? 1 : Math.min(1, (r + soft - dist) / (soft * 2));
      blendPixel(d, (y * w + x) * 4, rgb[0], rgb[1], rgb[2], edge);
    }
  }
}
function paintLine(d, w, h, x0, y0, x1, y1, thick, rgb) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    paintDisc(d, w, h, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, thick / 2, rgb, thick > 3 ? 1.2 : 0.6);
  }
}
function lensFlare(src, xPct, yPct, brightness, type) {
  const { width: w, height: h } = src;
  const out = { data: new Uint8ClampedArray(src.data), width: w, height: h };
  const fx = (w - 1) * xPct / 100;
  const fy = (h - 1) * yPct / 100;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const unit = Math.max(1, Math.min(w, h) / 2);
  const k = brightness / 100;
  const ghosts = type === 1 ? [
    { t: 0.35, size: 0.1, tint: [120, 160, 255] },
    { t: 0.55, size: 0.06, tint: [255, 190, 120] },
    { t: 0.8, size: 0.14, tint: [160, 220, 255] }
  ] : type === 2 ? [
    { t: 0.45, size: 0.08, tint: [255, 200, 140] },
    { t: 0.62, size: 0.05, tint: [150, 190, 255] },
    { t: 0.72, size: 0.11, tint: [255, 240, 200] },
    { t: 0.9, size: 0.04, tint: [200, 160, 255] }
  ] : [
    { t: 0.4, size: 0.07, tint: [255, 210, 150] },
    { t: 0.6, size: 0.12, tint: [140, 180, 255] },
    { t: 0.85, size: 0.05, tint: [255, 170, 220] }
  ];
  const layer = new Uint8ClampedArray(w * h * 4);
  for (let i = 3; i < layer.length; i += 4) layer[i] = 255;
  paintDisc(layer, w, h, fx, fy, unit * 0.06, [255, 255, 255], unit * 0.12);
  paintDisc(layer, w, h, fx, fy, unit * 0.02 * k, [255, 255, 255], unit * 0.05);
  for (let i = -1; i <= 1; i += 2) {
    paintLine(layer, w, h, fx, fy, fx + i * unit * 0.9, fy + i * unit * 0.06, 3, [255, 250, 230]);
  }
  for (const g of ghosts) {
    const gx = fx + (cx - fx) * 2 * g.t;
    const gy = fy + (cy - fy) * 2 * g.t;
    paintDisc(layer, w, h, gx, gy, unit * g.size, g.tint, unit * g.size * 0.25);
  }
  paintDisc(layer, w, h, fx, fy, unit * 0.28, [200, 210, 255], unit * 0.02);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const a = layer[o + 3] / 255;
      if (a <= 0) continue;
      for (let c = 0; c < 3; c += 1) {
        const v = out.data[o + c] + layer[o + c] * a * k;
        out.data[o + c] = v > 255 ? 255 : v;
      }
    }
  }
  return out;
}
function tree(src, seed, spreadDeg, depth, leaves) {
  const { width: w, height: h } = src;
  const out = { data: new Uint8ClampedArray(src.data), width: w, height: h };
  const rand = rng(seed || 1);
  const bark = [92, 66, 48];
  const leafRgb = leaves === 1 ? [232, 170, 200] : leaves === 2 ? [244, 208, 96] : [74, 150, 72];
  const baseLen = Math.max(6, h * 0.18);
  const spread = spreadDeg * Math.PI / 180;
  const grow = (x, y, ang, len, thick, level) => {
    if (level > depth || len < 1.5 || thick < 0.4) return;
    const jitter = (rand() - 0.5) * spread * 0.5;
    const a = ang + jitter;
    const x1 = x + Math.cos(a) * len;
    const y1 = y + Math.sin(a) * len;
    paintLine(out.data, w, h, x, y, x1, y1, thick, bark);
    if (level === depth) {
      paintDisc(out.data, w, h, x1, y1, Math.max(1.5, len * 0.55), leafRgb, Math.max(1, len * 0.3));
    }
    grow(x1, y1, a - spread * (0.7 + rand() * 0.5), len * 0.74, thick * 0.66, level + 1);
    grow(x1, y1, a + spread * (0.7 + rand() * 0.5), len * 0.74, thick * 0.66, level + 1);
    if (rand() > 0.65) grow(x1, y1, a + (rand() - 0.5) * 0.4, len * 0.6, thick * 0.6, level + 1);
  };
  grow(w / 2, h * 0.98, -Math.PI / 2, baseLen, Math.max(2, h * 0.022), 1);
  return out;
}
function flame(src, seed, turbulence, brightness, mode) {
  const { width: w, height: h } = src;
  const out = { data: new Uint8ClampedArray(src.data), width: w, height: h };
  const k = brightness / 100;
  if (mode === 1) {
    const acc = new Float32Array(w * h);
    const counts = new Float32Array(w * h);
    let x = 0.1;
    let y = 0.1;
    const rand = rng(seed || 3);
    const iters = Math.min(4e5, Math.max(2e4, Math.round(w * h * 1.5)));
    for (let i = 0; i < iters; i += 1) {
      const r = rand();
      let nx;
      let ny;
      if (r < 0.34) {
        nx = Math.sin(x) + Math.cos(y);
        ny = Math.sin(y) - Math.cos(x);
      } else if (r < 0.67) {
        const rr = Math.hypot(x, y) || 1e-6;
        nx = x / rr * (Math.sin(rr * 2.1) + 0.6);
        ny = y / rr * (Math.cos(rr * 2.1) + 0.6);
      } else {
        nx = (x + y) * 0.7 - 0.2;
        ny = (y - x) * 0.7 + 0.3;
      }
      x = nx;
      y = ny;
      if (i < 200) continue;
      const px = Math.round((x + 3) / 6 * (w - 1));
      const py = Math.round((y + 3) / 6 * (h - 1));
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      acc[py * w + px] += 1;
      counts[py * w + px] += 1;
    }
    let maxV = 0;
    for (let i = 0; i < acc.length; i += 1) if (acc[i] > maxV) maxV = acc[i];
    if (maxV <= 0) return out;
    for (let y2 = 0; y2 < h; y2 += 1) {
      for (let x2 = 0; x2 < w; x2 += 1) {
        const i = y2 * w + x2;
        if (acc[i] <= 0) continue;
        const t = Math.pow(acc[i] / maxV, 0.4) * k;
        const o = i * 4;
        out.data[o] = Math.min(255, out.data[o] + 255 * t);
        out.data[o + 1] = Math.min(255, out.data[o + 1] + 210 * t * t);
        out.data[o + 2] = Math.min(255, out.data[o + 2] + 120 * t * t * t);
      }
    }
    return out;
  }
  const turb = turbulence / 100;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const u = x / Math.max(1, w - 1) - 0.5;
      const v = y / Math.max(1, h - 1);
      const wobble = (valueNoise(x / 26, y / 26 + v * 2, seed) - 0.5) * turb * (0.25 + v);
      const halfWidth = Math.max(0.01, 0.42 * (1 - v) ** 0.7 + 0.02);
      const d = Math.abs(u + wobble) / halfWidth;
      if (d >= 1) continue;
      const heat = Math.max(0, 1 - d) * Math.max(0, 1 - v * 0.55) * k;
      const o = (y * w + x) * 4;
      out.data[o] = Math.min(255, out.data[o] + 255 * heat);
      out.data[o + 1] = Math.min(255, out.data[o + 1] + 200 * heat ** 1.6);
      out.data[o + 2] = Math.min(255, out.data[o + 2] + 90 * heat ** 2.6);
    }
  }
  return out;
}
function pictureFrame(src, thickness, style) {
  const { width: w, height: h } = src;
  const out = { data: new Uint8ClampedArray(src.data), width: w, height: h };
  const t = Math.max(1, Math.round(thickness));
  const frame = style === 2 ? [42, 30, 22] : [58, 58, 62];
  const hi = [214, 206, 190];
  const lo = [18, 16, 14];
  const corner = style === 2 ? t * 1.6 : 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = Math.min(x, w - 1 - x);
      const dy = Math.min(y, h - 1 - y);
      let inside = dx < t || dy < t;
      if (corner > 0) {
        const rx = Math.min(x, w - 1 - x) - t;
        const ry = Math.min(y, h - 1 - y) - t;
        if (rx < 0 && ry < 0 && Math.hypot(rx, ry) > corner) inside = true;
      }
      if (!inside) continue;
      const edge = Math.min(dx, dy);
      const rgb = edge === 0 || edge === t - 1 ? x + y > w / 2 + h / 2 - t * 2 ? lo : hi : frame;
      blendPixel(out.data, (y * w + x) * 4, rgb[0], rgb[1], rgb[2], 1);
    }
  }
  if (style === 1) {
    for (let i = 0; i < w; i += 1) {
      blendPixel(out.data, (t * 2 * w + i) * 4, hi[0], hi[1], hi[2], 0.8);
      blendPixel(out.data, ((h - 1 - t * 2) * w + i) * 4, hi[0], hi[1], hi[2], 0.8);
    }
    for (let i = 0; i < h; i += 1) {
      blendPixel(out.data, (i * w + t * 2) * 4, hi[0], hi[1], hi[2], 0.8);
      blendPixel(out.data, (i * w + (w - 1 - t * 2)) * 4, hi[0], hi[1], hi[2], 0.8);
    }
  }
  return out;
}
function lightingEffects(src, angleDeg, elevationDeg, ambientPct, glossPct, materialPct, exposurePct) {
  const { width: w, height: h, data } = src;
  const out = { data: new Uint8ClampedArray(data), width: w, height: h };
  const az = angleDeg * Math.PI / 180;
  const el = Math.min(89, Math.max(1, elevationDeg)) * Math.PI / 180;
  const lx = Math.cos(el) * Math.cos(az);
  const ly = Math.cos(el) * Math.sin(az);
  const lz = Math.sin(el);
  const hx = lx;
  const hy = ly;
  const hz = lz + 1;
  const hl = Math.hypot(hx, hy, hz) || 1;
  const ambient = ambientPct / 100;
  const gloss = glossPct / 100;
  const material = materialPct / 100;
  const exposure = exposurePct / 100;
  const shininess = 4 + gloss * 60;
  const bump = 2 + gloss * 6;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) lum[i] = luma(data, i * 4) / 255;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const o = i * 4;
      const l = lum[Math.min(h - 1, y + 1) * w + x] - lum[Math.max(0, y - 1) * w + x];
      const r = lum[y * w + Math.min(w - 1, x + 1)] - lum[y * w + Math.max(0, x - 1)];
      const nx = -r * bump * 8;
      const ny = -l * bump * 8;
      const nl = Math.hypot(nx, ny, 1) || 1;
      const ux = nx / nl;
      const uy = ny / nl;
      const uz = 1 / nl;
      const diff = Math.max(0, ux * lx + uy * ly + uz * lz);
      const specDot = Math.max(0, (ux * hx + uy * hy + uz * hz) / hl);
      const spec = Math.pow(specDot, shininess) * gloss;
      const shade = ambient + (1 - ambient) * diff;
      for (let c = 0; c < 3; c += 1) {
        const metallic = material > 0.5 ? 1 : 0;
        const base = data[o + c] * shade * exposure;
        const tinted = data[o + c] / 255;
        const specColor = (metallic ? tinted : 1) * spec * 255;
        const v = base + specColor;
        out.data[o + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
  return out;
}
function luma(d, o) {
  return 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
}

// src/engine/filters/lens.ts
function sampleChannel(src, x, y, ch) {
  const { width: w, height: h, data } = src;
  const cx = Math.min(w - 1, Math.max(0, x));
  const cy = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const p00 = data[(y0 * w + x0) * 4 + ch];
  const p10 = data[(y0 * w + x1) * 4 + ch];
  const p01 = data[(y1 * w + x0) * 4 + ch];
  const p11 = data[(y1 * w + x1) * 4 + ch];
  return (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy;
}
function sampleRgba(src, x, y, out, o) {
  for (let c = 0; c < 4; c += 1) out[o + c] = sampleChannel(src, x, y, c);
}
function lensCorrection(src, distortion, vertical, horizontal, ca, vignette, midpoint) {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const R = Math.max(1, Math.hypot(cx, cy));
  const k = distortion / 100 * 0.5;
  const vk = vertical / 100 * 0.5;
  const hk = horizontal / 100 * 0.5;
  const caR = ca;
  const vig = vignette / 100;
  const mid = Math.min(0.98, Math.max(0.02, midpoint / 100));
  const hasCa = Math.abs(ca) > 0.01;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let nx = (x - cx) / R;
      let ny = (y - cy) / R;
      if (vk !== 0) nx *= 1 + vk * ny;
      if (hk !== 0) ny *= 1 + hk * nx;
      if (k !== 0) {
        const r2 = nx * nx + ny * ny;
        const f2 = 1 + k * r2;
        nx *= f2;
        ny *= f2;
      }
      const sx = cx + nx * R;
      const sy = cy + ny * R;
      const o = (y * w + x) * 4;
      if (hasCa) {
        const rl = Math.hypot(nx, ny) || 1e-6;
        const kr = 1 + caR / (rl * R);
        const kb = 1 - caR / (rl * R);
        out.data[o] = sampleChannel(src, cx + nx * kr * R, cy + ny * kr * R, 0);
        out.data[o + 1] = sampleChannel(src, sx, sy, 1);
        out.data[o + 2] = sampleChannel(src, cx + nx * kb * R, cy + ny * kb * R, 2);
        out.data[o + 3] = sampleChannel(src, sx, sy, 3);
      } else {
        sampleRgba(src, sx, sy, out.data, o);
      }
      if (vig !== 0) {
        const rd = Math.hypot((x - cx) / R, (y - cy) / R);
        const t = Math.max(0, (rd - mid) / Math.max(0.02, 1 - mid));
        const gain = 1 - vig * t * t;
        for (let c = 0; c < 3; c += 1) {
          const v = out.data[o + c] * gain;
          out.data[o + c] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
    }
  }
  return out;
}
function adaptiveWideAngle(src, strength, mode) {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const R = Math.max(1, Math.hypot(cx, cy));
  const t = 0.35 + Math.min(100, Math.max(1, strength)) / 100 * 3;
  const at = Math.atan(t);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const nx = (x - cx) / R;
      const ny = (y - cy) / R;
      const r = Math.hypot(nx, ny);
      const o = (y * w + x) * 4;
      if (r < 1e-6) {
        sampleRgba(src, x, y, out.data, o);
        continue;
      }
      const rs = mode === 1 ? Math.tan(r * at) / t : Math.atan(r * t) / at;
      const f2 = rs / r;
      sampleRgba(src, cx + nx * f2 * R, cy + ny * f2 * R, out.data, o);
    }
  }
  return out;
}

// src/engine/filters/defs.ts
function filterParams(def) {
  const out = {};
  for (const p of def.params) out[p.id] = p.def;
  return out;
}
function filterDef(id) {
  return FILTER_DEFS.find((d) => d.id === id);
}
var BLUR_DEFS = [
  {
    id: "filter.blur.gaussianBlur",
    label: "\u9AD8\u65AF\u6A21\u7CCA",
    group: "blur",
    params: [
      { id: "radius", label: "\u534A\u5F84", min: 0.1, max: 250, step: 0.1, def: 4, dec: 1, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => gaussianBlur(b, p.radius)
  },
  {
    id: "filter.blur.blur",
    label: "\u6A21\u7CCA",
    group: "blur",
    params: [
      { id: "radius", label: "\u534A\u5F84", min: 1, max: 100, step: 1, def: 3, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => boxBlur(b, p.radius)
  },
  {
    id: "filter.blur.boxBlur",
    label: "\u65B9\u6846\u6A21\u7CCA",
    group: "blur",
    params: [
      { id: "radius", label: "\u534A\u5F84", min: 1, max: 250, step: 1, def: 8, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => boxBlur(b, p.radius)
  },
  {
    id: "filter.blur.blurMore",
    label: "\u8FDB\u4E00\u6B65\u6A21\u7CCA",
    group: "blur",
    params: [
      { id: "radius", label: "\u534A\u5F84", min: 1, max: 100, step: 1, def: 6, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => boxBlur(boxBlur(b, p.radius), p.radius)
  },
  {
    id: "filter.blur.motionBlur",
    label: "\u52A8\u611F\u6A21\u7CCA",
    group: "blur",
    params: [
      { id: "angle", label: "\u89D2\u5EA6", min: -90, max: 90, step: 1, def: 0, unit: "\xB0" },
      { id: "distance", label: "\u8DDD\u79BB", min: 1, max: 999, step: 1, def: 20, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => motionBlur(b, p.angle, p.distance)
  },
  {
    id: "filter.blur.radialBlur",
    label: "\u5F84\u5411\u6A21\u7CCA",
    group: "blur",
    params: [
      {
        id: "method",
        label: "\u65B9\u6CD5",
        min: 0,
        max: 1,
        step: 1,
        def: 0,
        choices: [
          { label: "\u65CB\u8F6C", value: 0 },
          { label: "\u7F29\u653E", value: 1 }
        ]
      },
      { id: "amount", label: "\u6570\u91CF", min: 1, max: 100, step: 1, def: 20, unit: "%" },
      { id: "quality", label: "\u54C1\u8D28\uFF08\u91C7\u6837\u6B65\u6570\uFF09", min: 2, max: 32, step: 1, def: 10 }
    ],
    apply: (b, p) => p.method === 1 ? radialZoom(b, p.amount, p.quality) : radialSpin(b, p.amount, p.quality)
  },
  {
    id: "filter.blur.surfaceBlur",
    label: "\u7279\u6B8A\u6A21\u7CCA\uFF08\u8868\u9762\uFF09",
    group: "blur",
    params: [
      { id: "radius", label: "\u534A\u5F84", min: 1, max: 100, step: 1, def: 5, unit: " \u50CF\u7D20" },
      { id: "threshold", label: "\u9608\u503C", min: 1, max: 255, step: 1, def: 24, unit: " \u8272\u9636" }
    ],
    apply: (b, p) => surfaceBlur(b, p.radius, p.threshold)
  }
];
var SHARPEN_DEFS = [
  {
    id: "filter.sharpen.sharpen",
    label: "\u9510\u5316",
    group: "sharpen",
    params: [],
    apply: (b) => convolve3x3(b, sharpenKernel(1))
  },
  {
    id: "filter.sharpen.sharpenMore",
    label: "\u8FDB\u4E00\u6B65\u9510\u5316",
    group: "sharpen",
    params: [],
    apply: (b) => convolve3x3(b, sharpenKernel(2))
  },
  {
    id: "filter.sharpen.sharpenEdges",
    label: "\u9510\u5316\u8FB9\u7F18",
    group: "sharpen",
    params: [
      { id: "strength", label: "\u5F3A\u5EA6", min: 1, max: 10, step: 1, def: 2 }
    ],
    apply: (b, p) => convolve3x3(b, sharpenKernel(p.strength))
  },
  {
    id: "filter.sharpen.unsharpMask",
    label: "USM \u9510\u5316",
    group: "sharpen",
    params: [
      { id: "amount", label: "\u6570\u91CF", min: 0, max: 500, step: 1, def: 100, unit: "%" },
      { id: "radius", label: "\u534A\u5F84", min: 0.1, max: 100, step: 0.1, def: 2, dec: 1, unit: " \u50CF\u7D20" },
      { id: "threshold", label: "\u9608\u503C", min: 0, max: 255, step: 1, def: 3, unit: " \u8272\u9636" }
    ],
    apply: (b, p) => unsharpMask(b, p.radius, p.amount, p.threshold)
  },
  {
    id: "filter.sharpen.smartSharpen",
    label: "\u667A\u80FD\u9510\u5316",
    group: "sharpen",
    params: [
      { id: "amount", label: "\u6570\u91CF", min: 0, max: 300, step: 1, def: 100, unit: "%" },
      { id: "radius", label: "\u534A\u5F84", min: 0.1, max: 50, step: 0.1, def: 1.5, dec: 1, unit: " \u50CF\u7D20" },
      { id: "threshold", label: "\u51CF\u5C11\u6742\u8272\uFF08\u9608\u503C\uFF09", min: 0, max: 100, step: 1, def: 12, unit: "%" }
    ],
    apply: (b, p) => {
      const denoised = reduceNoise(b, p.threshold * 0.5);
      return unsharpMask(denoised, p.radius, p.amount, 2);
    }
  }
];
var NOISE_DEFS = [
  {
    id: "filter.noise.addNoise",
    label: "\u6DFB\u52A0\u6742\u8272",
    group: "noise",
    params: [
      { id: "amount", label: "\u6570\u91CF", min: 0, max: 100, step: 1, def: 5, unit: "%" },
      {
        id: "monochrome",
        label: "\u5206\u5E03",
        min: 0,
        max: 1,
        step: 1,
        def: 1,
        choices: [
          { label: "\u5F69\u8272", value: 0 },
          { label: "\u5355\u8272", value: 1 }
        ]
      }
    ],
    apply: (b, p) => addNoise(b, p.amount, p.monochrome === 1)
  },
  {
    id: "filter.noise.despeckle",
    label: "\u53BB\u6591",
    group: "noise",
    params: [],
    apply: (b) => median(b, 1)
  },
  {
    id: "filter.noise.median",
    label: "\u4E2D\u95F4\u503C",
    group: "noise",
    params: [
      { id: "radius", label: "\u534A\u5F84", min: 1, max: 16, step: 1, def: 2, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => median(b, p.radius)
  },
  {
    id: "filter.noise.dustAndScratches",
    label: "\u8499\u5C18\u4E0E\u5212\u75D5",
    group: "noise",
    params: [
      { id: "radius", label: "\u534A\u5F84", min: 1, max: 16, step: 1, def: 2, unit: " \u50CF\u7D20" },
      { id: "threshold", label: "\u9608\u503C", min: 0, max: 128, step: 1, def: 20, unit: " \u8272\u9636" }
    ],
    apply: (b, p) => dustAndScratch(b, p.radius, p.threshold)
  },
  {
    id: "filter.noise.reduceNoise",
    label: "\u51CF\u5C11\u6742\u8272",
    group: "noise",
    params: [
      { id: "strength", label: "\u5F3A\u5EA6", min: 0, max: 100, step: 1, def: 50, unit: "%" }
    ],
    apply: (b, p) => reduceNoise(b, p.strength)
  }
];
var PIXELATE_DEFS = [
  {
    id: "filter.pixelate.mosaic",
    label: "\u5F69\u5757\u5316",
    group: "pixelate",
    params: [
      { id: "size", label: "\u5355\u5143\u683C\u5927\u5C0F", min: 2, max: 200, step: 1, def: 12, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => mosaic(b, p.size)
  },
  {
    id: "filter.pixelate.crystallize",
    label: "\u6676\u683C\u5316",
    group: "pixelate",
    params: [
      { id: "size", label: "\u5355\u5143\u683C\u5927\u5C0F", min: 2, max: 200, step: 1, def: 16, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => crystallize(b, p.size)
  },
  {
    id: "filter.pixelate.fragment",
    label: "\u788E\u7247",
    group: "pixelate",
    params: [
      { id: "offset", label: "\u504F\u79FB", min: 1, max: 20, step: 1, def: 4, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => fragment(b, p.offset)
  },
  {
    id: "filter.pixelate.mezzotint",
    label: "\u94DC\u7248\u96D5\u523B",
    group: "pixelate",
    params: [
      { id: "density", label: "\u5BC6\u5EA6", min: 1, max: 100, step: 1, def: 25, unit: "%" }
    ],
    apply: (b, p) => mezzotint(b, p.density)
  }
];
var DISTORT_DEFS = [
  {
    id: "filter.distort.twirl",
    label: "\u65CB\u8F6C\u626D\u66F2",
    group: "distort",
    params: [
      { id: "angle", label: "\u89D2\u5EA6", min: -999, max: 999, step: 1, def: 180, unit: "\xB0" },
      { id: "radius", label: "\u534A\u5F84", min: 1, max: 100, step: 1, def: 100, unit: "%" }
    ],
    apply: (b, p) => twirl(b, p.angle, p.radius)
  },
  {
    id: "filter.distort.wave",
    label: "\u6CE2\u6D6A",
    group: "distort",
    params: [
      { id: "amplitude", label: "\u6CE2\u5E45", min: 0, max: 100, step: 1, def: 8, unit: " \u50CF\u7D20" },
      { id: "wavelength", label: "\u6CE2\u957F", min: 2, max: 400, step: 1, def: 60, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => wave(b, p.amplitude, p.wavelength)
  },
  {
    id: "filter.distort.ripple",
    label: "\u6CE2\u7EB9",
    group: "distort",
    params: [
      { id: "amount", label: "\u6570\u91CF", min: 0, max: 200, step: 1, def: 40, unit: "%" },
      { id: "size", label: "\u6CE2\u7EB9\u95F4\u8DDD", min: 2, max: 400, step: 1, def: 48, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => ripple(b, p.amount, p.size)
  },
  {
    id: "filter.distort.pinch",
    label: "\u6324\u538B",
    group: "distort",
    params: [
      { id: "amount", label: "\u6570\u91CF", min: -100, max: 100, step: 1, def: 50, unit: "%" }
    ],
    apply: (b, p) => pinch(b, p.amount)
  },
  {
    id: "filter.distort.spherize",
    label: "\u7403\u9762\u5316",
    group: "distort",
    params: [
      { id: "amount", label: "\u6570\u91CF", min: -100, max: 100, step: 1, def: -50, unit: "%" }
    ],
    apply: (b, p) => pinch(b, p.amount)
  }
];
var STYLIZE_DEFS = [
  {
    id: "filter.stylize.findEdges",
    label: "\u67E5\u627E\u8FB9\u7F18",
    group: "stylize",
    params: [],
    apply: (b) => findEdges(b)
  },
  {
    id: "filter.stylize.emboss",
    label: "\u6D6E\u96D5\u6548\u679C",
    group: "stylize",
    params: [
      { id: "angle", label: "\u89D2\u5EA6", min: -180, max: 180, step: 1, def: 135, unit: "\xB0" },
      { id: "height", label: "\u9AD8\u5EA6", min: 1, max: 20, step: 1, def: 3, unit: " \u50CF\u7D20" },
      { id: "amount", label: "\u6570\u91CF", min: 1, max: 300, step: 1, def: 100, unit: "%" }
    ],
    apply: (b, p) => emboss(b, p.angle, p.height, p.amount)
  },
  {
    id: "filter.stylize.solarize",
    label: "\u66DD\u5149\u8FC7\u5EA6",
    group: "stylize",
    params: [],
    apply: (b) => solarize(b)
  },
  {
    id: "filter.stylize.wind",
    label: "\u98CE",
    group: "stylize",
    params: [
      { id: "strength", label: "\u5F3A\u5EA6", min: 1, max: 80, step: 1, def: 20, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => wind(b, p.strength)
  },
  {
    id: "filter.stylize.oilPaint",
    label: "\u6CB9\u753B",
    group: "stylize",
    params: [
      { id: "radius", label: "\u7B14\u89E6\u534A\u5F84", min: 1, max: 6, step: 1, def: 3, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => oilPaint(b, p.radius)
  }
];
var SKETCH_DEFS = [
  {
    id: "filter.sketch.halftone",
    label: "\u534A\u8C03\u56FE\u6848",
    group: "sketch",
    params: [
      { id: "size", label: "\u5355\u5143\u683C\u5927\u5C0F", min: 2, max: 64, step: 1, def: 8, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => halftone(b, p.size)
  }
];
var TEXTURE_DEFS = [
  {
    id: "filter.texture.grain",
    label: "\u9897\u7C92",
    group: "texture",
    params: [
      { id: "amount", label: "\u5F3A\u5EA6", min: 1, max: 100, step: 1, def: 12, unit: "%" }
    ],
    apply: (b, p) => grain(b, p.amount)
  },
  {
    id: "filter.texture.patchwork",
    label: "\u62FC\u7F00\u56FE",
    group: "texture",
    params: [
      { id: "size", label: "\u65B9\u5757\u5927\u5C0F", min: 2, max: 100, step: 1, def: 12, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => patchwork(b, p.size)
  }
];
var ARTISTIC_DEFS = [
  {
    id: "filter.artistic.watercolor",
    label: "\u6C34\u5F69",
    group: "artistic",
    params: [
      { id: "smoothing", label: "\u753B\u7B14\u7EC6\u8282", min: 1, max: 6, step: 1, def: 2, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => watercolor(b, p.smoothing)
  }
];
var BLUR_EXTRA_DEFS = [
  {
    id: "filter.blur.average",
    label: "\u5E73\u5747",
    group: "blur",
    params: [],
    apply: (b) => average(b)
  }
];
var OTHER_DEFS = [
  {
    id: "filter.other.highPass",
    label: "\u9AD8\u53CD\u5DEE\u4FDD\u7559",
    group: "other",
    params: [
      { id: "radius", label: "\u534A\u5F84", min: 0.1, max: 250, step: 0.1, def: 4, dec: 1, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => highPass(b, p.radius)
  },
  {
    id: "filter.other.maximum",
    label: "\u6700\u5927\u503C",
    group: "other",
    params: [
      { id: "radius", label: "\u534A\u5F84", min: 1, max: 10, step: 1, def: 1, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => maximum(b, p.radius)
  },
  {
    id: "filter.other.minimum",
    label: "\u6700\u5C0F\u503C",
    group: "other",
    params: [
      { id: "radius", label: "\u534A\u5F84", min: 1, max: 10, step: 1, def: 1, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => minimum(b, p.radius)
  },
  {
    id: "filter.other.offset",
    label: "\u4F4D\u79FB",
    group: "other",
    params: [
      { id: "dx", label: "\u6C34\u5E73", min: -500, max: 500, step: 1, def: 100, unit: " \u50CF\u7D20" },
      { id: "dy", label: "\u5782\u76F4", min: -500, max: 500, step: 1, def: 0, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => offset(b, p.dx, p.dy)
  },
  {
    id: "filter.other.custom",
    label: "\u81EA\u5B9A",
    group: "other",
    params: [
      { id: "k0", label: "\u6838 1", min: -20, max: 20, step: 1, def: 0 },
      { id: "k1", label: "\u6838 2", min: -20, max: 20, step: 1, def: 0 },
      { id: "k2", label: "\u6838 3", min: -20, max: 20, step: 1, def: 0 },
      { id: "k3", label: "\u6838 4", min: -20, max: 20, step: 1, def: 0 },
      { id: "k4", label: "\u6838 5\uFF08\u4E2D\u5FC3\uFF09", min: -20, max: 20, step: 1, def: 1 },
      { id: "k5", label: "\u6838 6", min: -20, max: 20, step: 1, def: 0 },
      { id: "k6", label: "\u6838 7", min: -20, max: 20, step: 1, def: 0 },
      { id: "k7", label: "\u6838 8", min: -20, max: 20, step: 1, def: 0 },
      { id: "k8", label: "\u6838 9", min: -20, max: 20, step: 1, def: 0 },
      { id: "divisor", label: "\u7F29\u653E", min: -50, max: 50, step: 1, def: 1 },
      { id: "bias", label: "\u4F4D\u79FB\u91CF", min: -255, max: 255, step: 1, def: 0 }
    ],
    apply: (b, p) => convolve3x3(
      b,
      [p.k0, p.k1, p.k2, p.k3, p.k4, p.k5, p.k6, p.k7, p.k8],
      p.divisor,
      p.bias
    )
  }
];
var PIXELATE_EXTRA_DEFS = [
  {
    id: "filter.pixelate.facet",
    label: "\u591A\u9762\u4F53",
    group: "pixelate",
    params: [
      { id: "threshold", label: "\u9608\u503C", min: 1, max: 50, step: 1, def: 10, unit: " \u8272\u9636" }
    ],
    apply: (b, p) => facet(b, p.threshold)
  },
  {
    id: "filter.pixelate.pointillize",
    label: "\u70B9\u72B6\u5316",
    group: "pixelate",
    params: [
      { id: "size", label: "\u5355\u5143\u683C\u5927\u5C0F", min: 2, max: 100, step: 1, def: 8, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => pointillize(b, p.size)
  }
];
var DISTORT_EXTRA_DEFS = [
  {
    id: "filter.distort.zigZag",
    label: "\u952F\u9F7F",
    group: "distort",
    params: [
      { id: "amount", label: "\u6570\u91CF", min: 1, max: 100, step: 1, def: 10, unit: " \u50CF\u7D20" },
      { id: "ridges", label: "\u8D77\u4F0F", min: 1, max: 20, step: 1, def: 5 }
    ],
    apply: (b, p) => zigZag(b, p.amount, p.ridges)
  },
  {
    id: "filter.distort.shear",
    label: "\u5207\u53D8",
    group: "distort",
    params: [
      { id: "amount", label: "\u6570\u91CF", min: 0, max: 200, step: 1, def: 20, unit: " \u50CF\u7D20" },
      { id: "phase", label: "\u76F8\u4F4D", min: -180, max: 180, step: 1, def: 0, unit: "\xB0" }
    ],
    apply: (b, p) => shear(b, p.amount, p.phase)
  },
  {
    id: "filter.distort.polarCoordinates",
    label: "\u6781\u5750\u6807",
    group: "distort",
    params: [
      {
        id: "mode",
        label: "\u65B9\u5F0F",
        min: 0,
        max: 1,
        step: 1,
        def: 0,
        choices: [
          { label: "\u77E9\u5F62\u5230\u6781\u5750\u6807", value: 0 },
          { label: "\u6781\u5750\u6807\u5230\u77E9\u5F62", value: 1 }
        ]
      }
    ],
    apply: (b, p) => polarCoordinates(b, p.mode)
  }
];
var STYLIZE_EXTRA_DEFS = [
  {
    id: "filter.stylize.diffuse",
    label: "\u6269\u6563",
    group: "stylize",
    params: [
      { id: "amount", label: "\u6570\u91CF", min: 1, max: 20, step: 1, def: 3, unit: " \u50CF\u7D20" },
      {
        id: "mode",
        label: "\u65B9\u5F0F",
        min: 0,
        max: 2,
        step: 1,
        def: 0,
        choices: [
          { label: "\u6B63\u5E38", value: 0 },
          { label: "\u53D8\u6697", value: 1 },
          { label: "\u53D8\u4EAE", value: 2 }
        ]
      }
    ],
    apply: (b, p) => diffuse(b, p.amount, p.mode)
  },
  {
    id: "filter.stylize.tiles",
    label: "\u62FC\u8D34",
    group: "stylize",
    params: [
      { id: "size", label: "\u62FC\u8D34\u5927\u5C0F", min: 2, max: 100, step: 1, def: 12, unit: " \u50CF\u7D20" },
      { id: "offset", label: "\u504F\u79FB", min: 0, max: 100, step: 1, def: 6, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => tiles(b, p.size, p.offset)
  },
  {
    id: "filter.stylize.traceContour",
    label: "\u7B49\u9AD8\u7EBF",
    group: "stylize",
    params: [
      { id: "level", label: "\u8272\u9636", min: 0, max: 255, step: 1, def: 128 }
    ],
    apply: (b, p) => traceContour(b, p.level)
  },
  {
    id: "filter.stylize.extrude",
    label: "\u51F8\u51FA",
    group: "stylize",
    params: [
      { id: "size", label: "\u5927\u5C0F", min: 2, max: 100, step: 1, def: 12, unit: " \u50CF\u7D20" },
      { id: "depth", label: "\u6DF1\u5EA6", min: 1, max: 50, step: 1, def: 8, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => extrude(b, p.size, p.depth)
  }
];
var LENS_DEFS = [
  {
    id: "filter.lensCorrection",
    label: "\u955C\u5934\u6821\u6B63",
    group: "distort",
    params: [
      { id: "distortion", label: "\u6876\u5F62/\u6795\u5F62\u7578\u53D8", min: -100, max: 100, step: 1, def: 0, unit: "%" },
      { id: "vertical", label: "\u5782\u76F4\u900F\u89C6", min: -100, max: 100, step: 1, def: 0, unit: "%" },
      { id: "horizontal", label: "\u6C34\u5E73\u900F\u89C6", min: -100, max: 100, step: 1, def: 0, unit: "%" },
      { id: "ca", label: "\u8272\u5DEE\u6821\u6B63", min: -20, max: 20, step: 1, def: 0, unit: " \u50CF\u7D20" },
      { id: "vignette", label: "\u6655\u5F71", min: -100, max: 100, step: 1, def: 0, unit: "%" },
      { id: "midpoint", label: "\u6655\u5F71\u4E2D\u70B9", min: 1, max: 98, step: 1, def: 50, unit: "%" }
    ],
    apply: (b, p) => lensCorrection(b, p.distortion, p.vertical, p.horizontal, p.ca, p.vignette, p.midpoint)
  },
  {
    id: "filter.adaptiveWideAngle",
    label: "\u81EA\u9002\u5E94\u5E7F\u89D2",
    group: "distort",
    params: [
      { id: "strength", label: "\u89C6\u91CE\u5F3A\u5EA6", min: 1, max: 100, step: 1, def: 45, unit: "%" },
      {
        id: "mode",
        label: "\u65B9\u5411",
        min: 0,
        max: 1,
        step: 1,
        def: 0,
        choices: [
          { label: "\u9C7C\u773C \u2192 \u76F4\u7EBF\uFF08\u53BB\u7578\u53D8\uFF09", value: 0 },
          { label: "\u76F4\u7EBF \u2192 \u9C7C\u773C\uFF08\u52A0\u7578\u53D8\uFF09", value: 1 }
        ]
      }
    ],
    apply: (b, p) => adaptiveWideAngle(b, p.strength, p.mode)
  }
];
var BLUR_GALLERY_DEFS = [
  {
    id: "filter.blurGallery.fieldBlur",
    label: "\u573A\u666F\u6A21\u7CCA",
    group: "blurGallery",
    params: [
      { id: "amount", label: "\u6A21\u7CCA", min: 0, max: 100, step: 1, def: 12, unit: " \u50CF\u7D20" },
      { id: "start", label: "\u8D77\u59CB\u7AEF\u4FDD\u7559", min: 0, max: 100, step: 1, def: 100, unit: "%" },
      {
        id: "dir",
        label: "\u6E10\u53D8\u65B9\u5411",
        min: 0,
        max: 1,
        step: 1,
        def: 0,
        choices: [
          { label: "\u5782\u76F4", value: 0 },
          { label: "\u6C34\u5E73", value: 1 }
        ]
      }
    ],
    apply: (b, p) => fieldBlur(b, p.amount, p.start, p.dir)
  },
  {
    id: "filter.blurGallery.irisBlur",
    label: "\u5149\u5708\u6A21\u7CCA",
    group: "blurGallery",
    params: [
      { id: "radius", label: "\u6A21\u7CCA", min: 0, max: 100, step: 1, def: 16, unit: " \u50CF\u7D20" },
      { id: "cx", label: "\u5706\u5FC3 X", min: 0, max: 100, step: 1, def: 50, unit: "%" },
      { id: "cy", label: "\u5706\u5FC3 Y", min: 0, max: 100, step: 1, def: 50, unit: "%" },
      { id: "iris", label: "\u6E05\u6670\u533A", min: 5, max: 100, step: 1, def: 30, unit: "%" },
      { id: "feather", label: "\u7FBD\u5316", min: 5, max: 200, step: 1, def: 60, unit: "%" }
    ],
    apply: (b, p) => irisBlur(b, p.radius, p.cx, p.cy, p.iris, p.feather)
  },
  {
    id: "filter.blurGallery.tiltShift",
    label: "\u79FB\u8F74\u6444\u5F71",
    group: "blurGallery",
    params: [
      { id: "radius", label: "\u6A21\u7CCA", min: 0, max: 100, step: 1, def: 18, unit: " \u50CF\u7D20" },
      { id: "center", label: "\u6E05\u6670\u4F4D\u7F6E", min: 0, max: 100, step: 1, def: 50, unit: "%" },
      { id: "keep", label: "\u6E05\u6670\u5E26\u9AD8\u5EA6", min: 0, max: 100, step: 1, def: 8, unit: "%" },
      { id: "feather", label: "\u8FC7\u6E21\u7FBD\u5316", min: 1, max: 100, step: 1, def: 40, unit: "%" }
    ],
    apply: (b, p) => tiltShift(b, p.radius, p.center, p.keep, p.feather)
  },
  {
    id: "filter.blurGallery.pathBlur",
    label: "\u8DEF\u5F84\u6A21\u7CCA",
    group: "blurGallery",
    params: [
      { id: "distance", label: "\u8DEF\u5F84\u957F\u5EA6", min: 0, max: 200, step: 1, def: 40, unit: " \u50CF\u7D20" },
      { id: "angle", label: "\u8D77\u59CB\u89D2\u5EA6", min: -180, max: 180, step: 1, def: 0, unit: "\xB0" },
      { id: "curvature", label: "\u5F2F\u66F2", min: -180, max: 180, step: 1, def: 30, unit: "\xB0" },
      { id: "taper", label: "\u4E24\u7AEF\u6E10\u9690", min: 0, max: 100, step: 1, def: 40, unit: "%" }
    ],
    apply: (b, p) => pathBlur(b, p.distance, p.angle, p.curvature, p.taper)
  },
  {
    id: "filter.blurGallery.spinBlur",
    label: "\u65CB\u8F6C\u6A21\u7CCA",
    group: "blurGallery",
    params: [
      { id: "angle", label: "\u65CB\u8F6C\u91CF", min: 0, max: 360, step: 1, def: 20, unit: "\xB0" },
      { id: "cx", label: "\u4E2D\u5FC3 X", min: 0, max: 100, step: 1, def: 50, unit: "%" },
      { id: "cy", label: "\u4E2D\u5FC3 Y", min: 0, max: 100, step: 1, def: 50, unit: "%" }
    ],
    apply: (b, p) => spinBlur(b, p.angle, p.cx, p.cy)
  }
];
var BLUR_ADVANCED_DEFS = [
  {
    id: "filter.blur.lensBlur",
    label: "\u955C\u5934\u6A21\u7CCA",
    group: "blur",
    params: [
      { id: "radius", label: "\u534A\u5F84", min: 1, max: 100, step: 1, def: 18, unit: " \u50CF\u7D20" },
      { id: "threshold", label: "\u9AD8\u5149\u9608\u503C", min: 0, max: 254, step: 1, def: 200 },
      { id: "boost", label: "\u6563\u666F\u5F3A\u5EA6", min: 0, max: 200, step: 1, def: 80, unit: "%" }
    ],
    apply: (b, p) => lensBlur(b, p.radius, p.threshold, p.boost)
  },
  {
    id: "filter.blur.shapeBlur",
    label: "\u5F62\u72B6\u6A21\u7CCA",
    group: "blur",
    params: [
      { id: "radius", label: "\u534A\u5F84", min: 1, max: 40, step: 1, def: 6, unit: " \u50CF\u7D20" },
      { id: "iterations", label: "\u8FED\u4EE3", min: 1, max: 6, step: 1, def: 2 },
      {
        id: "shape",
        label: "\u5F62\u72B6",
        min: 0,
        max: 3,
        step: 1,
        def: 0,
        choices: [
          { label: "\u5706\u5F62", value: 0 },
          { label: "\u83F1\u5F62", value: 1 },
          { label: "\u65B9\u5F62", value: 2 },
          { label: "\u516D\u8FB9\u5F62", value: 3 }
        ]
      }
    ],
    apply: (b, p) => shapeBlur(b, p.radius, p.iterations, p.shape)
  },
  {
    id: "filter.blur.smartBlur",
    label: "\u667A\u80FD\u6A21\u7CCA",
    group: "blur",
    params: [
      { id: "radius", label: "\u534A\u5F84", min: 1, max: 50, step: 1, def: 8, unit: " \u50CF\u7D20" },
      { id: "threshold", label: "\u9608\u503C", min: 1, max: 255, step: 1, def: 30 },
      {
        id: "quality",
        label: "\u54C1\u8D28",
        min: 0,
        max: 2,
        step: 1,
        def: 1,
        choices: [
          { label: "\u4F4E", value: 0 },
          { label: "\u4E2D", value: 1 },
          { label: "\u9AD8", value: 2 }
        ]
      },
      {
        id: "mode",
        label: "\u6A21\u5F0F",
        min: 0,
        max: 1,
        step: 1,
        def: 0,
        choices: [
          { label: "\u6B63\u5E38", value: 0 },
          { label: "\u5E73\u6ED1\u8FC7\u6E21", value: 1 }
        ]
      }
    ],
    apply: (b, p) => smartBlur(b, p.radius, p.threshold, p.quality, p.mode)
  }
];
var DISTORT_ADVANCED_DEFS = [
  {
    id: "filter.distort.displace",
    label: "\u4F4D\u79FB",
    group: "distort",
    params: [
      { id: "h", label: "\u6C34\u5E73\u6BD4\u4F8B", min: -200, max: 200, step: 1, def: 20, unit: " \u50CF\u7D20" },
      { id: "v", label: "\u5782\u76F4\u6BD4\u4F8B", min: -200, max: 200, step: 1, def: 20, unit: " \u50CF\u7D20" },
      {
        id: "mode",
        label: "\u4F4D\u79FB\u56FE",
        min: 0,
        max: 2,
        step: 1,
        def: 0,
        choices: [
          { label: "\u68CB\u76D8\u683C", value: 0 },
          { label: "\u6E4D\u6D41", value: 1 },
          { label: "\u5F84\u5411", value: 2 }
        ]
      },
      {
        id: "edge",
        label: "\u672A\u5B9A\u4E49\u533A\u57DF",
        min: 0,
        max: 1,
        step: 1,
        def: 0,
        choices: [
          { label: "\u8FB9\u7F18\u5EF6\u4F38", value: 0 },
          { label: "\u73AF\u7ED5\u91CD\u590D", value: 1 }
        ]
      }
    ],
    apply: (b, p) => displace(b, p.h, p.v, p.mode, p.edge)
  }
];
var PIXELATE_ADVANCED_DEFS = [
  {
    id: "filter.pixelate.colorHalftone",
    label: "\u5F69\u8272\u534A\u8C03",
    group: "pixelate",
    params: [
      { id: "size", label: "\u7F51\u70B9\u5927\u5C0F", min: 2, max: 40, step: 1, def: 6, unit: " \u50CF\u7D20" }
    ],
    apply: (b, p) => colorHalftone(b, p.size)
  }
];
var OTHER_ADVANCED_DEFS = [
  {
    id: "filter.other.hsbHsl",
    label: "HSB/HSL",
    group: "other",
    params: [
      {
        id: "mode",
        label: "\u8272\u5F69\u6A21\u578B",
        min: 0,
        max: 1,
        step: 1,
        def: 0,
        choices: [
          { label: "HSB\uFF08\u8272\u76F8/\u9971\u548C\u5EA6/\u660E\u5EA6\uFF09", value: 0 },
          { label: "HSL\uFF08\u8272\u76F8/\u9971\u548C\u5EA6/\u4EAE\u5EA6\uFF09", value: 1 }
        ]
      }
    ],
    apply: (b, p) => hsbHsl(b, p.mode)
  }
];
var RENDER_DEFS = [
  {
    id: "filter.render.clouds",
    label: "\u4E91\u5F69",
    group: "render",
    params: [
      { id: "scale", label: "\u7F29\u653E", min: 1, max: 20, step: 1, def: 4 }
    ],
    apply: (b, p) => clouds(b, p.scale)
  },
  {
    id: "filter.render.differenceClouds",
    label: "\u5206\u5C42\u4E91\u5F69",
    group: "render",
    params: [
      { id: "scale", label: "\u7F29\u653E", min: 1, max: 20, step: 1, def: 4 }
    ],
    apply: (b, p) => differenceClouds(b, p.scale)
  },
  {
    id: "filter.render.lensFlare",
    label: "\u955C\u5934\u5149\u6655",
    group: "render",
    params: [
      { id: "x", label: "\u5149\u5FC3 X", min: 0, max: 100, step: 1, def: 30, unit: "%" },
      { id: "y", label: "\u5149\u5FC3 Y", min: 0, max: 100, step: 1, def: 28, unit: "%" },
      { id: "brightness", label: "\u4EAE\u5EA6", min: 10, max: 300, step: 1, def: 100, unit: "%" },
      {
        id: "type",
        label: "\u955C\u5934\u7C7B\u578B",
        min: 0,
        max: 2,
        step: 1,
        def: 0,
        choices: [
          { label: "50-300 \u6BEB\u7C73\u53D8\u7126", value: 0 },
          { label: "35 \u6BEB\u7C73\u5B9A\u7126", value: 1 },
          { label: "105 \u6BEB\u7C73\u5B9A\u7126", value: 2 }
        ]
      }
    ],
    apply: (b, p) => lensFlare(b, p.x, p.y, p.brightness, p.type)
  },
  {
    id: "filter.render.tree",
    label: "\u6811",
    group: "render",
    params: [
      { id: "seed", label: "\u968F\u673A\u79CD\u5B50", min: 1, max: 999, step: 1, def: 42 },
      { id: "spread", label: "\u679D\u5E72\u5F20\u5F00", min: 5, max: 80, step: 1, def: 28, unit: "\xB0" },
      { id: "depth", label: "\u5206\u53C9\u5C42\u6570", min: 2, max: 10, step: 1, def: 7 },
      {
        id: "leaves",
        label: "\u53F6\u8272\u65B9\u6848",
        min: 0,
        max: 2,
        step: 1,
        def: 0,
        choices: [
          { label: "\u7EFF\u53F6", value: 0 },
          { label: "\u6A31\u82B1", value: 1 },
          { label: "\u79CB\u53F6", value: 2 }
        ]
      }
    ],
    apply: (b, p) => tree(b, p.seed, p.spread, p.depth, p.leaves)
  },
  {
    id: "filter.render.flame",
    label: "\u706B\u7130",
    group: "render",
    params: [
      { id: "seed", label: "\u968F\u673A\u79CD\u5B50", min: 1, max: 999, step: 1, def: 7 },
      { id: "turbulence", label: "\u6270\u52A8", min: 0, max: 100, step: 1, def: 45, unit: "%" },
      { id: "brightness", label: "\u4EAE\u5EA6", min: 10, max: 200, step: 1, def: 100, unit: "%" },
      {
        id: "mode",
        label: "\u7C7B\u578B",
        min: 0,
        max: 1,
        step: 1,
        def: 0,
        choices: [
          { label: "\u81EA\u7136\u706B\u7130", value: 0 },
          { label: "\u5206\u5F62\u706B\u7130", value: 1 }
        ]
      }
    ],
    apply: (b, p) => flame(b, p.seed, p.turbulence, p.brightness, p.mode)
  },
  {
    id: "filter.render.pictureFrame",
    label: "\u753B\u6846",
    group: "render",
    params: [
      { id: "thickness", label: "\u8FB9\u6846\u5BBD\u5EA6", min: 1, max: 80, step: 1, def: 12, unit: " \u50CF\u7D20" },
      {
        id: "style",
        label: "\u6837\u5F0F",
        min: 0,
        max: 2,
        step: 1,
        def: 0,
        choices: [
          { label: "\u7B80\u7EA6", value: 0 },
          { label: "\u53CC\u7EBF", value: 1 },
          { label: "\u5706\u89D2\u659C\u9762", value: 2 }
        ]
      }
    ],
    apply: (b, p) => pictureFrame(b, p.thickness, p.style)
  },
  {
    id: "filter.render.lightingEffects",
    label: "\u5149\u7167\u6548\u679C",
    group: "render",
    params: [
      { id: "angle", label: "\u5149\u7167\u89D2\u5EA6", min: -180, max: 180, step: 1, def: -45, unit: "\xB0" },
      { id: "elevation", label: "\u4EF0\u89D2", min: 1, max: 89, step: 1, def: 45, unit: "\xB0" },
      { id: "ambient", label: "\u73AF\u5883\u5149", min: 0, max: 100, step: 1, def: 30, unit: "%" },
      { id: "gloss", label: "\u5149\u6CFD", min: 0, max: 100, step: 1, def: 50, unit: "%" },
      { id: "material", label: "\u5851\u6599\u6548\u679C", min: 0, max: 100, step: 1, def: 60, unit: "%" },
      { id: "exposure", label: "\u66DD\u5149\u5EA6", min: 0, max: 200, step: 1, def: 100, unit: "%" }
    ],
    apply: (b, p) => lightingEffects(b, p.angle, p.elevation, p.ambient, p.gloss, p.material, p.exposure)
  },
  {
    id: "filter.render.fibers",
    label: "\u7EA4\u7EF4",
    group: "render",
    params: [
      { id: "strength", label: "\u5F3A\u5EA6", min: 1, max: 100, step: 1, def: 30, unit: "%" },
      { id: "variance", label: "\u5DEE\u5F02", min: 0, max: 50, step: 1, def: 10 }
    ],
    apply: (b, p) => fibers(b, p.strength, p.variance)
  }
];
var VIDEO_DEFS = [
  {
    id: "filter.video.ntscColors",
    label: "NTSC \u989C\u8272",
    group: "video",
    params: [],
    apply: (b) => ntscColors(b)
  },
  {
    id: "filter.video.deInterlace",
    label: "\u9010\u884C",
    group: "video",
    params: [
      {
        id: "field",
        label: "\u6D88\u9664",
        min: 0,
        max: 1,
        step: 1,
        def: 0,
        choices: [
          { label: "\u5076\u6570\u884C", value: 0 },
          { label: "\u5947\u6570\u884C", value: 1 }
        ]
      }
    ],
    apply: (b, p) => deInterlace(b, p.field)
  }
];
var FILTER_DEFS = [
  ...BLUR_DEFS,
  ...BLUR_EXTRA_DEFS,
  ...BLUR_ADVANCED_DEFS,
  ...BLUR_GALLERY_DEFS,
  ...SHARPEN_DEFS,
  ...NOISE_DEFS,
  ...PIXELATE_DEFS,
  ...PIXELATE_EXTRA_DEFS,
  ...PIXELATE_ADVANCED_DEFS,
  ...DISTORT_DEFS,
  ...DISTORT_EXTRA_DEFS,
  ...DISTORT_ADVANCED_DEFS,
  ...LENS_DEFS,
  ...STYLIZE_DEFS,
  ...STYLIZE_EXTRA_DEFS,
  ...SKETCH_DEFS,
  ...TEXTURE_DEFS,
  ...ARTISTIC_DEFS,
  ...OTHER_DEFS,
  ...OTHER_ADVANCED_DEFS,
  ...RENDER_DEFS,
  ...VIDEO_DEFS
];

// src/core/colorMode.ts
var clamp255 = (v) => v < 0 ? 0 : v > 255 ? 255 : v;
function toBitmap(src, threshold, halftoneCell = 0) {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  const th = Math.min(255, Math.max(0, threshold));
  const cell = Math.max(0, Math.round(halftoneCell));
  const k = Math.PI / Math.max(2, cell);
  const cos = Math.cos(Math.PI / 4);
  const sin = Math.sin(Math.PI / 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const lum = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      let on;
      if (cell === 0) {
        on = lum > th;
      } else {
        const sx = x * cos - y * sin;
        const sy = x * sin + y * cos;
        const pattern = Math.sin(sx * k) * Math.sin(sy * k);
        on = pattern + 2 * (lum / 255) - 1 > 0;
      }
      const v = on ? 255 : 0;
      out.data[o] = v;
      out.data[o + 1] = v;
      out.data[o + 2] = v;
      out.data[o + 3] = data[o + 3];
    }
  }
  return out;
}
function toDuotone(src, dark, light, strength = 100) {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  const k = Math.min(100, Math.max(0, strength)) / 100;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const lum = (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / 255;
      for (let c = 0; c < 3; c += 1) {
        const ramp = dark[c] + (light[c] - dark[c]) * lum;
        out.data[o + c] = data[o + c] * (1 - k) + ramp * k;
      }
      out.data[o + 3] = data[o + 3];
    }
  }
  return out;
}
function makeBox(pixels, data) {
  let rMin = 255;
  let rMax = 0;
  let gMin = 255;
  let gMax = 0;
  let bMin = 255;
  let bMax = 0;
  for (const p of pixels) {
    const i = p * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    if (g < gMin) gMin = g;
    if (g > gMax) gMax = g;
    if (b < bMin) bMin = b;
    if (b > bMax) bMax = b;
  }
  return { pixels, rMin, rMax, gMin, gMax, bMin, bMax };
}
function medianCutPalette(src, colors) {
  const { width: w, height: h, data } = src;
  const n = Math.max(2, Math.min(256, Math.round(colors)));
  const all = [];
  const step = Math.max(1, Math.floor(Math.sqrt(w * h / 2e4)));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const p = y * w + x;
      if (data[p * 4 + 3] < 8) continue;
      all.push(p);
    }
  }
  if (all.length === 0) return [[0, 0, 0]];
  let boxes = [makeBox(all, data)];
  while (boxes.length < n) {
    let best = -1;
    let bestRange = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      const b = boxes[i];
      if (b.pixels.length < 2) continue;
      const range = Math.max(b.rMax - b.rMin, b.gMax - b.gMin, b.bMax - b.bMin);
      if (range > bestRange) {
        bestRange = range;
        best = i;
      }
    }
    if (best < 0 || bestRange === 0) break;
    const box = boxes[best];
    const useR = box.rMax - box.rMin >= box.gMax - box.gMin && box.rMax - box.rMin >= box.bMax - box.bMin;
    const useG = !useR && box.gMax - box.gMin >= box.bMax - box.bMin;
    const ch = useR ? 0 : useG ? 1 : 2;
    box.pixels.sort((a, b) => data[a * 4 + ch] - data[b * 4 + ch]);
    const mid = box.pixels.length >> 1;
    const left = box.pixels.slice(0, mid);
    const right = box.pixels.slice(mid);
    boxes = boxes.filter((_, i) => i !== best);
    if (left.length) boxes.push(makeBox(left, data));
    if (right.length) boxes.push(makeBox(right, data));
  }
  return boxes.map((b) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    for (const p of b.pixels) {
      const i = p * 4;
      r += data[i];
      g += data[i + 1];
      bl += data[i + 2];
    }
    const c = b.pixels.length || 1;
    return [Math.round(r / c), Math.round(g / c), Math.round(bl / c)];
  });
}
function nearest(palette, r, g, b) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i += 1) {
    const p = palette[i];
    const dr = p[0] - r;
    const dg = p[1] - g;
    const db = p[2] - b;
    const d = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
function toIndexed(src, colors, dither) {
  const palette = medianCutPalette(src, colors);
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  const work = new Float32Array(w * h * 3);
  for (let p = 0; p < w * h; p += 1) {
    const i = p * 4;
    work[p * 3] = data[i];
    work[p * 3 + 1] = data[i + 1];
    work[p * 3 + 2] = data[i + 2];
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = y * w + x;
      const o = p * 4;
      if (data[o + 3] < 8) continue;
      const r = work[p * 3];
      const g = work[p * 3 + 1];
      const b = work[p * 3 + 2];
      const idx = nearest(palette, r, g, b);
      const pr = palette[idx][0];
      const pg = palette[idx][1];
      const pb = palette[idx][2];
      out.data[o] = pr;
      out.data[o + 1] = pg;
      out.data[o + 2] = pb;
      out.data[o + 3] = data[o + 3];
      if (!dither) continue;
      const er = r - pr;
      const eg = g - pg;
      const eb = b - pb;
      const spread = (dx, dy, k) => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
        const np = ny * w + nx;
        work[np * 3] += er * k;
        work[np * 3 + 1] += eg * k;
        work[np * 3 + 2] += eb * k;
      };
      spread(1, 0, 7 / 16);
      spread(-1, 1, 3 / 16);
      spread(0, 1, 5 / 16);
      spread(1, 1, 1 / 16);
    }
  }
  return { buf: out, palette };
}
function applyPalette(src, palette) {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  for (let p = 0; p < w * h; p += 1) {
    const o = p * 4;
    if (data[o + 3] < 8) continue;
    const idx = nearest(palette, data[o], data[o + 1], data[o + 2]);
    out.data[o] = palette[idx][0];
    out.data[o + 1] = palette[idx][1];
    out.data[o + 2] = palette[idx][2];
    out.data[o + 3] = data[o + 3];
  }
  return out;
}
function toCmyk(src, inkLimit, ucr) {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  const limit = Math.min(400, Math.max(100, inkLimit)) / 100;
  const u = Math.min(100, Math.max(0, ucr)) / 100;
  for (let p = 0; p < w * h; p += 1) {
    const o = p * 4;
    const r = data[o] / 255;
    const g = data[o + 1] / 255;
    const b = data[o + 2] / 255;
    let k = 1 - Math.max(r, g, b);
    k = Math.min(1, k * (1 + u));
    let c = 0;
    let m = 0;
    let y = 0;
    if (k < 1) {
      c = (1 - r - k) / (1 - k);
      m = (1 - g - k) / (1 - k);
      y = (1 - b - k) / (1 - k);
    }
    c = c < 0 ? 0 : c;
    m = m < 0 ? 0 : m;
    y = y < 0 ? 0 : y;
    let total = c + m + y + k;
    if (total > limit && total > 0) {
      const f2 = limit / total;
      c *= f2;
      m *= f2;
      y *= f2;
      k *= f2;
      total = limit;
    }
    void total;
    out.data[o] = clamp255((1 - c) * (1 - k) * 255);
    out.data[o + 1] = clamp255((1 - m) * (1 - k) * 255);
    out.data[o + 2] = clamp255((1 - y) * (1 - k) * 255);
    out.data[o + 3] = data[o + 3];
  }
  return out;
}
function srgbToLinear(v) {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(v) {
  const c = v <= 31308e-7 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return c * 255;
}
function f(t) {
  return t > 8856e-6 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}
function finv(t) {
  return t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787;
}
function toLab(src, chroma) {
  const { width: w, height: h, data } = src;
  const out = makeBuffer(w, h);
  const maxC = Math.max(0, chroma);
  for (let p = 0; p < w * h; p += 1) {
    const o = p * 4;
    const rl = srgbToLinear(data[o]);
    const gl = srgbToLinear(data[o + 1]);
    const bl = srgbToLinear(data[o + 2]);
    const X = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047;
    const Y = 0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl;
    const Z = (0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / 1.08883;
    const fx = f(X);
    const fy = f(Y);
    const fz = f(Z);
    let L = 116 * fy - 16;
    let a = 500 * (fx - fy);
    let b2 = 200 * (fy - fz);
    if (maxC > 0) {
      const c = Math.hypot(a, b2);
      if (c > maxC) {
        const k = maxC / c;
        a *= k;
        b2 *= k;
      }
    }
    const fy2 = (L + 16) / 116;
    const X2 = finv(fy2 + a / 500) * 0.95047;
    const Y2 = finv(fy2);
    const Z2 = finv(fy2 - b2 / 200) * 1.08883;
    const r2 = 3.2404542 * X2 - 1.5371385 * Y2 - 0.4985314 * Z2;
    const g2 = -0.969266 * X2 + 1.8760108 * Y2 + 0.041556 * Z2;
    const b3 = 0.0556434 * X2 - 0.2040259 * Y2 + 1.0572252 * Z2;
    out.data[o] = clamp255(linearToSrgb(Math.max(0, r2)));
    out.data[o + 1] = clamp255(linearToSrgb(Math.max(0, g2)));
    out.data[o + 2] = clamp255(linearToSrgb(Math.max(0, b3)));
    out.data[o + 3] = data[o + 3];
    void L;
  }
  return out;
}
function splitChannels(src) {
  const { width: w, height: h, data } = src;
  const make = (pick) => {
    const b = makeBuffer(w, h);
    for (let p = 0; p < w * h; p += 1) {
      const o = p * 4;
      const v = pick(o);
      b.data[o] = v;
      b.data[o + 1] = v;
      b.data[o + 2] = v;
      b.data[o + 3] = 255;
    }
    return b;
  };
  return {
    channels: [
      make((o) => data[o]),
      make((o) => data[o + 1]),
      make((o) => data[o + 2]),
      make((o) => data[o + 3])
    ],
    names: ["\u7EA2", "\u7EFF", "\u84DD", "Alpha"]
  };
}
function quantizeTo8(src) {
  const out = makeBuffer(src.width, src.height);
  for (let i = 0; i < src.data.length; i += 1) {
    out.data[i] = Math.round(src.data[i] / 1) * 1;
  }
  return out;
}

// src/core/seamCarve.ts
function energyMap(src) {
  const { width: w, height: h, data } = src;
  const out = new Float32Array(w * h);
  const lum = (o) => 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const xl = (y * w + Math.max(0, x - 1)) * 4;
      const xr = (y * w + Math.min(w - 1, x + 1)) * 4;
      const yu = (Math.max(0, y - 1) * w + x) * 4;
      const yd = (Math.min(h - 1, y + 1) * w + x) * 4;
      const gx = lum(xr) - lum(xl);
      const gy = lum(yd) - lum(yu);
      out[y * w + x] = Math.abs(gx) + Math.abs(gy);
    }
  }
  return out;
}
function findVerticalSeam(energy, w, h, opts = {}) {
  const bias = opts.protectBias ?? 1e5;
  const cost = new Float32Array(w * h);
  const from = new Int32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x2 = 0; x2 < w; x2 += 1) {
      const i = y * w + x2;
      let e = energy[i];
      if (opts.protect && opts.protect[i] > 0) e += bias * (opts.protect[i] / 255);
      if (opts.remove && opts.remove[i] > 0) e = 0;
      if (y === 0) {
        cost[i] = e;
        from[i] = -1;
        continue;
      }
      let best2 = cost[i - w];
      let bx = x2;
      if (x2 > 0 && cost[i - w - 1] < best2) {
        best2 = cost[i - w - 1];
        bx = x2 - 1;
      }
      if (x2 < w - 1 && cost[i - w + 1] < best2) {
        best2 = cost[i - w + 1];
        bx = x2 + 1;
      }
      cost[i] = e + best2;
      from[i] = bx;
    }
  }
  let x = 0;
  let best = cost[(h - 1) * w];
  for (let cx = 1; cx < w; cx += 1) {
    if (cost[(h - 1) * w + cx] < best) {
      best = cost[(h - 1) * w + cx];
      x = cx;
    }
  }
  const seam = new Array(h);
  for (let y = h - 1; y >= 0; y -= 1) {
    seam[y] = x;
    const p = from[y * w + x];
    x = p < 0 ? x : p;
  }
  return seam;
}
function findHorizontalSeam(energy, w, h, opts = {}) {
  const te = new Float32Array(w * h);
  const tp = opts.protect ? new Uint8ClampedArray(w * h) : void 0;
  const tr = opts.remove ? new Uint8ClampedArray(w * h) : void 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      te[x * h + y] = energy[y * w + x];
      if (tp) tp[x * h + y] = opts.protect[y * w + x];
      if (tr) tr[x * h + y] = opts.remove[y * w + x];
    }
  }
  const tseam = findVerticalSeam(te, h, w, {
    protect: tp,
    remove: tr,
    protectBias: opts.protectBias
  });
  return tseam;
}
function removeVerticalSeam(src, seam) {
  const { width: w, height: h } = src;
  const out = makeBuffer(w - 1, h);
  for (let y = 0; y < h; y += 1) {
    const sx = seam[y];
    let o = y * (w - 1) * 4;
    for (let x = 0; x < w; x += 1) {
      if (x === sx) continue;
      const s = (y * w + x) * 4;
      out.data[o] = src.data[s];
      out.data[o + 1] = src.data[s + 1];
      out.data[o + 2] = src.data[s + 2];
      out.data[o + 3] = src.data[s + 3];
      o += 4;
    }
  }
  return out;
}
function insertVerticalSeam(src, seam) {
  const { width: w, height: h } = src;
  const out = makeBuffer(w + 1, h);
  for (let y = 0; y < h; y += 1) {
    const sx = seam[y];
    let o = y * (w + 1) * 4;
    for (let x = 0; x < w + 1; x += 1) {
      const copyAt = x;
      const from = copyAt <= sx ? copyAt : copyAt - 1;
      const s = (y * w + from) * 4;
      let r = src.data[s];
      let g = src.data[s + 1];
      let b = src.data[s + 2];
      let a = src.data[s + 3];
      if (copyAt === sx) {
        const sl = (y * w + Math.max(0, sx - 1)) * 4;
        r = (r + src.data[sl]) / 2;
        g = (g + src.data[sl + 1]) / 2;
        b = (b + src.data[sl + 2]) / 2;
      }
      out.data[o] = r;
      out.data[o + 1] = g;
      out.data[o + 2] = b;
      out.data[o + 3] = a;
      o += 4;
    }
  }
  return out;
}
function removeHorizontalSeam(src, seam) {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h - 1);
  for (let x = 0; x < w; x += 1) {
    const sy = seam[x];
    let o = x * 4;
    for (let y = 0; y < h; y += 1) {
      if (y === sy) continue;
      const s = (y * w + x) * 4;
      out.data[o] = src.data[s];
      out.data[o + 1] = src.data[s + 1];
      out.data[o + 2] = src.data[s + 2];
      out.data[o + 3] = src.data[s + 3];
      o += w * 4;
    }
  }
  return out;
}
function insertHorizontalSeam(src, seam) {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h + 1);
  for (let x = 0; x < w; x += 1) {
    const sy = seam[x];
    for (let y = 0; y < h + 1; y += 1) {
      const from = y <= sy ? y : y - 1;
      const s = (from * w + x) * 4;
      let r = src.data[s];
      let g = src.data[s + 1];
      let b = src.data[s + 2];
      const a = src.data[s + 3];
      if (y === sy) {
        const su = (Math.max(0, sy - 1) * w + x) * 4;
        r = (r + src.data[su]) / 2;
        g = (g + src.data[su + 1]) / 2;
        b = (b + src.data[su + 2]) / 2;
      }
      const o = (y * w + x) * 4;
      out.data[o] = r;
      out.data[o + 1] = g;
      out.data[o + 2] = b;
      out.data[o + 3] = a;
    }
  }
  return out;
}
function contentAwareScale(src, targetW, targetH, opts = {}) {
  let cur = src;
  const dw = Math.round(targetW) - src.width;
  const dh = Math.round(targetH) - src.height;
  const vertical = Math.abs(dw);
  const horizontal = Math.abs(dh);
  for (let i = 0; i < vertical; i += 1) {
    const energy = energyMap(cur);
    const seam = findVerticalSeam(energy, cur.width, cur.height, opts);
    cur = dw > 0 ? insertVerticalSeam(cur, seam) : removeVerticalSeam(cur, seam);
  }
  for (let i = 0; i < horizontal; i += 1) {
    const energy = energyMap(cur);
    const seam = findHorizontalSeam(energy, cur.width, cur.height, opts);
    cur = dh > 0 ? insertHorizontalSeam(cur, seam) : removeHorizontalSeam(cur, seam);
  }
  return cur;
}

// src/engine/meshWarp.ts
var EPS = 1e-8;
function mlsWarp(src, pins, mode = "similarity") {
  const { width: w, height: h } = src;
  const out = makeBuffer(w, h);
  const minPins = mode === "affine" ? 3 : 2;
  if (pins.length < minPins || !hasSpan(pins)) {
    out.data.set(src.data);
    return out;
  }
  const n = pins.length;
  const qx = new Float64Array(n);
  const qy = new Float64Array(n);
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    qx[i] = pins[i].x;
    qy[i] = pins[i].y;
    px[i] = pins[i].ox;
    py[i] = pins[i].oy;
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      let sw = 0;
      let pcx = 0;
      let pcy = 0;
      let qcx = 0;
      let qcy = 0;
      let onPin = -1;
      for (let i = 0; i < n; i += 1) {
        const dx = x - qx[i];
        const dy = y - qy[i];
        const d2 = dx * dx + dy * dy;
        if (d2 < EPS) {
          onPin = i;
          break;
        }
        const wi = 1 / d2;
        sw += wi;
        pcx += wi * px[i];
        pcy += wi * py[i];
        qcx += wi * qx[i];
        qcy += wi * qy[i];
      }
      if (onPin >= 0) {
        sampleBilinear(src, px[onPin], py[onPin], out.data, o);
        continue;
      }
      pcx /= sw;
      pcy /= sw;
      qcx /= sw;
      qcy /= sw;
      let cre = 0;
      let cim = 0;
      let f11 = 0;
      let f12 = 0;
      let f22 = 0;
      let g11 = 0;
      let g12 = 0;
      let g21 = 0;
      let g22 = 0;
      for (let i = 0; i < n; i += 1) {
        const dx = x - qx[i];
        const dy = y - qy[i];
        const wi = 1 / (dx * dx + dy * dy);
        const phx = px[i] - pcx;
        const phy = py[i] - pcy;
        const qhx = qx[i] - qcx;
        const qhy = qy[i] - qcy;
        cre += wi * (phx * qhx + phy * qhy);
        cim += wi * (phy * qhx - phx * qhy);
        f11 += wi * qhx * qhx;
        f12 += wi * qhx * qhy;
        f22 += wi * qhy * qhy;
        g11 += wi * phx * qhx;
        g12 += wi * phx * qhy;
        g21 += wi * phy * qhx;
        g22 += wi * phy * qhy;
      }
      const vhx = x - qcx;
      const vhy = y - qcy;
      let sx;
      let sy;
      if (mode === "affine") {
        const det = f11 * f22 - f12 * f12;
        if (det < EPS) {
          sx = x + (pcx - qcx);
          sy = y + (pcy - qcy);
        } else {
          const i11 = f22 / det;
          const i12 = -f12 / det;
          const i21 = i12;
          const i22 = f11 / det;
          const fx = i11 * vhx + i12 * vhy;
          const fy = i21 * vhx + i22 * vhy;
          sx = pcx + g11 * fx + g12 * fy;
          sy = pcy + g21 * fx + g22 * fy;
        }
      } else {
        const mu = f11 + f22;
        if (mu < EPS) {
          sampleBilinear(src, x, y, out.data, o);
          continue;
        }
        const are = cre / mu;
        const aim = cim / mu;
        sx = pcx + are * vhx - aim * vhy;
        sy = pcy + aim * vhx + are * vhy;
      }
      sampleBilinear(src, sx, sy, out.data, o);
    }
  }
  return out;
}
function hasSpan(pins) {
  const x0 = pins[0].x;
  const y0 = pins[0].y;
  for (let i = 1; i < pins.length; i += 1) {
    if (Math.hypot(pins[i].x - x0, pins[i].y - y0) > 1) return true;
  }
  return false;
}

// src/core/smartSelect.ts
function colorRangeHit(d, w, h, rgb, tolerance) {
  const tol = Math.max(0, tolerance) * tolerance * 4;
  const hit = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p += 1) {
    const i = p * 4;
    const dr = d[i] - rgb[0];
    const dg = d[i + 1] - rgb[1];
    const db = d[i + 2] - rgb[2];
    if (dr * dr + dg * dg + db * db <= tol) hit[p] = 1;
  }
  return hit;
}
function growHit(sel, d, w, h, tolerance) {
  const out = sel.slice();
  const queue = [];
  for (let p = 0; p < w * h; p += 1) if (sel[p]) queue.push(p);
  if (queue.length === 0) return out;
  const tol = Math.max(0, tolerance) * tolerance * 4;
  let head = 0;
  while (head < queue.length) {
    const p = queue[head];
    head += 1;
    const x = p % w;
    const y = p / w | 0;
    const i = p * 4;
    for (let k = 0; k < 4; k += 1) {
      const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0);
      const ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const np = ny * w + nx;
      if (out[np]) continue;
      const j = np * 4;
      const dr = d[j] - d[i];
      const dg = d[j + 1] - d[i + 1];
      const db = d[j + 2] - d[i + 2];
      const da = d[j + 3] - d[i + 3];
      if (dr * dr + dg * dg + db * db + da * da <= tol) {
        out[np] = 1;
        queue.push(np);
      }
    }
  }
  return out;
}
function subjectHit(d, w, h) {
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const rs = [];
  const gs = [];
  const bs = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!(x < band || y < band || x >= w - band || y >= h - band)) continue;
      const i = (y * w + x) * 4;
      if (d[i + 3] < 32) continue;
      rs.push(d[i]);
      gs.push(d[i + 1]);
      bs.push(d[i + 2]);
    }
  }
  if (rs.length < 16) return null;
  const med = (arr) => {
    arr.sort((a, b) => a - b);
    return arr[arr.length >> 1];
  };
  const br = med(rs);
  const bg = med(gs);
  const bb = med(bs);
  let varSum = 0;
  for (let n = 0; n < rs.length; n += 1) {
    const dr = rs[n] - br;
    const dg = gs[n] - bg;
    const db = bs[n] - bb;
    varSum += dr * dr + dg * dg + db * db;
  }
  const sigma = Math.sqrt(varSum / rs.length);
  const thr = Math.min(120, sigma * 2 + 40);
  const thr2 = thr * thr;
  const hit = new Uint8Array(w * h);
  let count = 0;
  for (let p = 0; p < w * h; p += 1) {
    const i = p * 4;
    const dr = d[i] - br;
    const dg = d[i + 1] - bg;
    const db = d[i + 2] - bb;
    if (dr * dr + dg * dg + db * db > thr2) {
      hit[p] = 1;
      count += 1;
    }
  }
  if (count === 0) return null;
  return hit;
}
function skyHit(d, w, h) {
  const hit = new Uint8Array(w * h);
  let any = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      if (d[i + 3] < 32) continue;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max === min || max === 0) continue;
      const sat = (max - min) / max;
      const val = max / 255;
      if (val < 0.35 || sat < 0.12) continue;
      const hu = max === b ? 60 * (4 + (r - g) / (max - min)) : max === g ? 60 * (2 + (b - r) / (max - min)) : 60 * (((g - b) / (max - min) + 6) % 6);
      if (hu >= 170 && hu <= 260) {
        hit[y * w + x] = 1;
        any += 1;
      }
    }
  }
  if (any === 0) return null;
  const keep = new Uint8Array(w * h);
  const stack = [];
  const topLimit = Math.max(1, Math.round(h * 0.25));
  for (let y = 0; y < topLimit; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = y * w + x;
      if (hit[p] && !keep[p]) {
        keep[p] = 1;
        stack.push(p);
      }
    }
  }
  while (stack.length > 0) {
    const p = stack.pop();
    const x = p % w;
    const y = p / w | 0;
    if (x > 0 && hit[p - 1] && !keep[p - 1]) {
      keep[p - 1] = 1;
      stack.push(p - 1);
    }
    if (x < w - 1 && hit[p + 1] && !keep[p + 1]) {
      keep[p + 1] = 1;
      stack.push(p + 1);
    }
    if (y > 0 && hit[p - w] && !keep[p - w]) {
      keep[p - w] = 1;
      stack.push(p - w);
    }
    if (y < h - 1 && hit[p + w] && !keep[p + w]) {
      keep[p + w] = 1;
      stack.push(p + w);
    }
  }
  return keep;
}
function focusHit(d, w, h, threshold) {
  const lum = new Float32Array(w * h);
  for (let p = 0; p < w * h; p += 1) {
    const i = p * 4;
    lum[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  const t = Math.max(1, threshold);
  const hit = new Uint8Array(w * h);
  let any = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const p = y * w + x;
      const lap = 4 * lum[p] - lum[p - 1] - lum[p + 1] - lum[p - w] - lum[p + w];
      if (Math.abs(lap) > t) {
        hit[p] = 1;
        any += 1;
      }
    }
  }
  if (any < 4) return null;
  return hit;
}

// src/core/stackOps.ts
function lumaOf(buf) {
  const out = new Float32Array(buf.width * buf.height);
  for (let p = 0; p < out.length; p += 1) {
    const i = p * 4;
    out[p] = 0.299 * buf.data[i] + 0.587 * buf.data[i + 1] + 0.114 * buf.data[i + 2];
  }
  return out;
}
function smoothLum(lum, w, h) {
  let cur = lum;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = new Float32Array(cur.length);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            sum += cur[yy * w + xx];
            n += 1;
          }
        }
        next[y * w + x] = sum / n;
      }
    }
    cur = next;
  }
  return cur;
}
function halve(lum, w, h) {
  const nw = Math.max(1, w >> 1);
  const nh = Math.max(1, h >> 1);
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y += 1) {
    for (let x = 0; x < nw; x += 1) {
      const x0 = x * 2;
      const y0 = y * 2;
      const a = lum[y0 * w + x0];
      const b = lum[y0 * w + Math.min(w - 1, x0 + 1)];
      const c = lum[Math.min(h - 1, y0 + 1) * w + x0];
      const d = lum[Math.min(h - 1, y0 + 1) * w + Math.min(w - 1, x0 + 1)];
      out[y * nw + x] = (a + b + c + d) / 4;
    }
  }
  return { lum: out, w: nw, h: nh };
}
function bestShift(a, b, w, h, range) {
  let best = { dx: 0, dy: 0 };
  let bestScore = Infinity;
  const step = range > 20 ? 2 : 1;
  for (let dy = -range; dy <= range; dy += step) {
    for (let dx = -range; dx <= range; dx += step) {
      let sum = 0;
      let count = 0;
      const x0 = Math.max(0, dx);
      const y0 = Math.max(0, dy);
      const x1 = Math.min(w, w + dx);
      const y1 = Math.min(h, h + dy);
      if (x1 - x0 < 8 || y1 - y0 < 8) continue;
      const sample = Math.max(1, Math.floor(Math.sqrt((x1 - x0) * (y1 - y0) / 6e3)));
      for (let y = y0; y < y1; y += sample) {
        for (let x = x0; x < x1; x += sample) {
          sum += Math.abs(a[y * w + x] - b[(y - dy) * w + (x - dx)]);
          count += 1;
        }
      }
      if (count === 0) continue;
      const score = sum / count;
      if (score < bestScore) {
        bestScore = score;
        best = { dx, dy };
      }
    }
  }
  return best;
}
function estimateShift(reference, moving, coarseRange = 64) {
  const w = Math.min(reference.width, moving.width);
  const h = Math.min(reference.height, moving.height);
  const ra = halve(
    smoothLum(lumaOf(reference), reference.width, reference.height),
    reference.width,
    reference.height
  );
  const mb = halve(
    smoothLum(lumaOf(moving), moving.width, moving.height),
    moving.width,
    moving.height
  );
  const ww = Math.min(ra.w, mb.w);
  const hh = Math.min(ra.h, mb.h);
  const coarse = bestShift(ra.lum, mb.lum, ww, hh, Math.max(2, Math.round(coarseRange / 2)));
  const fa = smoothLum(lumaOf(reference), reference.width, reference.height);
  const fb = smoothLum(lumaOf(moving), moving.width, moving.height);
  const cx = coarse.dx * 2;
  const cy = coarse.dy * 2;
  let best = { dx: cx, dy: cy };
  let bestScore = Infinity;
  for (let dy = cy - 6; dy <= cy + 6; dy += 1) {
    for (let dx = cx - 6; dx <= cx + 6; dx += 1) {
      const x0 = Math.max(0, dx);
      const y0 = Math.max(0, dy);
      const x1 = Math.min(w, w + dx);
      const y1 = Math.min(h, h + dy);
      if (x1 - x0 < 16 || y1 - y0 < 16) continue;
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          sum += Math.abs(fa[y * w + x] - fb[(y - dy) * w + (x - dx)]);
          count += 1;
        }
      }
      if (count === 0) continue;
      const score = sum / count;
      if (score < bestScore) {
        bestScore = score;
        best = { dx, dy };
      }
    }
  }
  return best;
}
function sharpnessWeights(src, radius = 6) {
  const { width: w, height: h, data } = src;
  const lum = lumaOf(src);
  const raw = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const p2 = y * w + x;
      const lap = 4 * lum[p2] - lum[p2 - 1] - lum[p2 + 1] - lum[p2 - w] - lum[p2 + w];
      raw[p2] = Math.abs(lap);
    }
  }
  void data;
  const p = premultiply({ data: toRgba(raw), width: w, height: h });
  const blurred = boxBlurPass(p, w, h, Math.max(1, Math.round(radius)));
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) out[i] = blurred[i * 4] / 255;
  return out;
}
function toRgba(v) {
  const out = new Uint8ClampedArray(v.length * 4);
  for (let i = 0; i < v.length; i += 1) {
    out[i * 4] = v[i];
    out[i * 4 + 1] = v[i];
    out[i * 4 + 2] = v[i];
    out[i * 4 + 3] = 255;
  }
  return out;
}

// src/core/colorProfile.ts
var PROFILE_LABELS = {
  srgb: "sRGB IEC61966-2.1",
  "display-p3": "Display P3",
  "adobe-rgb": "Adobe RGB (1998)",
  gray: "\u7070\u5EA6 Gamma 2.2"
};
var TO_XYZ = {
  srgb: [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041],
  "display-p3": [0.4865709, 0.2656677, 0.1982173, 0.2289746, 0.6917385, 0.0792869, 0, 0.0451134, 1.0439444],
  "adobe-rgb": [0.5767309, 0.185554, 0.1881852, 0.2973769, 0.6273491, 0.0752741, 0.0270343, 0.0706872, 0.9911085]
};
var FROM_XYZ = {
  srgb: [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252],
  "display-p3": [2.4934969, -0.9313836, -0.4027108, -0.829489, 1.7626641, 0.0236247, 0.0358458, -0.0761724, 0.9568845],
  "adobe-rgb": [2.041369, -0.5649464, -0.3446944, -0.969266, 1.8760108, 0.041556, 0.0134474, -0.1183897, 1.0154096]
};
function toLinear(v, profile) {
  const c = v / 255;
  if (profile === "adobe-rgb") return Math.pow(c, 2.19921875);
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function fromLinear(v, profile) {
  const c = Math.max(0, v);
  if (profile === "adobe-rgb") return Math.pow(c, 1 / 2.19921875) * 255;
  const s = c <= 31308e-7 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return s * 255;
}
var clamp2552 = (v) => v < 0 ? 0 : v > 255 ? 255 : v;
function convertProfile(src, from, to) {
  const out = makeBuffer(src.width, src.height);
  if (from === to) {
    out.data.set(src.data);
    return out;
  }
  const d = src.data;
  for (let p = 0; p < src.width * src.height; p += 1) {
    const o = p * 4;
    if (from === "gray") {
      const g = d[o];
      out.data[o] = g;
      out.data[o + 1] = g;
      out.data[o + 2] = g;
      out.data[o + 3] = d[o + 3];
      continue;
    }
    const rl = toLinear(d[o], from);
    const gl = toLinear(d[o + 1], from);
    const bl = toLinear(d[o + 2], from);
    const m = TO_XYZ[from];
    const X = m[0] * rl + m[1] * gl + m[2] * bl;
    const Y = m[3] * rl + m[4] * gl + m[5] * bl;
    const Z = m[6] * rl + m[7] * gl + m[8] * bl;
    if (to === "gray") {
      const y = clamp2552(fromLinear(Y, "srgb"));
      out.data[o] = y;
      out.data[o + 1] = y;
      out.data[o + 2] = y;
      out.data[o + 3] = d[o + 3];
      continue;
    }
    const n = FROM_XYZ[to];
    const rr = n[0] * X + n[1] * Y + n[2] * Z;
    const gg = n[3] * X + n[4] * Y + n[5] * Z;
    const bb = n[6] * X + n[7] * Y + n[8] * Z;
    out.data[o] = clamp2552(fromLinear(rr, to));
    out.data[o + 1] = clamp2552(fromLinear(gg, to));
    out.data[o + 2] = clamp2552(fromLinear(bb, to));
    out.data[o + 3] = d[o + 3];
  }
  return out;
}

// src/core/photoCrop.ts
function estimateBackground(data, w, h) {
  const rs = [];
  const gs = [];
  const bs = [];
  const push = (x, y) => {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 8) return;
    rs.push(data[i]);
    gs.push(data[i + 1]);
    bs.push(data[i + 2]);
  };
  const band = Math.max(1, Math.round(Math.min(w, h) * 0.02));
  for (let x = 0; x < w; x += 1) {
    for (let k = 0; k < band; k += 1) {
      push(x, k);
      push(x, h - 1 - k);
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let k = 0; k < band; k += 1) {
      push(k, y);
      push(w - 1 - k, y);
    }
  }
  if (rs.length === 0) return [255, 255, 255];
  const mid = (arr) => {
    arr.sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)];
  };
  return [mid(rs), mid(gs), mid(bs)];
}
function findPhotoRegions(data, w, h, tolerance = 32, minArea = 5e-3) {
  const total = w * h;
  if (total === 0) return { boxes: [], singleBlob: false, background: [255, 255, 255] };
  const bg = estimateBackground(data, w, h);
  const [br, bgc, bb] = bg;
  const thr2 = tolerance * tolerance;
  const fg = new Uint8Array(total);
  for (let p = 0; p < total; p += 1) {
    const i = p * 4;
    if (data[i + 3] < 8) continue;
    const dr = data[i] - br;
    const dg = data[i + 1] - bgc;
    const db = data[i + 2] - bb;
    if (dr * dr + dg * dg + db * db > thr2) fg[p] = 1;
  }
  const parent = new Int32Array(total).fill(-1);
  const find = (a) => {
    let x = a;
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = y * w + x;
      if (!fg[p]) continue;
      parent[p] = p;
      if (x > 0 && fg[p - 1]) union(p, p - 1);
      if (y > 0 && fg[p - w]) union(p, p - w);
    }
  }
  const boxes = /* @__PURE__ */ new Map();
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = y * w + x;
      if (!fg[p] || parent[p] < 0) continue;
      const root = find(p);
      const cur = boxes.get(root);
      if (!cur) {
        boxes.set(root, { x0: x, y0: y, x1: x, y1: y, n: 1 });
      } else {
        if (x < cur.x0) cur.x0 = x;
        if (y < cur.y0) cur.y0 = y;
        if (x > cur.x1) cur.x1 = x;
        if (y > cur.y1) cur.y1 = y;
        cur.n += 1;
      }
    }
  }
  const minPixels = Math.max(16, Math.floor(total * minArea));
  const out = [];
  for (const b of boxes.values()) {
    if (b.n < minPixels) continue;
    const pad = 2;
    const x = Math.max(0, b.x0 - pad);
    const y = Math.max(0, b.y0 - pad);
    const x1 = Math.min(w - 1, b.x1 + pad);
    const y1 = Math.min(h - 1, b.y1 + pad);
    out.push({
      x,
      y,
      w: x1 - x + 1,
      h: y1 - y + 1,
      area: (x1 - x + 1) * (y1 - y + 1) / total
    });
  }
  out.sort((a, b) => Math.abs(a.y - b.y) > a.h * 0.5 ? a.y - b.y : a.x - b.x);
  const singleBlob = out.length === 1 && out[0].area > 0.82;
  return { boxes: out, singleBlob, background: bg };
}

// src/core/lut.ts
var CUBE_SIZE = 33;
function identityLut(size) {
  const width = size * size;
  const height = size;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const x = b * size + r;
        const y = g;
        const i = (y * width + x) * 4;
        data[i] = Math.round(r / (size - 1) * 255);
        data[i + 1] = Math.round(g / (size - 1) * 255);
        data[i + 2] = Math.round(b / (size - 1) * 255);
        data[i + 3] = 255;
      }
    }
  }
  return { data, width, height };
}
function lutToCube(data, width, size, title = "Strata LUT") {
  const lines = [];
  lines.push(`TITLE "${title.replace(/"/g, "'")}"`);
  lines.push(`LUT_3D_SIZE ${size}`);
  lines.push("DOMAIN_MIN 0.0 0.0 0.0");
  lines.push("DOMAIN_MAX 1.0 1.0 1.0");
  const fmt = (v) => (v / 255).toFixed(6);
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const x = b * size + r;
        const i = (g * width + x) * 4;
        lines.push(`${fmt(data[i])} ${fmt(data[i + 1])} ${fmt(data[i + 2])}`);
      }
    }
  }
  return `${lines.join("\n")}
`;
}
function identityCube(size) {
  const { data, width } = identityLut(size);
  return lutToCube(data, width, size, "Identity");
}

// src/core/proofread.ts
var TYPOS = {
  teh: "the",
  adn: "and",
  recieve: "receive",
  recieved: "received",
  seperate: "separate",
  definately: "definitely",
  occured: "occurred",
  untill: "until",
  wich: "which",
  thier: "their",
  becuase: "because",
  alot: "a lot",
  accomodate: "accommodate",
  arguement: "argument",
  calender: "calendar",
  enviroment: "environment",
  existance: "existence",
  goverment: "government",
  independant: "independent",
  neccessary: "necessary",
  occassion: "occasion",
  publically: "publicly",
  reccomend: "recommend",
  succesful: "successful",
  tommorow: "tomorrow",
  werid: "weird"
};
var CJK = /[\u4e00-\u9fff]/;
var LATIN = /[A-Za-z0-9]/;
function checkText(content) {
  const issues = [];
  const text = content.replace(/\r\n?/g, "\n");
  let m;
  const dupEn = /\b([A-Za-z]{2,})(\s+\1\b)/g;
  while ((m = dupEn.exec(text)) !== null) {
    issues.push({ kind: "duplicate", index: m.index, found: m[0], fix: m[1], message: "\u91CD\u590D\u8BCD" });
  }
  const dupCjk = /([\u4e00-\u9fff]{2,4})\1/g;
  while ((m = dupCjk.exec(text)) !== null) {
    issues.push({ kind: "duplicate", index: m.index, found: m[0], fix: m[1], message: "\u91CD\u590D\u8BCD" });
  }
  for (let i = 1; i < text.length; i += 1) {
    const prev = text[i - 1];
    const cur = text[i];
    if (CJK.test(prev) && LATIN.test(cur) || LATIN.test(prev) && CJK.test(cur)) {
      issues.push({
        kind: "spacing",
        index: i - 1,
        found: prev + cur,
        fix: `${prev} ${cur}`,
        message: "\u4E2D\u82F1\u6587\u4E4B\u95F4\u5EFA\u8BAE\u52A0\u7A7A\u683C"
      });
    }
  }
  const halfPunct = /[,;:!?]/g;
  while ((m = halfPunct.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 6), m.index);
    if (CJK.test(before)) {
      const map = { ",": "\uFF0C", ";": "\uFF1B", ":": "\uFF1A", "!": "\uFF01", "?": "\uFF1F" };
      issues.push({
        kind: "fullwidth",
        index: m.index,
        found: m[0],
        fix: map[m[0]],
        message: "\u4E2D\u6587\u91CC\u7528\u4E86\u534A\u89D2\u6807\u70B9"
      });
    }
  }
  const spaceRe = / {2,}/g;
  while ((m = spaceRe.exec(text)) !== null) {
    issues.push({
      kind: "doubleSpace",
      index: m.index,
      found: `${m[0].length} \u4E2A\u7A7A\u683C`,
      fix: " ",
      message: "\u591A\u4F59\u7684\u7A7A\u683C"
    });
  }
  const periodRe = /[\u4e00-\u9fff]\.(?=\s|$|[A-Za-z])/g;
  while ((m = periodRe.exec(text)) !== null) {
    issues.push({
      kind: "period",
      index: m.index + 1,
      found: "\u3002",
      fix: "\u3002",
      message: "\u4E2D\u6587\u53E5\u672B\u5EFA\u8BAE\u7528\u300C\u3002\u300D"
    });
  }
  const wordRe = /\b[A-Za-z]+\b/g;
  while ((m = wordRe.exec(text)) !== null) {
    const lower = m[0].toLowerCase();
    const right = TYPOS[lower];
    if (!right) continue;
    const fixed = m[0][0] === m[0][0].toUpperCase() ? right[0].toUpperCase() + right.slice(1) : right;
    issues.push({
      kind: "typo",
      index: m.index,
      found: m[0],
      fix: fixed,
      message: "\u5E38\u89C1\u9519\u62FC"
    });
  }
  return issues.sort((a, b) => a.index - b.index);
}
function applyFixes(content, issues) {
  let out = content;
  const sorted = issues.slice().sort((a, b) => b.index - a.index);
  for (const it of sorted) {
    const len = it.kind === "doubleSpace" ? Number.parseInt(it.found, 10) || 2 : it.found.length;
    out = out.slice(0, it.index) + it.fix + out.slice(it.index + len);
  }
  return out;
}
var ISSUE_LABEL = {
  duplicate: "\u91CD\u590D",
  spacing: "\u7A7A\u683C",
  fullwidth: "\u6807\u70B9",
  doubleSpace: "\u7A7A\u683C",
  period: "\u6807\u70B9",
  typo: "\u62FC\u5199"
};

// src/core/pdf.ts
function ascii(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return s;
}
function buildPdf(pages) {
  if (pages.length === 0) throw new Error("\u6CA1\u6709\u9875\u9762\u53EF\u5BFC\u51FA");
  const chunks = [];
  let length = 0;
  const push = (data) => {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const pageObjIds = [];
  const offsets = [];
  const total = pages.length;
  let next = 3;
  const layout = pages.map((p) => {
    const pageId = next;
    const contentId = next + 1;
    const imageId = next + 2;
    next += 3;
    pageObjIds.push(pageId);
    return { pageId, contentId, imageId, page: p };
  });
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const writeObj = (id, body, stream) => {
    offsets[id] = length;
    push(`${id} 0 obj
${body}
`);
    if (stream) {
      push(`<< ${stream.dict} /Length ${stream.data.length} >>
stream
`);
      push(stream.data);
      push("\nendstream\n");
    }
    push("endobj\n");
  };
  writeObj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  writeObj(
    2,
    `<< /Type /Pages /Count ${total} /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] >>`
  );
  for (const item of layout) {
    const dpi = item.page.dpi && item.page.dpi > 1 ? item.page.dpi : 72;
    const wPt = item.page.width / dpi * 72;
    const hPt = item.page.height / dpi * 72;
    writeObj(
      item.pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt.toFixed(2)} ${hPt.toFixed(2)}] /Resources << /XObject << /Im0 ${item.imageId} 0 R >> >> /Contents ${item.contentId} 0 R >>`
    );
    const content = `q
${wPt.toFixed(2)} 0 0 ${hPt.toFixed(2)} 0 0 cm
/Im0 Do
Q
`;
    writeObj(
      item.contentId,
      "",
      { data: new TextEncoder().encode(content), dict: "" }
    );
    writeObj(
      item.imageId,
      "",
      {
        data: item.page.jpeg,
        dict: `/Type /XObject /Subtype /Image /Width ${item.page.width} /Height ${item.page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`
      }
    );
  }
  const xrefStart = length;
  const maxId = next;
  let xref = `xref
0 ${maxId}
0000000000 65535 f 
`;
  for (let i = 1; i < maxId; i += 1) {
    const off = offsets[i] ?? 0;
    xref += `${String(off).padStart(10, "0")} 00000 n 
`;
  }
  push(xref);
  push(`trailer
<< /Size ${maxId} /Root 1 0 R >>
startxref
${xrefStart}
%%EOF
`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
function pdfHead(bytes) {
  return ascii(bytes.slice(0, 8));
}
function countPdfPages(bytes) {
  const text = ascii(bytes);
  return (text.match(/\/Type \/Page[^s]/g) ?? []).length;
}
export {
  CUBE_SIZE,
  FILTER_DEFS,
  ISSUE_LABEL,
  PROFILE_LABELS,
  applyFixes,
  applyPalette,
  buildPdf,
  checkText,
  colorRangeHit,
  contentAwareScale,
  convertProfile,
  countPdfPages,
  energyMap,
  estimateShift,
  filterDef,
  filterParams,
  findHorizontalSeam,
  findPhotoRegions,
  findVerticalSeam,
  focusHit,
  growHit,
  identityCube,
  identityLut,
  insertHorizontalSeam,
  insertVerticalSeam,
  lutToCube,
  medianCutPalette,
  mlsWarp,
  pdfHead,
  quantizeTo8,
  removeHorizontalSeam,
  removeVerticalSeam,
  sharpnessWeights,
  skyHit,
  splitChannels,
  subjectHit,
  toBitmap,
  toCmyk,
  toDuotone,
  toIndexed,
  toLab
};
