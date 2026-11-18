/**
 * Camera Raw 专用工作窗口 —— P1-2：左侧实时预览 + 右侧七个页签 + 预设存读。
 *
 * 为什么单独做，而不是继续用 460px 的 AdjustDialog：
 * PhotoCraft 的 Camera Raw 是 7 页签 + 直方图的大工作窗（清单 G7），18 个参数
 * 平铺在窄弹窗里又长又难找。现在按语义拆成 Light / Color / Effects / Curve /
 * Color Mixer / Color Grading / Detail 七页，左边一张从工作文档实时合成的预览 +
 * 直方图 —— 拖参数时看预览就知道效果，不用在主画布和长列表之间来回找。
 *
 * 预览范式与 AdjustDialog 完全一致（两条铁律不变）：
 *   ① 绝不改 activeLayerId —— 用 withTempLayer 插临时层，但保留 base 的活动层；
 *   ② 预览与结果同源 —— 工作文档就是最终落库的那份，取消则把 base 推回去。
 * 预览只走 ref / 局部 state，拖参数不进历史，确定才 onApply 落一条。
 *
 * 底层 18 参数全部已在 adjustPixels.ts::cameraraw 真实现（曲线 LUT / 8 色带
 * HSL mixer / 暗角等），这里纯粹是 UI 形态升级，不重造算法。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createAdjustLayer,
  newAdjustState,
  type StrataLayer,
} from "../../core/layer";
import { setAdjust } from "../../core/layerOps";
import type { StrataDoc } from "../../core/document";
import { composeDoc } from "../../engine/compositor";
import { createSurface } from "../../engine/surface";
import {
  BUILTIN_PRESETS,
  deleteUserPreset,
  loadUserPresets,
  presetToAdjust,
  saveUserPreset,
  type RawPreset,
} from "../../core/cameraRawPresets";
import { zh } from "../../i18n";
import DraggableModal from "./DraggableModal";
import RangeInput from "./RangeInput";
import MiniHistogram from "./MiniHistogram";
import HistogramPanel from "./HistogramPanel";
import "./CameraRawDialog.css";

interface Props {
  doc: StrataDoc;
  /** 拖动参数时的即时预览（不进历史） */
  onPreview: (next: StrataDoc) => void;
  onApply: (next: StrataDoc) => void;
  onClose: () => void;
}

/** 七页签定义：id → 页签名 + 该页包含的参数 id（对应 cameraraw 的 18 参数，无遗漏无重复）。 */
type TabId = "light" | "color" | "effects" | "curve" | "mixer" | "grading" | "detail";
const TABS: { id: TabId; label: string; params: string[] }[] = [
  { id: "light", label: "Light · 光", params: [
    "exposure", "contrast", "highlights", "shadows", "whites", "blacks",
  ] },
  { id: "color", label: "Color · 色", params: [
    "temperature", "tint", "vibrance", "saturation",
  ] },
  { id: "effects", label: "Effects · 效果", params: [
    "vignette", "vignetteMidpoint", "vignetteHighlights",
  ] },
  { id: "curve", label: "Curve · 曲线", params: ["curve"] },
  { id: "mixer", label: "Color Mixer · 混色", params: ["mixerPreset"] },
  { id: "grading", label: "Color Grading · 分级", params: [] },
  { id: "detail", label: "Detail · 细节", params: ["texture", "clarity", "dehaze"] },
];

/** 参数 display 元信息：label / 范围 / 步长 / 小数位 / 单位，取自 cameraraw 的定义。 */
import { adjustDef } from "../../core/layer";
const CAMERA_DEF = adjustDef("cameraraw");
const PARAM_INFO = new Map(CAMERA_DEF.params.map((p) => [p.id, p]));

/**
 * 在活动层上方插临时调整层 —— 与 layerOps.spliceAbove 位置规则一致，
 * 但保留 base.activeLayerId（同 AdjustDialog.withTempLayer，不重复解释）。
 */
function withTempLayer(base: StrataDoc): { doc: StrataDoc; layerId: string } {
  const layer = createAdjustLayer("Camera Raw", newAdjustState("cameraraw"));
  const at = base.layers.findIndex((l) => l.id === base.activeLayerId);
  const cur = at >= 0 ? base.layers[at] : null;
  const parent = cur ? (cur.kind === "group" ? cur.id : (cur.parent ?? null)) : null;
  const placed: StrataLayer = { ...layer, parent };
  const where = cur?.kind === "group" ? at : at < 0 ? base.layers.length : at + 1;
  const layers = [...base.layers];
  layers.splice(where, 0, placed);
  return { doc: { ...base, layers, dirty: true }, layerId: placed.id };
}

export default function CameraRawDialog({ doc, onPreview, onApply, onClose }: Props) {
  const base = useRef(doc).current;
  const temp = useMemo(() => withTempLayer(base), [base]);
  const [work, setWork] = useState<StrataDoc>(temp.doc);
  const layer = work.layers.find((l) => l.id === temp.layerId) ?? null;
  const st = layer?.adjust ?? null;
  const [tab, setTab] = useState<TabId>("light");

  // 预设状态
  const [userPresets, setUserPresets] = useState<RawPreset[]>(() => loadUserPresets());
  const [presetName, setPresetName] = useState("");
  const [presetMsg, setPresetMsg] = useState("");

  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  const closedRef = useRef(false);

  useEffect(() => {
    previewRef.current(work);
  }, [work]);

  /** 工作文档一变就合成一张预览画布（供左侧缩略图 + 直方图用）。 */
  const [previewCanvas, setPreviewCanvas] = useState<HTMLCanvasElement | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const previewElRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    // 左侧预览是「参考视图」，主画布预览仍每帧跟手；这里 24ms 防抖，
    // 避免大图拖参数时全文档合成两次造成掉帧。
    const t = window.setTimeout(() => {
      const cv = createSurface(1, 1);
      composeDoc(work, cv);
      setPreviewCanvas(cv);
      setPreviewVersion((v) => v + 1);
    }, 24);
    return () => window.clearTimeout(t);
  }, [work]);

  /** 预览画布或窗口尺寸变化时，把工作文档缩略图画进左栏 canvas。 */
  useEffect(() => {
    const el = previewElRef.current;
    if (!el || !previewCanvas) return;
    const repaint = () => {
      const ctx = el.getContext("2d");
      if (!ctx) return;
      const box = el.parentElement?.getBoundingClientRect();
      const boxW = Math.max(1, Math.floor(box?.width ?? 400));
      const boxH = Math.max(1, Math.floor(box?.height ?? 400));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const pw = Math.round(boxW * dpr);
      const ph = Math.round(boxH * dpr);
      if (el.width !== pw) el.width = pw;
      if (el.height !== ph) el.height = ph;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, el.width, el.height);
      const k = Math.min(el.width / previewCanvas.width, el.height / previewCanvas.height);
      const w = previewCanvas.width * k;
      const h = previewCanvas.height * k;
      ctx.drawImage(previewCanvas, (el.width - w) / 2, (el.height - h) / 2, w, h);
    };
    repaint();
    // 窗口可缩：监听容器尺寸变化重画，避免缩窗后预览被拉糊
    const ro = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(repaint)
      : null;
    if (ro && el.parentElement) ro.observe(el.parentElement);
    return () => ro?.disconnect();
  }, [previewCanvas, previewVersion]);

  const setParam = useCallback((id: string, value: number) => {
    if (!st || !layer) return;
    setWork(setAdjust(work, layer.id, { ...st, params: { ...st.params, [id]: value } }));
  }, [work, layer, st]);

  const applyPreset = useCallback((preset: RawPreset) => {
    if (!layer) return;
    setWork(setAdjust(work, layer.id, presetToAdjust(preset.params)));
    setPresetMsg(`已套用「${preset.name}」`);
  }, [work, layer]);

  const doSave = useCallback(() => {
    const name = presetName.trim();
    if (!name || !st) {
      setPresetMsg("先输入预设名称");
      return;
    }
    const ok = saveUserPreset({ name, params: st.params }, userPresets);
    setUserPresets(loadUserPresets());
    setPresetMsg(ok ? `已保存「${name}」` : "保存失败：浏览器存储不可用");
    if (ok) setPresetName("");
  }, [presetName, st, userPresets]);

  const doDelete = useCallback((name: string) => {
    deleteUserPreset(name, userPresets);
    setUserPresets(loadUserPresets());
    setPresetMsg(`已删除「${name}」`);
  }, [userPresets]);

  const neutral = st
    ? JSON.stringify(st) === JSON.stringify(newAdjustState("cameraraw"))
    : true;

  const cancel = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    previewRef.current(base);
    onClose();
  }, [base, onClose]);

  const apply = useCallback(() => {
    if (closedRef.current || neutral) return;
    closedRef.current = true;
    onApply(work);
  }, [work, neutral, onApply]);

  const curTab = TABS.find((t) => t.id === tab) ?? TABS[0];
  const allPresets = [...BUILTIN_PRESETS, ...userPresets];

  return (
    <DraggableModal
      id="cameraRaw"
      title="Camera Raw"
      badge="RAW"
      onClose={cancel}
      width={900}
      height={620}
      minWidth={720}
      minHeight={520}
      footer={
        <>
          <span className="cr-note">
            {neutral ? "拖动右侧参数或套用预设，左侧预览实时更新" : "确定后生成可随时回改的调整图层"}
          </span>
          <span className="cr-spacer" />
          <button className="btn-ghost" onClick={cancel}>{zh.dialog.cancel}</button>
          <button className="btn-primary" onClick={apply} disabled={neutral}>{zh.dialog.confirm}</button>
        </>
      }
    >
      <div className="cr">
        {/* 左：实时预览 + 直方图 + 预设条 */}
        <div className="cr-left">
          <div className="cr-preview">
            {previewCanvas && (
              <canvas ref={previewElRef} />
            )}
          </div>
          <MiniHistogram source={previewCanvas} version={previewVersion} height={64} />
          <div className="cr-presets">
            <div className="cr-presets-head">预设</div>
            <div className="cr-presets-list">
              {allPresets.map((p) => (
                <span className={`cr-preset${p.builtin ? " is-builtin" : ""}`} key={`${p.builtin ? "b" : "u"}-${p.name}`}>
                  <button className="cr-preset-name" onClick={() => applyPreset(p)} title="套用预设">{p.name}</button>
                  {!p.builtin && (
                    <button className="cr-preset-del" onClick={() => doDelete(p.name)} title="删除预设">×</button>
                  )}
                </span>
              ))}
            </div>
            <div className="cr-presets-save">
              <input
                className="cr-preset-input"
                value={presetName}
                placeholder="存为…"
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") doSave(); }}
              />
              <button className="btn-ghost" onClick={doSave}>保存</button>
            </div>
            {presetMsg && <div className="cr-preset-msg">{presetMsg}</div>}
          </div>
        </div>

        {/* 右：七页签 + 参数滑杆 */}
        <div className="cr-right">
          <div className="cr-tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={t.id === tab}
                className={`cr-tab${t.id === tab ? " is-active" : ""}`}
                onClick={() => setTab(t.id)}
                title={t.label}
              >
                {t.label.split(" · ")[0]}
              </button>
            ))}
          </div>
          <div className="cr-params">
            {st && curTab.params.map((id) => {
              const info = PARAM_INFO.get(id);
              if (!info) return null;
              const v = st.params[id] ?? info.def;
              return (
                <div className="cr-param" key={id}>
                  <div className="cr-param-head">
                    <span className="cr-param-label">{info.label}</span>
                    <span className="cr-param-value">
                      {Number.isInteger(info.step) ? Math.round(v) : v.toFixed(info.dec ?? 2)}{info.unit ?? ""}
                    </span>
                  </div>
                  <RangeInput
                    value={v}
                    min={info.min}
                    max={info.max}
                    step={info.step}
                    onChange={(nv) => setParam(id, nv)}
                  />
                </div>
              );
            })}
            {tab === "curve" && (
              <p className="cr-tab-hint">色调曲线预设：0 = 原图，1–4 = 由柔和到强对比的单调三次曲线，逐通道应用。</p>
            )}
            {tab === "mixer" && (
              <p className="cr-tab-hint">8 色带混色预设：0 = 原图，1–4 = 不同色相/饱和度/明度组合，可与人像/风光风格叠加。</p>
            )}
            {tab === "grading" && previewCanvas && (
              <div className="cr-grading">
                <p className="cr-tab-hint">分级参考：切换 R/G/B 通道看色偏，配合 Color 页的色温 / 色调校正。</p>
                <HistogramPanel source={previewCanvas} version={previewVersion} />
              </div>
            )}
          </div>
        </div>
      </div>
    </DraggableModal>
  );
}
