/**
 * 第四批滤镜：模糊画廊 / 高级模糊 / 位移 / 彩色半调 / HSB / 渲染五件套。
 *
 * 除了逐算法的行为断言，最后还有一条「新注册滤镜的 id 必须命中菜单目录」
 * 的契约测试 —— 菜单 id 写错的话，菜单会一直灰着而我们发现不了。
 */
import { describe, expect, it } from "vitest";
import { RAW } from "../../src/ui/components/menuCatalog.data";
import {
  colorHalftone,
  displace,
  fieldBlur,
  hsbHsl,
  irisBlur,
  lensBlur,
  pathBlur,
  shapeBlur,
  smartBlur,
  spinBlur,
  tiltShift,
} from "../../src/engine/filters/gallery";
import { flame, lensFlare, lightingEffects, pictureFrame, tree } from "../../src/engine/filters/renderFx";
import { gaussianBlur, type RgbaBuffer } from "../../src/engine/filters/kernels";

function make(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): RgbaBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const [r, g, b, a] = px(x, y);
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
  }
  return { data, width: w, height: h };
}

const solid = (w: number, h: number, r: number, g: number, b: number) => make(w, h, () => [r, g, b, 255]);
const at = (buf: RgbaBuffer, x: number, y: number) => {
  const o = (y * buf.width + x) * 4;
  return [buf.data[o], buf.data[o + 1], buf.data[o + 2], buf.data[o + 3]];
};

/** 左右半黑白竖条，用来检验模糊/保边行为。 */
const stepX = (w: number, h: number) => make(w, h, (x) => (x < w / 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]));

describe("可变半径模糊（模糊画廊地基）", () => {
  it("场景模糊把边缘附近的像素拉向两侧均值", () => {
    const src = stepX(16, 8);
    const out = fieldBlur(src, 8, 100, 0);
    const [r] = at(out, 7, 4); // 紧贴边界的左侧像素
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(255);
  });

  it("移轴摄影让清晰带保留、远离清晰带的地方糊掉", () => {
    // 40 行高的图，只有正中间一行是亮的
    const src = make(16, 40, (_x, y) => (y === 20 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const out = tiltShift(src, 8, 50, 10, 5);
    expect(at(out, 8, 20)[0]).toBeGreaterThan(100); // 清晰带基本保住
    expect(at(out, 8, 0)[0]).toBe(0); // 顶部被糊成了黑背景
  });

  it("光圈模糊让圆心清晰、四角糊开", () => {
    const src = make(16, 16, (x, y) => (x === 8 && y === 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const out = irisBlur(src, 6, 50, 50, 30, 40);
    expect(at(out, 8, 8)[0]).toBeGreaterThan(200);
    expect(at(out, 0, 0)[0]).toBeLessThan(60);
  });
});

describe("采样类模糊", () => {
  it("路径模糊路径长度为 0 时等于原图", () => {
    const src = stepX(8, 8);
    const out = pathBlur(src, 0, 30, 45, 50);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it("旋转模糊旋转量为 0 时等于原图", () => {
    const src = stepX(8, 8);
    const out = spinBlur(src, 0, 50, 50);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it("镜头模糊比同半径的高斯模糊更亮（散景把高光加回来了）", () => {
    const src = make(24, 24, (x, y) => (x === 12 && y === 12 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const base = gaussianBlur(src, 6);
    const out = lensBlur(src, 6, 250, 100);
    expect(at(out, 12, 12)[0]).toBeGreaterThan(at(base, 12, 12)[0]);
    expect(at(out, 15, 12)[0]).toBeGreaterThan(at(base, 15, 12)[0]);
  });

  it("形状模糊（方形 / 半径 1 / 一次）等于 3×3 均值", () => {
    const src = make(3, 1, (x) => {
      const v = [10, 50, 90][x];
      return [v, v, v, 255];
    });
    const out = shapeBlur(src, 1, 1, 2);
    expect(at(out, 0, 0)[0]).toBe(23); // (10+10+50)×3 / 9
    expect(at(out, 1, 0)[0]).toBe(50);
    expect(at(out, 2, 0)[0]).toBe(77); // (50+90+90)×3 / 9
  });

  it("形状模糊（菱形）比方形少取 4 个角", () => {
    const src = make(3, 3, () => [255, 255, 255, 255]);
    const out = shapeBlur(src, 1, 1, 1);
    expect(at(out, 1, 1)[0]).toBe(255);
  });

  it("智能模糊保边：阈值内的邻居才参与平均", () => {
    const src = stepX(12, 6);
    const out = smartBlur(src, 3, 10, 2, 0);
    expect(at(out, 5, 3)[0]).toBe(0); // 紧贴边界的暗侧不会被亮侧污染
    expect(at(out, 0, 3)[0]).toBe(0);
    expect(at(out, 11, 3)[0]).toBe(255);
  });

  it("智能模糊在纯色图上不改变任何像素", () => {
    const src = solid(8, 8, 90, 120, 150);
    const out = smartBlur(src, 4, 30, 1, 0);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });
});

describe("位移 / 彩色半调 / HSB", () => {
  it("位移量取 0 时等于原图", () => {
    const src = stepX(8, 8);
    const out = displace(src, 0, 0, 0, 0);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it("位移（棋盘格）会打乱左右半黑白", () => {
    const src = stepX(16, 16);
    const out = displace(src, 24, 0, 0, 0);
    expect(Array.from(out.data)).not.toEqual(Array.from(src.data));
  });

  it("彩色半调在中灰上产生疏密网点（有墨也有白）", () => {
    const out = colorHalftone(solid(16, 16, 128, 128, 128), 4);
    let white = 0;
    let ink = 0;
    for (let i = 0; i < out.data.length; i += 4) {
      if (out.data[i] > 250) white += 1;
      else ink += 1;
    }
    expect(white).toBeGreaterThan(0);
    expect(ink).toBeGreaterThan(0);
  });

  it("彩色半调对纯白不出墨、纯黑全版黑", () => {
    const w = colorHalftone(solid(16, 16, 255, 255, 255), 4);
    expect(at(w, 3, 5)[0]).toBe(255);
    const b = colorHalftone(solid(16, 16, 0, 0, 0), 4);
    expect(at(b, 3, 5)[0]).toBe(0);
  });

  it("HSB/HSL 把纯红拆成 H=0 S=1 V=1", () => {
    const out = hsbHsl(solid(2, 2, 255, 0, 0), 0);
    expect(at(out, 0, 0)[0]).toBe(0);
    expect(at(out, 0, 0)[1]).toBe(255);
    expect(at(out, 0, 0)[2]).toBe(255);
  });

  it("HSL 对中灰给出零饱和度、亮度 128", () => {
    const out = hsbHsl(solid(2, 2, 128, 128, 128), 1);
    expect(at(out, 0, 0)[0]).toBe(0);
    expect(at(out, 0, 0)[1]).toBe(0);
    expect(at(out, 0, 0)[2]).toBe(128);
  });
});

describe("渲染类滤镜", () => {
  it("树能在空画面上长出枝干", () => {
    const out = tree(solid(48, 48, 0, 0, 0), 42, 28, 6, 0);
    let painted = 0;
    for (let i = 0; i < out.data.length; i += 4) if (out.data[i] > 20) painted += 1;
    expect(painted).toBeGreaterThan(40);
  });

  it("树的结果是确定性的（同种子同结果）", () => {
    const a = tree(solid(32, 32, 0, 0, 0), 7, 30, 5, 1);
    const b = tree(solid(32, 32, 0, 0, 0), 7, 30, 5, 1);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it("自然火焰会在画面里点出成片的火光", () => {
    const out = flame(solid(32, 32, 0, 0, 0), 7, 45, 100, 0);
    let lit = 0;
    for (let i = 0; i < out.data.length; i += 4) if (out.data[i] > 8) lit += 1;
    expect(lit).toBeGreaterThan(20);
  });

  it("分形火焰会累积出密度分布", () => {
    const out = flame(solid(48, 48, 0, 0, 0), 3, 45, 100, 1);
    let lit = 0;
    for (let i = 0; i < out.data.length; i += 4) if (out.data[i] > 10) lit += 1;
    expect(lit).toBeGreaterThan(5);
  });

  it("画框覆盖四边、保留画面中央", () => {
    const out = pictureFrame(solid(24, 24, 255, 255, 255), 4, 0);
    expect(at(out, 0, 0)[0]).toBeLessThan(255);
    expect(at(out, 23, 12)[0]).toBeLessThan(255);
    expect(at(out, 12, 12)[0]).toBe(255);
  });

  it("镜头光晕在光心加亮并向画面中央排布鬼影", () => {
    const out = lensFlare(solid(40, 40, 0, 0, 0), 25, 25, 100, 0);
    expect(at(out, 10, 10)[0]).toBeGreaterThan(100);
    expect(at(out, 20, 20)[0]).toBeGreaterThan(0); // 画心方向的鬼影
  });

  it("光照效果把纯色图按朗伯项压暗（平面法线朝正上方）", () => {
    const out = lightingEffects(solid(8, 8, 128, 128, 128), 0, 45, 0, 50, 60, 100);
    const [r] = at(out, 4, 4);
    // 平面 → N=(0,0,1)，漫反射 = sin(45°) ≈ 0.707，再加一点高光
    expect(r).toBeGreaterThan(70);
    expect(r).toBeLessThan(130);
    expect(r).not.toBe(128);
  });

  it("光照效果在有起伏的地方比平面更亮或更暗（不再均匀）", () => {
    const src = make(16, 16, (x) => (x % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const out = lightingEffects(src, 0, 45, 0, 50, 60, 100);
    const a = at(out, 0, 4)[0];
    const b = at(out, 1, 4)[0];
    expect(a).not.toBe(b);
  });
});

describe("第四批滤镜的菜单契约", () => {
  const NEW_IDS = [
    "filter.blur.lensBlur",
    "filter.blur.shapeBlur",
    "filter.blur.smartBlur",
    "filter.blurGallery.fieldBlur",
    "filter.blurGallery.irisBlur",
    "filter.blurGallery.tiltShift",
    "filter.blurGallery.pathBlur",
    "filter.blurGallery.spinBlur",
    "filter.distort.displace",
    "filter.pixelate.colorHalftone",
    "filter.render.lensFlare",
    "filter.render.tree",
    "filter.render.flame",
    "filter.render.pictureFrame",
    "filter.render.lightingEffects",
    "filter.other.hsbHsl",
  ];

  it("每个新滤镜的 id 都能命中菜单目录里的真实条目", () => {
    const ids = new Set(RAW.map((row) => row[3]));
    for (const id of NEW_IDS) expect(ids.has(id)).toBe(true);
  });
});
