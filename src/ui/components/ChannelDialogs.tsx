/**
 * 通道系统对话框：存储选区 / 载入选区 / 通道运算。
 *
 * 与滤镜弹窗同一套「实时预览 + 确定才落盘」模型：载入选区在拖动过程中每帧
 * 把结果推给 onPreview（不进历史），通道运算则只算一张结果缩略图预览、不改
 * 画面；确定才由 EditorShell 进一条历史。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Modal from "./Modal";
import { zh } from "../../i18n/zh-CN";
import type { StrataDoc } from "../../core/document";
import {
  alphaChannelThumb,
  type AlphaChannel,
} from "../../core/channels";
import {
  alphaChannelsOf,
  combineAlphaChannels,
  isChannelMaskEmpty,
  loadChannelAsSelection,
  nextChannelName,
  previewChannelCombine,
  saveSelectionAsChannel,
  type ChannelOp,
} from "../../core/channelOps";
import type { SelectionMode } from "../../core/selection";
import "./ChannelDialogs.css";

interface DocProps {
  doc: StrataDoc;
  onApply: (next: StrataDoc) => void;
  onClose: () => void;
}

/* ------------------------------------------------------ 存储选区 */

export function SaveSelectionDialog({ doc, onApply, onClose }: DocProps) {
  const [name, setName] = useState(() => nextChannelName(doc));
  const hasSel = !!doc.selection && !isChannelMaskEmpty(doc.selection);
  const apply = () => {
    if (!hasSel) return;
    onApply(saveSelectionAsChannel(doc, name));
  };
  return (
    <Modal
      title={zh.dialog.channelSaveTitle}
      onClose={onClose}
      width={400}
      footer={
        <>
          <span className="cd-note">{hasSel ? zh.dialog.channelSaveHint : zh.dialog.channelSaveEmpty}</span>
          <span className="fg-foot-spacer" />
          <button type="button" className="btn-ghost" onClick={onClose}>
            {zh.dialog.cancel}
          </button>
          <button type="button" className="btn-primary" onClick={apply} disabled={!hasSel}>
            {zh.dialog.confirm}
          </button>
        </>
      }
    >
      <div className="cd">
        <label className="cd-field">
          <span className="cd-label">{zh.dialog.channelName}</span>
          <input
            className="cd-input"
            value={name}
            maxLength={40}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && hasSel) apply();
            }}
          />
        </label>
        {!hasSel && <p className="cd-empty">{zh.dialog.channelSaveEmpty}</p>}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------ 载入选区 */

const LOAD_OPS: { value: SelectionMode; label: string }[] = [
  { value: "new", label: zh.selection.new },
  { value: "add", label: zh.selection.add },
  { value: "subtract", label: zh.selection.subtract },
  { value: "intersect", label: zh.selection.intersect },
];

export function LoadSelectionDialog({
  doc,
  onPreview,
  onApply,
  onClose,
}: DocProps & { onPreview: (next: StrataDoc) => void }) {
  const base = useRef(doc).current;
  const channels = alphaChannelsOf(base);
  const [id, setId] = useState<string>(channels[0]?.id ?? "");
  const [op, setOp] = useState<SelectionMode>("new");
  const preview = useMemo(() => loadChannelAsSelection(base, id, op), [base, id, op]);

  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  const closedRef = useRef(false);
  useEffect(() => {
    previewRef.current(preview);
  }, [preview]);

  const cancel = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    previewRef.current(base);
    onClose();
  };
  const apply = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    onApply(preview);
  };

  return (
    <Modal
      title={zh.dialog.channelLoadTitle}
      onClose={cancel}
      width={400}
      footer={
        <>
          <span className="cd-note">{zh.dialog.channelLoadHint}</span>
          <span className="fg-foot-spacer" />
          <button type="button" className="btn-ghost" onClick={cancel}>
            {zh.dialog.cancel}
          </button>
          <button type="button" className="btn-primary" onClick={apply}>
            {zh.dialog.confirm}
          </button>
        </>
      }
    >
      <div className="cd">
        <label className="cd-field">
          <span className="cd-label">{zh.dialog.channelSource1}</span>
          <select className="cd-select" value={id} onChange={(e) => setId(e.target.value)}>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="cd-field">
          <span className="cd-label">{zh.dialog.channelLoadOp}</span>
          <select
            className="cd-select"
            value={op}
            onChange={(e) => setOp(e.target.value as SelectionMode)}
          >
            {LOAD_OPS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------ 通道运算 */

const CALC_OPS: { value: ChannelOp; label: string }[] = [
  { value: "add", label: zh.dialog.channelOpAdd },
  { value: "subtract", label: zh.dialog.channelOpSubtract },
  { value: "intersect", label: zh.dialog.channelOpIntersect },
];

export function ChannelCalcDialog({ doc, onApply, onClose }: DocProps) {
  const channels = alphaChannelsOf(doc);
  const [s1, setS1] = useState<string>(channels[0]?.id ?? "");
  const [s2, setS2] = useState<string>(channels[1]?.id ?? channels[0]?.id ?? "");
  const [op, setOp] = useState<ChannelOp>("add");
  const [inv1, setInv1] = useState(false);
  const [inv2, setInv2] = useState(false);
  const [inv, setInv] = useState(false);
  const [name, setName] = useState(() => nextChannelName(doc, "运算"));

  const preview = useMemo(
    () =>
      previewChannelCombine(doc, {
        source1: s1,
        source2: s2,
        op,
        invert1: inv1,
        invert2: inv2,
        invert: inv,
      }),
    [doc, s1, s2, op, inv1, inv2, inv],
  );

  const thumbRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = thumbRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (preview) ctx.drawImage(alphaChannelThumb(preview, c.width), 0, 0);
  }, [preview]);

  const same = s1 === s2;
  const apply = () => {
    if (!preview || same) return;
    onApply(
      combineAlphaChannels(doc, {
        source1: s1,
        source2: s2,
        op,
        invert1: inv1,
        invert2: inv2,
        invert: inv,
        name,
      }),
    );
  };

  return (
    <Modal
      title={zh.dialog.channelCalcTitle}
      onClose={onClose}
      width={440}
      footer={
        <>
          <span className="cd-note">{zh.dialog.channelCalcHint}</span>
          <span className="fg-foot-spacer" />
          <button type="button" className="btn-ghost" onClick={onClose}>
            {zh.dialog.cancel}
          </button>
          <button type="button" className="btn-primary" onClick={apply} disabled={!preview || same}>
            {zh.dialog.confirm}
          </button>
        </>
      }
    >
      <div className="cd">
        <div className="cd-calc-grid">
          <label className="cd-field">
            <span className="cd-label">{zh.dialog.channelSource1}</span>
            <select className="cd-select" value={s1} onChange={(e) => setS1(e.target.value)}>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="cd-check">
            <input type="checkbox" checked={inv1} onChange={(e) => setInv1(e.target.checked)} />
            <span>{zh.dialog.channelInvert}</span>
          </label>
          <label className="cd-field">
            <span className="cd-label">{zh.dialog.channelOp}</span>
            <select
              className="cd-select"
              value={op}
              onChange={(e) => setOp(e.target.value as ChannelOp)}
            >
              {CALC_OPS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <span className="cd-spacer" />
          <label className="cd-field">
            <span className="cd-label">{zh.dialog.channelSource2}</span>
            <select className="cd-select" value={s2} onChange={(e) => setS2(e.target.value)}>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="cd-check">
            <input type="checkbox" checked={inv2} onChange={(e) => setInv2(e.target.checked)} />
            <span>{zh.dialog.channelInvert}</span>
          </label>
        </div>

        <label className="cd-check">
          <input type="checkbox" checked={inv} onChange={(e) => setInv(e.target.checked)} />
          <span>{zh.dialog.channelInvert}({zh.dialog.channelResult})</span>
        </label>

        <div className="cd-preview">
          <span className="cd-label">{zh.dialog.channelPreview}</span>
          <canvas ref={thumbRef} width={160} height={120} className="cd-preview-canvas" />
        </div>

        <label className="cd-field">
          <span className="cd-label">{zh.dialog.channelResult}</span>
          <input
            className="cd-input"
            value={name}
            maxLength={40}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {same && <p className="cd-empty">{zh.dialog.channelCalcSame}</p>}
      </div>
    </Modal>
  );
}

/** 用于类型标注（避免未使用告警）。 */
export type { AlphaChannel };
