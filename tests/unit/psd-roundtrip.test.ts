/**
 * PSD 桥接层「纯数据层」往返测试（六项差距全修 · 第 1 项 · 写侧重修）。
 *
 * 与 psd-bridge.test.ts 一样遵守项目约定：不调用 writePsd / readPsd，不碰真实
 * 浏览器 Canvas。readNode / nodeToPsd 内部构造图层时会调 createSurface，这里用
 * tests/helpers/canvas.ts 的确定性 DOM 替身顶上；断言只验证「数据结构」是否
 * 往返一致（层顺序 / 嵌套 / 属性 / 参数 / 警告），不验证任何像素内容。
 *
 * 走的是真实的写侧链路：buildPsdForest → nodeToPsd（含 reverse 逆序）生成
 * PSD 中间结构，再逆序喂给 readNode 读回，与 encodeDocToPsd / decodePsdToDoc
 * 用的是同一套结构转换代码。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Layer as PsdLayer } from "ag-psd";
import {
  buildPsdForest,
  nodeToPsd,
  readNode,
  PSD_UNMAPPABLE_ADJUSTMENTS,
} from "../../src/engine/psd";
import {
  createAdjustLayer,
  createGroupLayer,
  createLayer,
  createMask,
  newAdjustState,
  initiallyCollapsedGroupIds,
  type AdjustState,
  type BlendId,
  type StrataLayer,
} from "../../src/core/layer";
import { defaultTextState } from "../../src/engine/text";
import { createSurface } from "../../src/engine/surface";
import { installDomStub, type DomStub } from "../helpers/canvas";

const W = 8;
const H = 6;

/** 桥接层用透明扩展字段承载组展开状态，测试里按同一约定读写。 */
type LayerWithOpened = StrataLayer & { opened?: boolean };

let dom: DomStub;

beforeEach(() => {
  dom = installDomStub();
});

afterEach(() => {
  dom.restore();
});

/** 写侧 → 读侧的一整趟往返，返回读回的图层栈、PSD 中间结构与警告。 */
function roundTrip(layers: StrataLayer[]): {
  out: StrataLayer[];
  children: PsdLayer[];
  warnings: string[];
} {
  const warnings: string[] = [];
  // 与 encodeDocToPsd 一致：森林自下而上 → PSD children 自上而下
  const children = [...buildPsdForest(layers)]
    .reverse()
    .map((n) => nodeToPsd(n, W, H, warnings));
  // 与 decodePsdToDoc 一致：PSD children 自上而下 → Strata 自下而上
  const out: StrataLayer[] = [];
  for (const node of [...children].reverse()) {
    readNode(node, W, H, null, out);
  }
  return { out, children, warnings };
}

function byName(layers: StrataLayer[], name: string): StrataLayer {
  const found = layers.find((l) => l.name === name);
  if (!found) throw new Error(`往返结果里没有名为「${name}」的图层`);
  return found;
}

describe("encode → decode 纯数据往返", () => {
  it("扁平层 + 两层嵌套组：层顺序、parent 链、可见性/不透明度/混合/锁定/剪贴/展开状态全部往返", () => {
    const bg = createLayer(W, H, "背景");

    const g1 = createGroupLayer("组1");
    g1.visible = false;
    g1.opacity = 70;
    g1.blend = "multiply";
    g1.locked = true;
    (g1 as LayerWithOpened).opened = false;

    const c1 = createLayer(W, H, "子1");
    c1.parent = g1.id;
    c1.opacity = 45;
    c1.visible = false;

    const g2 = createGroupLayer("组2");
    g2.parent = g1.id;
    (g2 as LayerWithOpened).opened = true;

    const c2 = createLayer(W, H, "子2");
    c2.parent = g2.id;
    c2.blend = "screen";
    c2.clip = true;

    const top = createLayer(W, H, "顶层");

    const { out } = roundTrip([bg, g1, c1, g2, c2, top]);

    // 层顺序（自下而上）不变
    expect(out.map((l) => l.name)).toEqual([
      "背景",
      "组1",
      "子1",
      "组2",
      "子2",
      "顶层",
    ]);

    const rBg = byName(out, "背景");
    const rG1 = byName(out, "组1");
    const rC1 = byName(out, "子1");
    const rG2 = byName(out, "组2");
    const rC2 = byName(out, "子2");
    const rTop = byName(out, "顶层");

    // 组嵌套：parent 链按新生成的 id 重建，仍是 组1 → {子1, 组2 → 子2}
    expect(rBg.parent).toBeNull();
    expect(rTop.parent).toBeNull();
    expect(rC1.parent).toBe(rG1.id);
    expect(rG2.parent).toBe(rG1.id);
    expect(rC2.parent).toBe(rG2.id);
    expect(rG1.kind).toBe("group");
    expect(rG2.kind).toBe("group");

    // 可见性 / 不透明度 / 混合 / 锁定 / 剪贴
    expect(rG1.visible).toBe(false);
    expect(rG1.opacity).toBe(70);
    expect(rG1.blend).toBe("multiply");
    expect(rG1.locked).toBe(true);
    expect(rC1.visible).toBe(false);
    expect(rC1.opacity).toBe(45);
    expect(rC2.blend).toBe("screen");
    expect(rC2.clip).toBe(true);

    // 组展开状态
    expect((rG1 as LayerWithOpened).opened).toBe(false);
    expect((rG2 as LayerWithOpened).opened).toBe(true);
  });

  it("多种混合模式往返一致（kebab-case ↔ 空格串）", () => {
    const ids: BlendId[] = [
      "normal",
      "multiply",
      "screen",
      "overlay",
      "color-burn",
      "hue",
      "divide",
    ];
    const layers = ids.map((b, i) => {
      const l = createLayer(W, H, `blend-${i}`);
      l.blend = b;
      return l;
    });
    const { out } = roundTrip(layers);
    out.forEach((l, i) => expect(l.blend).toBe(ids[i]));
  });

  it("文字层：内容 / 位置 / 字号 / 粗体 / 对齐 / 颜色 / 竖排 / 段落宽度往返", () => {
    const t = createLayer(W, H, "文字");
    t.text = defaultTextState(3, 4);
    t.text.content = "你好 Strata";
    t.text.settings.size = 24;
    t.text.settings.bold = true;
    t.text.settings.align = "center";
    t.text.color = "#ff8800";
    t.text.orientation = "vertical";
    t.text.boxWidth = 100;

    const { out } = roundTrip([t]);
    const back = byName(out, "文字");
    expect(back.kind).toBe("pixel");
    expect(back.text).toBeTruthy();
    expect(back.text?.content).toBe("你好 Strata");
    expect(back.text?.x).toBe(3);
    expect(back.text?.y).toBe(4);
    expect(back.text?.settings.size).toBe(24);
    expect(back.text?.settings.bold).toBe(true);
    expect(back.text?.settings.align).toBe("center");
    expect(back.text?.settings.lineHeight).toBeCloseTo(1.25, 5);
    expect(back.text?.color).toBe("#ff8800");
    expect(back.text?.orientation).toBe("vertical");
    expect(back.text?.boxWidth).toBe(100);
  });

  it("蒙版：存在性与启用状态往返（像素内容由 DOM 替身占位，不测光栅化）", () => {
    const a = createLayer(W, H, "启用蒙版");
    a.mask = createMask(W, H);
    a.maskActive = true;
    const b = createLayer(W, H, "停用蒙版");
    b.mask = createMask(W, H);
    b.maskActive = false;

    const { out } = roundTrip([a, b]);
    const ra = byName(out, "启用蒙版");
    const rb = byName(out, "停用蒙版");
    expect(ra.mask).not.toBeNull();
    expect(ra.maskActive).toBe(true);
    expect(rb.mask).not.toBeNull();
    expect(rb.maskActive).toBe(false);
  });

  it("可无损往返的调整层参数：14 类 id / params / 色标逐字段一致", () => {
    const cases: { name: string; state: AdjustState }[] = [];
    const mk = (name: string, id: Parameters<typeof newAdjustState>[0]): AdjustState => {
      const s = newAdjustState(id);
      cases.push({ name, state: s });
      return s;
    };

    const bc = mk("亮度对比度", "bc");
    bc.params.brightness = 20;
    bc.params.contrast = -15;

    const lv = mk("色阶", "levels");
    Object.assign(lv.params, {
      inBlack: 10,
      inWhite: 240,
      gamma: 120,
      outBlack: 5,
      outWhite: 250,
    });

    const ex = mk("曝光", "exposure");
    Object.assign(ex.params, { exposure: 1.5, offset: 0.2, gamma: 0.8 });

    const vb = mk("自然饱和度", "vibrance");
    vb.params.vibrance = 30;
    vb.params.saturation = -10;

    const hs = mk("色相简版", "hs");
    hs.params.hue = 45;
    hs.params.saturate = 20;

    const huesat = mk("色相全功能", "huesat");
    Object.assign(huesat.params, {
      hue: 10,
      saturate: 5,
      lightness: -5,
      colorize: 1,
      redHue: 12,
      redSat: 8,
      redLight: -3,
      blueHue: -20,
      blueSat: 15,
      magentaLight: 7,
    });

    const cb = mk("色彩平衡", "colorbalance");
    Object.assign(cb.params, {
      shcr: 10,
      shmg: -5,
      shyb: 3,
      mdcr: -8,
      mdmg: 6,
      mdyb: -2,
      hicr: 4,
      himg: -9,
      hiyb: 11,
    });

    const bwk = mk("黑白权重", "blackwhite");
    Object.assign(bwk.params, {
      red: 50,
      yellow: 60,
      green: 40,
      cyan: 30,
      blue: 20,
      magenta: 80,
    });

    const cm = mk("通道混合器", "channelmixer");
    Object.assign(cm.params, {
      rr: 110, rg: -10, rb: 5, rc: 2,
      gr: 4, gg: 90, gb: -3, gc: 1,
      br: -6, bg: 8, bb: 95, bc: 0,
    });

    const gm = mk("渐变映射", "gradientmap");
    gm.stops = [
      { at: 0, color: "#112233" },
      { at: 0.5, color: "#aabbcc" },
      { at: 1, color: "#ffffff" },
    ];

    mk("反相", "invert");
    const pz = mk("色调分离", "posterize");
    pz.params.levels = 8;
    const th = mk("阈值", "threshold");
    th.params.level = 200;
    mk("简单灰度", "bw");

    const layers = cases.map((c) => createAdjustLayer(c.name, c.state));
    const { out } = roundTrip(layers);

    for (const { name, state } of cases) {
      const back = byName(out, name);
      expect(back.kind, name).toBe("adjust");
      expect(back.adjust, name).toBeTruthy();
      expect(back.adjust?.id, name).toBe(state.id);
      expect(back.adjust?.params, name).toEqual(state.params);
      if (state.stops) expect(back.adjust?.stops, name).toEqual(state.stops);
    }
  });

  it("curves：复合曲线 + 分通道曲线往返（0–255 量化用容差比较）", () => {
    const s = newAdjustState("curves");
    s.curve = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.75 },
      { x: 1, y: 1 },
    ];
    s.curveR = [
      { x: 0, y: 0 },
      { x: 1, y: 0.8 },
    ];
    const { out } = roundTrip([createAdjustLayer("曲线", s)]);
    const back = byName(out, "曲线").adjust;
    expect(back?.id).toBe("curves");
    expect(back?.curve).toHaveLength(3);
    expect(back?.curveR).toHaveLength(2);
    expect(back?.curveG).toBeUndefined();
    expect(back?.curveB).toBeUndefined();
    const comp = s.curve;
    const r = s.curveR;
    back?.curve?.forEach((p, i) => {
      expect(p.x).toBeCloseTo(comp[i].x, 1);
      expect(p.y).toBeCloseTo(comp[i].y, 1);
    });
    back?.curveR?.forEach((p, i) => {
      expect(p.x).toBeCloseTo(r[i].x, 1);
      expect(p.y).toBeCloseTo(r[i].y, 1);
    });
  });

  it("photofilter：浓度 / 保留明度精确往返，色相经 RGB 中转近似还原", () => {
    const s = newAdjustState("photofilter");
    s.params.hue = 40;
    s.params.strength = 65;
    s.params.preserve = 100;
    const { out } = roundTrip([createAdjustLayer("照片滤镜", s)]);
    const back = byName(out, "照片滤镜").adjust;
    expect(back?.id).toBe("photofilter");
    expect(back?.params.strength).toBe(65);
    expect(back?.params.preserve).toBe(100);
    expect(Math.abs((back?.params.hue ?? 0) - 40)).toBeLessThanOrEqual(2);
  });

  it("未显式设置 opened 的组缺省为展开，往返后仍为 true", () => {
    const g = createGroupLayer("默认组");
    const c = createLayer(W, H, "组内子层");
    c.parent = g.id;
    const { out } = roundTrip([g, c]);
    expect((byName(out, "默认组") as LayerWithOpened).opened).toBe(true);
  });
});

describe("10 类无等价物调整层的降级", () => {
  it("warnings 逐条列出层名 + 降级原因；烤平像素优先保留，否则透明占位", () => {
    const bg = createLayer(W, H, "背景");
    const a1 = createAdjustLayer("色温", newAdjustState("colortemp"));
    const a2 = createAdjustLayer("已烤平", newAdjustState("equalize"));
    // 模拟该调整层已被烤平过：surface 达到文档尺寸
    a2.surface = createSurface(W, H);

    const { out, children, warnings } = roundTrip([bg, a1, a2]);

    expect(warnings).toHaveLength(2);
    expect(
      warnings.some(
        (w) => w.includes("色温") && w.includes("colortemp") && w.includes("无 PSD 等价"),
      ),
    ).toBe(true);
    expect(
      warnings.some(
        (w) => w.includes("已烤平") && w.includes("equalize") && w.includes("无 PSD 等价"),
      ),
    ).toBe(true);
    // 每条都不只是名字，还带括号里的降级原因
    for (const w of warnings) expect(w).toMatch(/（.+）/);

    // 烤平像素被保留（canvas 就是原 surface），透明占位是新建的
    const baked = children.find((c) => c.name.includes("已烤平"));
    const placeholder = children.find((c) => c.name.includes("色温"));
    expect(baked?.canvas).toBe(a2.surface);
    expect(placeholder?.canvas).not.toBe(a1.surface);

    // 降级占位层读回为普通像素层（效果不写入，但层不丢）
    const back = out.find((l) => l.name.includes("色温"));
    expect(back?.kind).toBe("pixel");
    expect(back?.name).toContain("效果未写入");
  });

  it("同名降级层也逐条列出，不再去重静默吞掉", () => {
    const a = createAdjustLayer("色温", newAdjustState("colortemp"));
    const b = createAdjustLayer("色温", newAdjustState("colortemp"));
    const { warnings } = roundTrip([a, b]);
    expect(warnings).toHaveLength(2);
    expect(warnings.every((w) => w.includes("色温") && w.includes("colortemp"))).toBe(true);
  });

  it("10 类无等价物清单每一项都产出带原因的警告", () => {
    const layers = PSD_UNMAPPABLE_ADJUSTMENTS.map((id, i) =>
      createAdjustLayer(`无等价物-${i}`, newAdjustState(id as Parameters<typeof newAdjustState>[0])),
    );
    const { warnings } = roundTrip(layers);
    expect(warnings).toHaveLength(PSD_UNMAPPABLE_ADJUSTMENTS.length);
    for (const id of PSD_UNMAPPABLE_ADJUSTMENTS) {
      expect(warnings.some((w) => w.includes(id) && w.includes("无 PSD 等价"))).toBe(true);
    }
  });
});

describe("组展开状态接入 UI 的可测部分", () => {
  it("opened:false 的组会被当作初始折叠，往返读回仍成立", () => {
    const closed = createGroupLayer("折叠组");
    closed.opened = false;
    const open = createGroupLayer("展开组");
    open.opened = true;
    const unset = createGroupLayer("缺省组");
    const pixel = createLayer(W, H, "像素层");
    pixel.opened = false; // 非组图层即便带 opened 也不参与面板折叠

    // 纯 helper：只收显式 opened === false 的组，其余维持展开
    expect(initiallyCollapsedGroupIds([closed, open, unset, pixel])).toEqual([closed.id]);

    // 往返读回：PSD 写回的 opened=false 被同一 helper 认作初始折叠
    const child = createLayer(W, H, "组内子层");
    child.parent = closed.id;
    const { out } = roundTrip([closed, child]);
    const back = byName(out, "折叠组");
    expect(back.kind).toBe("group");
    expect(back.opened).toBe(false);
    expect(initiallyCollapsedGroupIds(out)).toContain(back.id);
  });
});
