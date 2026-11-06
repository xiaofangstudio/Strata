/**
 * 滤镜真值核对 —— 「零假功能」铁律的落地测试。
 *
 * 对 FILTER_DEFS（src/engine/filters/defs.ts）注册的**每一个**滤镜逐一验证：
 *   1. 默认参数在标准测试图上真的出效果（输出 ≠ 输入）；
 *      默认态确实近似恒等时，用对该滤镜合理的复核参数再试一次，仍恒等才标假。
 *   2. 输出不是「全黑 / 全白 / 全透明」这类灾难性假输出。
 *   3. 参数敏感性：主要参数取最小 / 最大值各跑一次，两次输出必须可区分；
 *      min 语义为「关闭」（如 strength 0 = 不处理）时自动降级为「中间值 vs 最大值」；
 *      纯开关型（choices）用两态比较；无参数滤镜跳过并在报告注明。
 *
 * 测试只测纯函数内核（RgbaBuffer 纯字节数组），不碰任何浏览器 API。
 * 测试图为代码内生成：多色渐变（保证锐化/高反差在纯渐变区的合理恒等被噪声打破）
 * + 固定种子噪声（median / dust / facet 等需要邻域差异）+ 高饱和纯色块
 * （NTSC 色域等只在 max-min > 200 的像素上生效）。
 *
 * 白名单：语义上就该恒等 / 特殊的滤镜，附原因降级为弱断言，不掩盖真占位。
 * 失败策略（本任务选定）：疑似假滤镜**报告进 FILTER_TRUTH_REPORT 清单而不 fail**
 * （修复由主线程负责）；若后续人工确认某 id 是彻底没实现的 stub，
 * 把它加进下方 STUB_IDS 即可让对应断言变红、醒目标出。
 */
import { describe, expect, it } from "vitest";
import {
  FILTER_DEFS,
  filterParams,
  type FilterDef,
} from "../../src/engine/filters/defs";
import { makeBuffer, rng, type RgbaBuffer } from "../../src/engine/filters/kernels";

/* ================================================================ 标准测试图 */

const W = 64;
const H = 64;
const TOTAL = W * H;
/** 判定「有实际效果」所需的最小差异像素数（约 0.2%，排除个别舍入噪声）。 */
const MIN_CHANGED = 8;

/** 标准测试图：RGB 三向渐变 + ±25 固定种子噪声 + 三个高饱和纯色块，全不透明。 */
function makeStandardImage(): RgbaBuffer {
  const buf = makeBuffer(W, H);
  const rand = rng(20261106);
  // 高饱和纯色块：红色 / 蓝色 / 绿色（max-min = 255 > 200，供 NTSC 等生效）
  const blocks: { x0: number; y0: number; rgb: [number, number, number] }[] = [
    { x0: 28, y0: 28, rgb: [255, 0, 0] },
    { x0: 44, y0: 8, rgb: [0, 0, 255] },
    { x0: 8, y0: 44, rgb: [0, 255, 0] },
  ];
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 4;
      let r = (x / (W - 1)) * 255;
      let g = (y / (H - 1)) * 255;
      let b = ((x + y) / (W + H - 2)) * 255;
      r += (rand() * 2 - 1) * 25;
      g += (rand() * 2 - 1) * 25;
      b += (rand() * 2 - 1) * 25;
      for (const bk of blocks) {
        if (x >= bk.x0 && x < bk.x0 + 8 && y >= bk.y0 && y < bk.y0 + 8) {
          r = bk.rgb[0];
          g = bk.rgb[1];
          b = bk.rgb[2];
        }
      }
      buf.data[o] = r;
      buf.data[o + 1] = g;
      buf.data[o + 2] = b;
      buf.data[o + 3] = 255;
    }
  }
  return buf;
}

const SRC = makeStandardImage();

/* ================================================================ 工具 */

function copyBuf(src: RgbaBuffer): RgbaBuffer {
  return { data: new Uint8ClampedArray(src.data), width: src.width, height: src.height };
}

function runFilter(
  def: FilterDef,
  params: Record<string, number>,
  src: RgbaBuffer,
): RgbaBuffer {
  return def.apply(copyBuf(src), params);
}

/** 逐像素差异：changed = 任一通道 |Δ|≥1 的像素数，maxDiff = 最大通道差。 */
function diffStats(a: RgbaBuffer, b: RgbaBuffer): { changed: number; maxDiff: number } {
  let changed = 0;
  let maxDiff = 0;
  const n = Math.min(a.data.length, b.data.length);
  for (let i = 0; i < n; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c += 1) {
      const dd = Math.abs(a.data[i + c] - b.data[i + c]);
      if (dd > d) d = dd;
    }
    if (d >= 1) changed += 1;
    if (d > maxDiff) maxDiff = d;
  }
  return { changed, maxDiff };
}

const changedPixels = (a: RgbaBuffer, b: RgbaBuffer): number => diffStats(a, b).changed;

/** 灾难性假输出检测：全黑 / 全白 / 全透明。返回类型或 null。 */
function catastrophicKind(buf: RgbaBuffer): string | null {
  const d = buf.data;
  let allBlack = true;
  let allWhite = true;
  let allTransparent = true;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] !== 0 || d[i + 1] !== 0 || d[i + 2] !== 0) allBlack = false;
    if (d[i] !== 255 || d[i + 1] !== 255 || d[i + 2] !== 255) allWhite = false;
    if (d[i + 3] !== 0) allTransparent = false;
    if (!allBlack && !allWhite && !allTransparent) return null;
  }
  if (allTransparent) return "全透明";
  if (allBlack) return "全黑";
  if (allWhite) return "全白";
  return null;
}

/** 把所有非开关参数推到最大值（默认态近恒等时的兜底复核参数）。 */
function maxedParams(def: FilterDef): Record<string, number> {
  const out = filterParams(def);
  for (const p of def.params) {
    if (!p.choices && p.min !== p.max) out[p.id] = p.max;
  }
  return out;
}

/* ================================================================ 白名单与复核参数 */

/**
 * 白名单：默认参数下恒等 / 特殊是该滤镜的**设计语义**，不算假功能。
 * 值为原因说明（进报告）。白名单滤镜改用 RETRY_PARAMS 复核真效果。
 */
const WHITELIST: Record<string, string> = {
  // 六个参数默认值全为 0（= 不做任何校正），默认恒等即「不校正」的初始态。
  "filter.lensCorrection":
    "全部校正量（畸变/透视/色差/晕影）默认 0 = 不校正，默认恒等是设计语义；用非零校正参数复核真效果",
  // 「自定」卷积核默认即恒等核（中心 1 其余 0），对应 PS 自定滤镜的初始矩阵。
  "filter.other.custom":
    "默认核为中心 1 其余 0 的恒等卷积（自定滤镜初始矩阵），恒等是设计语义；用非平凡核复核真效果",
};

/** 白名单 / 默认态近恒等滤镜的复核参数（必须是「对该滤镜合理」的取值）。 */
const RETRY_PARAMS: Record<string, Record<string, number>> = {
  "filter.lensCorrection": { distortion: 80, vertical: 0, horizontal: 0, ca: 3, vignette: -60, midpoint: 50 },
  "filter.other.custom": {
    // 盒式模糊核：[ 1×9 ]，除数 9 —— 非平凡且核和为正（负和核会把 alpha 夹成 0）
    k0: 1, k1: 1, k2: 1, k3: 1, k4: 1, k5: 1, k6: 1, k7: 1, k8: 1,
    divisor: 9, bias: 0,
  },
};

/** 经人工确认的「彻底没实现」stub。加入后相关断言变红（当前为空）。 */
const STUB_IDS: readonly string[] = [];

/* ================================================================ 真值核对主流程 */

export type TruthStatus = "pass" | "weak" | "suspect";

export interface TruthEntry {
  id: string;
  label: string;
  group: string;
  /** pass=通过 / weak=白名单弱断言 / suspect=疑似假滤镜 */
  status: TruthStatus;
  /** 默认参数（或复核参数）下与输入的差异像素数 */
  changedVsInput: number;
  /** 与输入的最大通道差 */
  maxDiffVsInput: number;
  /** 是否使用了复核参数（默认态近恒等时） */
  usedRetry: boolean;
  /** 灾难性输出类型（全黑/全白/全透明），无则 null */
  catastrophic: string | null;
  /** 参数敏感性是否通过 */
  sensitivityOk: boolean;
  /** 参数敏感性说明（含降级 / 无参数备注） */
  sensitivityNote: string;
  /** 疑似假滤镜原因（status=suspect 时非空） */
  suspectReason: string | null;
  /** 白名单 / 弱断言说明（status=weak 时非空） */
  note: string;
}

/** 参数敏感性核对：主要参数最小 vs 最大必须可区分（含降级策略）。 */
function sensitivityCheck(
  def: FilterDef,
  src: RgbaBuffer,
): { ok: boolean; note: string } {
  const numeric = def.params.filter((p) => !p.choices && p.min !== p.max);
  const switches = def.params.filter((p) => p.choices && p.min !== p.max);
  if (numeric.length === 0 && switches.length === 0) {
    return { ok: true, note: "无参数，不适用参数敏感性检查" };
  }
  // 第一优先：min vs max；若 min 语义为「关闭」导致两次相同，降级 mid vs max。
  for (const p of numeric) {
    const params = filterParams(def);
    params[p.id] = p.min;
    const a = runFilter(def, params, src);
    params[p.id] = p.max;
    const b = runFilter(def, params, src);
    if (changedPixels(a, b) >= MIN_CHANGED) {
      return { ok: true, note: `参数 ${p.id}：min=${p.min} vs max=${p.max} 输出不同` };
    }
    const mid = (p.min + p.max) / 2;
    params[p.id] = mid;
    const c = runFilter(def, params, src);
    if (changedPixels(c, b) >= MIN_CHANGED) {
      return {
        ok: true,
        note: `参数 ${p.id}：min=${p.min} 语义为「关闭」故与 max 同输出，降级 mid=${mid} vs max=${p.max} 输出不同`,
      };
    }
  }
  // 兜底：开关型参数两态比较。
  for (const p of switches) {
    const params = filterParams(def);
    params[p.id] = p.min;
    const a = runFilter(def, params, src);
    params[p.id] = p.max;
    const b = runFilter(def, params, src);
    if (changedPixels(a, b) >= MIN_CHANGED) {
      return { ok: true, note: `开关参数 ${p.id}：两态（${p.min}/${p.max}）输出不同` };
    }
  }
  return { ok: false, note: "所有参数取最小/最大（含中间值/两态降级）输出完全相同 → 参数不生效" };
}

/** 对单个滤镜做完整真值核对。 */
function truthCheck(def: FilterDef, src: RgbaBuffer): TruthEntry {
  const entry: TruthEntry = {
    id: def.id,
    label: def.label,
    group: def.group,
    status: "pass",
    changedVsInput: 0,
    maxDiffVsInput: 0,
    usedRetry: false,
    catastrophic: null,
    sensitivityOk: true,
    sensitivityNote: "",
    suspectReason: null,
    note: "",
  };

  let out: RgbaBuffer;
  try {
    out = runFilter(def, filterParams(def), src);
  } catch (err) {
    entry.status = "suspect";
    entry.suspectReason = `默认参数运行抛异常：${err instanceof Error ? err.message : String(err)}`;
    return entry;
  }

  let st = diffStats(src, out);
  entry.changedVsInput = st.changed;
  entry.maxDiffVsInput = st.maxDiff;

  // 默认态近恒等 → 用复核参数（白名单优先，否则全参数推满）再试一次。
  if (st.changed < MIN_CHANGED) {
    const retry = RETRY_PARAMS[def.id] ?? maxedParams(def);
    const retried = runFilter(def, retry, src);
    const st2 = diffStats(src, retried);
    if (st2.changed > st.changed) {
      out = retried;
      st = st2;
      entry.usedRetry = true;
      entry.changedVsInput = st2.changed;
      entry.maxDiffVsInput = st2.maxDiff;
    }
  }

  entry.catastrophic = catastrophicKind(out);

  const sens = sensitivityCheck(def, src);
  entry.sensitivityOk = sens.ok;
  entry.sensitivityNote = sens.note;

  const whitelistReason = WHITELIST[def.id];

  if (st.changed < MIN_CHANGED) {
    entry.status = "suspect";
    entry.suspectReason = entry.usedRetry
      ? `默认参数与复核参数下输出均与输入相同（差异像素 ${st.changed}/${TOTAL}）→ 疑似恒等占位`
      : `默认参数下输出与输入相同（差异像素 ${st.changed}/${TOTAL}）→ 疑似恒等占位`;
    return entry;
  }

  if (entry.catastrophic) {
    if (whitelistReason) {
      entry.status = "weak";
      entry.note = `${whitelistReason}（另：输出为${entry.catastrophic}，属该滤镜语义允许）`;
    } else {
      entry.status = "suspect";
      entry.suspectReason = `输出为${entry.catastrophic}的灾难性假输出`;
      return entry;
    }
  } else if (whitelistReason) {
    entry.status = "weak";
    entry.note = whitelistReason;
  }

  if (!sens.ok) {
    entry.status = "suspect";
    entry.suspectReason = `参数敏感性失败：${sens.note}`;
  }

  return entry;
}

/** 全量真值报告（模块加载时计算一次，供断言与导出共用）。 */
const REPORT: TruthEntry[] = FILTER_DEFS.map((def) => truthCheck(def, SRC));

/** 导出结构化结果：总滤镜数 / 通过 / 白名单 / 疑似假清单。 */
export const FILTER_TRUTH_REPORT: readonly TruthEntry[] = REPORT;

const SUSPECTS = REPORT.filter((e) => e.status === "suspect");
const WEAKS = REPORT.filter((e) => e.status === "weak");
const PASSES = REPORT.filter((e) => e.status === "pass");
const REPORT_BY_ID = new Map(REPORT.map((e) => [e.id, e]));

/* ================================================================ 断言 */

describe("滤镜真值核对（零假功能铁律）", () => {
  it("报告覆盖全部注册滤镜且无遗漏 / 无重复", () => {
    expect(REPORT.length).toBe(FILTER_DEFS.length);
    const ids = new Set(REPORT.map((e) => e.id));
    expect(ids.size).toBe(FILTER_DEFS.length);
    for (const def of FILTER_DEFS) {
      expect(REPORT_BY_ID.has(def.id), `缺少滤镜 ${def.id} 的真值报告`).toBe(true);
    }
  });

  it("每个滤镜默认参数（或复核参数）都真的出效果 —— 疑似假滤镜报告制不 fail", () => {
    for (const e of REPORT) {
      if (e.status === "suspect") {
        // 报告制：疑似假滤镜进清单（修复由主线程负责），不让整套测试变红。
        console.warn(`[滤镜真值][疑似假滤镜] ${e.id}（${e.label}）：${e.suspectReason}`);
        continue;
      }
      expect(
        e.changedVsInput >= MIN_CHANGED,
        `${e.id} 输出与输入无差异（changed=${e.changedVsInput}）`,
      ).toBe(true);
    }
    console.warn(`[滤镜真值] 疑似假滤镜 ${SUSPECTS.length} 个：${SUSPECTS.map((s) => s.id).join(", ") || "无"}`);
  });

  it("无灾难性假输出（全黑 / 全白 / 全透明）—— 白名单滤镜除外", () => {
    for (const e of REPORT) {
      if (e.status === "suspect" && e.catastrophic) continue; // 已进报告
      expect(e.catastrophic, `${e.id} 输出为${e.catastrophic}`).toBeNull();
    }
  });

  it("参数敏感性：主要参数最小/最大值输出可区分（含降级策略）", () => {
    for (const e of REPORT) {
      if (!e.sensitivityOk) {
        console.warn(`[滤镜真值][参数不生效] ${e.id}：${e.sensitivityNote}`);
        continue; // 报告制
      }
      expect(e.sensitivityOk, `${e.id}：${e.sensitivityNote}`).toBe(true);
    }
  });

  it("彻底没实现的 stub（STUB_IDS）必须 fail —— 当前应清空", () => {
    const stubs = SUSPECTS.filter((e) => STUB_IDS.includes(e.id));
    expect(
      stubs.map((s) => `${s.id}: ${s.suspectReason}`),
      `以下滤镜确认为彻底未实现的 stub，必须修复：`,
    ).toEqual([]);
    expect(REPORT.filter((e) => STUB_IDS.includes(e.id)).length).toBe(STUB_IDS.length);
  });

  it("汇总：总滤镜数 / 通过 / 白名单弱断言 / 疑似假清单", () => {
    const lines = [
      "========== 滤镜真值核对汇总 ==========",
      `总滤镜数：${REPORT.length}`,
      `通过：${PASSES.length}`,
      `白名单弱断言：${WEAKS.length}${WEAKS.length ? " → " + WEAKS.map((w) => `${w.id}（${w.note}）`).join("；") : ""}`,
      `疑似假滤镜：${SUSPECTS.length}${SUSPECTS.length ? " → " + SUSPECTS.map((s) => `${s.id}（${s.suspectReason}）`).join("；") : "，无"}`,
      "======================================",
    ];
    console.log(lines.join("\n"));
    // 结构性断言：三态计数之和 = 总数，且 weak 必有原因说明。
    expect(PASSES.length + WEAKS.length + SUSPECTS.length).toBe(REPORT.length);
    for (const w of WEAKS) expect(w.note.length, `${w.id} 白名单必须写明原因`).toBeGreaterThan(0);
  });
});

/* ================================================================ 逐滤镜明细（报告制） */

describe("逐滤镜真值明细", () => {
  for (const def of FILTER_DEFS) {
    const e = REPORT_BY_ID.get(def.id)!;
    it(`${def.label}（${def.id}）[${e.status}]`, () => {
      if (e.status === "suspect") {
        console.warn(`[滤镜真值] ${e.id}：${e.suspectReason}｜敏感性：${e.sensitivityNote}`);
        expect(e.suspectReason, `${e.id} 已进疑似假滤镜清单（报告制，修复由主线程负责）`).toBeTruthy();
        return;
      }
      expect(e.changedVsInput).toBeGreaterThanOrEqual(MIN_CHANGED);
      expect(e.catastrophic).toBeNull();
      expect(e.sensitivityOk).toBe(true);
      if (e.status === "weak") {
        expect(e.note).toContain("设计语义");
      }
    });
  }
});
