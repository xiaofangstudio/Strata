/**
 * 校样每帧性能：缓存层 + 重算节流（纯函数测试，不碰 Tauri / 浏览器 API）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROOF,
  PROOF_RECOMPUTE_INTERVAL_MS,
  applyProofCached,
  gamutWarningCached,
  invalidateProofCache,
  shouldRecomputeProof,
} from "../../src/core/proof";
import type { ProofSettings } from "../../src/core/proof";
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

beforeEach(() => {
  invalidateProofCache();
});

describe("applyProofCached", () => {
  it("同 key 同参第二次命中缓存，返回同一引用", () => {
    const src = make([[255, 0, 0]]);
    const s: ProofSettings = { ...DEFAULT_PROOF, kind: "workingCmyk", inkLimit: 200, ucr: 0 };
    const first = applyProofCached(src, "doc1:rev1:1x1", s);
    const second = applyProofCached(src, "doc1:rev1:1x1", s);
    expect(second).toBe(first);
  });

  it("不同 key 各自计算，互不串缓存", () => {
    const src = make([[255, 0, 0]]);
    const s: ProofSettings = { ...DEFAULT_PROOF, kind: "workingCmyk" };
    const a = applyProofCached(src, "doc1:rev1", s);
    const b = applyProofCached(src, "doc2:rev1", s);
    expect(b).not.toBe(a);
    expect(at(b)).toEqual(at(a));
  });

  it("proofSet 变化（同 key）后缓存失效重算", () => {
    const src = make([[255, 0, 0]]);
    const none: ProofSettings = { ...DEFAULT_PROOF, kind: "none" };
    const cmyk: ProofSettings = { ...DEFAULT_PROOF, kind: "workingCmyk", inkLimit: 120, ucr: 0 };
    const before = applyProofCached(src, "doc1:rev1", none);
    expect(before).toBe(src);
    const after = applyProofCached(src, "doc1:rev1", cmyk);
    expect(after).not.toBe(src);
    // 工作 CMYK 掉饱和：红像素的绿/蓝通道被抬起来
    expect(at(after)[1]).toBeGreaterThan(0);
  });

  it("tone 变化（同 key）后缓存失效重算", () => {
    const src = make([[80, 80, 80]]);
    const s: ProofSettings = { ...DEFAULT_PROOF, kind: "none" };
    const plain = applyProofCached(src, "doc1:rev1", s);
    const boosted = applyProofCached(src, "doc1:rev1", s, { exposure: 1 });
    expect(boosted).not.toBe(plain);
    expect(at(boosted)[0]).toBeGreaterThan(at(plain)[0]);
  });

  it("LRU 上限 3 条：最旧的被淘汰，重算出新引用", () => {
    const src = make([[255, 0, 0]]);
    const s: ProofSettings = { ...DEFAULT_PROOF, kind: "workingCmyk" };
    const a = applyProofCached(src, "k1", s);
    const b = applyProofCached(src, "k2", s);
    const c = applyProofCached(src, "k3", s);
    // 第 4 条把 k1 挤出去
    applyProofCached(src, "k4", s);
    expect(applyProofCached(src, "k2", s)).toBe(b);
    expect(applyProofCached(src, "k3", s)).toBe(c);
    // k1 已被淘汰 → 重算，引用必然不同
    expect(applyProofCached(src, "k1", s)).not.toBe(a);
  });

  it("invalidateProofCache 清空后重算", () => {
    const src = make([[255, 0, 0]]);
    const s: ProofSettings = { ...DEFAULT_PROOF, kind: "workingCmyk" };
    const first = applyProofCached(src, "doc1:rev1", s);
    invalidateProofCache();
    expect(applyProofCached(src, "doc1:rev1", s)).not.toBe(first);
  });
});

describe("gamutWarningCached", () => {
  it("命中缓存返回同一 buf 引用与一致 coverage", () => {
    const src = make([[0, 255, 0]]);
    const s: ProofSettings = { ...DEFAULT_PROOF, warningThreshold: 4 };
    const first = gamutWarningCached(src, "doc1:rev1", s);
    const second = gamutWarningCached(src, "doc1:rev1", s);
    expect(second.buf).toBe(first.buf);
    expect(second.coverage).toBe(first.coverage);
    expect(first.coverage).toBeGreaterThan(0);
  });

  it("proofSet 变化（同 key）后缓存失效重算", () => {
    const src = make([[0, 255, 0]]);
    const pink: ProofSettings = { ...DEFAULT_PROOF, warningColor: [255, 0, 144], warningThreshold: 4 };
    const blue: ProofSettings = { ...DEFAULT_PROOF, warningColor: [0, 0, 255], warningThreshold: 4 };
    const first = gamutWarningCached(src, "doc1:rev1", pink);
    expect(at(first.buf)).toEqual([255, 0, 144]);
    const second = gamutWarningCached(src, "doc1:rev1", blue);
    expect(second.buf).not.toBe(first.buf);
    expect(at(second.buf)).toEqual([0, 0, 255]);
  });

  it("传入 ICC 掩码时绕过缓存，掩码刷新即时生效", () => {
    const src = make([[0, 255, 0]]);
    const s: ProofSettings = { ...DEFAULT_PROOF, warningThreshold: 4 };
    const hit = gamutWarningCached(src, "doc1:rev1", s, { outOfGamutMask: new Uint8Array([255]) });
    expect(at(hit.buf)).toEqual([255, 0, 144]);
    // 掩码异步刷新为「不超域」：不缓存 ICC 路径，结果立即跟随新掩码
    const miss = gamutWarningCached(src, "doc1:rev1", s, { outOfGamutMask: new Uint8Array([0]) });
    expect(at(miss.buf)).toEqual([0, 255, 0]);
    expect(miss.coverage).toBe(0);
  });
});

describe("shouldRecomputeProof", () => {
  it("从未算过（lastSignature 为空）→ 立即重算，不等间隔", () => {
    expect(shouldRecomputeProof({ lastRunAt: 0, lastSignature: "" }, 0, "sig-a")).toBe(true);
  });

  it("间隔未到：签名变了也节流不重算", () => {
    const state = { lastRunAt: 1000, lastSignature: "sig-a" };
    expect(shouldRecomputeProof(state, 1030, "sig-b")).toBe(false);
  });

  it("间隔到了且签名变了 → 重算（含恰好到达边界的情形）", () => {
    const state = { lastRunAt: 1000, lastSignature: "sig-a" };
    expect(shouldRecomputeProof(state, 1120, "sig-b")).toBe(true);
    expect(shouldRecomputeProof(state, 1500, "sig-b")).toBe(true);
  });

  it("间隔到了但签名没变 → 不重算（同一视口的重绘不值得算）", () => {
    const state = { lastRunAt: 1000, lastSignature: "sig-a" };
    expect(shouldRecomputeProof(state, 5000, "sig-a")).toBe(false);
  });

  it("自定义间隔生效", () => {
    const state = { lastRunAt: 1000, lastSignature: "sig-a" };
    expect(shouldRecomputeProof(state, 1200, "sig-b", 500)).toBe(false);
    expect(shouldRecomputeProof(state, 1500, "sig-b", 500)).toBe(true);
  });

  it("推荐间隔是 120ms", () => {
    expect(PROOF_RECOMPUTE_INTERVAL_MS).toBe(120);
  });
});
