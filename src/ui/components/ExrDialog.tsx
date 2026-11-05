/**
 * 打开 EXR（File > Open EXR Parts）。
 *
 * 先用内核命令列出文件的部件（multipart EXR / AOV 分层输出），让用户勾选，
 * 再逐个解码成 8 位图层。HDR → sRGB 8 位的转换在 Rust 侧完成（线性 → sRGB
 * 伽马、超亮裁白），这里如实写进界面，不假装保留了 HDR。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { zh } from "../../i18n";
import { docFromBlank, baseName } from "../../core/document";
import { createLayer } from "../../core/layer";
import { DEFAULT_DPI } from "../../core/presets";
import { mustCtx } from "../../engine/surface";
import type { StrataDoc } from "../../core/document";
import Modal from "./Modal";

interface ExrPartInfo {
  name: string;
  width: number;
  height: number;
  channels: string[];
}

interface ExrPartPixels {
  name: string;
  width: number;
  height: number;
  rgba: Uint8Array;
}

interface Props {
  path: string;
  onClose: () => void;
  onOpenDoc: (doc: StrataDoc) => void;
}

export default function ExrDialog({ path, onClose, onOpenDoc }: Props) {
  const [parts, setParts] = useState<ExrPartInfo[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set([0]));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await invoke<ExrPartInfo[]>("exr_part_info", { path });
        if (!alive) return;
        setParts(list);
        setPicked(new Set(list.map((_, i) => i).filter((i) => i === 0)));
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [path]);

  const toggle = (i: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const openParts = useCallback(async () => {
    if (!parts || picked.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const decoded = await invoke<ExrPartPixels[]>("exr_read_all", { path });
      const chosen = decoded.filter((_, i) => picked.has(i));
      if (chosen.length === 0) return;
      const w = Math.max(...chosen.map((c) => c.width));
      const h = Math.max(...chosen.map((c) => c.height));
      const doc = docFromBlank(w, h, baseName(path), "transparent", toInt(DEFAULT_DPI));
      doc.layers = chosen.map((c, i) => {
        const layer = createLayer(c.width, c.height, c.name || `部件 ${i + 1}`);
        mustCtx(layer.surface).putImageData(
          new ImageData(new Uint8ClampedArray(c.rgba), c.width, c.height),
          0,
          0,
        );
        return layer;
      });
      doc.activeLayerId = doc.layers[0].id;
      onOpenDoc(doc);
    } catch (e) {
      setError(`解码失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [parts, picked, path, onOpenDoc]);

  return (
    <Modal
      title="打开 EXR（选择部件）"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
            {zh.dialog.cancel}
          </button>
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={busy || picked.size === 0}
            onClick={() => void openParts()}
          >
            {busy ? "解码中…" : `打开所选部件（${picked.size}）`}
          </button>
        </>
      }
    >
      <p className="modal-lead">{path}</p>
      {error && <p className="isz-hint">{error}</p>}
      {!parts && !error && <p className="isz-hint">正在读取 EXR 头信息…</p>}
      {parts && (
        <>
          <p className="isz-hint">
            EXR 是 HDR 格式，Strata 会把线性亮度转成 sRGB 8 位落地（超亮裁到白），
            每个部件成为图层栈里独立的一层。
          </p>
          <div className="pref-tools">
            {parts.map((p, i) => (
              <label key={i} className="pref-tool">
                <input type="checkbox" checked={picked.has(i)} onChange={() => toggle(i)} />
                <span>
                  {p.name || `部件 ${i + 1}`} · {p.width}×{p.height} · {p.channels.join(" / ")}
                </span>
              </label>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

function toInt(v: string): number {
  return Number.parseInt(v, 10);
}
