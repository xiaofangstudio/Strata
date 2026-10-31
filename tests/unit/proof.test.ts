/**
 * 校样变换（视图 > 校样设置 / 校样颜色 / 色域警告 / 32 位预览）。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROOF,
  applyProof,
  gamutWarning,
  legacyMacGamma,
  plateView,
  previewTone,
} from "../../src/core/proof";
import type { RgbaBuffer } from "../../src/engine/filters/kernels";

function make(px: [number, number, number][]): RgbaBuffer {
  const data = new Uint8ClampedArray(px.length * 4);
  px.forEach((c, i) => {
    data[i * 4] = c[0];
    data[i * 4 + 1] = c[1];
    data[i * 4 + 2] = c[2];
    data[i * 4 + 3] = 255;
  });
  return { data, width: px.length, height: 1 };
}

const at = (b: RgbaBuffer, i = 0) => [b.data[i * 4], b.data[i * 4 + 1], b.data[i * 4 + 2]];

describe("分色版", () => {
  it("黑色版：纯黑最深、白色最浅", () => {
    const src = make([
      [0, 0, 0],
      [255, 255, 255],
    ]);
    const out = plateView(src, 3);
    expect(at(out, 0)[0]).toBe(0);
    expect(at(out, 1)[0]).toBe(255);
  });

  it("青色版：纯青（0,255,255）应该是最深的", () => {
    const src = make([
      [0, 255, 255],
      [255, 0, 0],
    ]);
    const out = plateView(src, 0);
    expect(at(out, 0)[0]).toBe(0);
    expect(at(out, 1)[0]).toBe(255);
  });

  it("三色版都是灰度（三通道相同）", () => {
    const src = make([[12, 200, 90]]);
    for (const ink of [0, 1, 2, 3, -1] as const) {
      const c = at(plateView(src, ink));
      expect(c[0]).toBe(c[1]);
      expect(c[1]).toBe(c[2]);
    }
  });
});

describe("色域警告", () => {
  it("中性灰在 CMYK 里能还原，不该被标出", () => {
    const src = make([[128, 128, 128]]);
    const { coverage } = gamutWarning(src, { ...DEFAULT_PROOF, ucr: 0, inkLimit: 400 });
    expect(coverage).toBe(0);
  });

  it("高饱和色超出印刷色域时会被涂成警示色", () => {
    const src = make([[0, 255, 0]]);
    const { buf, coverage } = gamutWarning(src, {
      ...DEFAULT_PROOF,
      warningColor: [255, 0, 144],
      warningThreshold: 4,
    });
    expect(coverage).toBeGreaterThan(0);
    expect(at(buf)).toEqual([255, 0, 144]);
  });
});

describe("显示补偿（32 位预览）", () => {
  it("曝光 +1 档让中间调变亮", () => {
    const src = make([[64, 64, 64]]);
    const out = previewTone(src, 1, 1);
    expect(at(out)[0]).toBeGreaterThan(64);
  });

  it("伽马 > 1 也提亮暗部，伽马 < 1 压暗", () => {
    const src = make([[100, 100, 100]]);
    expect(at(previewTone(src, 0, 1.5))[0]).toBeGreaterThan(100);
    expect(at(previewTone(src, 0, 0.8))[0]).toBeLessThan(100);
  });

  it("零曝光 + 伽马 1 是恒等", () => {
    const src = make([[37, 180, 244]]);
    expect(at(previewTone(src, 0, 1))).toEqual([37, 180, 244]);
  });
});

describe("旧版 Macintosh RGB", () => {
  it("整体变亮（伽马 2.2 → 1.8）", () => {
    const src = make([[128, 128, 128]]);
    const out = legacyMacGamma(src);
    expect(at(out)[0]).toBeGreaterThan(128);
  });

  it("黑白两端不动", () => {
    const src = make([
      [0, 0, 0],
      [255, 255, 255],
    ]);
    const out = legacyMacGamma(src);
    expect(at(out, 0)[0]).toBe(0);
    expect(at(out, 1)[0]).toBe(255);
  });
});

describe("applyProof 总入口", () => {
  it("kind=none 原样返回", () => {
    const src = make([[10, 20, 30]]);
    expect(at(applyProof(src, { ...DEFAULT_PROOF, kind: "none" }))).toEqual([10, 20, 30]);
  });

  it("监视器 RGB / Internet 标准 RGB 在 sRGB 管线上不改变像素（如实不装样子）", () => {
    const src = make([[10, 200, 130]]);
    expect(at(applyProof(src, { ...DEFAULT_PROOF, kind: "monitorRgb" }))).toEqual([10, 200, 130]);
    expect(at(applyProof(src, { ...DEFAULT_PROOF, kind: "internetStandardRgb" }))).toEqual([
      10, 200, 130,
    ]);
  });

  it("工作 CMYK 会改变饱和色（印刷后掉饱和）", () => {
    const src = make([[255, 0, 0]]);
    // 纯红本身用 200% 墨（品红+黄），墨量放到 200 刚好不压缩；收紧到 120 才会掉色
    const tight = applyProof(src, { ...DEFAULT_PROOF, kind: "workingCmyk", inkLimit: 120, ucr: 0 });
    // 红版本身没墨（R 仍是 255），掉的是绿/蓝：印刷红会变得偏「砖红」
    expect(at(tight)[1]).toBeGreaterThan(0);
    expect(at(tight)[2]).toBeGreaterThan(0);
  });

  it("可以叠加 32 位显示补偿", () => {
    const src = make([[80, 80, 80]]);
    const plain = applyProof(src, { ...DEFAULT_PROOF, kind: "none" });
    const boosted = applyProof(src, { ...DEFAULT_PROOF, kind: "none" }, { exposure: 1 });
    expect(at(boosted)[0]).toBeGreaterThan(at(plain)[0]);
  });

  it("自定义空间走色彩配置文件换算", () => {
    const src = make([[255, 0, 0]]);
    const out = applyProof(src, { ...DEFAULT_PROOF, kind: "custom", customSpace: "display-p3" });
    expect(at(out)[0]).toBeLessThan(255);
  });
});
