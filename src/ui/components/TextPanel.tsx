/**
 * 文字面板（Type > 面板 > 字符 / 段落 / 字形 / 字符样式 / 段落样式）。
 *
 * 一个面板五个页签，全部绑在「当前活动的文本层」上：改任何一项都会
 * 立刻 重新栅格化 那一层的 surface（文本层 = 像素层 + text 状态）。
 *
 * 字形页是一个字符网格：点一下就把字符追加到文本内容里 —— Strata 没有
 * 字形表 API，所以列的是常用汉字/拉丁/标点，够用来拼符号与特殊字符。
 *
 * 字符/段落样式存在偏好里（跨会话保留），应用时把整组排版参数写回文本层。
 */
import { useState } from "react";
import { usePrefs, setPrefs } from "../../stores/prefs";
import type { StrataDoc } from "../../core/document";
import { hasText, updateText, updateTextSettings } from "../../core/textLayer";
import {
  TEXT_FAMILIES,
  WARP_STYLES,
  type OpenTypeFeature,
  type TextAlign,
  type TextAntiAlias,
  type TextFamilyId,
  type WarpStyle,
} from "../../engine/text";
import { zh } from "../../i18n/zh-CN";
import Modal from "./Modal";
import RangeInput from "./RangeInput";
import "./Preferences.css";

export type TextPanelTab = "character" | "paragraph" | "glyphs" | "charStyles" | "paraStyles";

interface Props {
  tab: TextPanelTab;
  doc: StrataDoc;
  onApply: (next: StrataDoc, label: string) => void;
  onClose: () => void;
}

const AA_OPTIONS: { id: TextAntiAlias; label: string }[] = [
  { id: "none", label: "无" },
  { id: "sharp", label: "锐利" },
  { id: "crisp", label: "清晰" },
  { id: "strong", label: "强" },
  { id: "smooth", label: "平滑" },
  { id: "windowsLcd", label: "Windows LCD" },
  { id: "windows", label: "Windows" },
];

const OPENTYPE: { id: OpenTypeFeature; label: string; note?: string }[] = [
  { id: "liga", label: "标准连字", note: "fi / fl / ff" },
  { id: "calt", label: "上下文替代", note: "同标准连字" },
  { id: "dlig", label: "自由连字", note: "st / ct" },
  { id: "frac", label: "分数", note: "1/2 → ½" },
  { id: "ordn", label: "序数", note: "1st → 1ˢᵗ" },
  { id: "swsh", label: "花饰字" },
  { id: "onum", label: "老式数字" },
  { id: "salt", label: "风格替代" },
  { id: "titl", label: "标题替代" },
  { id: "ornm", label: "装饰字" },
];

/** 字形网格：常用汉字 + 拉丁 + 标点 + 常用符号。 */
const GLYPHS = Array.from(
  "的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处理世车技府究给术光金门受政务加化",
).map((c) => c);

const LATIN = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
const PUNCT = Array.from("，。、；：？！“”‘’（）【】《》—…·,.;:?!\"'()[]<>-+/=%$#@&*");

export default function TextPanel({ tab, doc, onApply, onClose }: Props) {
  const prefs = usePrefs();
  const [pane, setPane] = useState<TextPanelTab>(tab);
  const [styleName, setStyleName] = useState("");
  const layer = doc.layers.find((l) => l.id === doc.activeLayerId);
  const isText = hasText(layer);

  const patchText = (patch: Parameters<typeof updateText>[2], label: string): void => {
    if (!layer || !isText) return;
    onApply(updateText(doc, layer.id, patch), label);
  };
  const patchSettings = (
    patch: Parameters<typeof updateTextSettings>[2],
    label: string,
  ): void => {
    if (!layer || !isText) return;
    onApply(updateTextSettings(doc, layer.id, patch), label);
  };

  const tabs: { id: TextPanelTab; label: string }[] = [
    { id: "character", label: "字符" },
    { id: "paragraph", label: "段落" },
    { id: "glyphs", label: "字形" },
    { id: "charStyles", label: "字符样式" },
    { id: "paraStyles", label: "段落样式" },
  ];

  const s = isText ? layer.text.settings : null;

  return (
    <Modal
      title="文字"
      onClose={onClose}
      width={620}
      footer={
        <button type="button" className="btn-primary btn-sm" onClick={onClose}>
          {zh.preferences.done}
        </button>
      }
    >
      <div className="pref" style={{ height: 420 }}>
        <nav className="pref-tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`pref-tab${pane === t.id ? " is-on" : ""}`}
              onClick={() => setPane(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="pref-pane">
          {!isText && (
            <p className="pref-note">
              当前图层不是文本层。用文字工具（T）新建一段文字，或在「文字」菜单里先转换。
            </p>
          )}

          {isText && pane === "character" && (
            <>
              <section className="pref-sec">
                <h3 className="pref-h">内容</h3>
                <textarea
                  value={layer.text.content}
                  rows={3}
                  style={{ width: "100%", resize: "vertical" }}
                  onChange={(e) => patchText({ content: e.target.value }, "文字内容")}
                />
              </section>
              <section className="pref-sec">
                <h3 className="pref-h">字体（预览大小 {prefs.fontPreviewSize}px）</h3>
                <div className="pref-choice" style={{ flexWrap: "wrap" }}>
                  {TEXT_FAMILIES.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className={`pref-card${s?.family === f.id ? " is-on" : ""}`}
                      style={{ minWidth: 96 }}
                      onClick={() => patchSettings({ family: f.id as TextFamilyId }, "字体")}
                    >
                      <span
                        style={{
                          fontFamily: f.stack,
                          fontSize: prefs.fontPreviewSize,
                          lineHeight: 1.1,
                        }}
                      >
                        永字
                      </span>
                      <span className="pref-card-name">{f.label}</span>
                    </button>
                  ))}
                </div>
              </section>
              <section className="pref-sec">
                <h3 className="pref-h">字号 {s?.size}px · 字距 {s?.letterSpacing}px · 行距 {s?.lineHeight}</h3>
                <div className="pref-row">
                  <RangeInput
                    min={6}
                    max={400}
                    value={s?.size ?? 48}
                    aria-label="字号"
                    onChange={(v) => patchSettings({ size: v }, "字号")}
                  />
                </div>
                <div className="pref-row">
                  <RangeInput
                    min={-20}
                    max={40}
                    value={s?.letterSpacing ?? 0}
                    aria-label="字距"
                    onChange={(v) => patchSettings({ letterSpacing: v }, "字距")}
                  />
                </div>
                <div className="pref-row">
                  <RangeInput
                    min={0.6}
                    max={3}
                    step={0.05}
                    value={s?.lineHeight ?? 1.25}
                    aria-label="行距"
                    onChange={(v) => patchSettings({ lineHeight: v }, "行距")}
                  />
                </div>
              </section>
              <section className="pref-sec">
                <h3 className="pref-h">抗锯齿</h3>
                <div className="pref-seg" style={{ flexWrap: "wrap" }}>
                  {AA_OPTIONS.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className={`pref-seg-btn${layer.text.antiAlias === a.id ? " is-on" : ""}`}
                      onClick={() => patchText({ antiAlias: a.id }, "抗锯齿")}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </section>
              <section className="pref-sec">
                <h3 className="pref-h">OpenType</h3>
                {OPENTYPE.map((f) => (
                  <label className="pref-check" key={f.id}>
                    <input
                      type="checkbox"
                      checked={Boolean(layer.text.openType[f.id])}
                      onChange={(e) =>
                        patchText(
                          { openType: { ...layer.text.openType, [f.id]: e.target.checked } },
                          `OpenType ${f.label}`,
                        )
                      }
                    />
                    {f.label}
                    {f.note ? `（${f.note}）` : ""}
                  </label>
                ))}
                <p className="pref-note">
                  Canvas 不下发 font-feature-settings，所以这里做的是 Unicode 码位替换：
                  有对应码位的特性（连字/分数/序数）会真实改变字形，没有对应码位的
                  （花饰字/老式数字/装饰字等）只记录开关，需要有该特性的字体才能体现。
                </p>
              </section>
            </>
          )}

          {isText && pane === "paragraph" && (
            <>
              <section className="pref-sec">
                <h3 className="pref-h">对齐</h3>
                <div className="pref-seg">
                  {(["left", "center", "right"] as TextAlign[]).map((a) => (
                    <button
                      key={a}
                      type="button"
                      className={`pref-seg-btn${s?.align === a ? " is-on" : ""}`}
                      onClick={() => patchSettings({ align: a }, "对齐")}
                    >
                      {a === "left" ? "左" : a === "center" ? "中" : "右"}
                    </button>
                  ))}
                </div>
              </section>
              <section className="pref-sec">
                <h3 className="pref-h">文本框</h3>
                <p className="pref-note">
                  {layer.text.boxWidth
                    ? `段落文本，框宽 ${Math.round(layer.text.boxWidth)} px`
                    : "点文本（只在换行符处断行）"}
                </p>
                <div className="pref-row">
                  <RangeInput
                    min={40}
                    max={Math.max(80, doc.width)}
                    value={Math.round(layer.text.boxWidth ?? doc.width * 0.6)}
                    aria-label="框宽"
                    onChange={(v) => patchText({ boxWidth: v }, "框宽")}
                  />
                </div>
              </section>
              <section className="pref-sec">
                <h3 className="pref-h">语言</h3>
                <div className="pref-seg" style={{ flexWrap: "wrap" }}>
                  {(
                    [
                      ["default", "默认"],
                      ["eastAsian", "东亚（可在任意字符间断行）"],
                      ["middleEastern", "中东"],
                      ["mes", "中东与南亚排版"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={`pref-seg-btn${layer.text.language === id ? " is-on" : ""}`}
                      onClick={() => patchText({ language: id }, "语言选项")}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </section>
              <section className="pref-sec">
                <h3 className="pref-h">弯曲</h3>
                <div className="pref-seg" style={{ flexWrap: "wrap" }}>
                  {WARP_STYLES.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      className={`pref-seg-btn${s?.warp === w.id ? " is-on" : ""}`}
                      onClick={() => patchSettings({ warp: w.id as WarpStyle }, "弯曲文字")}
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
                <div className="pref-row">
                  <RangeInput
                    min={-100}
                    max={100}
                    value={s?.warpAmount ?? 0}
                    aria-label="弯曲强度"
                    onChange={(v) => patchSettings({ warpAmount: v }, "弯曲强度")}
                  />
                </div>
              </section>
            </>
          )}

          {isText && pane === "glyphs" && (
            <>
              <p className="pref-note">点一个字符追加到文本末尾（用来拼符号特别方便）。</p>
              {[["汉字", GLYPHS], ["拉丁", LATIN], ["标点符号", PUNCT]].map(([title, list]) => (
                <section className="pref-sec" key={title as string}>
                  <h3 className="pref-h">{title as string}</h3>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {(list as string[]).map((ch, i) => (
                      <button
                        key={`${ch}-${i}`}
                        type="button"
                        className="btn-ghost btn-xs"
                        style={{ minWidth: 26 }}
                        onClick={() => patchText({ content: layer.text.content + ch }, "插入字形")}
                      >
                        {ch}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </>
          )}

          {(pane === "charStyles" || pane === "paraStyles") && (
            <>
              <p className="pref-note">
                {pane === "charStyles"
                  ? "字符样式 = 字体 / 字号 / 字距 / 抗锯齿这一组参数。"
                  : "段落样式 = 对齐 / 行距 / 框宽 / 语言这一组参数。"}
              </p>
              {isText && (
                <div className="pref-row">
                  <input
                    type="text"
                    placeholder="样式名称"
                    value={styleName}
                    onChange={(e) => setStyleName(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={() => {
                      const name = styleName.trim() || `样式 ${Date.now() % 1000}`;
                      if (pane === "charStyles") {
                        const { family, size, letterSpacing } = layer.text.settings;
                        setPrefs({
                          typeCharStyles: [
                            ...prefs.typeCharStyles.filter((x) => x.name !== name),
                            { name, family, size, letterSpacing },
                          ],
                        });
                      } else {
                        const { align, lineHeight, warp, warpAmount } = layer.text.settings;
                        setPrefs({
                          typeParaStyles: [
                            ...prefs.typeParaStyles.filter((x) => x.name !== name),
                            { name, align, lineHeight, warp, warpAmount },
                          ],
                        });
                      }
                      setStyleName("");
                    }}
                  >
                    保存当前为样式
                  </button>
                </div>
              )}
              {(pane === "charStyles" ? prefs.typeCharStyles : prefs.typeParaStyles).map((st) => (
                <div className="pref-row" key={st.name}>
                  <span style={{ flex: 1 }}>{st.name}</span>
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={() => {
                      if (pane === "charStyles") {
                        const c = st as { family: TextFamilyId; size: number; letterSpacing: number };
                        patchSettings(
                          { family: c.family, size: c.size, letterSpacing: c.letterSpacing },
                          `应用样式 ${st.name}`,
                        );
                      } else {
                        const p = st as {
                          align: TextAlign;
                          lineHeight: number;
                          warp: WarpStyle;
                          warpAmount: number;
                        };
                        patchSettings(
                          {
                            align: p.align,
                            lineHeight: p.lineHeight,
                            warp: p.warp,
                            warpAmount: p.warpAmount,
                          },
                          `应用样式 ${st.name}`,
                        );
                      }
                    }}
                  >
                    应用
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={() =>
                      setPrefs(
                        pane === "charStyles"
                          ? { typeCharStyles: prefs.typeCharStyles.filter((x) => x.name !== st.name) }
                          : { typeParaStyles: prefs.typeParaStyles.filter((x) => x.name !== st.name) },
                      )
                    }
                  >
                    删除
                  </button>
                </div>
              ))}
              {(pane === "charStyles" ? prefs.typeCharStyles : prefs.typeParaStyles).length === 0 && (
                <p className="pref-note">还没有自定义样式。</p>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
