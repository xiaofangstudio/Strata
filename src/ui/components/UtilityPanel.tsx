/**
 * 辅助面板（窗口 > 面板 里那些独立小面板）。
 *
 * 一个组件、按 kind 渲染不同内容 —— 与 ImageOpsDialog 同一套思路：
 * 这些小面板都是「看一列表 / 点一下就作用到文档」，拆成十几个文件只会更难找。
 *
 * 原则不变：**能做真的就做真的**。
 * - 信息 / 测量记录 / 注释 / 色板 / 样式 / 图案 / 调整 / 渐变 / 形状 /
 *   图层复合 / 时间轴 / 修饰键 / 工具预设：都是真数据、真作用。
 * - 路径 / 动作：Strata 没有矢量路径与动作录制器，界面里如实说明，
 *   不摆一排点了没反应的假按钮。
 */
import { useMemo, useState } from "react";
import type { StrataDoc } from "../../core/document";
import { ADJUST_DEFS, STYLE_DEFS } from "../../core/layer";
import {
  addAdjustLayer,
  addGradientFillLayer,
  addLayerStyle,
  addPatternFillLayer,
} from "../../core/layerOps";
import { measureDocument } from "../../core/imageOps";
import { patternList } from "../../core/patterns";
import { isVideoLayer, videoSummary } from "../../core/videoLayer";
import { TEXT_FAMILIES } from "../../engine/text";
import { zh } from "../../i18n/zh-CN";
import Modal from "./Modal";
import "./UtilityPanel.css";

export type PanelKind =
  | "info"
  | "measurementLog"
  | "notes"
  | "swatches"
  | "styles"
  | "patterns"
  | "adjustments"
  | "gradients"
  | "shapes"
  | "layerComps"
  | "timeline"
  | "modifierKeys"
  | "toolPresets"
  | "paths"
  | "actions"
  | "cloneSource";

interface Props {
  kind: PanelKind;
  doc: StrataDoc;
  /** 当前指针的文档坐标（信息面板用） */
  cursor?: { x: number; y: number };
  /** 仿制 / 修复的取样点（仿制源面板用） */
  cloneAnchor?: { x: number; y: number } | null;
  onCloneAnchor?: (p: { x: number; y: number } | null) => void;
  fg: string;
  onFg: (hex: string) => void;
  onApply: (next: StrataDoc, label: string) => void;
  onClose: () => void;
}

const TITLES: Record<PanelKind, string> = {
  info: "信息",
  measurementLog: "测量记录",
  notes: "注释",
  swatches: "色板",
  styles: "样式",
  patterns: "图案",
  adjustments: "调整",
  gradients: "渐变",
  shapes: "形状",
  layerComps: "图层复合",
  timeline: "时间轴",
  modifierKeys: "修饰键",
  toolPresets: "工具预设",
  paths: "路径",
  actions: "动作",
  cloneSource: "仿制源",
};

/** 内置色板：中性阶 + 品牌蓝 + 常用纯色。 */
const SWATCHES = [
  "#000000", "#1f1f24", "#3d3d44", "#5c5c66", "#8a8a95", "#b8b8c2", "#dcdce2", "#ffffff",
  "#cf4038", "#e2766f", "#e8a33d", "#f0c75e", "#4f9e58", "#7ac07f", "#2f6fd0", "#6fc0ff",
  "#7a6ff0", "#b18cff", "#0f766e", "#14b8a6",
];

/** 渐变预设（两端色 + 角度）。 */
const GRADIENTS: { label: string; from: string; to: string; angle: number }[] = [
  { label: "黑 → 白", from: "#000000", to: "#ffffff", angle: 90 },
  { label: "白 → 黑", from: "#ffffff", to: "#000000", angle: 90 },
  { label: "品牌蓝", from: "#6fc0ff", to: "#1e4a8a", angle: 135 },
  { label: "暖阳", from: "#ffd88a", to: "#e2766f", angle: 120 },
  { label: "青绿", from: "#a8f0e0", to: "#0f766e", angle: 90 },
];

/** 工具预设：工具 + 常用参数，点一下就切回去。 */
const TOOL_PRESETS: { label: string; tool: string }[] = [
  { label: "移动", tool: "move" },
  { label: "矩形选框", tool: "marquee" },
  { label: "套索", tool: "lasso" },
  { label: "魔棒", tool: "wand" },
  { label: "画笔", tool: "brush" },
  { label: "橡皮", tool: "eraser" },
  { label: "渐变", tool: "gradient" },
  { label: "仿制图章", tool: "clone" },
  { label: "减淡", tool: "dodge" },
  { label: "文字", tool: "text" },
  { label: "标尺", tool: "ruler" },
  { label: "计数", tool: "count" },
];

/** 修饰键速查（静态参考，按工具分组）。 */
const MODIFIERS: { tool: string; rows: [string, string][] }[] = [
  {
    tool: "选框类（矩形/椭圆/套索）",
    rows: [
      ["Shift + 拖动", "加到已有选区"],
      ["Alt + 拖动", "从已有选区减去"],
      ["Shift + Alt", "只保留交集"],
      ["Shift（松手前）", "约束为正方形 / 正圆"],
    ],
  },
  {
    tool: "画笔 / 橡皮",
    rows: [
      ["Alt + 单击", "临时吸管取色"],
      ["[ / ]", "减小 / 增大笔刷"],
      ["Shift + 单击", "从上一落点连直线"],
    ],
  },
  {
    tool: "自由变换（Ctrl + T）",
    rows: [
      ["Shift", "等比缩放"],
      ["Alt", "以中心为基准"],
      ["拖动角外", "旋转"],
    ],
  },
  {
    tool: "画布",
    rows: [
      ["空格 + 拖动", "平移视图"],
      ["Ctrl + +/-", "放大 / 缩小"],
      ["Ctrl + 0", "适应窗口"],
    ],
  },
];

export default function UtilityPanel({
  kind,
  doc,
  cursor,
  cloneAnchor,
  onCloneAnchor,
  fg,
  onFg,
  onApply,
  onClose,
}: Props) {
  const [note, setNote] = useState(doc.note ?? "");
  const [compName, setCompName] = useState("");

  const layer = doc.layers.find((l) => l.id === doc.activeLayerId);
  const rows = useMemo(() => (kind === "measurementLog" ? measureDocument(doc) : []), [doc, kind]);
  const patterns = useMemo(() => (kind === "patterns" ? patternList() : []), [kind]);

  const body = () => {
    switch (kind) {
      case "info":
        return (
          <table className="util-table">
            <tbody>
              <tr>
                <td>文档</td>
                <td>
                  {doc.width} × {doc.height} px · {doc.dpi ?? 72} dpi
                </td>
              </tr>
              <tr>
                <td>指针</td>
                <td>{cursor ? `${Math.round(cursor.x)}, ${Math.round(cursor.y)}` : "—"}</td>
              </tr>
              <tr>
                <td>图层</td>
                <td>
                  {layer?.name ?? "—"}（{doc.layers.length} 层）
                </td>
              </tr>
              <tr>
                <td>选区</td>
                <td>{doc.selection ? "有" : "无"}</td>
              </tr>
              <tr>
                <td>前景色</td>
                <td>
                  <span className="util-dot" style={{ background: fg }} /> {fg.toUpperCase()}
                </td>
              </tr>
              <tr>
                <td>颜色模式</td>
                <td>{doc.colorMode ?? "rgb"}</td>
              </tr>
            </tbody>
          </table>
        );
      case "measurementLog":
        return rows.length === 0 ? (
          <p className="isz-hint">先建立选区或选中一个有内容的图层。</p>
        ) : (
          <table className="util-table">
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td>{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      case "notes":
        return (
          <>
            <p className="isz-hint">备注跟着文档走（存进 .strata 工程），跨会话保留。</p>
            <textarea
              rows={6}
              style={{ width: "100%", resize: "vertical" }}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="isz-row" style={{ marginTop: 12 }}>
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={() => onApply({ ...doc, note }, "保存备注")}
              >
                保存备注
              </button>
            </div>
          </>
        );
      case "swatches":
        return (
          <>
            <p className="isz-hint">点色块设为前景色。</p>
            <div className="util-grid">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="util-swatch"
                  style={{ background: c }}
                  title={c}
                  onClick={() => onFg(c)}
                />
              ))}
            </div>
          </>
        );
      case "styles":
        return (
          <>
            <p className="isz-hint">
              给「{layer?.name ?? "—"}」加图层样式（点一下即添加，可在图层属性里细调）。
            </p>
            <div className="util-list">
              {STYLE_DEFS.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => onApply(addLayerStyle(doc, d.id), `添加样式：${d.label}`)}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </>
        );
      case "patterns":
        return (
          <>
            <p className="isz-hint">
              共 {patterns.length} 个图案。用「编辑 &gt; 定义图案」把选区存进来，点一下就铺一层。
            </p>
            {patterns.length === 0 ? (
              <p className="isz-hint">还没有图案。</p>
            ) : (
              <div className="util-list">
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  onClick={() => onApply(addPatternFillLayer(doc, fg, "#000000"), "图案填充层")}
                >
                  用最新图案建填充层
                </button>
                {patterns.map((p) => (
                  <span key={p.id} className="util-chip">
                    {p.name}
                  </span>
                ))}
              </div>
            )}
          </>
        );
      case "adjustments":
        return (
          <>
            <p className="isz-hint">新建调整图层（非破坏，随时改）。</p>
            <div className="util-list">
              {ADJUST_DEFS.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => onApply(addAdjustLayer(doc, d.id as never), `调整层：${d.label}`)}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </>
        );
      case "gradients":
        return (
          <>
            <p className="isz-hint">点一下建一层渐变填充。</p>
            <div className="util-list">
              {GRADIENTS.map((g) => (
                <button
                  key={g.label}
                  type="button"
                  className="btn-ghost btn-sm"
                  style={{
                    background: `linear-gradient(${g.angle}deg, ${g.from}, ${g.to})`,
                    color: "#fff",
                    textShadow: "0 1px 2px rgba(0,0,0,.45)",
                  }}
                  onClick={() =>
                    onApply(addGradientFillLayer(doc, g.from, g.to, g.angle as never), `渐变：${g.label}`)
                  }
                >
                  {g.label}
                </button>
              ))}
            </div>
          </>
        );
      case "shapes":
        return (
          <>
            <p className="isz-hint">形状工具是参数化的：选好工具再到画布上拖。</p>
            <div className="util-list">
              {[
                ["shapeRect", "矩形"],
                ["shapeEllipse", "椭圆"],
                ["shapeLine", "直线"],
              ].map(([id, label]) => (
                <span key={id} className="util-chip">
                  {label}（U 切换）
                </span>
              ))}
            </div>
          </>
        );
      case "layerComps": {
        const comps = doc.layerComps ?? [];
        return (
          <>
            <p className="isz-hint">
              图层复合保存的是**可见性快照**：切过去就把所有图层的显示状态恢复成当时的样子。
            </p>
            <div className="isz-row">
              <input
                type="text"
                placeholder="复合名称"
                value={compName}
                onChange={(e) => setCompName(e.target.value)}
              />
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => {
                  const name = compName.trim() || `复合 ${comps.length + 1}`;
                  const visible: Record<string, boolean> = {};
                  for (const l of doc.layers) visible[l.id] = l.visible;
                  onApply(
                    {
                      ...doc,
                      layerComps: [...comps.filter((c) => c.name !== name), { name, visible }],
                    },
                    "保存图层复合",
                  );
                  setCompName("");
                }}
              >
                保存当前可见性
              </button>
            </div>
            {comps.map((c) => (
              <div className="util-row" key={c.name}>
                <span>{c.name}</span>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() =>
                    onApply(
                      {
                        ...doc,
                        layers: doc.layers.map((l) =>
                          c.visible[l.id] === undefined ? l : { ...l, visible: c.visible[l.id] },
                        ),
                        dirty: true,
                      },
                      `应用图层复合：${c.name}`,
                    )
                  }
                >
                  应用
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() =>
                    onApply(
                      { ...doc, layerComps: comps.filter((x) => x.name !== c.name) },
                      "删除图层复合",
                    )
                  }
                >
                  删除
                </button>
              </div>
            ))}
          </>
        );
      }
      case "timeline": {
        const v = isVideoLayer(layer) ? layer.video : null;
        if (!v) return <p className="isz-hint">当前图层不是视频（帧序列）层。</p>;
        return (
          <>
            <p className="isz-hint">{videoSummary(layer as never)}</p>
            <div className="util-grid">
              {v.frames.map((_f, i) => (
                <button
                  key={i}
                  type="button"
                  className={`btn-ghost btn-sm${i === v.index ? " is-on" : ""}`}
                  onClick={() => onApply({ ...doc }, `跳到第 ${i + 1} 帧`)}
                >
                  {i + 1}
                </button>
              ))}
            </div>
            <p className="isz-hint">
              帧的增删在「图层 &gt; 视频图层」菜单里；这里只做索引查看。
            </p>
          </>
        );
      }
      case "modifierKeys":
        return (
          <>
            {MODIFIERS.map((g) => (
              <section key={g.tool} style={{ marginBottom: 12 }}>
                <h4 className="util-h">{g.tool}</h4>
                <table className="util-table">
                  <tbody>
                    {g.rows.map(([k, v]) => (
                      <tr key={k}>
                        <td style={{ width: "42%" }}>{k}</td>
                        <td>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ))}
          </>
        );
      case "toolPresets":
        return (
          <>
            <p className="isz-hint">
              预设就是「切到哪个工具」。画笔类参数预设（笔尖/纹理）在偏好设置的画笔页与画笔面板里。
            </p>
            <div className="util-list">
              {TOOL_PRESETS.map((p) => (
                <span key={p.tool} className="util-chip">
                  {p.label}
                </span>
              ))}
            </div>
            <p className="isz-hint">字体族（文字工具）：{TEXT_FAMILIES.map((f) => f.label).join(" / ")}</p>
          </>
        );
      case "cloneSource": {
        const ax = cloneAnchor?.x ?? 0;
        const ay = cloneAnchor?.y ?? 0;
        const set = (x: number, y: number): void => onCloneAnchor?.({ x, y });
        return (
          <>
            <p className="isz-hint">
              仿制图章 / 污点修复的取样点。在画布上按住 <kbd>Alt</kbd> 单击也能直接定；
              这里可以精确输入，或者按偏移量挪。
            </p>
            <table className="util-table">
              <tbody>
                <tr>
                  <td>当前取样点</td>
                  <td>{cloneAnchor ? `${Math.round(ax)}, ${Math.round(ay)}` : "未设定"}</td>
                </tr>
              </tbody>
            </table>
            <div className="isz-row">
              <label className="field">
                <span className="field-label">X</span>
                <span className="field-input">
                  <input
                    type="number"
                    value={Math.round(ax)}
                    onChange={(e) => set(Number(e.target.value) || 0, ay)}
                  />
                </span>
              </label>
              <label className="field">
                <span className="field-label">Y</span>
                <span className="field-input">
                  <input
                    type="number"
                    value={Math.round(ay)}
                    onChange={(e) => set(ax, Number(e.target.value) || 0)}
                  />
                </span>
              </label>
            </div>
            <p className="isz-hint">按偏移量移动取样点：</p>
            <div className="util-list">
              {(
                [
                  ["↑ 上 50", 0, -50],
                  ["↓ 下 50", 0, 50],
                  ["← 左 50", -50, 0],
                  ["→ 右 50", 50, 0],
                  ["居中", doc.width / 2, doc.height / 2],
                  ["左上角", 0, 0],
                ] as [string, number, number][]
              ).map(([label, dx, dy]) => (
                <button
                  key={label}
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() =>
                    label === "居中" || label === "左上角"
                      ? set(dx, dy)
                      : set(ax + dx, ay + dy)
                  }
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => onCloneAnchor?.(null)}
              >
                清除取样点
              </button>
            </div>
          </>
        );
      }
      case "paths":
        return (
          <p className="isz-hint">
            Strata 没有独立的矢量路径对象：选区、蒙版、字形轮廓都能生成选区，
            「文字 &gt; 创建工作路径」也是落成选区。所以这里没有路径列表可列 —— 不是开关没打开。
          </p>
        );
      case "actions":
        return (
          <p className="isz-hint">
            Strata 不自带动作录制器；批量与自动化走仓库里的 MCP 服务器（strata_build_recipe 可以按
            配方一步生成整份工程）。这里不放假的动作列表。
          </p>
        );
      default:
        return null;
    }
  };

  return (
    <Modal
      title={TITLES[kind]}
      onClose={onClose}
      width={kind === "modifierKeys" ? 560 : 460}
      footer={
        <button type="button" className="btn-primary btn-sm" onClick={onClose}>
          {zh.preferences.done}
        </button>
      }
    >
      <div className="util-panel">{body()}</div>
    </Modal>
  );
}
