/**
 * 笔画引擎的连续性测试。
 *
 * 这是对「画笔画出来是一串孤立的点」那类回归的防线：笔尖间距只由半径与
 * 间距百分比决定，与指针事件频率无关；抬笔时虚拟光标会被吸附到最后一个
 * 输入点，末端不留缺口。
 *
 * 节点环境没有真画布，这里用确定性替身记录**每一次落笔的圆心**，
 * 只验证几何与控制流，不验证像素（像素正确性属于 Rust 合成内核与 e2e）。
 */
import { vi } from "vitest";
import { installDomStub, StubContext2D } from "../helpers/canvas";
import { DEFAULT_BRUSH, Stroke } from "../../src/engine/paint";

const W = 480;
const H = 400;

/** 一笔在图层的合成目标（替身即可，finish 只往里 drawImage）。 */
function layer(): HTMLCanvasElement {
  return document.createElement("canvas") as unknown as HTMLCanvasElement;
}

/** 笔画缓冲上记录到的落笔圆心（顺序即落笔顺序）。 */
function dabCenters(stroke: Stroke): { x: number; y: number }[] {
  const buf = stroke.buffer as unknown as { __ctx: StubContext2D | null };
  const ctx = buf.__ctx;
  if (!ctx) return [];
  const out: { x: number; y: number }[] = [];
  for (const a of ctx.drawImageCalls) {
    // drawImage(tip, x - w/2, y - w/2, w, w) —— 圆心在左上角加半个身位
    const dx = a[1] as number;
    const dy = a[2] as number;
    const w = a[3] as number;
    out.push({ x: dx + w / 2, y: dy + w / 2 });
  }
  return out;
}

/** 笔画缓冲上记录到的笔尖直径（drawImage 的第 4 个实参）。 */
function dabWidths(stroke: Stroke): number[] {
  const buf = stroke.buffer as unknown as { __ctx: StubContext2D | null };
  return (buf.__ctx?.drawImageCalls ?? []).map((a) => a[3] as number);
}

/** 相邻落笔圆心的最大间距。 */
function maxGap(pts: { x: number; y: number }[]): number {
  let g = 0;
  for (let i = 1; i < pts.length; i += 1) {
    g = Math.max(g, Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  return g;
}

/** 沿一条横向正弦曲线取 n 个点，x 从 40 走到 440。 */
function squiggle(n: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    out.push({ x: 40 + t * 400, y: 200 + 60 * Math.sin(t * Math.PI * 3) });
  }
  return out;
}

/** 沿直线取 n 个点。 */
function straight(n: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    out.push({ x: 40 + t * 400, y: 200 });
  }
  return out;
}

/** L 形 90° 硬折角：先向右 180px，再向下 180px。 */
function corner(n: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const half = Math.floor(n / 2);
  for (let i = 0; i < half; i += 1) out.push({ x: 60 + (i / half) * 180, y: 120 });
  for (let i = 0; i <= n - half; i += 1) out.push({ x: 240, y: 120 + (i / (n - half)) * 180 });
  return out;
}

/**
 * 折线在每个顶点处的最大转向角（度）。
 *
 * 这是「转角被磨圆了没有」的量化指标：把输入点直接连成折线时，转轴处的角度
 * 会很尖；而先做时间低通、再按距离投放笔尖的笔迹，角度会被摊到好多个笔尖上。
 * 平滑之后若某处仍接近 90°，肉眼看到的就是一条棱。
 */
function maxTurn(pts: { x: number; y: number }[]): number {
  let worst = 0;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const ax = pts[i].x - pts[i - 1].x;
    const ay = pts[i].y - pts[i - 1].y;
    const bx = pts[i + 1].x - pts[i].x;
    const by = pts[i + 1].y - pts[i].y;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la < 1e-6 || lb < 1e-6) continue;
    const cos = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb)));
    worst = Math.max(worst, (Math.acos(cos) * 180) / Math.PI);
  }
  return worst;
}

/** 按给定时间步长把一串点喂进一笔。 */
function draw(
  stroke: Stroke,
  pts: { x: number; y: number }[],
  stepMs: number,
): void {
  stroke.begin(pts[0].x, pts[0].y, 0.5, 0);
  for (let i = 1; i < pts.length; i += 1) {
    stroke.extend(pts[i].x, pts[i].y, 0.5, i * stepMs);
  }
}

describe("Stroke 连续性", () => {
  let dom: ReturnType<typeof installDomStub>;

  beforeEach(() => {
    dom = installDomStub();
  });
  afterEach(() => {
    dom.restore();
  });

  it("替身具备笔迹断言所需的能力（画布 / arc / 渐变）", () => {
    const c = document.createElement("canvas") as unknown as StubContext2D["canvas"];
    expect(dom.created.length).toBe(1);
    const ctx = c.getContext("2d") as StubContext2D;
    expect(ctx).not.toBeNull();
    // 笔迹连续性靠 arcCalls（矢量笔尖）与 drawImageCalls（贴图笔尖）反推落点
    ctx.arc(10, 20, 3);
    expect(ctx.arcCalls[0]).toEqual({ x: 10, y: 20, r: 3 });
    expect(ctx.createRadialGradient()).toBeTruthy();
    expect(ctx.createLinearGradient()).toBeTruthy();
  });

  it("按住快拖：笔尖密到看不出颗粒，绝不出现孤立圆点", () => {
    const s = new Stroke(W, H, DEFAULT_BRUSH, false);
    draw(s, squiggle(41), 16); // 41 个事件 / 640ms，约 500px/s 的鼠标速度

    const pts = dabCenters(s);
    // 半径 13.6、间距 8% → 相邻圆心约 2.2px；一整条 400px 的曲线应有上百个笔尖
    expect(pts.length).toBeGreaterThan(120);
    // 关键断言：任意相邻两个笔尖都远小于笔尖半径，视觉上必然连成一条线
    expect(maxGap(pts)).toBeLessThan(4);
  });

  it("事件稀疏（10 个点跨 640ms）也不会断成虚线", () => {
    const s = new Stroke(W, H, DEFAULT_BRUSH, false);
    draw(s, squiggle(10), 64);

    const pts = dabCenters(s);
    expect(maxGap(pts)).toBeLessThan(4);
  });

  it("时间戳退化（同值 / 零 / 缺失）也按名义间隔推进，绝不挤成孤点", () => {
    const path = squiggle(41);
    // 某些运行时把 getCoalescedEvents 的 timeStamp 一律填成同一个值，甚至
    // 0 或 NaN。时间低通一旦照单全收，虚拟光标会被钉死在原地，笔尖全挤在
    // 一处分不出彼此 —— 那正是「一连串孤立圆点」的成因。
    for (const bad of [0, 12345, Number.NaN]) {
      const s = new Stroke(W, H, DEFAULT_BRUSH, false);
      s.begin(path[0].x, path[0].y, 0.5, bad);
      for (let i = 1; i < path.length; i += 1) {
        s.extend(path[i].x, path[i].y, 0.5, bad);
      }
      const pts = dabCenters(s);
      expect(pts.length).toBeGreaterThan(120);
      expect(maxGap(pts)).toBeLessThan(4);
    }
  });

  it("落笔密度与事件频率无关：密采样与疏采样的笔尖数相近", () => {
    const dense = new Stroke(W, H, DEFAULT_BRUSH, false);
    draw(dense, straight(161), 4);
    const sparse = new Stroke(W, H, DEFAULT_BRUSH, false);
    draw(sparse, straight(11), 64);

    const a = dabCenters(dense).length;
    const b = dabCenters(sparse).length;
    expect(a).toBeGreaterThan(120);
    // 「一个事件盖一个章」的老写法在这里会差 15 倍，这里必须几乎相等
    expect(Math.abs(a - b) / a).toBeLessThan(0.2);
  });

  it("抬笔冲刷：末端笔尖落在最后一个输入点附近，不留缺口", () => {
    const path = squiggle(41);
    const s = new Stroke(W, H, DEFAULT_BRUSH, false);
    draw(s, path, 16);
    s.finish(layer());

    const pts = dabCenters(s);
    const last = pts[pts.length - 1];
    const want = path[path.length - 1];
    expect(Math.hypot(last.x - want.x, last.y - want.y)).toBeLessThan(5);
  });

  it("单击就是一个点：落笔即抬笔只留下 1 个笔尖", () => {
    const s = new Stroke(W, H, DEFAULT_BRUSH, false);
    s.begin(123, 77, 0.5, 0);
    s.finish(layer());

    const pts = dabCenters(s);
    expect(pts.length).toBe(1);
    expect(Math.hypot(pts[0].x - 123, pts[0].y - 77)).toBeLessThan(1.5);
  });

  it("细笔（1px）走矢量圆路径，同样连续", () => {
    const s = new Stroke(W, H, { ...DEFAULT_BRUSH, size: 1 }, false);
    draw(s, squiggle(41), 16);
    s.finish(layer());

    const buf = s.buffer as unknown as { __ctx: StubContext2D | null };
    const arcs = buf.__ctx?.arcCalls ?? [];
    // 半径不足 2px 时不再缩放贴图，改画矢量圆；点要够密才连成线
    expect(arcs.length).toBeGreaterThan(200);
    // 贴图路径不该被用到
    expect(dabCenters(s).length).toBe(0);
    let g = 0;
    for (let i = 1; i < arcs.length; i += 1) {
      g = Math.max(g, Math.hypot(arcs[i].x - arcs[i - 1].x, arcs[i].y - arcs[i - 1].y));
    }
    expect(g).toBeLessThan(1);
  });

  it("间距调大是唯一会拉开笔尖的手段，且仍小于直径", () => {
    const s = new Stroke(W, H, { ...DEFAULT_BRUSH, spacing: 50 }, false);
    draw(s, straight(41), 16);

    const pts = dabCenters(s);
    const radius = (DEFAULT_BRUSH.size / 2) * 0.85;
    // 间距 50% → 相邻圆心 ≈ 半径；这是「有意的稀疏」，不会大于直径
    expect(maxGap(pts)).toBeLessThanOrEqual(radius * 1.2);
  });

  it("转角被磨圆：笔迹的折角显著小于原始采样点连成的折线", () => {
    // 这是「画笔有棱角」的直接防线。把输入点直接连起来画（不做时间低通）
    // 时，笔迹的转角就等于输入的转角；平滑之后必须被明显摊平。
    for (const [n, ms] of [[41, 16], [21, 32], [11, 64]] as const) {
      const path = squiggle(n);
      const s = new Stroke(W, H, DEFAULT_BRUSH, false);
      draw(s, path, ms);

      const pts = dabCenters(s);
      expect(pts.length).toBeGreaterThan(120);
      expect(maxTurn(pts)).toBeLessThan(maxTurn(path) * 0.6);
    }
  });

  it("60Hz 快拖下单个折角不超过 9°，肉眼不成棱", () => {
    const s = new Stroke(W, H, DEFAULT_BRUSH, false);
    draw(s, squiggle(41), 16);

    // 实测 7.5°；直接连折线是 18.8°。阈值给到 9° 留出余量但不放水。
    expect(maxTurn(dabCenters(s))).toBeLessThan(9);
  });

  it("90° 硬折角被摊成弧：不再是一个尖角", () => {
    const path = corner(81);
    const s = new Stroke(W, H, DEFAULT_BRUSH, false);
    draw(s, path, 16);

    const turn = maxTurn(dabCenters(s));
    // 输入的拐点就是 90°；平滑后必须落在这个数的一半以下
    expect(turn).toBeLessThan(45);
    // 实测 15.8°，阈值放到 25° 仍足以抓住「棱角回归」
    expect(turn).toBeLessThan(25);
  });
});

/**
 * 画笔设置面板里的每个动态参数都必须真的作用在落笔上。
 *
 * 这些用例只数「笔尖个数 / 直径 / 圆心」，随机源统一用 vi.spyOn 固定，
 * 断言的是可预测的行为边界，而不是某一串随机数恰好长成什么样。
 */
describe("Stroke 动态参数", () => {
  let dom: ReturnType<typeof installDomStub>;

  beforeEach(() => {
    dom = installDomStub();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    dom.restore();
  });

  it("散布数量：单击按设定值撒出 N 个笔尖", () => {
    const s = new Stroke(W, H, { ...DEFAULT_BRUSH, scatterCount: 5 }, false);
    s.begin(240, 200, 0.5, 0);
    s.finish(layer());

    expect(dabCenters(s).length).toBe(5);
  });

  it("散布数量抖动只往下削：实际数量恒在 [1, 设定值] 内", () => {
    const random = vi.spyOn(Math, "random");
    // 每个笔尖只消耗一个随机数：0 → 满额，0.5 → 3 个，0.99 → 只剩 1 个
    const seq = [0, 0.5, 0.99];
    let i = 0;
    random.mockImplementation(() => seq[i++ % seq.length]);

    const counts = seq.map(() => {
      const s = new Stroke(
        W,
        H,
        { ...DEFAULT_BRUSH, scatterCount: 6, scatterCountJitter: 100 },
        false,
      );
      s.begin(200, 200, 0.5, 0);
      s.finish(layer());
      return dabCenters(s).length;
    });

    expect(counts).toEqual([6, 3, 1]);
  });

  it("大小抖动只把笔尖缩小，绝不越过基础直径", () => {
    const path = straight(41);
    const drawWith = (sizeJitter: number): number[] => {
      const s = new Stroke(W, H, { ...DEFAULT_BRUSH, sizeJitter, sizeMin: 0 }, false);
      draw(s, path, 16);
      s.finish(layer());
      return dabWidths(s);
    };

    const base = drawWith(0);
    const random = vi.spyOn(Math, "random");

    random.mockReturnValue(0); // keep = 1：抖动开到 100% 也不会变大
    const full = drawWith(100);
    expect(full.length).toBe(base.length);
    full.forEach((w, k) => expect(w).toBeCloseTo(base[k], 6));

    random.mockReturnValue(0.5); // keep = 0.5：直径正好减半
    const half = drawWith(100);
    expect(half.length).toBe(base.length);
    half.forEach((w, k) => expect(w).toBeCloseTo(base[k] * 0.5, 6));
  });

  it("关闭双轴散布后只沿笔迹法线甩开：水平笔迹的 x 不跑偏", () => {
    const path = straight(41);
    const plain = new Stroke(W, H, DEFAULT_BRUSH, false);
    draw(plain, path, 16);
    const base = dabCenters(plain);

    vi.spyOn(Math, "random").mockReturnValue(0.75); // 偏移量恒为 +0.5 × 半径
    const s = new Stroke(
      W,
      H,
      { ...DEFAULT_BRUSH, jitter: 100, scatterBothAxes: false },
      false,
    );
    draw(s, path, 16);
    const pts = dabCenters(s);

    expect(pts.length).toBe(base.length);
    pts.forEach((p, k) => {
      expect(p.x).toBeCloseTo(base[k].x, 6);
      // 水平笔迹的法线是竖直方向：笔尖只该往线的两侧甩
      expect(p.y).toBeGreaterThan(base[k].y);
    });
  });
});
