/**
 * 图像菜单里需要参数的那些操作，共用一套对话框。
 *
 * 为什么不给每个操作各写一个组件：这些都是「改几个数字 → 点确定」的小面板，
 * 拆成十几个文件只会让导航变难。这里的约定是 —— 顶部按 kind 决定标题，
 * 主体只渲染与该操作相关的字段，确定时统一走 onApply(新文档, 历史标题)。
 */
import { useMemo, useState } from "react";
import type { StrataDoc } from "../../core/document";
import type { BlendId } from "../../core/layer";
import {
  applyDataSet as applyDataSetOp,
  applyImage,
  measureDocument,
  placeScaleMarker,
  remapPalette,
  setColorMode,
  trapInk,
  type ColorModeId,
  type ColorModeOptions,
} from "../../core/imageOps";
import { zh } from "../../i18n/zh-CN";
import Modal from "./Modal";

export type ImageOpsKind =
  | "bitmap"
  | "duotone"
  | "indexed"
  | "cmyk"
  | "lab"
  | "colorTable"
  | "applyImage"
  | "trap"
  | "placeScaleMarker"
  | "measureScale"
  | "dataPoints"
  | "variables"
  | "dataSets"
  | "applyDataSet"
  | "recordMeasurements";

interface Props {
  kind: ImageOpsKind;
  doc: StrataDoc;
  onApply: (next: StrataDoc, label: string) => void;
  onToast: (msg: string) => void;
  onClose: () => void;
}

const TITLES: Record<ImageOpsKind, string> = {
  bitmap: "位图",
  duotone: "双色调",
  indexed: "索引颜色",
  cmyk: "CMYK 颜色",
  lab: "Lab 颜色",
  colorTable: "颜色表",
  applyImage: "应用图像",
  trap: "陷印",
  placeScaleMarker: "放置比例标记",
  measureScale: "设置测量比例",
  dataPoints: "选择数据点",
  variables: "变量",
  dataSets: "数据组",
  applyDataSet: "应用数据组",
  recordMeasurements: "测量记录",
};

const BLEND_LABELS: [BlendId, string][] = [
  ["normal", "正常"],
  ["multiply", "正片叠底"],
  ["screen", "滤色"],
  ["overlay", "叠加"],
  ["darken", "变暗"],
  ["lighten", "变亮"],
];

/** 测量结果表可选列（选择数据点）。 */
const MEASURE_FIELDS = ["面积", "宽度", "高度", "周长", "像素面积"];

function px(n: number): string {
  return `${Math.round(n)} px`;
}

export default function ImageOpsDialog({ kind, doc, onApply, onToast, onClose }: Props) {
  /* ---- 各操作自己的参数（初始值都从文档现状取） ---- */
  const [threshold, setThreshold] = useState("128");
  const [halftone, setHalftone] = useState("0");
  const [dark, setDark] = useState("#1b2a4a");
  const [light, setLight] = useState("#f2d9a0");
  const [strength, setStrength] = useState("100");
  const [colors, setColors] = useState(String(doc.palette?.length ?? 64));
  const [dither, setDither] = useState(true);
  const [inkLimit, setInkLimit] = useState("300");
  const [ucr, setUcr] = useState("40");
  const [chroma, setChroma] = useState("110");
  const [trapWidth, setTrapWidth] = useState("2");
  const [markerUnits, setMarkerUnits] = useState("1");
  const [markerColor, setMarkerColor] = useState("#ffffff");
  const [scalePx, setScalePx] = useState(String(doc.measureScale?.px ?? 100));
  const [scaleReal, setScaleReal] = useState(String(doc.measureScale?.real ?? 100));
  const [scaleUnit, setScaleUnit] = useState(doc.measureScale?.unit ?? "px");
  const [fields, setFields] = useState<string[]>(doc.measureFields ?? MEASURE_FIELDS);
  const [sourceId, setSourceId] = useState("");
  const [channel, setChannel] = useState<"rgb" | "r" | "g" | "b" | "gray">("rgb");
  const [blend, setBlend] = useState<BlendId>("normal");
  const [opacity, setOpacity] = useState("100");
  const [invert, setInvert] = useState(false);
  const [varLayer, setVarLayer] = useState(doc.layers[0]?.id ?? "");
  const [varName, setVarName] = useState("可见");
  const [setName, setSetName] = useState("数据组 1");
  const [activeSet, setActiveSet] = useState(doc.dataSets?.[0]?.name ?? "");
  const [swatch, setSwatch] = useState(0);

  const pixelLayers = useMemo(() => doc.layers.filter((l) => l.kind === "pixel"), [doc.layers]);
  const palette = doc.palette ?? [];
  const measureRows = useMemo(
    () => (kind === "recordMeasurements" ? measureDocument(doc) : []),
    [doc, kind],
  );

  const applyMode = (mode: ColorModeId, opts: ColorModeOptions, label: string): void => {
    onApply(setColorMode(doc, mode, opts), label);
  };

  const submit = (): void => {
    switch (kind) {
      case "bitmap":
        applyMode(
          "bitmap",
          { threshold: Number(threshold) || 128, halftone: Number(halftone) || 0 },
          "位图模式",
        );
        break;
      case "duotone":
        applyMode("duotone", { dark, light, strength: Number(strength) || 100 }, "双色调");
        break;
      case "indexed":
        applyMode("indexed", { colors: Number(colors) || 64, dither }, "索引颜色");
        break;
      case "cmyk":
        applyMode("cmyk", { inkLimit: Number(inkLimit) || 300, ucr: Number(ucr) || 40 }, "CMYK 颜色");
        break;
      case "lab":
        applyMode("lab", { chroma: Number(chroma) || 110 }, "Lab 颜色");
        break;
      case "colorTable":
        if (palette.length === 0) {
          onToast("当前没有调色板，先转换成索引颜色");
          break;
        }
        onApply(remapPalette(doc, palette), "颜色表");
        break;
      case "applyImage":
        onApply(
          applyImage(doc, {
            sourceId: sourceId || undefined,
            channel,
            blend,
            opacity: Number(opacity) || 100,
            invert,
          }),
          "应用图像",
        );
        break;
      case "trap": {
        const w = Math.round(Number(trapWidth) || 0);
        if (w <= 0) {
          onToast("陷印宽度要大于 0");
          return;
        }
        onApply(trapInk(doc, w), "陷印");
        break;
      }
      case "placeScaleMarker": {
        const units = Number(markerUnits);
        if (!Number.isFinite(units) || units <= 0) {
          onToast("标记长度要大于 0");
          return;
        }
        onApply(placeScaleMarker(doc, { units, color: markerColor }), "比例标记");
        break;
      }
      case "measureScale": {
        const p = Number(scalePx);
        const r = Number(scaleReal);
        if (!Number.isFinite(p) || !Number.isFinite(r) || p <= 0 || r <= 0) {
          onToast("像素长度与实际长度都要大于 0");
          return;
        }
        onApply({ ...doc, measureScale: { px: p, real: r, unit: scaleUnit || "px" } }, "测量比例");
        break;
      }
      case "dataPoints":
        onApply({ ...doc, measureFields: fields }, "选择数据点");
        break;
      case "variables": {
        if (!varLayer || !varName.trim()) {
          onToast("请选择图层并填变量名");
          return;
        }
        const rest = (doc.variables ?? []).filter((v) => v.layerId !== varLayer);
        onApply({ ...doc, variables: [...rest, { layerId: varLayer, name: varName.trim() }] }, "定义变量");
        break;
      }
      case "dataSets": {
        const name = setName.trim();
        if (!name) {
          onToast("请填数据组名称");
          return;
        }
        const values: Record<string, string> = {};
        for (const v of doc.variables ?? []) values[v.name] = "1";
        const rest = (doc.dataSets ?? []).filter((s) => s.name !== name);
        onApply({ ...doc, dataSets: [...rest, { name, values }] }, "数据组");
        break;
      }
      case "applyDataSet": {
        const set = (doc.dataSets ?? []).find((s) => s.name === activeSet);
        if (!set) {
          onToast("先创建一个数据组");
          return;
        }
        onApply(applyDataSetOp(doc, set.name), `应用数据组：${set.name}`);
        break;
      }
      default:
        onClose();
        return;
    }
    onClose();
  };

  const readOnly = kind === "recordMeasurements";

  return (
    <Modal
      title={TITLES[kind]}
      onClose={onClose}
      width={kind === "colorTable" || kind === "recordMeasurements" ? 560 : 440}
      footer={
        <>
          <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
            {readOnly ? zh.dialog.cancel : zh.dialog.cancel}
          </button>
          {!readOnly && (
            <button type="button" className="btn-primary btn-sm" onClick={submit}>
              {zh.dialog.confirm}
            </button>
          )}
        </>
      }
    >
      {kind === "bitmap" && (
        <>
          <p className="isz-hint">阈值以上的像素变白、以下变黑，只保留两色。半调网点 &gt; 0 时用 45° 网点模拟印刷效果。</p>
          <div className="isz-row">
            <label className="field">
              <span className="field-label">阈值</span>
              <span className="field-input">
                <input type="number" min={0} max={255} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
              </span>
            </label>
            <label className="field">
              <span className="field-label">半调网点</span>
              <span className="field-input">
                <input type="number" min={0} max={40} value={halftone} onChange={(e) => setHalftone(e.target.value)} />
                <span className="field-unit">px</span>
              </span>
            </label>
          </div>
        </>
      )}

      {kind === "duotone" && (
        <>
          <p className="isz-hint">亮度映射到「深色墨 → 浅色墨」的双色渐变；浓度降低会保留一部分原色。</p>
          <div className="isz-row">
            <label className="field">
              <span className="field-label">深色</span>
              <span className="field-input">
                <input type="color" value={dark} onChange={(e) => setDark(e.target.value)} />
              </span>
            </label>
            <label className="field">
              <span className="field-label">浅色</span>
              <span className="field-input">
                <input type="color" value={light} onChange={(e) => setLight(e.target.value)} />
              </span>
            </label>
            <label className="field">
              <span className="field-label">浓度</span>
              <span className="field-input">
                <input type="number" min={0} max={100} value={strength} onChange={(e) => setStrength(e.target.value)} />
                <span className="field-unit">%</span>
              </span>
            </label>
          </div>
        </>
      )}

      {kind === "indexed" && (
        <>
          <p className="isz-hint">中位切分量化到指定颜色数；抖动用弗洛伊德–斯坦伯格误差扩散，渐变更顺但会有颗粒。</p>
          <div className="isz-row">
            <label className="field">
              <span className="field-label">颜色数</span>
              <span className="field-input">
                <input type="number" min={2} max={256} value={colors} onChange={(e) => setColors(e.target.value)} />
              </span>
            </label>
            <label className="isz-check">
              <input type="checkbox" checked={dither} onChange={(e) => setDither(e.target.checked)} />
              抖动
            </label>
          </div>
        </>
      )}

      {kind === "cmyk" && (
        <>
          <p className="isz-hint">真的走一遍 RGB→CMYK→RGB：油墨总量上限会等比压缩四色，暗部与艳色因此变得像印刷品。</p>
          <div className="isz-row">
            <label className="field">
              <span className="field-label">油墨总量</span>
              <span className="field-input">
                <input type="number" min={100} max={400} value={inkLimit} onChange={(e) => setInkLimit(e.target.value)} />
                <span className="field-unit">%</span>
              </span>
            </label>
            <label className="field">
              <span className="field-label">底色去除</span>
              <span className="field-input">
                <input type="number" min={0} max={100} value={ucr} onChange={(e) => setUcr(e.target.value)} />
                <span className="field-unit">%</span>
              </span>
            </label>
          </div>
        </>
      )}

      {kind === "lab" && (
        <>
          <p className="isz-hint">sRGB→XYZ→Lab→限彩度→回 sRGB。最大彩度越小越保守（极端艳色会被收色）。</p>
          <label className="field">
            <span className="field-label">最大彩度 C*ab</span>
            <span className="field-input">
              <input type="number" min={0} max={180} value={chroma} onChange={(e) => setChroma(e.target.value)} />
            </span>
          </label>
        </>
      )}

      {kind === "colorTable" && (
        <>
          <p className="isz-hint">
            点一个色块改它的颜色，确定后按新调色板重新映射整层。当前共 {palette.length} 色。
          </p>
          {palette.length === 0 ? (
            <p className="isz-hint">还没有调色板 —— 先用「图像 &gt; 模式 &gt; 索引颜色」转换一次。</p>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(16, 1fr)", gap: 4, marginBottom: 12 }}>
                {palette.map((c, i) => (
                  <button
                    key={i}
                    type="button"
                    title={`#${[c[0], c[1], c[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`}
                    onClick={() => setSwatch(i)}
                    style={{
                      height: 18,
                      borderRadius: 3,
                      background: `rgb(${c[0]},${c[1]},${c[2]})`,
                      outline: i === swatch ? "2px solid var(--accent)" : "1px solid var(--border)",
                    }}
                  />
                ))}
              </div>
              <label className="field">
                <span className="field-label">第 {swatch + 1} 色</span>
                <span className="field-input">
                  <input
                    type="color"
                    value={`#${[palette[swatch]?.[0] ?? 0, palette[swatch]?.[1] ?? 0, palette[swatch]?.[2] ?? 0]
                      .map((v) => v.toString(16).padStart(2, "0"))
                      .join("")}`}
                    onChange={(e) => {
                      const hex = e.target.value.replace("#", "");
                      const v = Number.parseInt(hex, 16);
                      onApply(
                        remapPalette(
                          { ...doc, palette: palette.map((c, i) => (i === swatch ? [(v >> 16) & 255, (v >> 8) & 255, v & 255] : c)) },
                          palette.map((c, i) => (i === swatch ? [(v >> 16) & 255, (v >> 8) & 255, v & 255] : c)),
                        ),
                        "颜色表",
                      );
                    }}
                  />
                </span>
              </label>
            </>
          )}
        </>
      )}

      {kind === "applyImage" && (
        <>
          <p className="isz-hint">把另一个图层的通道按混合模式叠进当前图层（当前：{doc.layers.find((l) => l.id === doc.activeLayerId)?.name}）。</p>
          <label className="field">
            <span className="field-label">来源图层</span>
            <span className="field-input">
              <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                <option value="">（默认：下方像素层）</option>
                {pixelLayers.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <div className="isz-row">
            <label className="field">
              <span className="field-label">通道</span>
              <span className="field-input">
                <select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
                  <option value="rgb">RGB</option>
                  <option value="r">红</option>
                  <option value="g">绿</option>
                  <option value="b">蓝</option>
                  <option value="gray">灰度</option>
                </select>
              </span>
            </label>
            <label className="field">
              <span className="field-label">混合</span>
              <span className="field-input">
                <select value={blend} onChange={(e) => setBlend(e.target.value as BlendId)}>
                  {BLEND_LABELS.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <label className="field">
              <span className="field-label">不透明度</span>
              <span className="field-input">
                <input type="number" min={0} max={100} value={opacity} onChange={(e) => setOpacity(e.target.value)} />
                <span className="field-unit">%</span>
              </span>
            </label>
          </div>
          <label className="isz-check">
            <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} />
            反相
          </label>
        </>
      )}

      {kind === "trap" && (
        <>
          <p className="isz-hint">浅色向深色方向「长」出指定像素，避免套印不准出现白缝。</p>
          <label className="field">
            <span className="field-label">宽度</span>
            <span className="field-input">
              <input type="number" min={1} max={20} value={trapWidth} onChange={(e) => setTrapWidth(e.target.value)} />
              <span className="field-unit">px</span>
            </span>
          </label>
        </>
      )}

      {kind === "placeScaleMarker" && (
        <>
          <p className="isz-hint">在画面左下角画比例尺。长度按当前测量比例折算成像素。</p>
          <div className="isz-row">
            <label className="field">
              <span className="field-label">标记长度</span>
              <span className="field-input">
                <input type="number" min={0.01} step={0.5} value={markerUnits} onChange={(e) => setMarkerUnits(e.target.value)} />
                <span className="field-unit">{doc.measureScale?.unit ?? "px"}</span>
              </span>
            </label>
            <label className="field">
              <span className="field-label">颜色</span>
              <span className="field-input">
                <input type="color" value={markerColor} onChange={(e) => setMarkerColor(e.target.value)} />
              </span>
            </label>
          </div>
        </>
      )}

      {kind === "measureScale" && (
        <>
          <p className="isz-hint">定义「多少像素 = 多少实际长度」，测量与比例标记都按它换算。</p>
          <div className="isz-row">
            <label className="field">
              <span className="field-label">像素长度</span>
              <span className="field-input">
                <input type="number" min={1} value={scalePx} onChange={(e) => setScalePx(e.target.value)} />
                <span className="field-unit">px</span>
              </span>
            </label>
            <label className="field">
              <span className="field-label">实际长度</span>
              <span className="field-input">
                <input type="number" min={0.0001} step={0.1} value={scaleReal} onChange={(e) => setScaleReal(e.target.value)} />
              </span>
            </label>
            <label className="field">
              <span className="field-label">单位</span>
              <span className="field-input">
                <input type="text" value={scaleUnit} onChange={(e) => setScaleUnit(e.target.value)} />
              </span>
            </label>
          </div>
        </>
      )}

      {kind === "dataPoints" && (
        <>
          <p className="isz-hint">勾选测量记录里要显示的列。</p>
          {MEASURE_FIELDS.map((f) => (
            <label className="isz-check" key={f}>
              <input
                type="checkbox"
                checked={fields.includes(f)}
                onChange={(e) =>
                  setFields((prev) => (e.target.checked ? [...prev, f] : prev.filter((x) => x !== f)))
                }
              />
              {f}
            </label>
          ))}
        </>
      )}

      {kind === "variables" && (
        <>
          <p className="isz-hint">
            把一个图层绑到变量名上（可见性变量）。之后用「数据组」批量切换它们的显示状态。
          </p>
          <label className="field">
            <span className="field-label">图层</span>
            <span className="field-input">
              <select value={varLayer} onChange={(e) => setVarLayer(e.target.value)}>
                {doc.layers.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <label className="field">
            <span className="field-label">变量名</span>
            <span className="field-input">
              <input type="text" value={varName} onChange={(e) => setVarName(e.target.value)} />
            </span>
          </label>
          <p className="isz-hint">
            已定义 {(doc.variables ?? []).length} 个变量：
            {(doc.variables ?? []).map((v) => v.name).join("、") || "无"}
          </p>
        </>
      )}

      {kind === "dataSets" && (
        <>
          <p className="isz-hint">
            一个数据组 = 一组变量的取值。新建后可用「应用数据组」一键切换。
          </p>
          <label className="field">
            <span className="field-label">新数据组</span>
            <span className="field-input">
              <input type="text" value={setName} onChange={(e) => setSetName(e.target.value)} />
            </span>
          </label>
          <p className="isz-hint">
            现有数据组：
            {(doc.dataSets ?? []).map((s) => s.name).join("、") || "无"}
          </p>
        </>
      )}

      {kind === "applyDataSet" && (
        <>
          <p className="isz-hint">选一个数据组应用到文档（按变量值切换图层可见性）。</p>
          {(doc.dataSets ?? []).length === 0 ? (
            <p className="isz-hint">还没有数据组 —— 先用「图像 &gt; 变量 &gt; 数据组」建一个。</p>
          ) : (
            <label className="field">
              <span className="field-label">数据组</span>
              <span className="field-input">
                <select value={activeSet} onChange={(e) => setActiveSet(e.target.value)}>
                  {(doc.dataSets ?? []).map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </span>
            </label>
          )}
        </>
      )}

      {kind === "recordMeasurements" && (
        <>
          <p className="isz-hint">
            按当前测量比例换算。比例：
            {doc.measureScale
              ? `${doc.measureScale.px} px = ${doc.measureScale.real} ${doc.measureScale.unit}`
              : "未设置（按像素计）"}
          </p>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <tbody>
              {measureRows
                .filter((r) => {
                  const f = doc.measureFields;
                  if (!f || f.length === 0) return true;
                  return f.some((k) => r.label.includes(k)) || r.label === "单位" || r.label === "提示";
                })
                .map((r) => (
                  <tr key={r.label}>
                    <td style={{ padding: "6px 8px", color: "var(--text-3)", width: "46%" }}>{r.label}</td>
                    <td style={{ padding: "6px 8px", fontVariantNumeric: "tabular-nums" }}>{r.value}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <p className="isz-hint" style={{ marginTop: 10 }}>
            画布 {px(doc.width)} × {px(doc.height)}
          </p>
        </>
      )}
    </Modal>
  );
}
