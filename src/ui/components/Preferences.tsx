/**
 * 偏好设置（菜单 Edit > Preferences 下的 18 个条目都落到这里）。
 *
 * 布局与 PS 首选项同构：左侧页面列表 + 右侧内容。
 *
 * **尺寸稳定**：整个面板的高度固定（见 Preferences.css 的 `.pref` 高度），
 * 右侧内容区自己滚动。之前是按内容撑高，切换页面时窗口忽大忽小 —— 现在不会了。
 *
 * 每一条设置都真的被代码消费（不是装饰）：历史步数进 HistoryStack、网格间距进网格浮层、
 * 棋盘格进 CSS 变量、光标进画布 cursor、密度进根节点 class、字号进文字工具、
 * 导出格式进快速导出。没有后端可接的两页（增效工具 / AI 集成）如实显示当前状态，
 * 不做假的开关。
 */
import { useState } from "react";
import { zh } from "../../i18n/zh-CN";
import { resetPrefs, setPrefs, usePrefs } from "../../stores/prefs";
import type { ThemeMode } from "../../stores/theme";
import { TOOLS, TOOL_GROUPS, type ToolId } from "../../tools/catalog";
import type { BrushSettings } from "../../engine/paint";
import Modal from "./Modal";
import ToolIcon from "./ToolIcon";
import "./Preferences.css";
import RangeInput from "./RangeInput";

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
  | "rawDefaults";

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

const PAGES: { id: PrefPage; label: string }[] = [
  { id: "general", label: "常规" },
  { id: "interface", label: "界面" },
  { id: "workspace", label: "工作区" },
  { id: "tools", label: "工具" },
  { id: "brush", label: "画笔" },
  { id: "historyLog", label: "历史记录" },
  { id: "fileHandling", label: "文件处理" },
  { id: "export", label: "导出" },
  { id: "performance", label: "性能" },
  { id: "scratchDisks", label: "暂存盘" },
  { id: "cursors", label: "光标" },
  { id: "transparencyAndGamut", label: "透明与色域" },
  { id: "unitsAndRulers", label: "单位与标尺" },
  { id: "guidesGridAndSlices", label: "参考线、网格" },
  { id: "type", label: "文字" },
  { id: "enhancedControls", label: "增强控件" },
  { id: "rawDefaults", label: "Raw 默认" },
  { id: "plugIns", label: "增效工具" },
  { id: "integrations", label: "AI 集成" },
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
          {PAGES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`pref-tab${tab === t.id ? " is-on" : ""}`}
              onClick={() => go(t.id)}
            >
              {t.label}
            </button>
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
        </div>
      </div>
    </Modal>
  );
}
