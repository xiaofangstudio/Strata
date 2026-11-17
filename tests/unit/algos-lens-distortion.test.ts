/**
 * P2-C：Brown–Conrady 镜头畸变 / 通用镜头配置文件的回归测试。
 */
import { describe, expect, it } from "vitest";
import {
  applyLensProfile,
  brownConrady,
  genericProfile,
  vignetteFalloff,
} from "../../src/engine/algos/lensDistortion";
import { lensCorrection } from "../../src/engine/filters/lens";
import { makeBuffer } from "../../src/engine/filters/kernels";

function grid(w: number, h: number) {
  const img = makeBuffer(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = (y * w + x) * 4;
      const v = ((x * 17 + y * 31) % 200) + 28;
      img.data[p] = v;
      img.data[p + 1] = (v + 37) % 256;
      img.data[p + 2] = (v + 91) % 256;
      img.data[p + 3] = 255;
    }
  }
  return img;
}

describe("Brown–Conrady 模型", () => {
  it("零系数是恒等映射", () => {
    const [x, y] = brownConrady(0.4, -0.3, 0, 0, 0, 0);
    expect(x).toBeCloseTo(0.4, 12);
    expect(y).toBeCloseTo(-0.3, 12);
  });

  it("正 k1 把采样点往外推（修正桶形）", () => {
    const [x, y] = brownConrady(0.5, 0, 0.3, 0, 0, 0);
    expect(x).toBeGreaterThan(0.5);
    expect(y).toBeCloseTo(0, 12);
  });

  it("切向系数产生非对称位移", () => {
    const [x, y] = brownConrady(0.4, 0.3, 0, 0, 0.01, 0);
    expect(x).not.toBeCloseTo(0.4, 6);
    expect(y).not.toBeCloseTo(0.3, 6);
  });

  it("广角焦距的 k1 更负、晕影更强", () => {
    const wide = genericProfile(12);
    const normal = genericProfile(50);
    expect(wide.k1).toBeLessThan(normal.k1);
    expect(vignetteFalloff(wide, 0.9)).toBeLessThan(vignetteFalloff(normal, 0.9));
    expect(vignetteFalloff(normal, 0)).toBeCloseTo(1, 12);
  });
});

describe("镜头校正接线", () => {
  it("中性 profile 且关掉晕影消除时近似恒等", () => {
    const src = grid(32, 32);
    const profile = genericProfile(50);
    profile.vignette = [0, 0, 0];
    const out = applyLensProfile(src, profile, { undoProfileVignette: false });
    for (let i = 0; i < src.data.length; i += 4) {
      expect(Math.abs(out.data[i] - src.data[i])).toBeLessThanOrEqual(1);
    }
  });

  it("启用焦距配置文件后边角像素真的改变", () => {
    const src = grid(48, 48);
    const out = applyLensProfile(src, genericProfile(16));
    let changed = 0;
    for (let i = 0; i < src.data.length; i += 4) if (Math.abs(out.data[i] - src.data[i]) > 3) changed += 1;
    expect(changed).toBeGreaterThan(src.data.length / 4 / 10);
  });

  it("lensCorrection 不传 opts 时保持旧行为，传 focal 时走新模型", () => {
    const src = grid(48, 48);
    const legacy = lensCorrection(src, 0, 0, 0, 0, 0, 50);
    const neutral = lensCorrection(src, 0, 0, 0, 0, 0, 50, { focal: 0 });
    expect(Array.from(legacy.data)).toEqual(Array.from(neutral.data));

    const profile = lensCorrection(src, 0, 0, 0, 0, 0, 50, { focal: 16 });
    let diff = 0;
    for (let i = 0; i < src.data.length; i += 4) if (Math.abs(profile.data[i] - src.data[i]) > 3) diff += 1;
    expect(diff).toBeGreaterThan(10);
  });
});
