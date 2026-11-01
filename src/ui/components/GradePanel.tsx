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
  /** 落一条历史（松手 / 输入完成时） */
  onChange: (next: StrataDoc, label: string) => void;
  /** 只改画面不入栈（拖动过程中） */
  onPreview: (next: StrataDoc) => void;
}

type Tab = "primary" | "wheel" | "slicer" | "curve";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "primary", label: "一级", icon: "◐" },
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

export default function GradePanel({ doc, layer, onChange, onPreview }: Props) {
  const [tab, setTab] = useState<Tab>("primary");
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

      <RangeBar doc={doc} layer={layer} onChange={onChange} />

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
  onChange,
}: {
  doc: StrataDoc;
  layer: StrataLayer;
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
            onClick={() => onChange(addLocalGradeLayer(doc, s2.kind), `新建${s2.label}范围`)}
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
  const svgRef = useRef<SVGSVGElement>(null);

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
          const idx = dragIdx.current;
          if (idx === null) return;
          const p = fromEvent(e);
          const next = pts.map((q, i) => (i === idx ? { x: p.x, y: p.y } : q));
          next.sort((a, b) => a.x - b.x);
          dragIdx.current = next.findIndex((q) => q.x === p.x && q.y === p.y);
          push(next, false, "曲线");
        }}
        onPointerUp={() => {
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
        单击加点 · 拖动改形 · 双击删点。曲线挂在这一层上，与一级 / 色轮 / 切片器叠加生效。
      </p>
    </div>
  );
}
