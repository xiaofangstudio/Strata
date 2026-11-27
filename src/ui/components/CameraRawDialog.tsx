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
import { createSurface, surfaceFromBitmap } from "../../engine/surface";
import { developRawBitmap } from "../../engine/image";
import { defaultRawUiParams, uiToRawDevelop, type RawDevelopState } from "../../core/rawDevelopParams";
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
const TABS: { id: TabId; params: string[] }[] = [
  { id: "light", params: [
    "exposure", "contrast", "highlights", "shadows", "whites", "blacks",
  ] },
  { id: "color", params: [
    "temperature", "tint", "vibrance", "saturation",
  ] },
  { id: "effects", params: [
    "vignette", "vignetteMidpoint", "vignetteHighlights",
  ] },
  { id: "curve", params: ["curve"] },
  { id: "mixer", params: ["mixerPreset"] },
  { id: "grading", params: [] },
  { id: "detail", params: ["texture", "clarity", "dehaze"] },
];

/** 页签名走 i18n（六语言），渲染时读取当前字典。 */
const TAB_LABEL: Record<TabId, keyof typeof zh.dialog> = {
  light: "crTabLight",
  color: "crTabColor",
  effects: "crTabEffects",
  curve: "crTabCurve",
  mixer: "crTabMixer",
  grading: "crTabGrading",
  detail: "crTabDetail",
};

/** 参数 display 元信息：label / 范围 / 步长 / 小数位 / 单位，取自 cameraraw 的定义。 */
import { adjustDef } from "../../core/layer";
const CAMERA_DEF = adjustDef("cameraraw");
const PARAM_INFO = new Map(CAMERA_DEF.params.map((p) => [p.id, p]));

/**
 * 在活动层上方插临时调整层 —— 与 layerOps.spliceAbove 位置规则一致，
 * 但保留 base.activeLayerId（同 AdjustDialog.withTempLayer，不重复解释）。
 */
function withTempLayer(
  base: StrataDoc,
  params?: Record<string, number>,
): { doc: StrataDoc; layerId: string } {
  const state = newAdjustState("cameraraw");
  if (params) state.params = { ...state.params, ...params };
  const layer = createAdjustLayer("Camera Raw", state);
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
  const rawState = useRef<RawDevelopState | null>(base.rawDevelop ?? null).current;
  const temp = useMemo(
    () => withTempLayer(base, rawState?.ui ?? defaultRawUiParams()),
    [base, rawState],
  );
  const [work, setWork] = useState<StrataDoc>(temp.doc);
  const layer = work.layers.find((l) => l.id === temp.layerId) ?? null;
  const st = layer?.adjust ?? null;
  const paramsKey = st ? JSON.stringify(st.params) : "";
  const [tab, setTab] = useState<TabId>("light");
  const [rawError, setRawError] = useState("");
  const [developing, setDeveloping] = useState(false);

  // 预设状态
  const [userPresets, setUserPresets] = useState<RawPreset[]>(() => loadUserPresets());
  const [presetName, setPresetName] = useState("");
  const [presetMsg, setPresetMsg] = useState("");

  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  const closedRef = useRef(false);

  /** RAW 图走「参数回炉 Rust 线性显影」，不做 cameraraw 8bit 调整层。 */
  const rawTargetId = useRef(
    base.layers.find((l) => l.id === base.activeLayerId && l.kind === "pixel")?.id ??
      base.layers.find((l) => l.kind === "pixel")?.id ??
      base.activeLayerId,
  ).current;

  const buildRawDoc = useCallback(async (params: Record<string, number>): Promise<StrataDoc> => {
    if (!rawState) throw new Error("这份文档没有 RAW 源，无法线性显影");
    const linear = uiToRawDevelop(params, rawState.meta);
    const bitmap = await developRawBitmap(rawState.path, linear, 8);
    const surface = surfaceFromBitmap(bitmap);
    bitmap.close();
    return {
      ...base,
      layers: base.layers.map((l) => (l.id === rawTargetId ? { ...l, surface } : l)),
      rawDevelop: { ...rawState, params: linear, ui: { ...params } },
      dirty: true,
    };
  }, [base, rawState, rawTargetId]);

  // 主画布预览推送：work 状态本身即时更新（滑块本地值跟手）。
  // 全文档合成 + 18 参数像素管线在大图上每帧跑会堵主线程 —— 用尾随节流
  // （每 60ms 强制推一帧最新值），拖动中画面持续刷新，停手后最后一帧保证推。
  const pushTimer = useRef<number | null>(null);
  const lastPush = useRef(0);
  const pushPending = useRef<(() => void) | null>(null);
  useEffect(() => {
    // RAW 的主画布预览走下面的线性显影链，不能把临时 cameraraw 层推出去。
    if (rawState) return;
    pushPending.current = () => {
      if (closedRef.current) return;
      previewRef.current(work);
    };
    const elapsed = Date.now() - lastPush.current;
    if (elapsed >= 60) {
      lastPush.current = Date.now();
      pushPending.current();
      return;
    }
    if (pushTimer.current !== null) return; // 已有排定帧，它算的是最新 pending
    pushTimer.current = window.setTimeout(() => {
      pushTimer.current = null;
      lastPush.current = Date.now();
      pushPending.current?.();
    }, 60 - elapsed);
  }, [work, rawState]);
  useEffect(() => () => {
    if (pushTimer.current !== null) window.clearTimeout(pushTimer.current);
  }, []);

  /** 工作文档一变就合成一张预览画布（供左侧缩略图 + 直方图用）。 */
  const [previewCanvas, setPreviewCanvas] = useState<HTMLCanvasElement | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const previewElRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (rawState) return; // RAW 预览由线性显影 effect 负责
    // 左侧预览是「参考视图」，主画布预览仍每帧跟手；这里 24ms 防抖，
    // 避免大图拖参数时全文档合成两次造成掉帧。
    const t = window.setTimeout(() => {
      const cv = createSurface(1, 1);
      composeDoc(work, cv);
      setPreviewCanvas(cv);
      setPreviewVersion((v) => v + 1);
    }, 24);
    return () => window.clearTimeout(t);
  }, [work, rawState]);

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

  /**
   * RAW 预览：尾随节流 60ms，参数直接回炉 Rust 线性显影。
   * 每次请求带序号，旧结果回来时直接丢弃，避免拖动滑杆时画面倒退。
   */
  const rawReqRef = useRef(0);
  useEffect(() => {
    if (!rawState || !st) return;
    const seq = ++rawReqRef.current;
    const params = { ...st.params };
    const t = window.setTimeout(() => {
      void buildRawDoc(params)
        .then((next) => {
          if (closedRef.current || seq !== rawReqRef.current) return;
          const surface = next.layers.find((l) => l.id === rawTargetId)?.surface;
          if (surface) setPreviewCanvas(surface);
          setPreviewVersion((v) => v + 1);
          setRawError("");
          previewRef.current(next);
        })
        .catch((e) => {
          if (closedRef.current || seq !== rawReqRef.current) return;
          setRawError(e instanceof Error ? e.message : String(e));
        });
    }, 60);
    return () => window.clearTimeout(t);
    // paramsKey 是滑杆的稳定签名；st 对象每次 setWork 都会变，不能用引用做依赖。
  }, [paramsKey, rawState, st, buildRawDoc, rawTargetId]);

  const setParam = useCallback((id: string, value: number) => {
    if (!st || !layer) return;
    setWork(setAdjust(work, layer.id, { ...st, params: { ...st.params, [id]: value } }));
  }, [work, layer, st]);

  /** 内置预设显示名走 i18n；用户预设直接显示保存时的名字。 */
  const presetLabel = useCallback(
    (p: RawPreset): string =>
      p.nameKey ? ((zh.dialog as Record<string, string>)[p.nameKey] ?? p.name) : p.name,
    [],
  );

  const applyPreset = useCallback((preset: RawPreset) => {
    if (!layer) return;
    setWork(setAdjust(work, layer.id, presetToAdjust(preset.params)));
    setPresetMsg(zh.dialog.crApplied.replace("{name}", presetLabel(preset)));
  }, [work, layer, presetLabel]);

  const doSave = useCallback(() => {
    const name = presetName.trim();
    if (!name || !st) {
      setPresetMsg(zh.dialog.crNeedName);
      return;
    }
    const ok = saveUserPreset({ name, params: st.params }, userPresets);
    setUserPresets(loadUserPresets());
    setPresetMsg(ok ? zh.dialog.crSaved.replace("{name}", name) : zh.dialog.crSaveFailed);
    if (ok) setPresetName("");
  }, [presetName, st, userPresets]);

  const doDelete = useCallback((name: string) => {
    deleteUserPreset(name, userPresets);
    setUserPresets(loadUserPresets());
    setPresetMsg(zh.dialog.crDeleted.replace("{name}", name));
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

  const apply = useCallback(async () => {
    if (closedRef.current || neutral || developing) return;
    if (rawState && st) {
      setDeveloping(true);
      try {
        const next = await buildRawDoc({ ...st.params });
        if (closedRef.current) return;
        closedRef.current = true;
        onApply(next);
      } catch (e) {
        setRawError(e instanceof Error ? e.message : String(e));
      } finally {
        setDeveloping(false);
      }
      return;
    }
    closedRef.current = true;
    onApply(work);
  }, [work, neutral, onApply, rawState, st, buildRawDoc, developing]);

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
            {rawError ? `${zh.dialog.crRawFailed}${rawError}` : neutral ? zh.dialog.crNeutralHint : zh.dialog.crTunedHint}
          </span>
          <span className="cr-spacer" />
          <button className="btn-ghost" onClick={cancel}>{zh.dialog.cancel}</button>
          <button className="btn-primary" onClick={() => void apply()} disabled={neutral || developing}>
            {developing ? zh.dialog.crDeveloping : zh.dialog.confirm}
          </button>
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
            <div className="cr-presets-head">{zh.dialog.crPresets}</div>
            <div className="cr-presets-list">
              {allPresets.map((p) => (
                <span className={`cr-preset${p.builtin ? " is-builtin" : ""}`} key={`${p.builtin ? "b" : "u"}-${p.name}`}>
                  <button className="cr-preset-name" onClick={() => applyPreset(p)} title={zh.dialog.crApplyTitle}>{presetLabel(p)}</button>
                  {!p.builtin && (
                    <button className="cr-preset-del" onClick={() => doDelete(p.name)} title={zh.dialog.crDelTitle}>×</button>
                  )}
                </span>
              ))}
            </div>
            <div className="cr-presets-save">
              <input
                className="cr-preset-input"
                value={presetName}
                placeholder={zh.dialog.crSaveAs}
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") doSave(); }}
              />
              <button className="btn-ghost" onClick={doSave}>{zh.dialog.crSave}</button>
            </div>
            {presetMsg && <div className="cr-preset-msg">{presetMsg}</div>}
          </div>
        </div>

        {/* 右：七页签 + 参数滑杆 */}
        <div className="cr-right">
          <div className="cr-tabs" role="tablist">
            {TABS.map((t) => {
              const label = zh.dialog[TAB_LABEL[t.id]];
              return (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={t.id === tab}
                  className={`cr-tab${t.id === tab ? " is-active" : ""}`}
                  onClick={() => setTab(t.id)}
                  title={label}
                >
                  {label}
                </button>
              );
            })}
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
              <p className="cr-tab-hint">{zh.dialog.crCurveHint}</p>
            )}
            {tab === "mixer" && (
              <p className="cr-tab-hint">{zh.dialog.crMixerHint}</p>
            )}
            {tab === "grading" && previewCanvas && (
              <div className="cr-grading">
                <p className="cr-tab-hint">{zh.dialog.crGradingHint}</p>
                <HistogramPanel source={previewCanvas} version={previewVersion} />
              </div>
            )}
          </div>
        </div>
      </div>
    </DraggableModal>
  );
}
