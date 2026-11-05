/**
 * CMS 色彩管理重修的纯函数测试。
 *
 * 约定：不碰真实浏览器 API / Tauri invoke。`@tauri-apps/api/core` 的 invoke
 * 全部用 vi.mock 顶掉，真 ICC 命令的失败 / 成功都在测试里模拟；矩阵换算、
 * 掩码边界、ICC 描述解析都走纯算法，node 环境可直接断言。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// 提升的 mock：让 cms.ts 里所有 invoke 都指向同一个可控的 vi.fn()。
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { convertProfile } from "../../src/core/colorProfile";
import { type RgbaBuffer } from "../../src/engine/filters/kernels";
import {
  DEFAULT_PROOF,
  applyProof,
  gamutWarning,
  type IccProofContext,
} from "../../src/core/proof";
import {
  iccSoftProofBestEffort,
  parseIccDescription,
  profileIdFromIcc,
  profileIdFromIccStructured,
} from "../../src/engine/cms";

/* -------------------------------------------------------------- 测试辅助 */

/** 由一组 RGBA 像素造一张 1 行缓冲（width = 像素数）。 */
function makePx(px: [number, number, number, number?][]): RgbaBuffer {
  const data = new Uint8ClampedArray(px.length * 4);
  px.forEach((c, i) => {
    data[i * 4] = c[0];
    data[i * 4 + 1] = c[1];
    data[i * 4 + 2] = c[2];
    data[i * 4 + 3] = c[3] ?? 255;
  });
  return { data, width: px.length, height: 1 };
}

const at = (b: RgbaBuffer, i = 0): number[] => [
  b.data[i * 4],
  b.data[i * 4 + 1],
  b.data[i * 4 + 2],
  b.data[i * 4 + 3],
];

function be32(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 24) & 255;
  b[o + 1] = (v >>> 16) & 255;
  b[o + 2] = (v >>> 8) & 255;
  b[o + 3] = v & 255;
}

function utf16be(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    out[i * 2] = (c >> 8) & 255;
    out[i * 2 + 1] = c & 255;
  }
  return out;
}

/** 构造最小合法 ICC：128B header + 1 条 desc(mluc, v4) tag。 */
function iccWithMlucDesc(text: string): Uint8Array {
  const enc = utf16be(text);
  const tagDataOff = 144; // 128 header + 4 tagCount + 12 tag record
  const strOffset = 28; // mluc 头 16 + record 12，相对 tag 起点
  const b = new Uint8Array(tagDataOff + strOffset + enc.length);
  be32(b, 128, 1); // tag count
  b.set([0x64, 0x65, 0x73, 0x63], 132); // tag sig 'desc'
  be32(b, 136, tagDataOff);
  be32(b, 140, strOffset + enc.length);
  b.set([0x6d, 0x6c, 0x75, 0x63], tagDataOff); // type 'mluc'
  be32(b, tagDataOff + 8, 1); // record count
  be32(b, tagDataOff + 12, 12); // record size
  b[tagDataOff + 16] = 0x65; // 'e'
  b[tagDataOff + 17] = 0x6e; // 'n'
  b[tagDataOff + 18] = 0x55; // 'U'
  b[tagDataOff + 19] = 0x53; // 'S'
  be32(b, tagDataOff + 20, enc.length); // string length (bytes)
  be32(b, tagDataOff + 24, strOffset); // string offset
  b.set(enc, tagDataOff + strOffset);
  return b;
}

/** 构造最小合法 ICC：128B header + 1 条 desc(desc, v2) tag。 */
function iccWithDesc(text: string): Uint8Array {
  const tagDataOff = 144;
  const count = text.length + 1; // ASCII 字节数，含结尾 null
  const b = new Uint8Array(tagDataOff + 12 + count);
  be32(b, 128, 1);
  b.set([0x64, 0x65, 0x73, 0x63], 132);
  be32(b, 136, tagDataOff);
  be32(b, 140, 12 + count);
  b.set([0x64, 0x65, 0x73, 0x63], tagDataOff); // type 'desc'
  be32(b, tagDataOff + 8, count);
  for (let i = 0; i < text.length; i += 1) b[tagDataOff + 12 + i] = text.charCodeAt(i);
  return b;
}

/** 常见的一组中间调像素（4 个），避免贴近色域边缘被 clamp 干扰往返断言。 */
function samplePixels(): Uint8ClampedArray {
  return new Uint8ClampedArray([
    200, 40, 40, 255,
    40, 160, 90, 255,
    30, 60, 200, 255,
    128, 128, 128, 255,
  ]);
}

beforeEach(() => {
  // 默认：所有 Tauri invoke 都失败 —— 用来驱动「明确回退」路径。
  invokeMock.mockReset();
  invokeMock.mockRejectedValue(new Error("Tauri 不可用（测试模拟）"));
});

/* ================================================================ 矩阵路径 */

describe("adobe-rgb ↔ srgb 矩阵往返（纯函数，不依赖 Tauri）", () => {
  it("srgb → adobe-rgb → srgb 往返误差在个位数以内", () => {
    const src = makePx([
      [200, 40, 40],
      [40, 160, 90],
      [30, 60, 200],
      [128, 128, 128],
    ]);
    const mid = convertProfile(src, "srgb", "adobe-rgb");
    const back = convertProfile(mid, "adobe-rgb", "srgb");
    for (let p = 0; p < src.width; p += 1) {
      for (let c = 0; c < 3; c += 1) {
        expect(Math.abs(back.data[p * 4 + c] - src.data[p * 4 + c])).toBeLessThanOrEqual(6);
      }
    }
  });

  it("白色在 srgb / adobe-rgb 之间往返仍是白色", () => {
    const src = makePx([[255, 255, 255]]);
    const back = convertProfile(convertProfile(src, "srgb", "adobe-rgb"), "adobe-rgb", "srgb");
    expect(at(back)[0]).toBeGreaterThanOrEqual(253);
    expect(at(back)[1]).toBeGreaterThanOrEqual(253);
    expect(at(back)[2]).toBeGreaterThanOrEqual(253);
  });

  it("srgb 纯红转 adobe-rgb 后红通道下降（证明是换算而非恒等）", () => {
    const src = makePx([[255, 0, 0]]);
    const out = convertProfile(src, "srgb", "adobe-rgb");
    expect(at(out)[0]).toBeLessThan(255);
    expect(at(out)[0]).toBeGreaterThan(180);
  });
});

/* ==================================================== proof.ts 可选 ICC 参数 */

describe("gamutWarning 可选 ICC 掩码 / 边界", () => {
  it("不传 icc 参数时行为不变（中性灰不被标出，向后兼容）", () => {
    const src = makePx([[128, 128, 128]]);
    const { coverage } = gamutWarning(src, { ...DEFAULT_PROOF, ucr: 0, inkLimit: 400 });
    expect(coverage).toBe(0);
  });

  it("传 outOfGamutMask 时按掩码刷警示色并统计 coverage", () => {
    const src = makePx([
      [10, 20, 30],
      [40, 50, 60],
      [70, 80, 90],
      [100, 110, 120],
    ]);
    const mask = new Uint8Array([255, 0, 255, 0]);
    const { buf, coverage } = gamutWarning(
      src,
      { ...DEFAULT_PROOF, warningColor: [1, 2, 3] },
      { outOfGamutMask: mask },
    );
    expect(coverage).toBe(0.5);
    expect(at(buf, 0)).toEqual([1, 2, 3, 255]);
    expect(at(buf, 1)).toEqual([40, 50, 60, 255]);
    expect(at(buf, 2)).toEqual([1, 2, 3, 255]);
    expect(at(buf, 3)).toEqual([100, 110, 120, 255]);
  });

  it("掩码全 0 → coverage 0；掩码全 255 → coverage 1", () => {
    const src = makePx([[200, 30, 30], [10, 200, 20]]);
    const none = gamutWarning(src, DEFAULT_PROOF, { outOfGamutMask: new Uint8Array(2) });
    expect(none.coverage).toBe(0);
    expect(at(none.buf, 0)).toEqual([200, 30, 30, 255]);
    const all = gamutWarning(src, DEFAULT_PROOF, { outOfGamutMask: new Uint8Array([255, 255]) });
    expect(all.coverage).toBe(1);
    expect(at(all.buf, 1)).toEqual([255, 0, 144, 255]);
  });

  it("掩码长度不符时回退到原 CMYK 往返路径（高饱和色仍被标出）", () => {
    const src = makePx([[0, 255, 0]]);
    const { coverage } = gamutWarning(
      src,
      { ...DEFAULT_PROOF, warningThreshold: 4 },
      { outOfGamutMask: new Uint8Array(3) }, // 长度 3 != 像素数 1
    );
    expect(coverage).toBeGreaterThan(0);
  });
});

describe("applyProof 可选 ICC transform", () => {
  const custom = { ...DEFAULT_PROOF, kind: "custom" as const, customSpace: "display-p3" as const };

  it("不传 icc 时 custom 走矩阵换算（与旧行为一致）", () => {
    const src = makePx([[255, 0, 0]]);
    const out = applyProof(src, custom);
    expect(at(out)[0]).toBeLessThan(255);
  });

  it("传 transform 回调时 custom 分支使用真 ICC 校样像素", () => {
    const src = makePx([[255, 0, 0]]);
    const ctx: IccProofContext = {
      transform: () => new Uint8ClampedArray([7, 8, 9, 255]),
      intent: 1,
      bpc: true,
    };
    const out = applyProof(src, custom, undefined, ctx);
    expect(at(out)).toEqual([7, 8, 9, 255]);
  });

  it("transform 返回 null 时明确回退到矩阵近似", () => {
    const src = makePx([[255, 0, 0]]);
    const ctx: IccProofContext = { transform: () => null };
    const out = applyProof(src, custom, undefined, ctx);
    expect(at(out)).toEqual(at(applyProof(src, custom)));
  });
});

/* ============================================== profileIdFromIcc 真解析/兜底 */

describe("profileIdFromIcc：真解析优先、猜标签兜底", () => {
  it("按 ICC 规范解析 mluc desc（Adobe RGB）", () => {
    const bytes = iccWithMlucDesc("Adobe RGB (1998)");
    expect(parseIccDescription(bytes)).toBe("Adobe RGB (1998)");
    expect(profileIdFromIccStructured(bytes)).toBe("adobe-rgb");
    expect(profileIdFromIcc(bytes)).toBe("adobe-rgb");
  });

  it("按 ICC 规范解析 v2 desc tag（Display P3）", () => {
    const bytes = iccWithDesc("Display P3");
    expect(parseIccDescription(bytes)).toBe("Display P3");
    expect(profileIdFromIcc(bytes)).toBe("display-p3");
  });

  it("无 desc tag 时结构化解析返回 null，退回猜标签兜底", () => {
    const b = new Uint8Array(512);
    be32(b, 128, 0); // tag count = 0 → 真解析拿不到 desc
    const txt = "sRGB IEC61966-2.1";
    for (let i = 0; i < txt.length; i += 1) b[200 + i] = txt.charCodeAt(i);
    expect(profileIdFromIccStructured(b)).toBeNull();
    expect(profileIdFromIcc(b)).toBe("srgb");
  });

  it("完全无关的字节返回 null", () => {
    expect(profileIdFromIcc(new Uint8Array(256))).toBeNull();
  });
});

/* ============================================ iccSoftProofBestEffort 回退行为 */

describe("iccSoftProofBestEffort：mock invoke 失败后的明确回退", () => {
  it("invoke 失败 → usedIcc=false、带 fallbackReason、输出尺寸正确", async () => {
    const px = samplePixels();
    const r = await iccSoftProofBestEffort(px, 4, 1, "srgb", "display-p3");
    expect(r.usedIcc).toBe(false);
    expect(r.fallbackReason).toContain("真 ICC 校样不可用");
    expect(r.fallbackReason).toContain("已回退矩阵近似");
    expect(r.proofPixels.length).toBe(px.length);
    expect(r.outOfGamutMask.length).toBe(4);
  });

  it("回退后的 proofPixels 就是矩阵近似结果，而不是原图或恒等", async () => {
    const px = samplePixels();
    const r = await iccSoftProofBestEffort(px, 4, 1, "srgb", "display-p3");
    const expected = convertProfile(
      { data: new Uint8ClampedArray(px), width: 4, height: 1 },
      "srgb",
      "display-p3",
    ).data;
    expect(Array.from(r.proofPixels)).toEqual(Array.from(expected));
  });

  it("回退后的掩码是每像素 0 / 255 的 Uint8Array", async () => {
    const r = await iccSoftProofBestEffort(samplePixels(), 4, 1, "srgb", "display-p3");
    expect(r.outOfGamutMask).toBeInstanceOf(Uint8Array);
    for (const v of r.outOfGamutMask) expect(v === 0 || v === 255).toBe(true);
  });

  it("源与目标相同且无自定义字节时短路为恒等，明确标记回退", async () => {
    const px = samplePixels();
    const r = await iccSoftProofBestEffort(px, 4, 1, "srgb", "srgb");
    expect(r.usedIcc).toBe(false);
    expect(Array.from(r.proofPixels)).toEqual(Array.from(px));
    expect(Array.from(r.outOfGamutMask).every((v) => v === 0)).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("iccSoftProofBestEffort：mock invoke 成功时走真 ICC", () => {
  it("真 ICC 命令可用 → usedIcc=true，像素与掩码来自 ICC transform", async () => {
    invokeMock.mockImplementation((cmd: unknown, args?: unknown) => {
      const a = args as { pixels?: number[] } | undefined;
      if (cmd === "cms_builtin_profile") {
        return Promise.resolve(Array.from({ length: 128 }, (_, i) => i & 255));
      }
      if (cmd === "cms_transform") {
        return Promise.resolve(
          (a?.pixels ?? []).map((v, i) => (i % 4 === 3 ? v : Math.max(0, v - 10))),
        );
      }
      return Promise.resolve([]);
    });
    const px = samplePixels();
    // 注入源端真字节，避免依赖 builtinProfile(from)；dst 仍走 mock 的 builtinProfile。
    const r = await iccSoftProofBestEffort(px, 4, 1, "srgb", "adobe-rgb", 1, true, {
      srcIccBytes: new Uint8Array(128),
    });
    expect(r.usedIcc).toBe(true);
    expect(r.fallbackReason).toBeUndefined();
    expect(r.proofPixels[0]).toBe(190); // 200 - 10
    expect(r.outOfGamutMask[0]).toBe(255); // 往返误差 20/通道 > 阈值
  });
});
