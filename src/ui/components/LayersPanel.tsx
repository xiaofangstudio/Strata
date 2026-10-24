/**
 * 右侧单列面板（立项规划书 §7.1 的第 ③ 条）。
 *
 * 只保留一列标签页：图层 / 通道 / 路径 / 历史。已接入的是「图层」「通道」
 * 与「历史」，路径仍以禁用态呈现并说明去向，不做假面板 —— 其余功能一律
 * 改成按需呼出的浮层（颜色在工具轨底部、命令在 Ctrl+K）。
 *
 * 通道页与其它页的性质不同：它**只看不改** —— 缩略图与「载入选区」都从
 * 合成结果现算，通道的显示开关属于视图状态，一个像素都不动（详见
 * core/channels）。图层页则相反，所有改动都走 core/layerOps 的纯函数，
 * 面板自己不碰像素。
 */
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  useMemo,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { zh } from "../../i18n/zh-CN";
import { activeLayer, type StrataDoc } from "../../core/document";
import { capturePointer } from "../pointer";
import {
  ADJUST_DEFS,
  BLEND_MODES,
  DEFAULT_STOPS,
  STROKE_POSITIONS,
  STYLE_DEFS,
  adjustDef,
  adjustFamily,
  curveOf,
  setCurveOf,
  newAdjustState,
  newLayerStyle,
  styleDef,
  type AdjustFamily,
  type AdjustId,
  type AdjustParam,
  type AdjustState,
  type BlendId,
  type CurveChannel,
  type GradientStop,
  type LayerStyle,
  type StrataLayer,
  type StyleId,
} from "../../core/layer";
import { hexToRgb01, monotoneAt, rgb01ToHex, type CurvePoint } from "../../engine/filters";
import {
  addAdjustLayer,
  addLayer,
  addLayerStyle,
  addMask,
  canShiftLayer,
  duplicateLayer,
  groupLayers,
  invertMask,
  mergeDown,
  moveLayer,
  removeLayer,
  removeMask,
  removeLayerStyle,
  selectLayer,
  setAdjust,
  setBlend,
  setOpacity,
  setSelection,
  toggleClip,
  toggleLayerStyle,
  toggleMaskActive,
  ungroupLayers,
  updateLayer,
  updateLayerStyle,
} from "../../core/layerOps";
import { composeDoc } from "../../engine/compositor";
import { createSurface } from "../../engine/surface";
import {
  CHANNEL_ORDER,
  DEFAULT_CHANNEL_VIS,
  channelThumb,
  channelToSelection,
  isChannelViewDefault,
  toggleChannelVis,
  alphaChannelThumb,
  type AlphaChannel,
  type ChannelId,
  type ChannelVis,
} from "../../core/channels";
import {
  alphaChannelsOf,
  createBlankChannel,
  deleteChannel,
  duplicateChannel,
  loadChannelAsSelection,
} from "../../core/channelOps";
import ColorChip from "./ColorChip";
import RangeInput from "./RangeInput";
import "./LayersPanel.css";

interface Props {
  doc: StrataDoc;
  /** 会写进历史栈的改动 */
  onChange: (next: StrataDoc, label: string) => void;
  /** 不写历史的即时预览（拖动滑杆、切换选中） */
  onPreview: (next: StrataDoc) => void;
  /** 当前是否在编辑蒙版（画笔落在蒙版上） */
  maskEdit: boolean;
  onMaskEdit: (on: boolean) => void;
  /** 通道页：各原色通道是否参与合成（纯视图，不入历史） */
  channelVis: ChannelVis;
  /** 通道页：当前正在查看的通道 */
  activeChannel: ChannelId;
  /** 通道页：改视图 —— 只影响屏幕，不写历史 */
  onChannel: (vis: ChannelVis, active: ChannelId) => void;
  /** 通道页：打开「存储选区」对话框 */
  onSaveSelection: () => void;
  /** 通道页：打开「载入选区」对话框 */
  onLoadSelection: () => void;
  /** 通道页：打开「通道运算」对话框 */
  onChannelCalc: () => void;
  /** 正在灰度查看的 Alpha 通道 id（null = 没在看） */
  viewAlpha: string | null;
  /** 切换 / 关闭 Alpha 通道灰度查看 */
  onViewAlpha: (id: string | null) => void;
  /** 图层行右键（菜单浮层在 EditorShell 统一渲染） */
  onLayerContextMenu?: (e: ReactMouseEvent, layerId: string) => void;
  /** 蒙版缩略图右键 */
  onMaskContextMenu?: (e: ReactMouseEvent, layerId: string) => void;
}

type TabId = "layers" | "channels" | "paths";

export default function LayersPanel({
  doc,
  onChange,
  onPreview,
  maskEdit,
  onMaskEdit,
  channelVis,
  activeChannel,
  onChannel,
  onSaveSelection,
  onLoadSelection,
  onChannelCalc,
  viewAlpha,
  onViewAlpha,
  onLayerContextMenu,
  onMaskContextMenu,
}: Props) {
  const [tab, setTab] = useState<TabId>("layers");
  const cur = activeLayer(doc);

  return (
    <aside className="panel dock-panel" aria-label={zh.panel.layers}>
      <div className="panel-tabs" role="tablist">
        <TabButton id="layers" tab={tab} onPick={setTab} label={zh.panel.layers} />
        <TabButton
          id="channels"
          tab={tab}
          onPick={setTab}
          label={zh.panel.channels}
          hint={zh.panel.channelHint}
        />
        <TabButton
          id="paths"
          tab={tab}
          onPick={setTab}
          label={zh.panel.paths}
          hint={zh.panel.pathsSoon}
          disabled
        />
      </div>

      {tab === "layers" && cur && (
        <LayerTab
          doc={doc}
          cur={cur}
          onChange={onChange}
          onPreview={onPreview}
          maskEdit={maskEdit}
          onMaskEdit={onMaskEdit}
          onLayerContextMenu={onLayerContextMenu}
          onMaskContextMenu={onMaskContextMenu}
        />
      )}

      {tab === "channels" && (
        <ChannelTab
          doc={doc}
          vis={channelVis}
          active={activeChannel}
          onChannel={onChannel}
          onChange={onChange}
          onSaveSelection={onSaveSelection}
          onLoadSelection={onLoadSelection}
          onChannelCalc={onChannelCalc}
          viewAlpha={viewAlpha}
          onViewAlpha={onViewAlpha}
        />
      )}
    </aside>
  );
}

/* ---------------- 通道页 ---------------- */

/** 通道名的中文文案；复合通道排在最上，与 PS 一致。 */
function channelName(id: ChannelId): string {
  switch (id) {
    case "red":
      return zh.panel.channelRed;
    case "green":
      return zh.panel.channelGreen;
    case "blue":
      return zh.panel.channelBlue;
    case "alpha":
      return zh.panel.channelAlpha;
    default:
      return zh.panel.channelRgb;
  }
}

/**
 * 通道面板。
 *
 * 五行顺序与 PS 一致：RGB 复合通道在最上，下面依次红、绿、蓝、透明度。
 * 两种操作各管一摊、互不干扰：
 *  · **点眼睛** —— 该通道是否参与合成。关掉红，画面整体偏青；关掉透明度，
 *    整幅按不透明看。复合通道没有独立开关，点它等于同时开关红绿蓝。
 *  · **点名字** —— 整幅按该通道的灰度单独查看，看清这一原色的浓淡；
 *    再点回 RGB 就回到完整彩色画面。
 *
 * 缩略图与「载入选区」都从合成结果现算 —— 通道是视图不是数据，面板一个像素
 * 都不改。缩略图算的是**原始**合成结果、不含通道视图本身，否则关掉红之后
 * 红通道的缩略图永远全黑，反而看不出里面有什么。
 */
function ChannelTab({
  doc,
  vis,
  active,
  onChannel,
  onChange,
  onSaveSelection,
  onLoadSelection,
  onChannelCalc,
  viewAlpha,
  onViewAlpha,
}: {
  doc: StrataDoc;
  vis: ChannelVis;
  active: ChannelId;
  onChannel: (vis: ChannelVis, active: ChannelId) => void;
  onChange: (next: StrataDoc, label: string) => void;
  /** 打开「存储选区」对话框 */
  onSaveSelection: () => void;
  /** 打开「载入选区」对话框 */
  onLoadSelection: () => void;
  /** 打开「通道运算」对话框 */
  onChannelCalc: () => void;
  /** 正在查看的 Alpha 通道 id（灰色单独查看）；null = 没在看 */
  viewAlpha: string | null;
  /** 切换 / 关闭 Alpha 通道灰度查看 */
  onViewAlpha: (id: string | null) => void;
}) {
  // 合成结果现算一次，五张缩略图与「载入选区」共用同一张。
  const [flat, setFlat] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = createSurface(doc.width, doc.height);
    composeDoc(doc, c);
    setFlat(c);
  }, [doc]);

  const channels = alphaChannelsOf(doc);
  const current = viewAlpha ? channels.find((c) => c.id === viewAlpha) : undefined;

  /** 把当前通道的明暗当作选区载入 —— 与 PS 的「载入通道作为选区」同一口径。 */
  const loadChannel = () => {
    if (!flat) return;
    onChange(
      setSelection(doc, channelToSelection(flat, active)),
      zh.panel.channelLoad,
    );
  };

  const duplicateSelected = () => {
    if (current) onChange(duplicateChannel(doc, current.id), zh.panel.channelDuplicate);
  };
  const deleteSelected = () => {
    if (!current) return;
    onChange(deleteChannel(doc, current.id), zh.panel.channelDelete);
    onViewAlpha(null);
  };
  const newBlank = () => onChange(createBlankChannel(doc), zh.panel.channelNew);

  return (
    <Fragment>
      <div className="ly-list">
        <div className="ch-list">
          {CHANNEL_ORDER.map((id) => (
            <ChannelRow
              key={id}
              id={id}
              flat={flat}
              vis={vis}
              active={active}
              onChannel={onChannel}
            />
          ))}
        </div>

        {/* 正在单独查看某个通道时给一句说明，免得以为画面坏了 */}
        {active !== "rgb" && <p className="ch-note">{zh.panel.channelViewing}</p>}

        {/* Alpha 通道（存储的选区）：持久数据，与上面的派生视图分开成段 */}
        {channels.length > 0 && (
          <>
            <div className="ch-divider">{zh.panel.channelAlphaChannels}</div>
            <div className="ch-list">
              {channels.map((c) => (
                <AlphaChannelRow
                  key={c.id}
                  channel={c}
                  viewed={viewAlpha === c.id}
                  onView={(on) => onViewAlpha(on ? c.id : null)}
                  onLoad={() => onChange(loadChannelAsSelection(doc, c.id, "new"), zh.dialog.channelLoadDone)}
                  onDelete={() => {
                    onChange(deleteChannel(doc, c.id), zh.panel.channelDelete);
                    if (viewAlpha === c.id) onViewAlpha(null);
                  }}
                />
              ))}
            </div>
          </>
        )}

        {/* 查看某个 Alpha 通道时也提示一句，免得以为画面黑了 */}
        {viewAlpha && <p className="ch-note">{zh.panel.channelViewingAlpha}</p>}
      </div>

      <div className="ly-foot ch-foot">
        <button
          type="button"
          className="ch-act"
          disabled={!flat || isChannelViewDefault(vis, active)}
          title={zh.panel.channelReset}
          onClick={() => onChannel(DEFAULT_CHANNEL_VIS, "rgb")}
        >
          {zh.panel.channelReset}
        </button>
        <span className="ly-foot-gap" />
        <button
          type="button"
          className="ch-act"
          disabled={!flat}
          title={zh.panel.channelLoadHint}
          onClick={loadChannel}
        >
          {zh.panel.channelLoad}
        </button>
        <span className="ly-foot-gap" />
        <button
          type="button"
          className="ch-act"
          disabled={!flat}
          title="把当前选区存成 Alpha 通道"
          onClick={onSaveSelection}
        >
          {zh.panel.channelSave}
        </button>
        <button
          type="button"
          className="ch-act"
          disabled={channels.length === 0}
          title="把某个 Alpha 通道载回选区"
          onClick={onLoadSelection}
        >
          {zh.panel.channelLoad}
        </button>
        <button
          type="button"
          className="ch-act"
          disabled={channels.length < 2}
          title="两个 Alpha 通道逐像素运算"
          onClick={onChannelCalc}
        >
          {zh.dialog.channelCalcTitle}
        </button>
        <span className="ly-foot-gap" />
        <button
          type="button"
          className="ch-act"
          disabled={!current}
          title="复制当前查看的通道"
          onClick={duplicateSelected}
        >
          {zh.panel.channelDuplicate}
        </button>
        <button
          type="button"
          className="ch-act is-danger"
          disabled={!current}
          title="删除当前查看的通道"
          onClick={deleteSelected}
        >
          {zh.panel.channelDelete}
        </button>
        <button
          type="button"
          className="ch-act"
          disabled={!flat}
          title="新建一张空白通道"
          onClick={newBlank}
        >
          {zh.panel.channelNew}
        </button>
      </div>
    </Fragment>
  );
}

/**
 * Alpha 通道行：眼睛管「灰度单独查看」，缩略图点一下把该通道当选区载入，
 * 名字也切到查看。与上面颜色通道同一套行样式，只是底部多了一个删除「×」。
 */
function AlphaChannelRow({
  channel,
  viewed,
  onView,
  onLoad,
  onDelete,
}: {
  channel: AlphaChannel;
  viewed: boolean;
  onView: (on: boolean) => void;
  onLoad: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(alphaChannelThumb(channel.mask, c.width), 0, 0);
  }, [channel]);

  return (
    <div className={viewed ? "ch-row is-viewed" : "ch-row"}>
      <button
        type="button"
        className={viewed ? "ly-eye" : "ly-eye is-off"}
        aria-pressed={viewed}
        title="查看此通道（灰度）"
        onClick={() => onView(!viewed)}
      >
        <EyeIcon open={viewed} />
      </button>

      <canvas
        ref={ref}
        width={36}
        height={36}
        className="ly-thumb ch-mono"
        title="点击把该通道载入选区"
        onClick={onLoad}
      />

      <button
        type="button"
        className="ch-name"
        title="查看此通道（灰度）"
        onClick={() => onView(!viewed)}
      >
        {channel.name}
      </button>

      <button
        type="button"
        className="ch-del"
        title={zh.panel.channelDelete}
        aria-label={`${zh.panel.channelDelete}：${channel.name}`}
        onClick={onDelete}
      >
        ×
      </button>
    </div>
  );
}

/** 通道行：眼睛管「是否参与合成」，点名字管「单独查看」。 */
function ChannelRow({
  id,
  flat,
  vis,
  active,
  onChannel,
}: {
  id: ChannelId;
  flat: HTMLCanvasElement | null;
  vis: ChannelVis;
  active: ChannelId;
  onChannel: (vis: ChannelVis, active: ChannelId) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c || !flat) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    // 缩略图统一走 channels 的纯函数：等比居中 + 单通道灰度化都在那里
    ctx.drawImage(channelThumb(flat, id, c.width), 0, 0);
  }, [flat, id]);

  // 复合通道的「眼睛」是红绿蓝的总开关：三个都亮才算亮着。
  const on = id === "rgb" ? vis.red && vis.green && vis.blue : vis[id];
  const viewed = id === active;

  return (
    <div className={viewed ? "ch-row is-viewed" : "ch-row"}>
      <button
        type="button"
        className={on ? "ly-eye" : "ly-eye is-off"}
        aria-pressed={on}
        title={on ? zh.layers.visible : zh.layers.hidden}
        onClick={() => onChannel(toggleChannelVis(vis, id), active)}
      >
        <EyeIcon open={on} />
      </button>

      <canvas
        ref={ref}
        width={36}
        height={36}
        className={id === "rgb" ? "ly-thumb" : "ly-thumb ch-mono"}
      />

      <button
        type="button"
        className="ch-name"
        title={zh.panel.channelHint}
        onClick={() => onChannel(vis, id)}
      >
        {channelName(id)}
      </button>
    </div>
  );
}

/* ---------------- 标签页 ---------------- */

interface TabProps {
  id: TabId;
  tab: TabId;
  label: string;
  hint?: string;
  /** 尚未接入的页签（通道 / 路径）：置灰不可点 */
  disabled?: boolean;
  onPick: (id: TabId) => void;
}

function TabButton({ id, tab, label, hint, disabled, onPick }: TabProps) {
  const on = id === tab;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      className={on ? "panel-tab is-on" : "panel-tab"}
      disabled={disabled}
      title={hint ?? label}
      onClick={() => onPick(id)}
    >
      {label}
    </button>
  );
}

/* ---------------- 图层页 ---------------- */

interface LayerTabProps {
  doc: StrataDoc;
  cur: StrataLayer;
  onChange: (next: StrataDoc, label: string) => void;
  onPreview: (next: StrataDoc) => void;
  maskEdit: boolean;
  onMaskEdit: (on: boolean) => void;
  onLayerContextMenu?: (e: ReactMouseEvent, layerId: string) => void;
  onMaskContextMenu?: (e: ReactMouseEvent, layerId: string) => void;
}

/**
 * 把扁平的 layers 数组摊成面板要显示的行。
 *
 * 两个变换：① 面板自上而下对应图层自顶向下，所以从数组末尾往前遍历（组内
 * 子层在数组里排在组的「下面」，倒着走正好落在组的下方，与 PS 的从属关系
 * 一致）；② 被折叠的组，它整棵子树都跳过 —— 折叠纯粹是显示的收起，文档
 * 结构一点不动。
 */
function buildRows(
  doc: StrataDoc,
  collapsed: Set<string>,
): { layer: StrataLayer; depth: number }[] {
  const byId = new Map(doc.layers.map((l) => [l.id, l]));
  const depthOf = (l: StrataLayer): number => {
    let d = 0;
    let p = l.parent ?? null;
    while (p) {
      const g = byId.get(p);
      if (!g) break;
      d += 1;
      p = g.parent ?? null;
    }
    return d;
  };
  const hidden = (l: StrataLayer): boolean => {
    let p = l.parent ?? null;
    while (p) {
      if (collapsed.has(p)) return true;
      const g = byId.get(p);
      if (!g) break;
      p = g.parent ?? null;
    }
    return false;
  };

  const rows: { layer: StrataLayer; depth: number }[] = [];
  for (let i = doc.layers.length - 1; i >= 0; i -= 1) {
    const l = doc.layers[i];
    if (hidden(l)) continue;
    rows.push({ layer: l, depth: depthOf(l) });
  }
  return rows;
}

function LayerTab({
  doc,
  cur,
  onChange,
  onPreview,
  maskEdit,
  onMaskEdit,
  onLayerContextMenu,
  onMaskContextMenu,
}: LayerTabProps) {
  const [dragOpacity, setDragOpacity] = useState<number | null>(null);
  /** 被折叠起来的组 id（只影响面板显示，不动文档） */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const shown = dragOpacity ?? cur.opacity;
  const canRemove = doc.layers.length > 1;
  const at = doc.layers.findIndex((l) => l.id === cur.id);
  const rows = buildRows(doc, collapsed);

  /** 向下合并的可用态：与 layerOps.mergeDown 的守卫一一对应 */
  const mergeOk =
    at > 0 &&
    doc.layers[at].kind !== "group" &&
    doc.layers[at - 1].kind === "pixel" &&
    (doc.layers[at].parent ?? null) === (doc.layers[at - 1].parent ?? null);

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const commitOpacity = () => {
    if (dragOpacity === null) return;
    onChange(setOpacity(doc, cur.id, dragOpacity), zh.layers.opacity);
    setDragOpacity(null);
  };

  return (
    <>
      <div className="ly-props">
        <div className="ly-quick">
          <select
            className="ly-select"
            value={cur.blend}
            title={zh.layers.blend}
            onChange={(e) => onChange(setBlend(doc, cur.id, e.target.value as BlendId), zh.layers.blend)}
          >
            {BLEND_MODES.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
          <div className="ly-op" title={zh.layers.opacity}>
            <RangeInput
              className="ly-range"
              min={0}
              max={100}
              step={1}
              value={shown}
              aria-label={zh.layers.opacity}
              onChange={(v) => {
                setDragOpacity(v);
                onPreview(setOpacity(doc, cur.id, v));
              }}
              onDragEnd={commitOpacity}
            />
            <span className="ly-opacity">{shown}</span>
          </div>
        </div>

        {cur.mask && (
          <div className="ly-maskbar">
            <span className="ly-prop-label">{zh.layers.mask}</span>
            <button
              type="button"
              className={maskEdit ? "ly-toggle is-on" : "ly-toggle"}
              title={maskEdit ? zh.layers.maskEditPixel : zh.layers.maskEdit}
              onClick={() => onMaskEdit(!maskEdit)}
            >
              {maskEdit ? zh.layers.mask : zh.layers.maskEdit}
            </button>
            <button
              type="button"
              className="ly-toggle"
              title={zh.layers.maskEnable}
              onClick={() => onChange(toggleMaskActive(doc), zh.layers.maskEnable)}
            >
              {cur.maskActive ? "◉" : "○"}
            </button>
            <button
              type="button"
              className="ly-toggle"
              title={zh.layers.maskInvert}
              onClick={() => onChange(invertMask(doc), zh.layers.maskInvert)}
            >
              ⇄
            </button>
            <button
              type="button"
              className="ly-toggle"
              title={zh.layers.maskRemove}
              onClick={() => {
                onMaskEdit(false);
                onChange(removeMask(doc), zh.layers.maskRemove);
              }}
            >
              ✕
            </button>
          </div>
        )}
      </div>

      <div className="ly-list" role="listbox" aria-label={zh.panel.layers}>
        {doc.layers.length === 0 && <p className="ly-empty">{zh.layers.empty}</p>}
        {rows.map(({ layer, depth }) => (
          <LayerRow
            key={layer.id}
            doc={doc}
            layer={layer}
            depth={depth}
            on={layer.id === cur.id}
            collapsed={collapsed.has(layer.id)}
            onToggleCollapse={() => toggleCollapse(layer.id)}
            onChange={onChange}
            onPreview={onPreview}
            onContextMenu={onLayerContextMenu}
            onMaskContextMenu={onMaskContextMenu}
          />
        ))}
      </div>

      <div className="ly-foot">
        <button
          type="button"
          className="ly-act"
          title={`${zh.layers.new}（Ctrl + Shift + N）`}
          onClick={() => onChange(addLayer(doc), zh.layers.new)}
        >
          +
        </button>
        <button
          type="button"
          className="ly-act"
          title={`${zh.layers.duplicate}（Ctrl + J）`}
          onClick={() => onChange(duplicateLayer(doc), zh.layers.duplicate)}
        >
          ⧉
        </button>
        <button
          type="button"
          className="ly-act"
          disabled={!canRemove}
          title={canRemove ? zh.layers.delete : zh.layers.onlyOne}
          onClick={() => onChange(removeLayer(doc), zh.layers.delete)}
        >
          −
        </button>
        <button
          type="button"
          className={cur.mask ? "ly-act is-on" : "ly-act"}
          disabled={Boolean(cur.mask)}
          title={cur.mask ? zh.layers.mask : zh.layers.maskAdd}
          onClick={() => {
            onMaskEdit(true);
            onChange(addMask(doc, "reveal"), zh.layers.maskAdd);
          }}
        >
          ▣
        </button>
        <button
          type="button"
          className={cur.clip ? "ly-act is-on" : "ly-act"}
          disabled={at <= 0 || cur.kind === "adjust"}
          title={
            cur.kind === "adjust"
              ? zh.layers.clipAdjustDenied
              : at <= 0
                ? zh.layers.clipDenied
                : cur.clip
                  ? zh.layers.clipOn
                  : zh.layers.clipOff
          }
          onClick={() =>
            onChange(toggleClip(doc), cur.clip ? zh.layers.clipRelease : zh.layers.clipCreate)
          }
        >
          ⊂
        </button>
        <AdjustMenu onAdd={(id) => onChange(addAdjustLayer(doc, newAdjustState(id)), zh.layers.adjustAdd)} />
        <button
          type="button"
          className="ly-act"
          title={`${zh.layers.group}（Ctrl + G）`}
          onClick={() => onChange(groupLayers(doc), zh.layers.group)}
        >
          <GroupIcon />
        </button>
        <button
          type="button"
          className="ly-act"
          disabled={cur.kind !== "group"}
          title={cur.kind === "group" ? `${zh.layers.ungroup}（Ctrl + Shift + G）` : zh.layers.groupDenied}
          onClick={() => onChange(ungroupLayers(doc), zh.layers.ungroup)}
        >
          <UngroupIcon />
        </button>
        <span className="ly-foot-gap" />
        <button
          type="button"
          className="ly-act"
          disabled={!mergeOk}
          title={zh.layers.mergeDown}
          onClick={() => onChange(mergeDown(doc), zh.layers.mergeDown)}
        >
          ⤓
        </button>
        <button
          type="button"
          className="ly-act"
          disabled={!canShiftLayer(doc, 1)}
          title={zh.layers.up}
          onClick={() => onChange(moveLayer(doc, 1), zh.layers.up)}
        >
          ↑
        </button>
        <button
          type="button"
          className="ly-act"
          disabled={!canShiftLayer(doc, -1)}
          title={zh.layers.down}
          onClick={() => onChange(moveLayer(doc, -1), zh.layers.down)}
        >
          ↓
        </button>
      </div>
    </>
  );
}

/* ---------------- 调整图层 ---------------- */

/** 族的显示名与顺序（与 core/layer 的 AdjustFamily 一一对应）。 */
const FAMILY_LABEL: Record<AdjustFamily, string> = {
  tone: zh.layers.adjustFamilyTone,
  color: zh.layers.adjustFamilyColor,
  effect: zh.layers.adjustFamilyEffect,
};

const FAMILY_ORDER: readonly AdjustFamily[] = ["tone", "color", "effect"];

/** 底部「调整」按钮：点开按族分节列出可用的调整类型。 */
function AdjustMenu({ onAdd }: { onAdd: (id: AdjustId) => void }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]);

  return (
    <div className="ly-menu-wrap" ref={boxRef}>
      <button
        type="button"
        className={open ? "ly-act is-on" : "ly-act"}
        title={zh.layers.adjustAdd}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        fx
      </button>
      {open && (
        <div className="ly-menu" role="menu">
          {FAMILY_ORDER.map((fam) => {
            const items = ADJUST_DEFS.filter((d) => d.family === fam);
            if (items.length === 0) return null;
            return (
              <Fragment key={fam}>
                <span className="ly-menu-group">{FAMILY_LABEL[fam]}</span>
                {items.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    role="menuitem"
                    className="ly-menu-item"
                    onClick={() => {
                      setOpen(false);
                      onAdd(d.id);
                    }}
                  >
                    {d.label}
                  </button>
                ))}
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 调整图层的参数区（改参数不碰像素，随时可调可删）。 */
export function AdjustProps({
  doc,
  layer,
  onChange,
  onPreview,
}: {
  doc: StrataDoc;
  layer: StrataLayer;
  onChange: (next: StrataDoc, label: string) => void;
  onPreview: (next: StrataDoc) => void;
}) {
  const st = layer.adjust;
  if (!st) return null;
  const def = adjustDef(st.id);

  /** 只动一个数值，曲线 / 色标原样带走。 */
  const setParam = (id: string, value: number) =>
    onPreview(setAdjust(doc, layer.id, { ...st, params: { ...st.params, [id]: value } }));

  /** 松手时把当前这份状态写进历史。 */
  const commit = () => onChange(setAdjust(doc, layer.id, st), zh.layers.adjustParams);

  // 带 group 的参数按 group 分段显示（色彩平衡、通道混合器参数多，不分段会糊成一片）
  const sections: { title?: string; items: AdjustParam[] }[] = [];
  for (const p of def.params) {
    const last = sections[sections.length - 1];
    if (last && last.title === p.group) last.items.push(p);
    else sections.push({ title: p.group, items: [p] });
  }

  return (
    <div className="ly-adjust">
      <div className="ly-adjust-head">
        <span className="ly-adjust-title">{FAMILY_LABEL[adjustFamily(st.id)]} · {def.label}</span>
        <button
          type="button"
          className="ly-mini"
          title={zh.layers.adjustReset}
          onClick={() => onChange(setAdjust(doc, layer.id, newAdjustState(st.id)), zh.layers.adjustReset)}
        >
          ↺
        </button>
      </div>

      {st.id === "curves" && (
        <CurveEditor doc={doc} layer={layer} st={st} onChange={onChange} onPreview={onPreview} />
      )}
      {st.id === "gradientmap" && (
        <GradientEditor doc={doc} layer={layer} st={st} onChange={onChange} onPreview={onPreview} />
      )}

      {sections.map((sec, si) => (
        <Fragment key={sec.title ?? `s${si}`}>
          {sec.title && <span className="ly-group">{sec.title}</span>}
          {sec.items.map((p) => {
            const v = st.params[p.id] ?? p.def;
            return (
              <div className="ly-prop" key={p.id}>
                <span className="ly-prop-label">{p.label}</span>
                {p.choices ? (
                  <select
                    className="ly-select"
                    value={v}
                    onChange={(e) => setParam(p.id, Number(e.target.value))}
                    onBlur={commit}
                  >
                    {p.choices.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                ) : (
                  <RangeInput
                    className="ly-range"
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    value={v}
                    aria-label={p.label}
                    onChange={(nv) => setParam(p.id, nv)}
                    onDragEnd={commit}
                  />
                )}
                {!p.choices && (
                  <span className="ly-opacity">
                    {v.toFixed(p.dec ?? 0)}
                    {p.unit ?? ""}
                  </span>
                )}
              </div>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

/* ---------------- 图层样式（M2） ---------------- */

/** 样式里可以拖滑杆的四个数值字段。 */
type NumField = "opacity" | "size" | "distance" | "angle";

/**
 * 图层样式的编辑区。
 *
 * 只列出真实能渲染出来的六种（见 core/layer 的 STYLE_DEFS），不做假条目。
 * 每种样式能单独开关、改参数、重置、删除；拖滑杆时走 onPreview 实时预览，
 * 松手才写进历史，和调整图层一个套路。
 */
export function StyleProps({
  doc,
  layer,
  onChange,
  onPreview,
}: {
  doc: StrataDoc;
  layer: StrataLayer;
  onChange: (next: StrataDoc, label: string) => void;
  onPreview: (next: StrataDoc) => void;
}) {
  const list = layer.styles ?? [];
  /** 收起的样式（默认全展开，样式多了点标题能收起来） */
  const [folded, setFolded] = useState<StyleId[]>([]);
  const [pick, setPick] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pick) return;
    const away = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setPick(false);
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [pick]);

  /** live = true 时只预览不写历史。 */
  const setNum = (id: StyleId, field: NumField, v: number, live: boolean) => {
    const p = { [field]: v } as Partial<LayerStyle>;
    if (live) onPreview(updateLayerStyle(doc, id, p));
    else onChange(updateLayerStyle(doc, id, p), zh.layers.styleTitle);
  };

  const missing = STYLE_DEFS.filter((d) => !list.some((s) => s.id === d.id));

  return (
    <div className="ly-adjust ly-style">
      <div className="ly-adjust-head">
        <span className="ly-adjust-title">{zh.layers.style}</span>
        <div className="ly-menu-wrap" ref={boxRef}>
          <button
            type="button"
            className={pick ? "ly-mini is-on" : "ly-mini"}
            title={zh.layers.styleAdd}
            aria-haspopup="menu"
            aria-expanded={pick}
            onClick={() => setPick((v) => !v)}
          >
            +
          </button>
          {pick && (
            <div className="ly-menu is-down" role="menu">
              {missing.length === 0 ? (
                <span className="ly-menu-group">{zh.layers.styleAllAdded}</span>
              ) : (
                missing.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    role="menuitem"
                    className="ly-menu-item"
                    onClick={() => {
                      setPick(false);
                      onChange(addLayerStyle(doc, d.id), zh.layers.styleAdd);
                    }}
                  >
                    {d.label}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {list.length === 0 && <span className="ly-hint">{zh.layers.styleEmpty}</span>}

      {list.map((s) => {
        const def = styleDef(s.id);
        const shut = folded.includes(s.id);

        /** 一条数值滑杆。 */
        const numRow = (label: string, field: NumField, min: number, max: number) => (
          <div className="ly-prop" key={field}>
            <span className="ly-prop-label">{label}</span>
            <RangeInput
              className="ly-range"
              min={min}
              max={max}
              step={1}
              value={s[field]}
              aria-label={label}
              onChange={(v) => setNum(s.id, field, v, true)}
              onDragEnd={(v) => setNum(s.id, field, v, false)}
            />
            <span className="ly-opacity">
              {s[field]}
              {field === "angle" ? "°" : ""}
            </span>
          </div>
        );

        return (
          <div className="ly-style-item" key={s.id}>
            <div className="ly-style-head">
              <button
                type="button"
                className={s.enabled ? "ly-check is-on" : "ly-check"}
                title={zh.layers.styleEnable}
                aria-pressed={s.enabled}
                onClick={() => onChange(toggleLayerStyle(doc, s.id), zh.layers.styleEnable)}
              >
                {s.enabled ? "◉" : "○"}
              </button>
              <button
                type="button"
                className="ly-style-name"
                title={zh.layers.styleTitle}
                onClick={() =>
                  setFolded((f) => (f.includes(s.id) ? f.filter((x) => x !== s.id) : [...f, s.id]))
                }
              >
                {def.label}
              </button>
              <button
                type="button"
                className="ly-mini"
                title={zh.layers.styleReset}
                onClick={() =>
                  onChange(updateLayerStyle(doc, s.id, newLayerStyle(s.id)), zh.layers.styleReset)
                }
              >
                ↺
              </button>
              <button
                type="button"
                className="ly-mini"
                title={zh.layers.styleRemove}
                onClick={() => onChange(removeLayerStyle(doc, s.id), zh.layers.styleRemove)}
              >
                ✕
              </button>
            </div>

            {!shut && (
              <>
                <div className="ly-prop">
                  <span className="ly-prop-label">{zh.layers.styleColor}</span>
                  <ColorChip
                    className="ly-color"
                    label={zh.layers.styleColor}
                    hex={s.color}
                    onChange={(hex) => onPreview(updateLayerStyle(doc, s.id, { color: hex }))}
                    onCommit={() =>
                      onChange(updateLayerStyle(doc, s.id, { color: s.color }), zh.layers.styleTitle)
                    }
                  />
                </div>

                {numRow(zh.layers.styleOpacity, "opacity", 0, 100)}
                {def.size && numRow(def.sizeLabel, "size", 0, def.sizeMax)}
                {def.offset && numRow(zh.layers.styleDistance, "distance", 0, def.sizeMax)}
                {def.offset && numRow(zh.layers.styleAngle, "angle", -180, 180)}

                {def.position && (
                  <div className="ly-prop">
                    <span className="ly-prop-label">{zh.layers.stylePosition}</span>
                    <div className="ly-seg">
                      {STROKE_POSITIONS.map((p, i) => (
                        <button
                          key={p}
                          type="button"
                          className={s.position === i ? "ly-seg-btn is-on" : "ly-seg-btn"}
                          onClick={() =>
                            onChange(
                              updateLayerStyle(doc, s.id, { position: i }),
                              zh.layers.stylePosition,
                            )
                          }
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="ly-prop">
                  <span className="ly-prop-label">{zh.layers.styleBlend}</span>
                  <select
                    className="ly-select"
                    value={s.blend}
                    onChange={(e) =>
                      onChange(
                        updateLayerStyle(doc, s.id, { blend: e.target.value as BlendId }),
                        zh.layers.styleBlend,
                      )
                    }
                  >
                    {BLEND_MODES.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- 曲线编辑器 ---------------- */

const CURVE_BOX = 200;
const CURVE_PAD = 12;

/** 数据坐标（0–1）→ 画布坐标。 */
function curvePx(p: CurvePoint) {
  return {
    x: CURVE_PAD + p.x * (CURVE_BOX - CURVE_PAD * 2),
    y: CURVE_PAD + (1 - p.y) * (CURVE_BOX - CURVE_PAD * 2),
  };
}

/**
 * 曲线编辑器。
 *
 * 控制点存在调整状态里（st.curve），这里只负责编辑与预览 —— 画的曲线用
 * 和滤镜同一套单调三次插值，所见即所得。
 */
function CurveEditor({
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
  // 当前编辑的是哪条曲线：切通道等于换一组点，写回也写到对应那一组
  const pts = useMemo(() => curveOf(st, channel), [st, channel]);
  const ref = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<number | null>(null);
  // 刚刚由「空白处单击」新增的点，双击时不能立刻删掉它
  const freshRef = useRef<number | null>(null);

  /** 把编辑后的点集写回对应通道（预览不进历史，松手才落一条）。 */
  const push = (next: CurvePoint[], label?: string) => {
    const doc2 = setAdjust(doc, layer.id, setCurveOf(st, channel, next));
    if (label) onChange(doc2, label);
    else onPreview(doc2);
  };

  const CHANNEL_TABS: { id: CurveChannel; label: string; hue: string }[] = [
    { id: "rgb", label: "RGB", hue: "var(--text-2)" },
    { id: "r", label: "红", hue: "#e05252" },
    { id: "g", label: "绿", hue: "#4caf50" },
    { id: "b", label: "蓝", hue: "#5b8def" },
  ];

  const activeHue = CHANNEL_TABS.find((c) => c.id === channel)?.hue ?? "var(--accent)";

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = CURVE_BOX * dpr;
    cv.height = CURVE_BOX * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cs = getComputedStyle(cv);
    const ink = (name: string, fallback: string) =>
      cs.getPropertyValue(name).trim() || fallback;
    const border = ink("--border", "#2b2b2f");
    const surface = ink("--surface", "#1a1a1f");
    // 曲线与控制点用「当前通道」的色：RGB 复合走强调色，单通道各自带本色
    const accent = ink("--ly-curve-hue", ink("--accent", "#6fc0ff"));

    ctx.clearRect(0, 0, CURVE_BOX, CURVE_BOX);
    ctx.fillStyle = surface;
    ctx.fillRect(0, 0, CURVE_BOX, CURVE_BOX);

    // 四等分网格 + 对角参考线
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i += 1) {
      const t = CURVE_PAD + (i / 4) * (CURVE_BOX - CURVE_PAD * 2);
      ctx.beginPath();
      ctx.moveTo(t, CURVE_PAD);
      ctx.lineTo(t, CURVE_BOX - CURVE_PAD);
      ctx.moveTo(CURVE_PAD, t);
      ctx.lineTo(CURVE_BOX - CURVE_PAD, t);
      ctx.stroke();
    }
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(CURVE_PAD, CURVE_BOX - CURVE_PAD);
    ctx.lineTo(CURVE_BOX - CURVE_PAD, CURVE_PAD);
    ctx.stroke();
    ctx.setLineDash([]);

    // 曲线本体
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    const steps = 72;
    for (let i = 0; i <= steps; i += 1) {
      const x = i / steps;
      const q = curvePx({ x, y: monotoneAt(pts, x) });
      if (i === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();

    // 控制点
    for (const p of pts) {
      const q = curvePx(p);
      ctx.beginPath();
      ctx.arc(q.x, q.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = surface;
      ctx.stroke();
    }
  }, [pts]);

  /** 指针位置 → 数据坐标（两端夹到 0–1）。 */
  const toData = (e: { clientX: number; clientY: number }) => {
    const cv = ref.current;
    if (!cv) return { x: 0, y: 0 };
    const r = cv.getBoundingClientRect();
    const span = CURVE_BOX - CURVE_PAD * 2;
    const raw = (v: number) => ((v / (r.width || 1)) * CURVE_BOX - CURVE_PAD) / span;
    return {
      x: Math.max(0, Math.min(1, raw(e.clientX - r.left))),
      y: Math.max(0, Math.min(1, 1 - raw(e.clientY - r.top))),
    };
  };

  /** 找出离指针最近的控制点（超过阈值算没点到）。 */
  const hit = (d: CurvePoint) => {
    const target = curvePx(d);
    let best = -1;
    let bestD = 13;
    pts.forEach((p, i) => {
      const q = curvePx(p);
      const dist = Math.hypot(q.x - target.x, q.y - target.y);
      if (dist < bestD) {
        bestD = dist;
        best = i;
      }
    });
    return best;
  };

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = toData(e);
    const found = hit(d);
    let next: CurvePoint[];
    let idx: number;
    if (found >= 0) {
      next = pts.map((p) => ({ ...p }));
      idx = found;
      freshRef.current = null;
    } else {
      const fresh: CurvePoint = { ...d };
      next = [...pts.map((p) => ({ ...p })), fresh].sort((a, b) => a.x - b.x);
      idx = next.indexOf(fresh);
      freshRef.current = idx;
    }
    dragRef.current = idx;
    capturePointer(e.currentTarget, e.pointerId);
    push(next);
  };

  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const idx = dragRef.current;
    if (idx === null) return;
    const d = toData(e);
    const next = pts.map((p) => ({ ...p }));
    const p = next[idx];
    if (!p) return;
    p.y = d.y;
    // 两个端点只能上下动；中间点的 x 不许越过左右邻居
    if (idx > 0 && idx < next.length - 1) {
      p.x = Math.max(next[idx - 1].x + 0.01, Math.min(next[idx + 1].x - 0.01, d.x));
    }
    push(next);
  };

  const onUp = () => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    const touched = freshRef.current;
    freshRef.current = null;
    if (touched === null) onChange(setAdjust(doc, layer.id, st), zh.layers.adjustParams);
  };

  const onDbl = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const idx = hit(toData(e));
    // 刚加的点不删，端点也不删
    if (idx <= 0 || idx >= pts.length - 1 || idx === freshRef.current) return;
    const next = pts.filter((_, i) => i !== idx).map((p) => ({ ...p }));
    push(next, zh.layers.adjustParams);
  };

  return (
    <div className="ly-curve">
      <div className="ly-curve-tabs" role="tablist" aria-label="曲线通道">
        {CHANNEL_TABS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={channel === c.id}
            className={channel === c.id ? "ly-curve-tab is-on" : "ly-curve-tab"}
            style={{ "--ly-tab-hue": c.hue } as React.CSSProperties}
            onClick={() => setChannel(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <canvas
        ref={ref}
        className="ly-curve-canvas"
        style={{ "--ly-curve-hue": activeHue } as React.CSSProperties}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={onDbl}
      />
      <span className="ly-hint">{zh.layers.curveHint}</span>
    </div>
  );
}

/* ---------------- 渐变映射编辑器 ---------------- */

/** 在色标之间取插值色（用来给新加的色标一个合理的初始色）。 */
function sampleColor(stops: readonly GradientStop[], at: number): string {
  if (stops.length === 0) return "#000000";
  const s = [...stops].sort((a, b) => a.at - b.at);
  if (at <= s[0].at) return s[0].color;
  if (at >= s[s.length - 1].at) return s[s.length - 1].color;
  for (let i = 0; i < s.length - 1; i += 1) {
    const a = s[i];
    const b = s[i + 1];
    if (at >= a.at && at <= b.at) {
      const t = b.at === a.at ? 0 : (at - a.at) / (b.at - a.at);
      const ca = hexToRgb01(a.color);
      const cb = hexToRgb01(b.color);
      return rgb01ToHex(ca.map((v, k) => v + ((cb[k] ?? v) - v) * t));
    }
  }
  return s[0].color;
}

/** 渐变映射的色标条：拖动标改位置，双击删，空白处单击加。 */
function GradientEditor({
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
  const raw = st.stops ?? DEFAULT_STOPS;
  // 拖动过程中用本地数组顶住，避免每次预览都重排导致指针跟丢
  const [live, setLive] = useState<GradientStop[] | null>(null);
  const stops = live ?? [...raw].sort((a, b) => a.at - b.at);
  const [sel, setSel] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<number | null>(null);
  const freshRef = useRef<number | null>(null);

  const preview = (next: GradientStop[]) => {
    setLive(next);
    onPreview(setAdjust(doc, layer.id, { ...st, stops: next }));
  };

  const commit = (next: GradientStop[], label: string = zh.layers.adjustParams) => {
    setLive(null);
    onChange(
      setAdjust(doc, layer.id, { ...st, stops: [...next].sort((a, b) => a.at - b.at) }),
      label,
    );
  };

  const atOf = (e: { clientX: number }) => {
    const el = barRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1)));
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const at = atOf(e);
    let found = -1;
    let bestD = 0.06;
    stops.forEach((s, i) => {
      const d = Math.abs(s.at - at);
      if (d < bestD) {
        bestD = d;
        found = i;
      }
    });
    let next: GradientStop[];
    let idx: number;
    if (found >= 0) {
      next = stops.map((s) => ({ ...s }));
      idx = found;
      freshRef.current = null;
    } else {
      const fresh: GradientStop = { at, color: sampleColor(stops, at) };
      next = [...stops.map((s) => ({ ...s })), fresh];
      idx = next.indexOf(fresh);
      freshRef.current = idx;
    }
    dragRef.current = idx;
    setSel(idx);
    capturePointer(e.currentTarget, e.pointerId);
    preview(next);
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const idx = dragRef.current;
    if (idx === null) return;
    const next = stops.map((s) => ({ ...s }));
    const s = next[idx];
    if (!s) return;
    s.at = atOf(e);
    preview(next);
  };

  const onUp = () => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    freshRef.current = null;
    commit(stops);
  };

  const onDbl = (e: ReactPointerEvent<HTMLDivElement>) => {
    const at = atOf(e);
    let found = -1;
    let bestD = 0.06;
    stops.forEach((s, i) => {
      const d = Math.abs(s.at - at);
      if (d < bestD) {
        bestD = d;
        found = i;
      }
    });
    // 至少留两个色标，刚加的那个也不删
    if (found < 0 || stops.length <= 2 || found === freshRef.current) return;
    const next = stops.filter((_, i) => i !== found).map((s) => ({ ...s }));
    setSel(Math.max(0, Math.min(found, next.length - 1)));
    commit(next);
  };

  const current = stops[Math.min(sel, stops.length - 1)];
  const ramp = stops.map((s) => `${s.color} ${(s.at * 100).toFixed(1)}%`).join(", ");

  return (
    <div className="ly-grad">
      <div
        className="ly-grad-bar"
        ref={barRef}
        style={{ backgroundImage: `linear-gradient(90deg, ${ramp})` }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={onDbl}
      >
        {stops.map((s, i) => (
          <span
            key={`${i}-${s.at}`}
            className={i === Math.min(sel, stops.length - 1) ? "ly-grad-stop is-on" : "ly-grad-stop"}
            style={{ left: `${s.at * 100}%`, background: s.color }}
          />
        ))}
      </div>

      <div className="ly-prop">
        <span className="ly-prop-label">{zh.layers.gradientStop}</span>
        <ColorChip
          className="ly-color"
          label={zh.layers.gradientStop}
          hex={current?.color ?? "#000000"}
          onChange={(hex) => {
            const i = Math.min(sel, stops.length - 1);
            preview(stops.map((s, k) => (k === i ? { ...s, color: hex } : { ...s })));
          }}
          onCommit={() => commit(stops)}
        />
        <span className="ly-opacity">{((current?.at ?? 0) * 100).toFixed(0)}%</span>
        <button
          type="button"
          className="ly-mini"
          title={zh.layers.gradientReverse}
          onClick={() => commit(stops.map((s) => ({ ...s, at: 1 - s.at })))}
        >
          ⇄
        </button>
        <button
          type="button"
          className="ly-mini"
          title={zh.layers.adjustReset}
          onClick={() => commit(DEFAULT_STOPS.map((s) => ({ ...s })), zh.layers.gradientReset)}
        >
          ↺
        </button>
      </div>

      <span className="ly-hint">{zh.layers.gradientHint}</span>
    </div>
  );
}


/* ---------------- 一行 ---------------- */

interface RowProps {
  doc: StrataDoc;
  layer: StrataLayer;
  on: boolean;
  /** 嵌套深度，用来算左边缩进 */
  depth: number;
  /** 仅组有意义：子树是否收起 */
  collapsed: boolean;
  onToggleCollapse: () => void;
  onChange: (next: StrataDoc, label: string) => void;
  onPreview: (next: StrataDoc) => void;
  /** 行右键 / 蒙版缩略图右键（菜单浮层统一在 EditorShell） */
  onContextMenu?: (e: ReactMouseEvent, layerId: string) => void;
  onMaskContextMenu?: (e: ReactMouseEvent, layerId: string) => void;
}

function LayerRow({
  doc,
  layer,
  on,
  depth,
  collapsed,
  onToggleCollapse,
  onChange,
  onPreview,
  onContextMenu,
  onMaskContextMenu,
}: RowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(layer.name);
  const isGroup = layer.kind === "group";

  const commitName = () => {
    setEditing(false);
    const name = draft.trim();
    if (!name || name === layer.name) {
      setDraft(layer.name);
      return;
    }
    onChange(updateLayer(doc, layer.id, { name }), zh.menu.renameLayer);
  };

  return (
    <div
      className={on ? "ly-row is-on" : "ly-row"}
      role="option"
      aria-selected={on}
      aria-level={depth + 1}
      onClick={() => onPreview(selectLayer(doc, layer.id))}
      onContextMenu={(e) => onContextMenu?.(e, layer.id)}
    >
      {/* 缩进靠一段可伸缩的空白，子层往右让一格，一眼看出归属 */}
      <span className="ly-indent" style={{ width: depth * 14 }} aria-hidden="true" />

      {isGroup ? (
        <button
          type="button"
          className="ly-caret"
          aria-expanded={!collapsed}
          title={collapsed ? zh.layers.groupExpand : zh.layers.groupCollapse}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapse();
          }}
        >
          <CaretIcon />
        </button>
      ) : (
        <span className="ly-caret is-empty" aria-hidden="true" />
      )}

      <button
        type="button"
        className={layer.visible ? "ly-eye" : "ly-eye is-off"}
        title={layer.visible ? zh.layers.visible : zh.layers.hidden}
        aria-pressed={layer.visible}
        onClick={(e) => {
          e.stopPropagation();
          onChange(
            updateLayer(doc, layer.id, { visible: !layer.visible }),
            zh.menu.toggleVisible,
          );
        }}
      >
        <EyeIcon open={layer.visible} />
      </button>

      <LayerThumb layer={layer} doc={doc} />

      {layer.mask && (
        <MaskThumb
          layer={layer}
          doc={doc}
          onContextMenu={onMaskContextMenu}
        />
      )}

      {editing ? (
        <input
          className="ly-name-input"
          value={draft}
          autoFocus
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitName();
            if (e.key === "Escape") {
              setDraft(layer.name);
              setEditing(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className="ly-name"
          title={zh.layers.renameHint}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setDraft(layer.name);
            setEditing(true);
          }}
        >
          {layer.name}
        </span>
      )}

      {layer.clip && (
        <span className="ly-flag is-accent" title={zh.layers.clipHint}>
          ⊂
        </span>
      )}

      {layer.styles?.some((s) => s.enabled) && (
        <span className="ly-flag is-accent" title={zh.layers.style}>
          fx
        </span>
      )}

      {layer.locked && <span className="ly-flag">{zh.layers.locked}</span>}

      <button
        type="button"
        className={layer.locked ? "ly-lock is-on" : "ly-lock"}
        title={layer.locked ? zh.layers.unlock : zh.layers.lock}
        aria-pressed={layer.locked}
        onClick={(e) => {
          e.stopPropagation();
          onChange(
            updateLayer(doc, layer.id, { locked: !layer.locked }),
            layer.locked ? zh.layers.unlock : zh.layers.lock,
          );
        }}
      >
        <LockIcon closed={layer.locked} />
      </button>
    </div>
  );
}

/**
 * 图层缩略图。
 *
 * 直接画在 canvas 上而不是生成 dataURL：绘制过程中图层像素是原地改的，
 * 每次文档对象更新都重画一遍最省事，也不会攒下一堆 base64 字符串。
 *
 * 调整层与图层组都没有自己的像素（surface 只是 1×1 占位），画出来只会是
 * 一坨拉伸的噪点，所以各给一枚徽标。
 */
function LayerThumb({ layer, doc }: { layer: StrataLayer; doc: StrataDoc }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const kind = layer.kind;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (kind !== "pixel") return;
    const k = Math.min(c.width / doc.width, c.height / doc.height);
    const w = doc.width * k;
    const h = doc.height * k;
    ctx.drawImage(layer.surface, (c.width - w) / 2, (c.height - h) / 2, w, h);
  }, [layer, doc, kind]);

  if (kind === "adjust") {
    return (
      <span className="ly-thumb ly-thumb-fx" title={zh.layers.adjust}>
        fx
      </span>
    );
  }
  if (kind === "group") {
    return (
      <span className="ly-thumb ly-thumb-group" title={zh.layers.groupHint}>
        <FolderIcon />
      </span>
    );
  }
  return <canvas ref={ref} width={36} height={36} className="ly-thumb" />;
}

/** 蒙版缩略图：alpha 直接当灰度画在白底上，所见即所得。 */
function MaskThumb({
  layer,
  doc,
  onContextMenu,
}: {
  layer: StrataLayer;
  doc: StrataDoc;
  onContextMenu?: (e: ReactMouseEvent, layerId: string) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    const m = layer.mask;
    if (!c || !m) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, c.width, c.height);
    const k = Math.min(c.width / doc.width, c.height / doc.height);
    const w = doc.width * k;
    const h = doc.height * k;
    const x = (c.width - w) / 2;
    const y = (c.height - h) / 2;
    // 先画黑底，再把蒙版按 alpha 叠上去，透明处自然呈现为黑。
    ctx.fillStyle = "#000000";
    ctx.fillRect(x, y, w, h);
    ctx.drawImage(m, x, y, w, h);
  }, [layer, doc]);

  return (
    <canvas
      ref={ref}
      width={36}
      height={36}
      className={layer.maskActive ? "ly-mask-thumb is-on" : "ly-mask-thumb is-off"}
      title={layer.maskActive ? zh.layers.maskOff : zh.layers.maskOn}
      onContextMenu={(e) => onContextMenu?.(e, layer.id)}
    />
  );
}

/* ---------------- 图标 ---------------- */

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" />
        <circle cx="12" cy="12" r="2.8" />
        {!open && <path d="M4 20 20 4" />}
      </g>
    </svg>
  );
}

function LockIcon({ closed }: { closed: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="4.5" y="10.5" width="15" height="9.5" rx="1.8" />
        {closed ? (
          <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
        ) : (
          <path d="M8 10.5V7.8a4 4 0 0 1 7.7-1.5" />
        )}
      </g>
    </svg>
  );
}

/** 组的折叠三角；展开时由 CSS 转 90°。 */
function CaretIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M4 2.5 8 6l-4 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 文件夹轮廓：图层组的通用符号。 */
function FoldIcon() {
  return (
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h3.7l1.6 2h9.7A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5Z" />
  );
}

/** 组缩略图上的徽标。 */
function FolderIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <FoldIcon />
      </g>
    </svg>
  );
}

/** 编组：文件夹里多一个加号。 */
function GroupIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <FoldIcon />
        <path d="M12 10.8v5.4M9.3 13.5h5.4" />
      </g>
    </svg>
  );
}

/** 取消编组：文件夹里多一个减号。 */
function UngroupIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <FoldIcon />
        <path d="M9.3 13.5h5.4" />
      </g>
    </svg>
  );
}
