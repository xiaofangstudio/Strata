/**
 * 调色台面板（对齐达芬奇 Resolve 的 Color 页）。
 *
 * 四个子页共用同一份参数，落在**一张「调色台」调整层**上：
 *   一级 —— 白平衡 / 对比度轴心 / Lift·Gamma·Gain / 阴影高光饱和色相
 *   色轮 —— 暗部·阴影·亮部·全局 四个色轮 + 曝光 / 饱和
 *   切片器 —— 红·皮肤·黄·绿·青·蓝·品红 七段色相各自微调
 *   曲线 —— RGB 复合 + 分通道
 *
 * 为什么做成调整层而不是直接改像素：非破坏、可继续叠别的层、随文档保存，
 * 而且每次松手落一条历史 —— Ctrl+Z 天然覆盖。
 *
 * 排版上吃过窄面板的亏：卡片分组、宽面板自动两列、所有网格列都可压缩，
 * 再窄也不会把数字框顶出可视区。
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { composeForDisplay } from "../../engine/displayCompose";
import { createSurface, mustCtx } from "../../engine/surface";
import {
  curveOf,
  setCurveOf,
  type AdjustState,
  type CurveChannel,
  type StrataLayer,
} from "../../core/layer";
import {
  addLocalGradeLayer,
  applyGradeWindow,
  setAdjust,
  toggleMaskActive,
  updateLayer,
  type LocalGradeKind,
} from "../../core/layerOps";
import { DEFAULT_FEATHER, quadEdgeFeathers, type GradeWindow } from "../../core/gradeWindow";
import type { StrataDoc } from "../../core/document";
import {
  GRADE_PARAMS,
  GRADE_WHEELS,
  SLICER_RANGES,
  neutralGrade,
} from "../../engine/grading";
import "./GradePanel.css";

interface Props {
  doc: StrataDoc;
  layer: StrataLayer;
  /** 点「钢笔」时：新建一个空范围的调色层并进入逐点绘制 */
  onStartPen: () => void;
  /** 文档里所有调色层（二级页的范围列表用） */
  layers: StrataLayer[];
  /** 点范围列表里的一项：切到那一层 */
  onSelectLayer: (id: string) => void;
  /** 显示 / 隐藏某个调色层 */
  onToggleVisible: (id: string, nextVisible: boolean) => void;
  /** 删除某个调色层 */
  onDeleteLayer: (id: string) => void;
  /** 落一条历史（松手 / 输入完成时） */
  onChange: (next: StrataDoc, label: string) => void;
  /** 只改画面不入栈（拖动过程中） */
  onPreview: (next: StrataDoc) => void;
}

type Tab = "primary" | "wheel" | "slicer" | "curve";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "primary", label: "基础", icon: "◐" },
  { id: "wheel", label: "色轮", icon: "◍" },
  { id: "slicer", label: "切片器", icon: "◈" },
  { id: "curve", label: "曲线", icon: "∿" },
];

/** 曲线控制点（与 core/layer 的 CurvePoint 结构一致，这里只用到 x / y）。 */
interface CurvePoint {
  x: number;
  y: number;
}

/* ---------------------------------------------------------------- 预设 */

interface Preset {
  id: string;
  label: string;
  /** 相对中性的参数覆盖 */
  patch: Record<string, number>;
}

const PRESETS: Preset[] = [
  { id: "reset", label: "还原（全部中性）", patch: {} },
  { id: "warm", label: "暖调 · 阳光", patch: { temp: 26, tint: 5, sat: 8, shadow: 6 } },
  { id: "cool", label: "冷调 · 阴天", patch: { temp: -26, tint: -4, sat: 4, gainB: 6 } },
  {
    id: "cinema",
    label: "电影感 · 青橙",
    patch: { contrast: 16, pivot: 48, liftB: 14, gainR: 10, sat: -6, midDetail: 10 },
  },
  { id: "punch", label: "高对比 · 通透", patch: { contrast: 40, midDetail: 18, sat: 10 } },
  {
    id: "bw",
    label: "黑白 · 胶片",
    patch: { sat: -100, contrast: 20, liftR: 5, liftG: 5, liftB: 5, gammaR: 4, gammaG: 4 },
  },
  {
    id: "portrait",
    label: "人像 · 皮肤提亮",
    patch: { shadow: 12, highlight: -8, sl_skin_lum: 10, sl_skin_sat: -8, sat: 4 },
  },
  {
    id: "night",
    label: "夜景 · 压暗提蓝",
    patch: { shadow: -8, darkY: 60, sat: 6, contrast: 12 },
  },
];

/* ---------------------------------------------------------------- 主体 */

export default function GradePanel({
  doc,
  layer,
  onStartPen,
  layers,
  onSelectLayer,
  onToggleVisible,
  onDeleteLayer,
  onChange,
  onPreview,
}: Props) {
  const [tab, setTab] = useState<Tab>("primary");
  /**
   * 一级 = 全画面调色；二级 = 局部（范围）调色。
   *
   * 范围的「新建」与「范围列表」只在二级出现 —— 一级就是整张画面，
   * 放一堆画范围的按钮在那儿反而让人以为一级也要先圈范围。
   */
  const [level, setLevel] = useState<"primary" | "secondary">(
    layer.window ? "secondary" : "primary",
  );
  /**
   * 范围列表默认**收起**。
   *
   * 范围一多，这一列会越堆越长，把下面的调色参数（基础/色轮/切片器/曲线）
   * 一直往下顶 —— 那才是常用的地方。收成一行标题后，列表只在需要时展开，
   * 展开用 0fr→1fr 的高度过渡，不会"啪"地跳一下。
   */
  const [listOpen, setListOpen] = useState(false);
  const st = layer.adjust;
  const params = useMemo(
    () => ({ ...neutralGrade(), ...(st?.params ?? {}) }),
    [st?.params],
  );

  /** 对比原始：按住时临时把这一层关掉，松手恢复。 */
  const beforeRef = useRef<StrataDoc | null>(null);
  const [comparing, setComparing] = useState(false);
  const startCompare = () => {
    if (!st) return;
    beforeRef.current = doc;
    setComparing(true);
    onPreview(updateLayer(doc, layer.id, { visible: false }));
  };
  const endCompare = () => {
    const back = beforeRef.current;
    beforeRef.current = null;
    setComparing(false);
    if (back) onPreview(back);
  };

  /** 改参数：commit=false 只预览，true 才进历史。 */
  const patch = useCallback(
    (ids: Record<string, number>, label: string, commit: boolean) => {
      if (!st) return;
      const next: AdjustState = { ...st, params: { ...st.params, ...ids } };
      const doc2 = setAdjust(doc, layer.id, next);
      if (commit) onChange(doc2, label);
      else onPreview(doc2);
    },
    [doc, layer.id, st, onChange, onPreview],
  );

  /** 套用预设：整表替换（不是叠加），曲线保持不动。 */
  const applyPreset = useCallback(
    (p: Preset) => {
      if (!st) return;
      const base = neutralGrade();
      onChange(
        setAdjust(doc, layer.id, { ...st, params: { ...base, ...p.patch } }),
        `调色预设：${p.label}`,
      );
    },
    [doc, layer.id, st, onChange],
  );

  if (!st || st.id !== "grade") {
    return <p className="grade-empty">这个面板只服务于「调色台」调整层。</p>;
  }

  const dirty =
    Object.keys(params).some(
      (k) =>
        Math.abs((params[k] ?? 0) - (GRADE_PARAMS.find((d) => d.id === k)?.def ?? 0)) > 1e-6,
    ) || Boolean(st.curve || st.curveR || st.curveG || st.curveB);

  return (
    <div className="grade">
      {/* 顶栏：预设 + 对比原始 + 复位 */}
      <div className="grade-bar">
        <select
          className="grade-preset"
          aria-label="调色预设"
          value=""
          onChange={(e) => {
            const p = PRESETS.find((x) => x.id === e.currentTarget.value);
            if (p) applyPreset(p);
            e.currentTarget.value = "";
          }}
        >
          <option value="">预设…</option>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`grade-tool${comparing ? " is-on" : ""}`}
          title="按住查看原始画面（松手回来）"
          onPointerDown={startCompare}
          onPointerUp={endCompare}
          onPointerLeave={() => {
            if (comparing) endCompare();
          }}
        >
          对比原始
        </button>
        <button
          type="button"
          className="grade-tool"
          disabled={!dirty}
          title="把这一层调色全部复位"
          onClick={() =>
            onChange(
              setAdjust(doc, layer.id, {
                ...st,
                params: neutralGrade(),
                curve: undefined,
                curveR: undefined,
                curveG: undefined,
                curveB: undefined,
              }),
              "调色复位",
            )
          }
        >
          复位
        </button>
      </div>

      <div className="grade-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`grade-tab${tab === t.id ? " is-on" : ""}`}
            onClick={() => setTab(t.id)}
          >
            <span className="grade-tab-icon" aria-hidden="true">
              {t.icon}
            </span>
            {t.label}
          </button>
        ))}
      </div>

      <div className="grade-levels" role="tablist" aria-label="调色级别">
        <button
          type="button"
          role="tab"
          aria-selected={level === "primary"}
          className={`grade-level${level === "primary" ? " is-on" : ""}`}
          onClick={() => setLevel("primary")}
          title="整张画面一起调"
        >
          一级
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={level === "secondary"}
          className={`grade-level${level === "secondary" ? " is-on" : ""}`}
          onClick={() => setLevel("secondary")}
          title="只调圈出来的范围"
        >
          二级
        </button>
      </div>

      {level === "secondary" && (
        <>
          <RangeBar doc={doc} layer={layer} onStartPen={onStartPen} onChange={onChange} />

          {layers.length > 0 && (
            <div className={`gr-drop${listOpen ? " is-open" : ""}`}>
              <button
                type="button"
                className="gr-drop-head"
                aria-expanded={listOpen}
                onClick={() => setListOpen((v) => !v)}
                title={listOpen ? "收起范围列表" : "展开范围列表"}
              >
                <span className="gr-drop-caret" aria-hidden="true">
                  ▸
                </span>
                <span className="gr-drop-title">范围</span>
                <span className="gr-drop-count">{layers.length}</span>
                <span className="gr-drop-now">{layer.name}</span>
              </button>
              <div className="gr-drop-body">
                <div className="gr-drop-inner">
                  <RangeList
                    layers={layers}
                    activeId={layer.id}
                    onSelect={onSelectLayer}
                    onToggleVisible={onToggleVisible}
                    onDelete={onDeleteLayer}
                  />
                </div>
              </div>
            </div>
          )}
        </>
      )}

      <div className="grade-body">
        {tab === "primary" && <PrimaryPage params={params} patch={patch} />}
        {tab === "wheel" && <WheelPage params={params} patch={patch} />}
        {tab === "slicer" && <SlicerPage params={params} patch={patch} />}
        {tab === "curve" && (
          <CurvePage doc={doc} layer={layer} st={st} onChange={onChange} onPreview={onPreview} />
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- 调色范围 */

/**
 * 调色范围（达芬奇的 Power Window）。
 *
 * 这里是「加范围」的地方，而**加范围 = 加一层**：
 * 每点一个形状按钮就新建一个调色层（自带几何 + 蒙版），
 * 于是图层面板里的眼睛 / 删除 / 拖动排序，天然就是范围的开关 / 删除 / 先后。
 * 层里已经带范围时，这一条变成"当前范围"的参数（羽化 / 反转 / 停用 / 移除）。
 */
const SHAPES: { kind: LocalGradeKind; label: string; icon: string; hint: string }[] = [
  { kind: "line", label: "线性", icon: "╱", hint: "线性渐变：一条可拉长的线，两侧淡出（压天空/地面）" },
  { kind: "ellipse", label: "椭圆", icon: "◯", hint: "椭圆范围：四向把手改大小，可旋转" },
  { kind: "quad", label: "四边形", icon: "▱", hint: "四边形范围：拖一个角只动那个角，四条边各自羽化" },
  { kind: "poly", label: "钢笔", icon: "✎", hint: "多边形范围：逐点可拖（钢笔）" },
];

function RangeBar({
  doc,
  layer,
  onStartPen,
  onChange,
}: {
  doc: StrataDoc;
  layer: StrataLayer;
  onStartPen: () => void;
  onChange: (next: StrataDoc, label: string) => void;
}) {
  const win = layer.window;
  const maskOn = layer.maskActive !== false;
  const [feather, setFeather] = useState(win?.feather ?? DEFAULT_FEATHER);
  const shownFeather = win?.feather ?? feather;

  const setWin = (w: GradeWindow, label: string) =>
    onChange(applyGradeWindow(doc, layer.id, w), label);

  return (
    <div className="gr-stack">
      <div className="gr-range">
        <span className="gr-tag">新建范围</span>
        {SHAPES.map((s2) => (
          <button
            key={s2.kind}
            type="button"
            className="gr-shape"
            title={`${s2.hint}（会新建一个调色层）`}
            onClick={() =>
              // 钢笔要"点一下再点一下"地画，不能直接给个预置形状
              s2.kind === "poly"
                ? onStartPen()
                : onChange(addLocalGradeLayer(doc, s2.kind), `新建${s2.label}范围`)
            }
          >
            <span className="gr-shape-icon" aria-hidden="true">
              {s2.icon}
            </span>
            {s2.label}
          </button>
        ))}
      </div>

      {win?.kind === "quad" &&
        (() => {
          const fe = quadEdgeFeathers(win);
          return (
            <Card title="四条边羽化" hint="每条边独立">
              {fe.map((v, i) => (
                <GradeSlider
                  key={i}
                  label={`边 ${i + 1}`}
                  value={v}
                  min={0}
                  max={400}
                  onInput={() => {}}
                  onCommit={(nv) => {
                    const edges = [...fe];
                    edges[i] = Math.round(nv);
                    setWin({ ...win, edges }, `边 ${i + 1} 羽化 ${Math.round(nv)} px`);
                  }}
                  onReset={() => {
                    const edges = [...fe];
                    edges[i] = 0;
                    setWin({ ...win, edges }, `边 ${i + 1} 羽化 0`);
                  }}
                />
              ))}
            </Card>
          );
        })()}

      {win ? (
        <div className="gr-range is-on">
          <span className={maskOn ? "gr-tag is-on" : "gr-tag"}>
            {win.kind === "ellipse"
              ? "椭圆"
              : win.kind === "quad"
                ? "四边形"
                : win.kind === "line"
                  ? "线性"
                  : "钢笔"}
            {win.invert ? " · 反转" : ""}
            {maskOn ? "" : " · 停用"}
          </span>
          <div className="gr-feather">
            <GradeSlider
              label="羽化"
              value={shownFeather}
              min={0}
              max={400}
              onInput={(v) => setFeather(v)}
              onCommit={(v) => {
                setFeather(v);
                // 四边形：拖"统一羽化"等于把四条边一起设成这个值（清掉逐边覆盖）
                setWin(
                  win.kind === "quad"
                    ? { ...win, feather: Math.round(v), edges: undefined }
                    : { ...win, feather: Math.round(v) },
                  `范围羽化 ${Math.round(v)} px`,
                );
              }}
              onReset={() => {
                setFeather(0);
                setWin(
                  win.kind === "quad"
                    ? { ...win, feather: 0, edges: undefined }
                    : { ...win, feather: 0 },
                  "范围羽化 0",
                );
              }}
            />
          </div>
          <div className="gr-actions">
            {win.kind === "line" && (
              <button
                type="button"
                className="gr-btn"
                title="交换两端：渐变方向反过来（哪一边被调色）"
                onClick={() =>
                  setWin(
                    { ...win, x1: win.x2, y1: win.y2, x2: win.x1, y2: win.y1 },
                    "反向渐变",
                  )
                }
              >
                反向
              </button>
            )}
            <button
              type="button"
              className="gr-btn"
              title="圈内不调、圈外调"
              onClick={() =>
                setWin({ ...win, invert: !win.invert }, win.invert ? "取消反转" : "反转范围")
              }
            >
              反转
            </button>
            <button
              type="button"
              className="gr-btn"
              title="临时关掉范围看全局效果（等同在图层面板点眼睛）"
              onClick={() => onChange(toggleMaskActive(doc), maskOn ? "停用范围" : "启用范围")}
            >
              {maskOn ? "停用" : "启用"}
            </button>
            <button
              type="button"
              className="gr-btn"
              title="移除范围，这一层改回全画面调色"
              onClick={() =>
                onChange(
                  updateLayer(doc, layer.id, { mask: null, maskActive: false, window: undefined }),
                  "移除范围",
                )
              }
            >
              移除
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------- 范围列表 */

/**
 * 二级调色里的范围列表 —— **调色层的唯一入口**。
 *
 * 图层面板已经不再显示调色层（它们不能画、不能拖像素，堆在列表里只会碍事），
 * 所以「切换 / 显示隐藏 / 删除」都在这里：点行切换，右边两个小按钮管开关和删除。
 * 每建一个范围就多一行，常驻不隐藏。
 */
function RangeList({
  layers,
  activeId,
  onSelect,
  onToggleVisible,
  onDelete,
}: {
  layers: StrataLayer[];
  activeId: string;
  onSelect: (id: string) => void;
  onToggleVisible: (id: string, visible: boolean) => void;
  onDelete: (id: string) => void;
}) {
  if (layers.length === 0) return null;
  return (
    <div className="gr-list" role="list">
      {layers.map((l) => {
        const kind = l.window?.kind;
        const icon =
          kind === "line" ? "╱" : kind === "ellipse" ? "◯" : kind === "quad" ? "▱" : kind ? "✎" : "全";
        return (
          <div
            key={l.id}
            className={`gr-item${l.id === activeId ? " is-on" : ""}${l.visible === false ? " is-hidden" : ""}`}
          >
            <button
              type="button"
              className="gr-item-main"
              onClick={() => onSelect(l.id)}
              title={l.name}
            >
              <span className="gr-item-icon" aria-hidden="true">
                {icon}
              </span>
              <span className="gr-item-name">{l.name}</span>
            </button>
            <button
              type="button"
              className="gr-item-btn"
              title={l.visible === false ? "显示这一层" : "隐藏这一层"}
              aria-pressed={l.visible !== false}
              onClick={() => onToggleVisible(l.id, l.visible === false)}
            >
              {l.visible === false ? "◌" : "◉"}
            </button>
            <button
              type="button"
              className="gr-item-btn"
              title="删除这一层"
              onClick={() => onDelete(l.id)}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ 基础件 */

function GradeSlider({
  label,
  value,
  min,
  max,
  step = 1,
  onInput,
  onCommit,
  onReset,
}: {
  label?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onInput: (v: number) => void;
  onCommit: (v: number) => void;
  onReset?: () => void;
}) {
  const read = (el: HTMLInputElement) => Number(el.value);
  /**
   * 只在「值真的变了」时落库：History.commit 不去重，
   * 松手就提交会让撤销栈里塞满无变化的假步骤。
   */
  const lastCommitted = useRef(value);
  const commitIfChanged = (v: number) => {
    if (v === lastCommitted.current) return;
    lastCommitted.current = v;
    onCommit(v);
  };

  return (
    <label className="gs">
      {label && <span className="gs-label">{label}</span>}
      <input
        className="gs-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onInput(read(e.currentTarget))}
        onPointerUp={(e) => commitIfChanged(read(e.currentTarget))}
        onKeyUp={(e) => commitIfChanged(read(e.currentTarget))}
        onDoubleClick={() => {
          lastCommitted.current = Number.NaN;
          onReset?.();
        }}
        title={onReset ? "双击复位" : undefined}
      />
      <input
        className="gs-num"
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? Math.round(value * 10) / 10 : 0}
        onChange={(e) => commitIfChanged(Number(e.currentTarget.value) || 0)}
      />
    </label>
  );
}

/** 卡片分组：标题 + 可选提示 + 组内复位。 */
function Card({
  title,
  hint,
  onReset,
  children,
}: {
  title: string;
  hint?: string;
  onReset?: () => void;
  children: ReactNode;
}) {
  return (
    <section className="gc">
      <header className="gc-head">
        <span className="gc-title">{title}</span>
        {hint && <span className="gc-hint">{hint}</span>}
        {onReset && (
          <button type="button" className="gc-reset" title="本组复位" onClick={onReset}>
            ↺
          </button>
        )}
      </header>
      <div className="gc-body">{children}</div>
    </section>
  );
}

/* -------------------------------------------------------------- 一级页 */

function PrimaryPage({
  params,
  patch,
}: {
  params: Record<string, number>;
  patch: (ids: Record<string, number>, label: string, commit: boolean) => void;
}) {
  const def = (id: string) => GRADE_PARAMS.find((p) => p.id === id)?.def ?? 0;

  const slider = (id: string) => {
    const d = GRADE_PARAMS.find((p) => p.id === id)!;
    return (
      <GradeSlider
        key={id}
        label={d.label}
        value={params[id]}
        min={d.min}
        max={d.max}
        step={d.step}
        onInput={(v) => patch({ [id]: v }, d.label, false)}
        onCommit={(v) => patch({ [id]: v }, d.label, true)}
        onReset={() => patch({ [id]: def(id) }, `${d.label}复位`, true)}
      />
    );
  };

  const resetGroup = (ids: string[], label: string) => () => {
    const next: Record<string, number> = {};
    for (const id of ids) next[id] = def(id);
    patch(next, `${label}复位`, true);
  };

  const WB = ["temp", "tint"];
  const TONE = ["contrast", "pivot", "midDetail"];
  const LIFT = ["liftR", "liftG", "liftB"];
  const GAMMA = ["gammaR", "gammaG", "gammaB"];
  const GAIN = ["gainR", "gainG", "gainB"];
  const OVERALL = ["shadow", "highlight", "sat", "hue", "blackOffset"];

  return (
    <div className="gp gp-cols">
      <Card title="白平衡" onReset={resetGroup(WB, "白平衡")}>
        {WB.map(slider)}
      </Card>
      <Card title="对比度" onReset={resetGroup(TONE, "对比度")}>
        {TONE.map(slider)}
      </Card>
      <Card title="暗部 Lift" hint="抬黑场" onReset={resetGroup(LIFT, "暗部")}>
        {LIFT.map(slider)}
      </Card>
      <Card title="中间调 Gamma" hint="改中段" onReset={resetGroup(GAMMA, "中间调")}>
        {GAMMA.map(slider)}
      </Card>
      <Card title="亮部 Gain" hint="压白场" onReset={resetGroup(GAIN, "亮部")}>
        {GAIN.map(slider)}
      </Card>
      <Card title="整体" onReset={resetGroup(OVERALL, "整体")}>
        {OVERALL.map(slider)}
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------- 色轮页 */

function ColorWheel({
  label,
  x,
  y,
  exp,
  sat,
  onMove,
}: {
  label: string;
  x: number;
  y: number;
  exp: number;
  sat: number;
  onMove: (x: number, y: number, commit: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const last = useRef({ x, y });

  const point = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    let dx = ((e.clientX - (r.left + r.width / 2)) / (r.width / 2)) * 100;
    let dy = ((e.clientY - (r.top + r.height / 2)) / (r.height / 2)) * 100;
    const len = Math.hypot(dx, dy);
    if (len > 100) {
      dx = (dx / len) * 100;
      dy = (dy / len) * 100;
    }
    return { x: Math.round(dx), y: Math.round(dy) };
  };

  const px = 50 + (x / 100) * 46;
  const py = 50 + (y / 100) * 46;

  return (
    <div className="gw">
      <div
        ref={ref}
        className="gw-wheel"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = point(e);
          last.current = p;
          onMove(p.x, p.y, false);
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          const p = point(e);
          last.current = p;
          onMove(p.x, p.y, false);
        }}
        onPointerUp={() => {
          if (!dragging.current) return;
          dragging.current = false;
          if (last.current.x === x && last.current.y === y) return;
          onMove(last.current.x, last.current.y, true);
        }}
        onDoubleClick={() => {
          if (x !== 0 || y !== 0) onMove(0, 0, true);
        }}
        title="拖动偏色 · 双击归零"
      >
        <span className="gw-ring" />
        <span className="gw-puck" style={{ left: `${px}%`, top: `${py}%` }} />
      </div>
      <span className="gw-label">{label}</span>
      <div className="gw-meta">
        <span>
          E <b>{exp}</b>
        </span>
        <span>
          S <b>{sat}</b>
        </span>
      </div>
    </div>
  );
}

function WheelPage({
  params,
  patch,
}: {
  params: Record<string, number>;
  patch: (ids: Record<string, number>, label: string, commit: boolean) => void;
}) {
  return (
    <div className="gp">
      <Card
        title="四档色轮"
        hint="按亮度分档上色"
        onReset={() => {
          const next: Record<string, number> = {};
          for (const w of GRADE_WHEELS) {
            for (const s of ["X", "Y", "Exp", "Sat"]) next[`${w.key}${s}`] = 0;
          }
          patch(next, "色轮复位", true);
        }}
      >
        <div className="gp-wheels">
          {GRADE_WHEELS.map((w) => {
            const k = w.key;
            return (
              <div key={k} className="gp-wheel-cell">
                <ColorWheel
                  label={w.label}
                  x={params[`${k}X`]}
                  y={params[`${k}Y`]}
                  exp={params[`${k}Exp`]}
                  sat={params[`${k}Sat`]}
                  onMove={(x, y, commit) =>
                    patch({ [`${k}X`]: x, [`${k}Y`]: y }, `${w.label}色偏`, commit)
                  }
                />
                <div className="gp-wheel-sliders">
                  <GradeSlider
                    label="曝光"
                    value={params[`${k}Exp`]}
                    min={-100}
                    max={100}
                    onInput={(v) => patch({ [`${k}Exp`]: v }, `${w.label}曝光`, false)}
                    onCommit={(v) => patch({ [`${k}Exp`]: v }, `${w.label}曝光`, true)}
                    onReset={() => patch({ [`${k}Exp`]: 0 }, `${w.label}曝光复位`, true)}
                  />
                  <GradeSlider
                    label="饱和"
                    value={params[`${k}Sat`]}
                    min={-100}
                    max={100}
                    onInput={(v) => patch({ [`${k}Sat`]: v }, `${w.label}饱和`, false)}
                    onCommit={(v) => patch({ [`${k}Sat`]: v }, `${w.label}饱和`, true)}
                    onReset={() => patch({ [`${k}Sat`]: 0 }, `${w.label}饱和复位`, true)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Card>
      <Card title="黑场" onReset={() => patch({ blackOffset: 0 }, "黑场复位", true)}>
        <GradeSlider
          label="黑场偏移"
          value={params.blackOffset}
          min={-100}
          max={100}
          onInput={(v) => patch({ blackOffset: v }, "黑场偏移", false)}
          onCommit={(v) => patch({ blackOffset: v }, "黑场偏移", true)}
          onReset={() => patch({ blackOffset: 0 }, "黑场偏移复位", true)}
        />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------ 切片器页 */

function SlicerPage({
  params,
  patch,
}: {
  params: Record<string, number>;
  patch: (ids: Record<string, number>, label: string, commit: boolean) => void;
}) {
  return (
    <div className="gp">
      <p className="gp-note">
        按色相区间分别调色 —— 只动这个颜色范围里的像素。双击滑杆复位，右侧 ↺ 复位整段。
      </p>
      {SLICER_RANGES.map((r) => {
        const hId = `sl_${r.key}_hue`;
        const sId = `sl_${r.key}_sat`;
        const lId = `sl_${r.key}_lum`;
        const active = params[hId] !== 0 || params[sId] !== 0 || params[lId] !== 0;
        return (
          <section className={active ? "gs-card is-active" : "gs-card"} key={r.key}>
            <span
              className="gs-chip"
              style={{ background: `hsl(${r.center} 78% 52%)` }}
              title={`色相中心 ${r.center}°`}
            />
            <span className="gs-name">{r.label}</span>
            <button
              type="button"
              className="gc-reset"
              title="这段复位"
              onClick={() => patch({ [hId]: 0, [sId]: 0, [lId]: 0 }, `${r.label}复位`, true)}
            >
              ↺
            </button>
            <div className="gs-row-sliders">
              <GradeSlider
                label="色相"
                value={params[hId]}
                min={-60}
                max={60}
                onInput={(v) => patch({ [hId]: v }, `${r.label}色相`, false)}
                onCommit={(v) => patch({ [hId]: v }, `${r.label}色相`, true)}
                onReset={() => patch({ [hId]: 0 }, `${r.label}色相复位`, true)}
              />
              <GradeSlider
                label="饱和"
                value={params[sId]}
                min={-100}
                max={100}
                onInput={(v) => patch({ [sId]: v }, `${r.label}饱和`, false)}
                onCommit={(v) => patch({ [sId]: v }, `${r.label}饱和`, true)}
                onReset={() => patch({ [sId]: 0 }, `${r.label}饱和复位`, true)}
              />
              <GradeSlider
                label="亮度"
                value={params[lId]}
                min={-100}
                max={100}
                onInput={(v) => patch({ [lId]: v }, `${r.label}亮度`, false)}
                onCommit={(v) => patch({ [lId]: v }, `${r.label}亮度`, true)}
                onReset={() => patch({ [lId]: 0 }, `${r.label}亮度复位`, true)}
              />
            </div>
          </section>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- 曲线页 */

const CURVE_W = 240;
const CURVE_H = 190;
const PAD = 10;

/**
 * 曲线背后的示波器：当前画面的亮度分布。
 *
 * 曲线要解决的是「黑场压在哪、白场卡在哪」，所以背景得能看见分布 ——
 * 空着一片网格去调曲线，等于闭着眼睛调。
 *
 * 统计用的是**缩到 192px 的合成结果**：分布形状在这个尺寸下已经稳定，
 * 代价却只有全分辨率的千分之一，拖滑杆时不会因为它再卡一下。
 */
function useScope(doc: StrataDoc): Float32Array {
  return useMemo(() => {
    const hist = new Float32Array(256);
    const w = 192;
    const h = Math.max(1, Math.round((doc.height / Math.max(1, doc.width)) * w));
    try {
      const c = createSurface(w, h);
      composeForDisplay(doc, c, w / Math.max(1, doc.width));
      const d = mustCtx(c).getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 8) continue; // 透明区不计入
        const lum = d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722;
        hist[Math.min(255, Math.max(0, Math.round(lum)))] += 1;
      }
    } catch {
      /* 合成失败就画一条平的，不至于把面板搞崩 */
    }
    return hist;
  }, [doc]);
}

function CurvePage({
  doc,
  layer,
  st,
  onChange,
  onPreview,
}: {
  doc: StrataDoc;
  layer: StrataLayer;
  st: AdjustState;
  onChange: (next: StrataDoc, label: string) => void;
  onPreview: (next: StrataDoc) => void;
}) {
  const [channel, setChannel] = useState<CurveChannel>("rgb");
  const pts = useMemo(() => curveOf(st, channel), [st, channel]);
  const dragIdx = useRef<number | null>(null);
  /**
   * 正在拖「黑场 / 白场」竖线。
   *
   * 这两条线不引入新数据结构：**它们就是曲线首尾两个控制点的 x 位置**。
   * 黑场线右移 = 把输入 0…x 全压成 0（更黑）；白场线左移 = 把 x…1 全提到 1。
   * 语义与达芬奇的输入黑点 / 白点一致，导出、存盘、撤销都不用另写一套。
   */
  const dragBW = useRef<"black" | "white" | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const scope = useScope(doc);

  const toSvg = (p: CurvePoint) => ({
    x: PAD + p.x * (CURVE_W - PAD * 2),
    y: CURVE_H - PAD - p.y * (CURVE_H - PAD * 2),
  });

  const push = (next: CurvePoint[], commit: boolean, label: string) => {
    const doc2 = setAdjust(doc, layer.id, setCurveOf(st, channel, next));
    if (commit) onChange(doc2, label);
    else onPreview(doc2);
  };

  const fromEvent = (e: { clientX: number; clientY: number }): CurvePoint => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    // 视口与 viewBox 可能不等比：按实际缩放换算，否则点不准
    const sx = CURVE_W / Math.max(1, r.width);
    const sy = CURVE_H / Math.max(1, r.height);
    const x = ((e.clientX - r.left) * sx - PAD) / (CURVE_W - PAD * 2);
    const y = 1 - ((e.clientY - r.top) * sy - PAD) / (CURVE_H - PAD * 2);
    return {
      x: Math.min(1, Math.max(0, Math.round(x * 1000) / 1000)),
      y: Math.min(1, Math.max(0, Math.round(y * 1000) / 1000)),
    };
  };

  const CH: { id: CurveChannel; label: string; stroke: string }[] = [
    { id: "rgb", label: "RGB", stroke: "var(--text)" },
    { id: "r", label: "红", stroke: "#e05252" },
    { id: "g", label: "绿", stroke: "#4caf50" },
    { id: "b", label: "蓝", stroke: "#5b8def" },
  ];
  const stroke = CH.find((c) => c.id === channel)?.stroke ?? "var(--text)";

  /** 示波器：亮度分布的填充面积（开方压缩，尖峰不会一家独大）。 */
  const scopePath = useMemo(() => {
    let peak = 1;
    for (let i = 0; i < scope.length; i += 1) if (scope[i] > peak) peak = scope[i];
    const x = (i: number) => PAD + (i / 255) * (CURVE_W - PAD * 2);
    const y = (i: number) =>
      CURVE_H - PAD - Math.sqrt(scope[i] / peak) * (CURVE_H - PAD * 2);
    let d = `M${x(0).toFixed(1)} ${CURVE_H - PAD}`;
    for (let i = 0; i < 256; i += 1) d += ` L${x(i).toFixed(1)} ${y(i).toFixed(1)}`;
    d += ` L${x(255).toFixed(1)} ${CURVE_H - PAD} Z`;
    return d;
  }, [scope]);

  const path = pts
    .map((p, i) => {
      const s = toSvg(p);
      return `${i === 0 ? "M" : "L"}${s.x.toFixed(1)} ${s.y.toFixed(1)}`;
    })
    .join("");

  return (
    <div className="gp-curve">
      <div className="grade-tabs grade-tabs-sub">
        {CH.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`grade-tab${channel === c.id ? " is-on" : ""}`}
            onClick={() => setChannel(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <svg
        ref={svgRef}
        className="gp-curve-svg"
        viewBox={`0 0 ${CURVE_W} ${CURVE_H}`}
        preserveAspectRatio="none"
        onPointerDown={(e) => {
          const p = fromEvent(e);
          /**
           * 竖线只在**上半部**响应（y > 0.72）。
           *
           * 曲线首尾控制点本来就在 (0,0)/(1,1)，如果整条竖线都抢命中，
           * 用户想拖端点改形状就永远拖不动。分上下两段各管一件事：
           * 上半部定黑场白场，下半部拖端点改曲线形状。
           */
          if (p.y > 0.72 && pts.length >= 2) {
            if (Math.abs(p.x - pts[0].x) < 0.05) {
              dragBW.current = "black";
              e.currentTarget.setPointerCapture(e.pointerId);
              return;
            }
            if (Math.abs(p.x - pts[pts.length - 1].x) < 0.05) {
              dragBW.current = "white";
              e.currentTarget.setPointerCapture(e.pointerId);
              return;
            }
          }
          const idx = pts.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.06);
          if (idx >= 0) {
            dragIdx.current = idx;
          } else {
            const next = [...pts, p].sort((a, b) => a.x - b.x);
            dragIdx.current = next.findIndex((q) => q.x === p.x && q.y === p.y);
            push(next, false, "曲线加点");
          }
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const bw = dragBW.current;
          if (bw) {
            const p = fromEvent(e);
            // 黑场只能停在白场左边、白场只能停在黑场右边 —— 夹住就不会反相
            const next = pts.map((q) => ({ ...q }));
            if (bw === "black") {
              next[0].x = Math.min(Math.max(p.x, 0), next[next.length - 1].x - 0.02);
            } else {
              next[next.length - 1].x = Math.max(Math.min(p.x, 1), next[0].x + 0.02);
            }
            push(next, false, bw === "black" ? "黑场" : "白场");
            return;
          }
          const idx = dragIdx.current;
          if (idx === null) return;
          const p = fromEvent(e);
          const next = pts.map((q, i) => (i === idx ? { x: p.x, y: p.y } : q));
          next.sort((a, b) => a.x - b.x);
          dragIdx.current = next.findIndex((q) => q.x === p.x && q.y === p.y);
          push(next, false, "曲线");
        }}
        onPointerUp={() => {
          if (dragBW.current) {
            dragBW.current = null;
            push(pts, true, "调黑白场");
            return;
          }
          if (dragIdx.current === null) return;
          dragIdx.current = null;
          push(pts, true, "调色曲线");
        }}
        onDoubleClick={(e) => {
          const p = fromEvent(e);
          const idx = pts.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.06);
          if (idx <= 0 || idx >= pts.length - 1) return;
          push(
            pts.filter((_, i) => i !== idx),
            true,
            "删曲线点",
          );
        }}
      >
        <rect x={0} y={0} width={CURVE_W} height={CURVE_H} className="gp-curve-bg" />
        <path d={scopePath} className="gp-curve-scope" />
        {[0.25, 0.5, 0.75].map((t) => (
          <g key={t} className="gp-curve-grid">
            <line
              x1={PAD + t * (CURVE_W - PAD * 2)}
              y1={PAD}
              x2={PAD + t * (CURVE_W - PAD * 2)}
              y2={CURVE_H - PAD}
            />
            <line
              x1={PAD}
              y1={PAD + t * (CURVE_H - PAD * 2)}
              x2={CURVE_W - PAD}
              y2={PAD + t * (CURVE_H - PAD * 2)}
            />
          </g>
        ))}
        <line className="gp-curve-diag" x1={PAD} y1={CURVE_H - PAD} x2={CURVE_W - PAD} y2={PAD} />

        {/*
          黑场 / 白场竖线：位置就是曲线首尾控制点的 x。
          顶端给一个小把手，提示"这条可以拖"；拖它就等于把输入范围往里收。
        */}
        {pts.length >= 2 &&
          ([
            { key: "black", at: pts[0].x },
            { key: "white", at: pts[pts.length - 1].x },
          ] as const).map((b) => {
            const sx = PAD + b.at * (CURVE_W - PAD * 2);
            return (
              <g key={b.key} className={`gp-bw is-${b.key}`}>
                <line x1={sx} y1={PAD - 4} x2={sx} y2={CURVE_H - PAD} />
                <rect x={sx - 4.5} y={PAD - 9} width={9} height={9} rx={2} />
              </g>
            );
          })}
        <path
          d={path}
          fill="none"
          stroke={stroke}
          strokeWidth={1.8}
          vectorEffect="non-scaling-stroke"
        />
        {pts.map((p, i) => {
          const s = toSvg(p);
          return <circle key={i} cx={s.x} cy={s.y} r={4} fill={stroke} />;
        })}
      </svg>
      <p className="gp-note">
        单击加点 · 拖动改形 · 双击删点。上方的两条竖线是黑场 / 白场，拖它把输入范围收进来。
        背景那一片是当前画面的亮度分布 —— 峰在哪儿，就该在哪儿定黑白。
      </p>
    </div>
  );
}
