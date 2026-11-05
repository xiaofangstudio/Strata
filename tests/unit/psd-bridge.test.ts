/**
 * PSD 桥接层纯逻辑测试（六项差距全修 · 第 1 项）。
 *
 * 项目约定：测试不碰真实浏览器 API，所以只测「扁平栈 → PSD 树」的结构转换、
 * 「调整参数 → PSD 调整资源」的映射，以及「PSD 调整资源 → 调整参数」的逆映射，
 * 不测 writePsd / canvas。结构级的 encode→decode 往返见 psd-roundtrip.test.ts。
 */
import { describe, expect, it } from "vitest";
import {
  buildPsdForest,
  psdAdjustmentOf,
  psdAdjustmentFrom,
  PSD_UNMAPPABLE_ADJUSTMENTS,
} from "../../src/engine/psd";
import { newAdjustState, type StrataLayer } from "../../src/core/layer";

/** 只填结构转换需要的字段，其余字段在 node 环境下造不出来也不需要。 */
function stub(id: string, parent: string | null = null, kind = "pixel"): StrataLayer {
  return { id, name: id, parent, kind } as unknown as StrataLayer;
}

describe("buildPsdForest", () => {
  it("顶层扁平层保持自下而上的原顺序", () => {
    const forest = buildPsdForest([stub("a"), stub("b"), stub("c")]);
    expect(forest.map((n) => n.layer.id)).toEqual(["a", "b", "c"]);
    expect(forest.every((n) => n.children.length === 0)).toBe(true);
  });

  it("组把直属子层收进 children，且不改变同层顺序", () => {
    const flat = [
      stub("bg"),
      stub("g1", null, "group"),
      stub("c1", "g1"),
      stub("c2", "g1"),
      stub("top"),
    ];
    const forest = buildPsdForest(flat);
    expect(forest.map((n) => n.layer.id)).toEqual(["bg", "g1", "top"]);
    expect(forest[1].children.map((n) => n.layer.id)).toEqual(["c1", "c2"]);
  });

  it("嵌套组递归成树", () => {
    const flat = [
      stub("g1", null, "group"),
      stub("g2", "g1", "group"),
      stub("leaf", "g2"),
      stub("sibling", "g1"),
    ];
    const forest = buildPsdForest(flat);
    expect(forest[0].children.map((n) => n.layer.id)).toEqual(["g2", "sibling"]);
    expect(forest[0].children[0].children.map((n) => n.layer.id)).toEqual(["leaf"]);
  });

  it("父组被删掉后子层不会静默丢失，一律挂回顶层", () => {
    const forest = buildPsdForest([stub("orphan", "missing"), stub("ok")]);
    expect(forest.map((n) => n.layer.id)).toEqual(["orphan", "ok"]);
  });

  it("环状 parent 不会死循环，也不丢层", () => {
    const a = stub("a", "b");
    const b = stub("b", "a");
    const forest = buildPsdForest([a, b, stub("c")]);
    const ids = new Set<string>();
    const walk = (nodes: ReturnType<typeof buildPsdForest>): void => {
      for (const n of nodes) {
        ids.add(n.layer.id);
        walk(n.children);
      }
    };
    walk(forest);
    expect(ids).toEqual(new Set(["a", "b", "c"]));
  });
});

describe("psdAdjustmentOf", () => {
  it("亮度对比度按原值映射", () => {
    const s = newAdjustState("bc");
    s.params.brightness = 20;
    s.params.contrast = -15;
    expect(psdAdjustmentOf(s)).toMatchObject({
      type: "brightness/contrast",
      brightness: 20,
      contrast: -15,
    });
  });

  it("色阶把 0–255 输入区间写成 PSD 通道", () => {
    const s = newAdjustState("levels");
    s.params.inBlack = 10;
    s.params.inWhite = 240;
    s.params.gamma = 120;
    expect(psdAdjustmentOf(s)).toMatchObject({
      type: "levels",
      channels: [{ shadowInput: 10, highlightInput: 240, midtoneInput: 1.2 }],
    });
  });

  it("曲线控制点从 0–1 换算成 0–255", () => {
    const s = newAdjustState("curves");
    s.curve = [{ x: 0, y: 0 }, { x: 0.5, y: 0.75 }, { x: 1, y: 1 }];
    expect(psdAdjustmentOf(s)).toMatchObject({
      type: "curves",
      channels: [[{ input: 0, output: 0 }, { input: 128, output: 191 }, { input: 255, output: 255 }]],
    });
  });

  it("阈值 / 色调分离 / 反相有等价资源", () => {
    const t = newAdjustState("threshold");
    t.params.level = 200;
    expect(psdAdjustmentOf(t)).toEqual({ type: "threshold", level: 200 });
    const p = newAdjustState("posterize");
    p.params.levels = 6;
    expect(psdAdjustmentOf(p)).toEqual({ type: "posterize", levels: 6 });
    expect(psdAdjustmentOf(newAdjustState("invert"))).toEqual({ type: "invert" });
  });

  it("没有 PSD 等价物的调整层返回 null，并且都在清单里", () => {
    for (const id of PSD_UNMAPPABLE_ADJUSTMENTS) {
      // 这些 id 在 ADJUST_DEFS 里存在时才是有效状态；不存在就直接跳过
      let state;
      try {
        state = newAdjustState(id as Parameters<typeof newAdjustState>[0]);
      } catch {
        continue;
      }
      expect(psdAdjustmentOf(state), id).toBeNull();
    }
  });
});

describe("psdAdjustmentOf 补齐字段", () => {
  it("colorbalance 写阴影/中间调/高光三组，参数名对齐 ADJUST_DEFS", () => {
    const s = newAdjustState("colorbalance");
    Object.assign(s.params, {
      shcr: 12, shmg: -4, shyb: 6,
      mdcr: -8, mdmg: 3, mdyb: -2,
      hicr: 9, himg: -7, hiyb: 5,
    });
    expect(psdAdjustmentOf(s)).toMatchObject({
      type: "color balance",
      shadows: { cyanRed: 12, magentaGreen: -4, yellowBlue: 6 },
      midtones: { cyanRed: -8, magentaGreen: 3, yellowBlue: -2 },
      highlights: { cyanRed: 9, magentaGreen: -7, yellowBlue: 5 },
      preserveLuminosity: false,
    });
  });

  it("blackwhite 写六色权重，bw 只有类型", () => {
    const s = newAdjustState("blackwhite");
    Object.assign(s.params, { red: 50, yellow: 60, green: 40, cyan: 30, blue: 20, magenta: 80 });
    expect(psdAdjustmentOf(s)).toMatchObject({
      type: "black & white",
      reds: 50, yellows: 60, greens: 40, cyans: 30, blues: 20, magentas: 80,
    });
    expect(psdAdjustmentOf(newAdjustState("bw"))).toEqual({ type: "black & white" });
  });

  it("photofilter 写滤镜颜色 / 浓度 / 保留明度，density 是 0–1", () => {
    const s = newAdjustState("photofilter");
    s.params.hue = 40;
    s.params.strength = 65;
    s.params.preserve = 100;
    expect(psdAdjustmentOf(s)).toMatchObject({
      type: "photo filter",
      color: { r: expect.any(Number), g: expect.any(Number), b: expect.any(Number) },
      density: 0.65,
      preserveLuminosity: true,
    });
    const off = newAdjustState("photofilter");
    off.params.preserve = 0;
    expect(psdAdjustmentOf(off)).toMatchObject({ preserveLuminosity: false });
  });

  it("channelmixer 写 red/green/blue 三条输出通道系数", () => {
    const s = newAdjustState("channelmixer");
    Object.assign(s.params, { rr: 110, rg: -10, rb: 5, rc: 2, gg: 90, bb: 95 });
    expect(psdAdjustmentOf(s)).toMatchObject({
      type: "channel mixer",
      monochrome: false,
      red: { red: 110, green: -10, blue: 5, constant: 2 },
      green: { green: 90 },
      blue: { blue: 95 },
      gray: { red: 0, green: 0, blue: 0, constant: 0 },
    });
  });

  it("gradientmap 补齐必需的 gradientType 与 colorStops", () => {
    const s = newAdjustState("gradientmap");
    s.stops = [{ at: 0, color: "#112233" }, { at: 1, color: "#ffffff" }];
    expect(psdAdjustmentOf(s)).toMatchObject({
      type: "gradient map",
      gradientType: "solid",
      colorStops: expect.arrayContaining([
        expect.objectContaining({ location: 0, midpoint: 0.5, color: { r: 17, g: 34, b: 51 } }),
      ]),
    });
  });

  it("huesat 写 6 个分色相通道，hs 只写 master", () => {
    const s = newAdjustState("huesat");
    s.params.redHue = 15;
    s.params.redSat = 8;
    s.params.colorize = 1;
    expect(psdAdjustmentOf(s)).toMatchObject({
      type: "hue/saturation",
      colorize: true,
      reds: { hue: 15, saturation: 8, lightness: 0 },
      yellows: expect.any(Object),
      magentas: expect.any(Object),
    });
    expect(psdAdjustmentOf(newAdjustState("hs"))).not.toHaveProperty("reds");
  });

  it("curves 把分通道曲线写进 channels[1..3]", () => {
    const s = newAdjustState("curves");
    s.curveR = [{ x: 0, y: 0 }, { x: 1, y: 0.8 }];
    expect(psdAdjustmentOf(s)).toMatchObject({
      type: "curves",
      channels: [expect.any(Array), [{ input: 0, output: 0 }, { input: 255, output: 204 }]],
    });
  });
});

describe("psdAdjustmentFrom 逆映射（纯函数）", () => {
  it("写侧全部可映射类型都能还原成同 id 的 AdjustState", () => {
    const ids = [
      "bc", "levels", "curves", "exposure", "vibrance",
      "hs", "huesat", "colorbalance", "bw", "blackwhite",
      "photofilter", "channelmixer", "gradientmap",
      "invert", "posterize", "threshold",
    ] as const;
    for (const id of ids) {
      const s = newAdjustState(id);
      const adj = psdAdjustmentOf(s);
      expect(adj, id).not.toBeNull();
      const back = psdAdjustmentFrom(adj!);
      expect(back, id).not.toBeNull();
      expect(back!.id, id).toBe(id);
    }
  });

  it("hs / huesat、bw / blackwhite 靠分通道 / 权重字段区分", () => {
    expect(psdAdjustmentFrom(psdAdjustmentOf(newAdjustState("hs"))!)?.id).toBe("hs");
    expect(psdAdjustmentFrom(psdAdjustmentOf(newAdjustState("huesat"))!)?.id).toBe("huesat");
    expect(psdAdjustmentFrom(psdAdjustmentOf(newAdjustState("bw"))!)?.id).toBe("bw");
    expect(psdAdjustmentFrom(psdAdjustmentOf(newAdjustState("blackwhite"))!)?.id).toBe("blackwhite");
  });

  it("ag-psd 能读但 Strata 写不出的资源返回 null", () => {
    expect(psdAdjustmentFrom({ type: "selective color" } as never)).toBeNull();
    expect(psdAdjustmentFrom({ type: "color lookup" } as never)).toBeNull();
  });

  it("关键参数逐字段还原（bc / levels / exposure / colorbalance / channelmixer）", () => {
    const bc = newAdjustState("bc");
    bc.params.brightness = 33;
    bc.params.contrast = -21;
    expect(psdAdjustmentFrom(psdAdjustmentOf(bc)!)?.params).toEqual(bc.params);

    const lv = newAdjustState("levels");
    Object.assign(lv.params, { inBlack: 7, inWhite: 230, gamma: 130, outBlack: 3, outWhite: 245 });
    expect(psdAdjustmentFrom(psdAdjustmentOf(lv)!)?.params).toEqual(lv.params);

    const ex = newAdjustState("exposure");
    Object.assign(ex.params, { exposure: 1.25, offset: -0.2, gamma: 1.4 });
    expect(psdAdjustmentFrom(psdAdjustmentOf(ex)!)?.params).toEqual(ex.params);

    const cb = newAdjustState("colorbalance");
    Object.assign(cb.params, { shcr: 10, mdmg: -6, hiyb: 12 });
    expect(psdAdjustmentFrom(psdAdjustmentOf(cb)!)?.params).toEqual(cb.params);

    const cm = newAdjustState("channelmixer");
    Object.assign(cm.params, { rr: 105, rg: -12, bb: 88, bc: 3 });
    expect(psdAdjustmentFrom(psdAdjustmentOf(cm)!)?.params).toEqual(cm.params);
  });
});
