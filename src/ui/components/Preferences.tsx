/**
 * 偏好设置（菜单 Edit > Preferences 下的 18 个条目都落到这里）。
 *
 * 布局与 PS 首选项同构：左侧页面列表 + 右侧内容。
 *
 * **尺寸稳定**：弹窗整体固定 620px 高（Modal 的 height 参数），
 * 右侧内容区自己滚动。之前是按内容撑高，切换页面时窗口忽大忽小 —— 现在不会了。
 *
 * 每一条设置都真的被代码消费（不是装饰）：历史步数进 HistoryStack、网格间距进网格浮层、
 * 棋盘格进 CSS 变量、光标进画布 cursor、密度进根节点 class、字号进文字工具、
 * 导出格式进快速导出。没有后端可接的两页（增效工具 / AI 集成）如实显示当前状态，
 * 不做假的开关。
 */
import { useState } from "react";
import { zh, useLang, setLang, resolveLang, LANGUAGES, type ActiveLang } from "../../i18n";
import { resetPrefs, setPrefs, usePrefs } from "../../stores/prefs";
import type { ThemeMode } from "../../stores/theme";
import { TOOLS, TOOL_GROUPS, type ToolId } from "../../tools/catalog";
import type { BrushSettings } from "../../engine/paint";
import Modal from "./Modal";
import ToolIcon from "./ToolIcon";
import "./Preferences.css";
import RangeInput from "./RangeInput";
import { open } from "@tauri-apps/plugin-dialog";

export type PrefPage =
  | "general"
  | "integrations"
  | "interface"
  | "workspace"
  | "tools"
  | "brush"
  | "historyLog"
  | "fileHandling"
  | "export"
  | "performance"
  | "scratchDisks"
  | "cursors"
  | "transparencyAndGamut"
  | "unitsAndRulers"
  | "guidesGridAndSlices"
  | "plugIns"
  | "type"
  | "enhancedControls"
  | "rawDefaults"
  | "personal";

interface Props {
  /** 打开时定位到哪一页（Edit > Preferences 的各条目直接指过来） */
  page?: PrefPage;
  onPage?: (p: PrefPage) => void;
  onClose: () => void;
  themeMode: ThemeMode;
  onSetTheme: (m: ThemeMode) => void;
  brush: BrushSettings;
  onBrush: (patch: Partial<BrushSettings>) => void;
  /** 工作区页：复位面板布局 */
  onResetLayout?: () => void;
  /** 文件处理页：清掉最近文件列表 */
  onClearRecent?: () => void;
}

/**
 * 19 个页签按语义归成 6 组，左侧栏两级结构。
 * 页签 id 一个没动 —— Edit > Preferences 各菜单条目仍按原 id 直达。
 */
const GROUPS: { id: string; label: string; pages: { id: PrefPage; label: string }[] }[] = [
  {
    id: "personal",
    label: "个性化",
    pages: [{ id: "personal", label: "个性化" }],
  },
  {
    id: "general",
    label: "常规",
    pages: [
      { id: "general", label: "常规" },
      { id: "interface", label: "界面" },
      { id: "cursors", label: "光标" },
      { id: "enhancedControls", label: "增强控件" },
      { id: "workspace", label: "工作区" },
      { id: "unitsAndRulers", label: "单位与标尺" },
      { id: "guidesGridAndSlices", label: "参考线、网格" },
    ],
  },
  {
    id: "editing",
    label: "编辑",
    pages: [
      { id: "tools", label: "工具" },
      { id: "brush", label: "画笔" },
      { id: "type", label: "文字" },
      { id: "historyLog", label: "历史记录" },
    ],
  },
  {
    id: "files",
    label: "文件",
    pages: [
      { id: "fileHandling", label: "文件处理" },
      { id: "export", label: "导出" },
      { id: "rawDefaults", label: "Raw 默认" },
    ],
  },
  {
    id: "color",
    label: "色彩",
    pages: [{ id: "transparencyAndGamut", label: "透明与色域" }],
  },
  {
    id: "performance",
    label: "性能",
    pages: [
      { id: "performance", label: "性能" },
      { id: "scratchDisks", label: "暂存盘" },
    ],
  },
  {
    id: "misc",
    label: "其他",
    pages: [
      { id: "plugIns", label: "增效工具" },
      { id: "integrations", label: "AI 集成" },
    ],
  },
  {
    id: "personal",
    label: "个性化",
    pages: [{ id: "personal", label: "个性化" }],
  },
];

/** 本地存储占用（KB），暂存盘页显示用。 */
function localStoreKb(): number {
  try {
    let n = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k) continue;
      n += k.length + (localStorage.getItem(k)?.length ?? 0);
    }
    return Math.round(n / 1024);
  } catch {
    return 0;
  }
}

/** 磨砂色预设：首位是中性白（真磨砂玻璃的默认观感），其余高饱和七色供着色。 */
const FROST_COLORS = [
  "#e8edf5",
  "#ff3b30",
  "#ff9500",
  "#ffd60a",
  "#34c759",
  "#32ade6",
  "#0a84ff",
  "#bf5af2",
];

/** UI 字体族选项（id 与 stores/prefs 的 UI_FONT_STACKS 对应）。 */
const FONT_OPTIONS: { id: string; label: string }[] = [
  { id: "", label: "系统默认" },
  { id: "yahei", label: "微软雅黑" },
  { id: "pingfang", label: "苹方" },
  { id: "segoe", label: "Segoe UI" },
  { id: "source-han", label: "思源黑体" },
  { id: "dengxian", label: "等线" },
  { id: "song", label: "宋体（衬线）" },
];

export default function Preferences({
  page,
  onPage,
  onClose,
  themeMode,
  onSetTheme,
  brush,
  onBrush,
  onResetLayout,
  onClearRecent,
}: Props) {
  const prefs = usePrefs();
  const lang = useLang();
  const [tab, setTab] = useState<PrefPage>(page ?? "general");
  const go = (p: PrefPage) => {
    setTab(p);
    onPage?.(p);
  };

  const toggleTool = (id: ToolId) => {
    const hidden = prefs.hiddenTools.includes(id);
    if (!hidden && prefs.hiddenTools.length >= TOOLS.length - 1) return;
    setPrefs({
      hiddenTools: hidden
        ? prefs.hiddenTools.filter((t) => t !== id)
        : [...prefs.hiddenTools, id],
    });
  };

  return (
    <Modal
      title={zh.preferences.title}
      onClose={onClose}
      width={760}
      height={620}
      footer={
        <>
          <button type="button" className="btn-ghost btn-sm" onClick={resetPrefs}>
            {zh.preferences.resetAll}
          </button>
          <button type="button" className="btn-primary btn-sm" onClick={onClose}>
            {zh.preferences.done}
          </button>
        </>
      }
    >
      <div className="pref">
        <nav className="pref-tabs">
          {GROUPS.map((g) => (
            <div key={g.id} className="pref-group">
              <span className="pref-group-title">{g.label}</span>
              {g.pages.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`pref-tab${tab === t.id ? " is-on" : ""}`}
                  onClick={() => go(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="pref-pane">
          {tab === "general" && (
            <>
              <section className="pref-sec">
                <h3 className="pref-h">界面密度</h3>
                <div className="pref-seg">
                  {(["comfortable", "compact"] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={`pref-seg-btn${prefs.density === d ? " is-on" : ""}`}
                      onClick={() => setPrefs({ density: d })}
                    >
                      {d === "comfortable" ? "舒适" : "紧凑"}
                    </button>
                  ))}
                </div>
                <p className="pref-note">紧凑会收紧工具轨与面板的行高，小屏幕上能多放一点内容。</p>
              </section>
              <section className="pref-sec">
                <h3 className="pref-h">拖动判定阈值</h3>
                <div className="pref-row">
                  <RangeInput
                    min={1}
                    max={20}
                    value={prefs.dragThreshold}
                    aria-label="拖动判定阈值"
                    onChange={(v) => setPrefs({ dragThreshold: v })}
                  />
                  <span className="pref-val">{prefs.dragThreshold} px</span>
                </div>
                <p className="pref-note">指针移动超过这个距离才算「拖动」，越小越灵敏。</p>
              </section>
            </>
          )}

          {tab === "interface" && (
            <>
              <section className="pref-sec">
                <h3 className="pref-h">界面语言</h3>
                <div className="pref-row">
                  <select
                    className="pref-select"
                    value={lang}
                    onChange={(e) => setLang(e.target.value as ActiveLang)}
                    aria-label="界面语言"
                  >
                    <option value="auto">
                      跟随系统{resolveLang("auto") !== "zh-CN" ? `（${LANGUAGES.find((l) => l.code === resolveLang("auto"))?.native}）` : ""}
                    </option>
                    {LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.native} · {l.english}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="pref-note">
                  切换后立即生效，并记住你的选择。未翻译的词条会回退到简体中文，保证界面不空。
                </p>
              </section>
              <section className="pref-sec">
                <h3 className="pref-h">{zh.preferences.theme}</h3>
                <div className="pref-choice">
                  {(["light", "dark"] as ThemeMode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`pref-card${themeMode === m ? " is-on" : ""}`}
                      onClick={() => onSetTheme(m)}
                    >
                      <span className={`pref-swatch is-${m}`} />
                      <span className="pref-card-name">
                        {m === "light" ? zh.theme.light : zh.theme.dark}
                      </span>
                    </button>
                  ))}
                </div>
                <p className="pref-note">{zh.preferences.themeHint}</p>
              </section>
              <section className="pref-sec">
                <h3 className="pref-h">界面密度</h3>
                <div className="pref-seg">
                  {(["comfortable", "compact"] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={`pref-seg-btn${prefs.density === d ? " is-on" : ""}`}
                      onClick={() => setPrefs({ density: d })}
                    >
                      {d === "comfortable" ? "舒适" : "紧凑"}
                    </button>
                  ))}
                </div>
              </section>
            </>
          )}

          {tab === "workspace" && (
            <section className="pref-sec">
              <h3 className="pref-h">面板布局</h3>
              <label className="pref-check">
                <input
                  type="checkbox"
                  checked={prefs.rememberDock}
                  onChange={(e) => setPrefs({ rememberDock: e.target.checked })}
                />
                记住面板的展开 / 收起状态
              </label>
              <div className="pref-row">
                <button type="button" className="btn-ghost btn-sm" onClick={() => onResetLayout?.()}>
                  复位面板布局
                </button>
              </div>
              <p className="pref-note">
                复位会把右侧停靠栏恢复成「属性 + 颜色 + 图层」的默认组合。
              </p>
            </section>
          )}

          {tab === "tools" && (
            <>
              <section className="pref-sec">
                <h3 className="pref-h">{zh.preferences.columns}</h3>
                <div className="pref-seg">
                  {([1, 2, 3] as const).map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`pref-seg-btn${prefs.columns === n ? " is-on" : ""}`}
                      onClick={() => setPrefs({ columns: n })}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <p className="pref-note">{zh.preferences.columnsHint}</p>
              </section>
              <section className="pref-sec">
                <h3 className="pref-h">显示工具名</h3>
                <label className="pref-check">
                  <input
                    type="checkbox"
                    checked={prefs.toolLabels}
                    onChange={(e) => setPrefs({ toolLabels: e.target.checked })}
                  />
                  在工具轨上显示中文名
                </label>
              </section>
              <section className="pref-sec">
                <h3 className="pref-h">{zh.preferences.tools}</h3>
                <div className="pref-tools">
                  {TOOL_GROUPS.map((g) => (
                    <div key={g} className="pref-tool-group">
                      {TOOLS.filter((t) => t.group === g).map((t) => (
                        <label key={t.id} className="pref-tool">
                          <input
                            type="checkbox"
                            checked={!prefs.hiddenTools.includes(t.id)}
                            onChange={() => toggleTool(t.id)}
                          />
                          <ToolIcon id={t.id} size={15} />
                          <span>{zh.tools[t.id]}</span>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
                <p className="pref-note">{zh.preferences.toolsHint}</p>
              </section>
            </>
          )}

          {tab === "brush" && (
            <>
              <section className="pref-sec">
                <h3 className="pref-h">{zh.preferences.spacing}</h3>
                <div className="pref-row">
                  <RangeInput
                    min={1}
                    max={50}
                    value={brush.spacing}
                    aria-label={zh.preferences.spacing}
                    onChange={(v) => onBrush({ spacing: v })}
                  />
                  <span className="pref-val">{brush.spacing}%</span>
                </div>
                <p className="pref-note">{zh.preferences.spacingHint}</p>
              </section>
              <section className="pref-sec">
                <h3 className="pref-h">不透明度</h3>
                <div className="pref-row">
                  <RangeInput
                    min={1}
                    max={100}
                    value={brush.opacity}
                    aria-label="不透明度"
                    onChange={(v) => onBrush({ opacity: v })}
                  />
                  <span className="pref-val">{brush.opacity}%</span>
                </div>
                <h3 className="pref-h">流量</h3>
                <div className="pref-row">
                  <RangeInput
                    min={1}
                    max={100}
                    value={brush.flow}
                    aria-label="流量"
                    onChange={(v) => onBrush({ flow: v })}
                  />
                  <span className="pref-val">{brush.flow}%</span>
                </div>
                <p className="pref-note">{zh.preferences.brushHint}</p>
              </section>
            </>
          )}

          {tab === "historyLog" && (
            <section className="pref-sec">
              <h3 className="pref-h">历史记录步数</h3>
              <div className="pref-row">
                <RangeInput
                  min={10}
                  max={500}
                  value={prefs.historyLimit}
                  aria-label="历史记录步数"
                  onChange={(v) => setPrefs({ historyLimit: v })}
                />
                <span className="pref-val">{prefs.historyLimit} 步</span>
              </div>
              <p className="pref-note">
                只作用于之后新打开的文档 —— 已经在编辑的文档仍用它打开时的上限，
                免得调设置的时候把现有历史悄悄裁掉。
              </p>
            </section>
          )}

          {tab === "fileHandling" && (
            <section className="pref-sec">
              <h3 className="pref-h">文件处理</h3>
              <label className="pref-check">
                <input
                  type="checkbox"
                  checked={prefs.confirmClose}
                  onChange={(e) => setPrefs({ confirmClose: e.target.checked })}
                />
                关闭有未保存改动的文档前先确认
              </label>
              <label className="pref-check">
                <input
                  type="checkbox"
                  checked={prefs.restoreView}
                  onChange={(e) => setPrefs({ restoreView: e.target.checked })}
                />
                打开文档时恢复上次的缩放与平移
              </label>
              <div className="pref-row">
                <button type="button" className="btn-ghost btn-sm" onClick={() => onClearRecent?.()}>
                  清空最近文件
                </button>
              </div>
              <p className="pref-note">最近文件只存在本机，不会上传。</p>
            </section>
          )}

          {tab === "export" && (
            <section className="pref-sec">
              <h3 className="pref-h">快速导出</h3>
              <div className="pref-seg">
                {(["png", "jpg", "webp"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={`pref-seg-btn${prefs.exportFormat === f ? " is-on" : ""}`}
                    onClick={() => setPrefs({ exportFormat: f })}
                  >
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
              <div className="pref-row">
                <RangeInput
                  min={10}
                  max={100}
                  value={prefs.exportQuality}
                  aria-label="导出质量"
                  onChange={(v) => setPrefs({ exportQuality: v })}
                />
                <span className="pref-val">{prefs.exportQuality}</span>
              </div>
              <p className="pref-note">质量只对 JPG / WebP 有效，PNG 始终无损。</p>

              <h3 className="pref-h">默认保存位置</h3>
              <div className="pref-row">
                <input
                  type="text"
                  className="pref-path"
                  value={prefs.saveDir ?? ""}
                  readOnly
                  placeholder="未设置（由系统保存框决定）"
                  aria-label="默认保存位置"
                />
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={async () => {
                    const d = await open({ directory: true, title: "选择默认保存位置" });
                    if (typeof d === "string") setPrefs({ saveDir: d });
                  }}
                >
                  浏览…
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  disabled={!prefs.saveDir}
                  onClick={() => setPrefs({ saveDir: "" })}
                >
                  清除
                </button>
              </div>
              <p className="pref-note">
                导出 / 另存时会默认落到这里。留空则不做偏好，仍由系统保存框决定起始位置。
              </p>
            </section>
          )}

          {tab === "performance" && (
            <section className="pref-sec">
              <h3 className="pref-h">滤镜预览质量</h3>
              <div className="pref-seg">
                {([0, 1, 2] as const).map((q) => (
                  <button
                    key={q}
                    type="button"
                    className={`pref-seg-btn${prefs.previewQuality === q ? " is-on" : ""}`}
                    onClick={() => setPrefs({ previewQuality: q })}
                  >
                    {q === 0 ? "低" : q === 1 ? "中" : "高"}
                  </button>
                ))}
              </div>
              <p className="pref-note">
                预览会把图像缩到这个上限再算：低 = 640px、中 = 1024px、高 = 1600px。
                调低能让大图上的滤镜预览更跟手。
              </p>
            </section>
          )}

          {tab === "scratchDisks" && (
            <section className="pref-sec">
              <h3 className="pref-h">暂存盘</h3>
              <p className="pref-note">
                Strata 的暂存都在内存里（历史快照 + 图层画布），不落临时盘。
              </p>
              <p className="pref-note">本机偏好与最近文件占用：约 {localStoreKb()} KB</p>
              <div className="pref-row">
                <button type="button" className="btn-ghost btn-sm" onClick={() => onClearRecent?.()}>
                  清理最近文件缓存
                </button>
              </div>
            </section>
          )}

          {tab === "cursors" && (
            <section className="pref-sec">
              <h3 className="pref-h">画布光标</h3>
              <div className="pref-seg">
                {(["tip", "crosshair", "system"] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`pref-seg-btn${prefs.cursorMode === c ? " is-on" : ""}`}
                    onClick={() => setPrefs({ cursorMode: c })}
                  >
                    {c === "tip" ? "笔尖光圈" : c === "crosshair" ? "十字" : "系统箭头"}
                  </button>
                ))}
              </div>
              <p className="pref-note">
                画笔类工具始终显示笔尖光圈（要看落笔范围）；这一项决定的是其它工具的光标。
              </p>
            </section>
          )}

          {tab === "transparencyAndGamut" && (
            <section className="pref-sec">
              <h3 className="pref-h">透明区域</h3>
              <div className="pref-row">
                <RangeInput
                  min={4}
                  max={64}
                  value={prefs.checkerSize}
                  aria-label="棋盘格大小"
                  onChange={(v) => setPrefs({ checkerSize: v })}
                />
                <span className="pref-val">{prefs.checkerSize} px</span>
              </div>
              <p className="pref-note">棋盘格越小越容易看出细小透明像素，越大画面越安静。</p>
              <p className="pref-note">色域：Strata 全流程使用 sRGB，导出不做额外的色彩空间转换。</p>
            </section>
          )}

          {tab === "unitsAndRulers" && (
            <section className="pref-sec">
              <h3 className="pref-h">标尺与测量单位</h3>
              <div className="pref-seg">
                {(["px", "cm", "mm", "in"] as const).map((u) => (
                  <button
                    key={u}
                    type="button"
                    className={`pref-seg-btn${prefs.rulerUnit === u ? " is-on" : ""}`}
                    onClick={() => setPrefs({ rulerUnit: u })}
                  >
                    {u}
                  </button>
                ))}
              </div>
              <p className="pref-note">
                影响标尺刻度与「图像 &gt; 分析」里的测量显示（按 96 dpi 折算：1 in = 96 px）。
              </p>
            </section>
          )}

          {tab === "guidesGridAndSlices" && (
            <section className="pref-sec">
              <h3 className="pref-h">网格间距</h3>
              <div className="pref-row">
                <RangeInput
                  min={8}
                  max={512}
                  value={prefs.gridSize}
                  aria-label="网格间距"
                  onChange={(v) => setPrefs({ gridSize: v })}
                />
                <span className="pref-val">{prefs.gridSize} px</span>
              </div>
              <p className="pref-note">
                网格随画布缩放一起缩放，改完立刻生效（视图 &gt; 显示 &gt; 网格）。
              </p>
            </section>
          )}

          {tab === "type" && (
            <section className="pref-sec">
              <h3 className="pref-h">默认字号</h3>
              <div className="pref-row">
                <RangeInput
                  min={6}
                  max={400}
                  value={prefs.typeSize}
                  aria-label="默认字号"
                  onChange={(v) => setPrefs({ typeSize: v })}
                />
                <span className="pref-val">{prefs.typeSize} px</span>
              </div>
              <p className="pref-note">文字工具新建文本框时用这个字号。</p>
            </section>
          )}

          {tab === "enhancedControls" && (
            <section className="pref-sec">
              <h3 className="pref-h">拖动判定阈值</h3>
              <div className="pref-row">
                <RangeInput
                  min={1}
                  max={20}
                  value={prefs.dragThreshold}
                  aria-label="拖动判定阈值"
                  onChange={(v) => setPrefs({ dragThreshold: v })}
                />
                <span className="pref-val">{prefs.dragThreshold} px</span>
              </div>
              <p className="pref-note">
                与「常规」页是同一项：指针移动超过这个距离才算拖动，而不是点了一下。
              </p>
            </section>
          )}

          {tab === "rawDefaults" && (
            <section className="pref-sec">
              <h3 className="pref-h">RAW 导入</h3>
              <label className="pref-check">
                <input
                  type="checkbox"
                  checked={prefs.rawAutoTone}
                  onChange={(e) => setPrefs({ rawAutoTone: e.target.checked })}
                />
                导入 RAW 时自动做一次色调恢复
              </label>
              <p className="pref-note">
                Strata 直接读 TIFF / PNG / JPEG / PSD；RAW 容器走系统解码后的 8 位数据，
                这一项决定解码后是否再套一次自动色阶。
              </p>
            </section>
          )}

          {tab === "plugIns" && (
            <section className="pref-sec">
              <h3 className="pref-h">增效工具</h3>
              <p className="pref-note">
                当前构建不加载第三方 Photoshop 插件（8BF / 插件目录）。滤镜与自动化能力都内建在
                Strata 里：滤镜走「滤镜」菜单，批量与外部调用走仓库里的 MCP 服务器。
              </p>
              <p className="pref-note">这里如实显示状态，不做假的「启用插件」开关。</p>
            </section>
          )}

          {tab === "integrations" && (
            <section className="pref-sec">
              <h3 className="pref-h">AI 集成</h3>
              <p className="pref-note">
                Strata 不内置云端 AI；需要 AI 能力时通过 MCP 服务器把文档读写暴露给外部模型
                （仓库里的 mcp/ 就是这套服务）。
              </p>
              <p className="pref-note">连接管理在左侧「连接器」里做，这里不重复一套开关。</p>
            </section>
          )}

          {tab === "personal" && (
            <>
              <p className="pref-note" style={{ marginTop: 0 }}>
                {zh.preferences.personal.title}：{zh.preferences.personal.bgImageHint}
              </p>
              <section className="pref-sec">
                <h3 className="pref-h">{zh.preferences.personal.bgImage}</h3>
                <div className="pref-row">
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={async () => {
                      const p = await open({
                        multiple: false,
                        filters: [
                          { name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] },
                        ],
                      });
                      if (typeof p === "string") setPrefs({ bgImage: p });
                    }}
                  >
                    {zh.preferences.personal.bgImageImport}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    disabled={!prefs.bgImage}
                    onClick={() => setPrefs({ bgImage: "" })}
                  >
                    {zh.preferences.personal.bgImageClear}
                  </button>
                </div>
                {prefs.bgImage ? (
                  <div className="frost-preview" aria-hidden="true" />
                ) : (
                  <div className="frost-preview-empty">{zh.preferences.personal.bgImageHint}</div>
                )}
                <p className="pref-note">{zh.preferences.personal.bgImageHint}</p>
              </section>

              <section className="pref-sec">
                <h3 className="pref-h">{zh.preferences.personal.bgFrost}</h3>
                <div className="pref-row">
                  <RangeInput
                    min={0}
                    max={100}
                    value={prefs.bgFrost}
                    aria-label={zh.preferences.personal.bgFrost}
                    onChange={(v) => setPrefs({ bgFrost: v })}
                  />
                  <span className="pref-val">{prefs.bgFrost}%</span>
                </div>
                <p className="pref-note">
                  {zh.preferences.personal.bgFrostHint}
                  {prefs.bgFrost >= 70 ? "（高品质磨砂）" : ""}
                </p>
              </section>

              <section className="pref-sec">
                <h3 className="pref-h">{zh.preferences.personal.globalFrost}</h3>
                <div className="pref-seg">
                  <button
                    type="button"
                    className={`pref-seg-btn${prefs.globalFrost ? " is-on" : ""}`}
                    onClick={() => setPrefs({ globalFrost: true })}
                  >
                    {zh.panel.yes}
                  </button>
                  <button
                    type="button"
                    className={`pref-seg-btn${!prefs.globalFrost ? " is-on" : ""}`}
                    onClick={() => setPrefs({ globalFrost: false })}
                  >
                    {zh.panel.no}
                  </button>
                </div>
                <p className="pref-note">{zh.preferences.personal.globalFrostHint}</p>
              </section>

              {!prefs.globalFrost && (
                <section className="pref-sec">
                  <h3 className="pref-h">{zh.preferences.personal.windowFrost}</h3>
                  <div className="pref-seg">
                    <button
                      type="button"
                      className={`pref-seg-btn${prefs.windowFrost ? " is-on" : ""}`}
                      onClick={() => setPrefs({ windowFrost: true })}
                    >
                      {zh.panel.yes}
                    </button>
                    <button
                      type="button"
                      className={`pref-seg-btn${!prefs.windowFrost ? " is-on" : ""}`}
                      onClick={() => setPrefs({ windowFrost: false })}
                    >
                      {zh.panel.no}
                    </button>
                  </div>
                  <p className="pref-note">{zh.preferences.personal.windowFrostHint}</p>
                </section>
              )}

              <section className="pref-sec">
                <h3 className="pref-h">{zh.preferences.personal.frostColor}</h3>
                <div className="frost-swatches">
                  {FROST_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`frost-swatch${prefs.frostColor.toLowerCase() === c.toLowerCase() ? " is-on" : ""}`}
                      style={{ background: c }}
                      aria-label={c}
                      onClick={() => setPrefs({ frostColor: c })}
                    />
                  ))}
                  <label
                    className="frost-swatch"
                    style={{
                      background: prefs.frostColor,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      overflow: "hidden",
                    }}
                  >
                    <input
                      type="color"
                      value={prefs.frostColor}
                      onChange={(e) => setPrefs({ frostColor: e.target.value })}
                      style={{
                        width: "180%",
                        height: "180%",
                        border: "none",
                        padding: 0,
                        background: "none",
                        cursor: "pointer",
                      }}
                      aria-label="自定义磨砂色"
                    />
                  </label>
                </div>
                <p className="pref-note">{zh.preferences.personal.frostColorHint}</p>
              </section>

              <section className="pref-sec">
                <h3 className="pref-h">{zh.preferences.personal.glass}</h3>
                <div className="glass-preview" aria-hidden="true" />
                <p className="pref-note">{zh.preferences.personal.glassHint}</p>
                <div className="pref-row">
                  <span style={{ minWidth: 92 }}>{zh.preferences.personal.glassAlpha}</span>
                  <RangeInput
                    min={10}
                    max={45}
                    value={prefs.glassAlpha}
                    aria-label={zh.preferences.personal.glassAlpha}
                    onChange={(v) => setPrefs({ glassAlpha: v })}
                  />
                  <span className="pref-val">{prefs.glassAlpha}%</span>
                </div>
                <p className="pref-note">{zh.preferences.personal.glassAlphaHint}</p>
                <div className="pref-row">
                  <span style={{ minWidth: 92 }}>{zh.preferences.personal.glassBlur}</span>
                  <RangeInput
                    min={8}
                    max={40}
                    value={prefs.glassBlur}
                    aria-label={zh.preferences.personal.glassBlur}
                    onChange={(v) => setPrefs({ glassBlur: v })}
                  />
                  <span className="pref-val">{prefs.glassBlur}px</span>
                </div>
                <p className="pref-note">{zh.preferences.personal.glassBlurHint}</p>
                <div className="pref-row">
                  <span style={{ minWidth: 92 }}>{zh.preferences.personal.glassSat}</span>
                  <RangeInput
                    min={100}
                    max={200}
                    value={prefs.glassSat}
                    aria-label={zh.preferences.personal.glassSat}
                    onChange={(v) => setPrefs({ glassSat: v })}
                  />
                  <span className="pref-val">{prefs.glassSat}%</span>
                </div>
                <p className="pref-note">{zh.preferences.personal.glassSatHint}</p>
                <div className="pref-row">
                  <span style={{ minWidth: 92 }}>{zh.preferences.personal.glassSheen}</span>
                  <RangeInput
                    min={0}
                    max={40}
                    value={prefs.glassSheen}
                    aria-label={zh.preferences.personal.glassSheen}
                    onChange={(v) => setPrefs({ glassSheen: v })}
                  />
                  <span className="pref-val">{prefs.glassSheen}%</span>
                </div>
                <p className="pref-note">{zh.preferences.personal.glassSheenHint}</p>
              </section>

              <section className="pref-sec">
                <h3 className="pref-h">{zh.preferences.personal.motion}</h3>
                <div className="pref-seg" style={{ flexWrap: "wrap" }}>
                  {(
                    [
                      ["full", zh.preferences.personal.motionFull],
                      ["reduced", zh.preferences.personal.motionReduced],
                      ["off", zh.preferences.personal.motionOff],
                    ] as const
                  ).map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      className={`pref-seg-btn${prefs.motion === v ? " is-on" : ""}`}
                      onClick={() => setPrefs({ motion: v })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="pref-note">{zh.preferences.personal.motionHint}</p>
              </section>

              <section className="pref-sec">
                <h3 className="pref-h">{zh.preferences.personal.touchpad}</h3>
                <div className="pref-row">
                  <span>{zh.preferences.personal.touchpadNaturalScroll}</span>
                  <div className="pref-seg">
                    <button
                      type="button"
                      className={`pref-seg-btn${prefs.touchpadNaturalScroll ? " is-on" : ""}`}
                      onClick={() => setPrefs({ touchpadNaturalScroll: true })}
                    >
                      {zh.panel.yes}
                    </button>
                    <button
                      type="button"
                      className={`pref-seg-btn${!prefs.touchpadNaturalScroll ? " is-on" : ""}`}
                      onClick={() => setPrefs({ touchpadNaturalScroll: false })}
                    >
                      {zh.panel.no}
                    </button>
                  </div>
                </div>
                <p className="pref-note">{zh.preferences.personal.touchpadNaturalScrollHint}</p>
              </section>

              <section className="pref-sec">
                <h3 className="pref-h">{zh.preferences.personal.hoverGlow}</h3>
                <div className="pref-row">
                  <span>{zh.preferences.personal.hoverGlow}</span>
                  <div className="pref-seg">
                    <button
                      type="button"
                      className={`pref-seg-btn${prefs.hoverGlow ? " is-on" : ""}`}
                      onClick={() => setPrefs({ hoverGlow: true })}
                    >
                      {zh.panel.yes}
                    </button>
                    <button
                      type="button"
                      className={`pref-seg-btn${!prefs.hoverGlow ? " is-on" : ""}`}
                      onClick={() => setPrefs({ hoverGlow: false })}
                    >
                      {zh.panel.no}
                    </button>
                  </div>
                </div>
                <p className="pref-note">{zh.preferences.personal.hoverGlowHint}</p>
              </section>

              <section className="pref-sec">
                <h3 className="pref-h">{zh.preferences.personal.font}</h3>
                <div className="pref-row">
                  <select
                    className="ui-font-select"
                    value={prefs.uiFont ?? ""}
                    onChange={(e) => setPrefs({ uiFont: e.target.value })}
                    aria-label={zh.preferences.personal.font}
                  >
                    {FONT_OPTIONS.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="pref-note">{zh.preferences.personal.fontHint}</p>
              </section>

              <section className="pref-sec">
                <h3 className="pref-h">{zh.preferences.personal.uiScale}</h3>
                <div className="pref-row">
                  <RangeInput
                    min={80}
                    max={140}
                    value={prefs.uiScale}
                    aria-label={zh.preferences.personal.uiScale}
                    onChange={(v) => setPrefs({ uiScale: v })}
                  />
                  <span className="pref-val">{prefs.uiScale}%</span>
                </div>
                <p className="pref-note">{zh.preferences.personal.uiScaleHint}</p>
              </section>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
