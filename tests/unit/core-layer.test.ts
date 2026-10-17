/**
 * `src/core/layer.ts` 的纯逻辑契约。
 *
 * 图层模型、混合模式表、调整定义表、调整状态与滤镜串编译，都是不依赖渲染的
 * 纯数据 / 纯函数。唯一会碰浏览器的只有 `adjustFilter` 走 SVG 滤镜的那几支
 * —— 它们通过 `svgFilter` 往 DOM 里注册 `<filter>`，因此这里用最小 DOM 替身
 * 承接，只断言「注册了什么」，不解析 SVG。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADJUST_DEFS,
  BLEND_MODES,
  DEFAULT_CURVE,
  DEFAULT_STOPS,
  STROKE_POSITIONS,
  STYLE_DEFS,
  adjustDef,
  adjustFamily,
  adjustFilter,
  blendLabel,
  blendOp,
  cloneAdjust,
  cloneLayer,
  createAdjustLayer,
  createLayer,
  createMask,
  dupLayer,
  newAdjustState,
  newLayerStyle,
  nextLayerId,
  styleDef,
  type AdjustId,
  type AdjustState,
  type BlendId,
  type StyleId,
} from "../../src/core/layer";
import { installDomStub, type DomStub, type StubCanvas } from "../helpers/canvas";

let dom: DomStub;

beforeAll(() => {
  dom = installDomStub();
});
afterAll(() => {
  dom.restore();
});

/** 一条参数全为空（走各字段的兜底默认值）的调整状态。 */
const neutral = (id: AdjustId): AdjustState => ({ id, params: {} });

describe("混合模式表 BLEND_MODES", () => {
  it("恰好 27 条（对齐 PS）且 id 不重复，首条是 normal", () => {
    expect(BLEND_MODES).toHaveLength(27);
    const ids = BLEND_MODES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(BLEND_MODES[0]).toMatchObject({
      id: "normal",
      label: "正常",
      op: "source-over",
    });
  });

  it("11 种 Canvas2D 不支持的模式标了 soft", () => {
    const soft = BLEND_MODES.filter((b) => b.soft).map((b) => b.id);
    expect(soft).toHaveLength(11);
    expect(soft).toContain("linear-burn");
    expect(soft).toContain("dissolve");
    expect(soft).toContain("divide");
    // 标了 soft 的一律不能声称有 GPU 算子
    for (const b of BLEND_MODES) if (b.soft) expect(b.op).toBe("source-over");
  });

  it("blendOp 给出正确的 Canvas2D 算子", () => {
    expect(blendOp("multiply")).toBe("multiply");
    expect(blendOp("color-burn")).toBe("color-burn");
    expect(blendOp("luminosity")).toBe("luminosity");
    expect(blendOp("normal")).toBe("source-over");
  });

  it("未知 id 回退到正常（source-over / 正常）", () => {
    const bogus = "not-a-blend" as BlendId;
    expect(blendOp(bogus)).toBe("source-over");
    expect(blendLabel(bogus)).toBe("正常");
  });

  it("blendLabel 返回中文标签", () => {
    expect(blendLabel("multiply")).toBe("正片叠底");
    expect(blendLabel("soft-light")).toBe("柔光");
  });
});

describe("调整定义表 ADJUST_DEFS", () => {
  it("21 条且 id 唯一", () => {
    expect(ADJUST_DEFS).toHaveLength(21);
    const ids = ADJUST_DEFS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("三族 tone / color / effect 都非空", () => {
    const families = new Set(ADJUST_DEFS.map((d) => d.family));
    expect(families).toEqual(new Set(["tone", "color", "effect"]));
  });

  it("每个参数定义 min <= def <= max、step > 0", () => {
    for (const def of ADJUST_DEFS) {
      for (const p of def.params) {
        expect(p.min).toBeLessThanOrEqual(p.max);
        expect(p.def).toBeGreaterThanOrEqual(p.min);
        expect(p.def).toBeLessThanOrEqual(p.max);
        expect(p.step).toBeGreaterThan(0);
      }
    }
  });

  it("adjustDef 未知 id 回退到首条（亮度 / 对比度）", () => {
    expect(adjustDef("nope" as AdjustId).id).toBe(ADJUST_DEFS[0].id);
    expect(adjustDef("levels").family).toBe("tone");
    expect(adjustFamily("nope" as AdjustId)).toBe("tone");
    expect(adjustFamily("blur")).toBe("effect");
  });
});

describe("调整状态 newAdjustState / cloneAdjust", () => {
  it("按定义填好默认参数", () => {
    expect(newAdjustState("bc").params).toEqual({ brightness: 0, contrast: 0 });
    expect(newAdjustState("threshold").params).toEqual({ level: 128 });
  });

  it("曲线 / 渐变映射给出深拷贝，改新状态不会污染常量", () => {
    const curves = newAdjustState("curves");
    expect(curves.curve).toEqual(DEFAULT_CURVE.map((c) => ({ ...c })));
    expect(curves.curve).not.toBe(DEFAULT_CURVE);
    expect(curves.curve?.[0]).not.toBe(DEFAULT_CURVE[0]);

    const gm = newAdjustState("gradientmap");
    expect(gm.stops).toEqual(DEFAULT_STOPS.map((s) => ({ ...s })));
    expect(gm.stops).not.toBe(DEFAULT_STOPS);

    curves.curve![0].y = 0.9;
    expect(DEFAULT_CURVE[0].y).toBe(0);
  });

  it("cloneAdjust 深拷贝 params / curve / stops", () => {
    const src: AdjustState = {
      id: "curves",
      params: { a: 1 },
      curve: [
        { x: 0, y: 0 },
        { x: 1, y: 0.5 },
      ],
      stops: [
        { at: 0, color: "#000000" },
        { at: 1, color: "#ffffff" },
      ],
    };
    const copy = cloneAdjust(src);
    expect(copy).toEqual(src);
    expect(copy).not.toBe(src);
    expect(copy.params).not.toBe(src.params);
    expect(copy.curve).not.toBe(src.curve);
    expect(copy.stops).not.toBe(src.stops);

    copy.params.a = 99;
    copy.curve![1].y = 0.1;
    copy.stops![1].color = "#123456";
    expect(src.params.a).toBe(1);
    expect(src.curve![1].y).toBe(0.5);
    expect(src.stops![1].color).toBe("#ffffff");
  });

  it("没有 curve / stops 时也不凭空造出来", () => {
    const copy = cloneAdjust(neutral("bc"));
    expect(copy.curve).toBeUndefined();
    expect(copy.stops).toBeUndefined();
  });
});

describe("adjustFilter 的中性契约", () => {
  const NEUTRAL_IDS: AdjustId[] = [
    "bc",
    "levels",
    "curves",
    "exposure",
    "hs",
    "colorbalance",
    "bw",
    "gradientmap",
    "channelmixer",
    "invert",
    "colortemp",
    "photofilter",
    "channellevels",
    "shadowhighlight",
    "blur",
    "motionblur",
    "sharpen",
    "grain",
    "noise",
  ];

  it.each(NEUTRAL_IDS)("参数中性时返回空串：%s", (id) => {
    expect(adjustFilter(neutral(id), "L")).toBe("");
  });

  it("阈值 / 色调分离没有「中性」一说，总是产出滤镜", () => {
    expect(adjustFilter(neutral("threshold"), "L")).not.toBe("");
    expect(adjustFilter(neutral("posterize"), "L")).not.toBe("");
  });
});

describe("adjustFilter 的非中性契约：Canvas2D 原生滤镜", () => {
  it("亮度 / 对比度", () => {
    expect(
      adjustFilter(
        { id: "bc", params: { brightness: 20, contrast: -50 } },
        "L",
      ),
    ).toBe("brightness(1.200) contrast(0.500)");
  });

  it("色相 / 饱和度", () => {
    expect(
      adjustFilter({ id: "hs", params: { hue: 30, saturate: 50 } }, "L"),
    ).toBe("hue-rotate(30deg) saturate(1.500)");
  });

  it("黑白 / 反相 / 模糊", () => {
    expect(adjustFilter({ id: "bw", params: { amount: 50 } }, "L")).toBe(
      "grayscale(0.500)",
    );
    expect(adjustFilter({ id: "invert", params: { amount: 40 } }, "L")).toBe(
      "invert(0.400)",
    );
    expect(adjustFilter({ id: "blur", params: { radius: 5 } }, "L")).toBe(
      "blur(5px)",
    );
  });

  it("用 newAdjustState 的默认值即为非中性（如模糊默认半径 6）", () => {
    expect(adjustFilter(newAdjustState("blur"), "L")).toBe("blur(6px)");
    expect(adjustFilter(newAdjustState("bw"), "L")).toBe("grayscale(1.000)");
    expect(adjustFilter(newAdjustState("invert"), "L")).toBe("invert(1.000)");
  });
});

describe("adjustFilter 的非中性契约：SVG 滤镜（返回 url(#sfx-<图层 id>)）", () => {
  const expectedUrl = (layerId: string) => `url(#sfx-${layerId})`;

  it("色阶 / 曲线 / 渐变映射 / 通道混合器 / 阈值 各自注册滤镜", () => {
    const cases: Array<[string, AdjustState]> = [
      ["L-levels", { id: "levels", params: { gamma: 150 } }],
      [
        "L-curves",
        {
          id: "curves",
          params: {},
          curve: [
            { x: 0, y: 0 },
            { x: 0.5, y: 0.75 },
            { x: 1, y: 1 },
          ],
        },
      ],
      [
        "L-grad",
        {
          id: "gradientmap",
          params: {},
          stops: [
            { at: 0, color: "#000000" },
            { at: 1, color: "#ff0000" },
          ],
        },
      ],
      ["L-mixer", { id: "channelmixer", params: { rr: 120 } }],
      ["L-threshold", { id: "threshold", params: { level: 200 } }],
    ];

    for (const [layerId, state] of cases) {
      expect(adjustFilter(state, layerId)).toBe(expectedUrl(layerId));
    }
  });

  it("注册出的 <filter> 真的挂在 body 下、带 id 且标记非空", () => {
    // 先确保注册发生（不依赖上一条用例的执行顺序）
    adjustFilter({ id: "levels", params: { gamma: 150 } }, "L-levels");
    const id = "sfx-L-levels";
    const el = dom.findAll("filter").find((e) => e.id === id);
    expect(el).toBeDefined();
    expect(el!.getAttribute("id")).toBe(id);
    expect(el!.getAttribute("color-interpolation-filters")).toBe("sRGB");
    expect(el!.innerHTML).toContain("feComponentTransfer");
    // 承载节点（<svg id="strata-fx">）应已挂在 body 下
    expect(dom.findAll("svg").some((s) => s.id === "strata-fx")).toBe(true);
  });

  it("色阶的传递函数是真表：33 个采样点", () => {
    const el = dom.findAll("filter").find((e) => e.id === "sfx-L-levels");
    const m = /tableValues="([^"]*)"/.exec(el!.innerHTML);
    expect(m).not.toBeNull();
    expect(m![1].split(" ")).toHaveLength(33);
  });
});

/** 取某个已注册滤镜里每条 tableValues 的数值数组（R/G/B 顺序）。 */
function tablesOf(filterId: string): number[][] {
  const el = dom.findAll("filter").find((e) => e.id === filterId);
  const out: number[][] = [];
  const re = /tableValues="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(el!.innerHTML)) !== null) {
    out.push(m[1].trim().split(/\s+/).map(Number));
  }
  return out;
}

/** 33 级采样，索引 16 正好落在中点 0.5。 */
const MID = 16;

describe("adjustFilter 的非中性契约：新增的四种调整", () => {
  it("通道色阶：只压红通道黑场，红表变暗、绿蓝保持恒等", () => {
    adjustFilter({ id: "channellevels", params: { rBlack: 51 } }, "T-cl");
    const [r, g, b] = tablesOf("sfx-T-cl");
    expect(r).toHaveLength(33);
    expect(r[MID]).toBeLessThan(0.5);
    expect(r[32]).toBeCloseTo(1, 5);
    expect(g[MID]).toBeCloseTo(0.5, 5);
    expect(b).toEqual(g);
  });

  it("阴影 / 高光：提亮阴影抬高中间调，黑点 / 白点不动且全程单调", () => {
    adjustFilter({ id: "shadowhighlight", params: { shadow: 100 } }, "T-sh");
    const [t] = tablesOf("sfx-T-sh");
    expect(t[MID]).toBeGreaterThan(0.5);
    expect(t[0]).toBeCloseTo(0, 5);
    expect(t[32]).toBeCloseTo(1, 5);
    for (let i = 1; i < t.length; i += 1) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1]);

    adjustFilter({ id: "shadowhighlight", params: { highlight: 100 } }, "T-sh2");
    const [t2] = tablesOf("sfx-T-sh2");
    expect(t2[MID]).toBeLessThan(0.5);
    expect(t2[0]).toBeCloseTo(0, 5);
    expect(t2[32]).toBeCloseTo(1, 5);
  });

  it("色温：暖调抬红压蓝，冷调反过来", () => {
    adjustFilter({ id: "colortemp", params: { temp: 100 } }, "T-warm");
    const [wr, wg, wb] = tablesOf("sfx-T-warm");
    expect(wr[32]).toBeGreaterThan(0.99);
    expect(wb[32]).toBeLessThan(0.7);
    expect(wg[32]).toBeCloseTo(1, 5);

    adjustFilter({ id: "colortemp", params: { temp: -100 } }, "T-cool");
    const [cr, , cb] = tablesOf("sfx-T-cool");
    expect(cb[32]).toBeGreaterThan(0.99);
    expect(cr[32]).toBeLessThan(0.7);
  });

  it("照片滤镜：暖滤镜压蓝、冷滤镜提蓝，保留明度把中间调锁在原亮度", () => {
    adjustFilter(
      { id: "photofilter", params: { hue: 40, strength: 60, preserve: 100 } },
      "T-pf",
    );
    const [r, g, b] = tablesOf("sfx-T-pf");
    expect(b[MID]).toBeLessThan(r[MID]);
    expect(b[MID]).toBeLessThan(g[MID]);
    // Rec.709 亮度守恒：中间调的加权亮度仍是 0.5
    const lum = 0.2126 * r[MID] + 0.7152 * g[MID] + 0.0722 * b[MID];
    expect(lum).toBeCloseTo(0.5, 3);

    adjustFilter(
      { id: "photofilter", params: { hue: 220, strength: 60, preserve: 100 } },
      "T-pf2",
    );
    const [r2, , b2] = tablesOf("sfx-T-pf2");
    expect(b2[MID]).toBeGreaterThan(r2[MID]);
  });
});

describe("图层构造 / 复制", () => {
  it("nextLayerId 逐次递增且唯一", () => {
    const a = nextLayerId();
    const b = nextLayerId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^layer-/);
  });

  it("createLayer 的默认属性", () => {
    const layer = createLayer(40, 30, "图层 1");
    expect(layer.kind).toBe("pixel");
    expect(layer.name).toBe("图层 1");
    expect(layer.visible).toBe(true);
    expect(layer.opacity).toBe(100);
    expect(layer.blend).toBe("normal");
    expect(layer.locked).toBe(false);
    expect(layer.mask).toBeNull();
    expect(layer.maskActive).toBe(false);
    expect(layer.styles).toEqual([]);
    expect(layer.adjust).toBeUndefined();
    const surface = layer.surface as unknown as StubCanvas;
    expect(surface.width).toBe(40);
    expect(surface.height).toBe(30);
  });

  it("createLayer 把尺寸夹到至少 1×1", () => {
    const surface = createLayer(0, -5, "x").surface as unknown as StubCanvas;
    expect(surface.width).toBe(1);
    expect(surface.height).toBe(1);
  });

  it("带底色会立刻填一次", () => {
    const layer = createLayer(8, 8, "底", "#ffffff");
    const ctx = layer.surface.getContext("2d")!;
    expect(ctx.fillStyle).toBe("#ffffff");
    expect(ctx.calls).toContain("fillRect");
  });

  it("createAdjustLayer 不占像素（surface 1×1）且直接持有 adjust", () => {
    const state = newAdjustState("bc");
    const layer = createAdjustLayer("亮度 / 对比度", state);
    expect(layer.kind).toBe("adjust");
    expect(layer.adjust).toBe(state);
    const surface = layer.surface as unknown as StubCanvas;
    expect(surface.width).toBe(1);
    expect(surface.height).toBe(1);
  });

  it("createMask 生成文档尺寸的画布", () => {
    const mask = createMask(24, 16) as unknown as StubCanvas;
    expect(mask.width).toBe(24);
    expect(mask.height).toBe(16);
  });

  it("cloneLayer 换新 id 且深拷贝 surface / adjust", () => {
    const src = createAdjustLayer("曲线", newAdjustState("curves"));
    const copy = cloneLayer(src);
    expect(copy.id).not.toBe(src.id);
    expect(copy.adjust).not.toBe(src.adjust);
    expect(copy.surface).not.toBe(src.surface);
    copy.adjust!.curve![0].y = 0.8;
    expect(src.adjust!.curve![0].y).toBe(0);
  });

  it("dupLayer 保留原 id（历史栈回填用）", () => {
    const src = createLayer(10, 10, "A");
    const copy = dupLayer(src);
    expect(copy.id).toBe(src.id);
    expect(copy.surface).not.toBe(src.surface);
  });
});

describe("图层样式", () => {
  it("STYLE_DEFS 非空且 id 唯一，STROKE_POSITIONS 固定三档", () => {
    expect(STYLE_DEFS.length).toBeGreaterThan(0);
    const ids = STYLE_DEFS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...STROKE_POSITIONS]).toEqual(["外", "内", "居中"]);
  });

  it("styleDef 未知 id 回退到首条", () => {
    expect(styleDef("nope" as StyleId).id).toBe(STYLE_DEFS[0].id);
    expect(styleDef("stroke").position).toBe(true);
  });

  it("newLayerStyle 按定义填默认值且默认启用", () => {
    const s = newLayerStyle("stroke");
    const def = styleDef("stroke");
    expect(s.enabled).toBe(true);
    expect(s.color).toBe(def.color);
    expect(s.size).toBe(def.size0);
    expect(s.opacity).toBe(def.opacity0);
    expect(s.position).toBe(0);
  });
});
