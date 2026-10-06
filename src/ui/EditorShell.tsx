import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type WheelEvent,
} from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { zh } from "../i18n/zh-CN";
import { encodePng, writeFileBytes } from "../engine/image";
import type { StrataDoc } from "../core/document";
import "./EditorShell.css";

interface Props {
  doc: StrataDoc;
  onClose: () => void;
}

const PAD = 56;
const MIN_SCALE = 0.02;
const MAX_SCALE = 16;

/**
 * 编辑壳（M0 版）。
 *
 * 只做最小闭环：把图片画到 canvas 上、可缩放查看、可导出 PNG。
 * 正式工具栏 / 图层面板随 M1 接入，这里刻意不做假 UI。
 */
export default function EditorShell({ doc, onClose }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(1);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 把位图画进画布
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = doc.width;
    c.height = doc.height;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(doc.bitmap, 0, 0);
  }, [doc]);

  const fit = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const s = Math.min(
      (vp.clientWidth - PAD) / doc.width,
      (vp.clientHeight - PAD) / doc.height,
    );
    setScale(Math.min(Math.max(s, MIN_SCALE), MAX_SCALE));
  }, [doc.height, doc.width]);

  useEffect(() => {
    fit();
  }, [fit]);

  const exportPng = useCallback(async () => {
    setError(null);
    try {
      const target = await save({
        title: zh.dialog.saveTitle,
        defaultPath: `${doc.name}.png`,
        filters: [{ name: "PNG 图片", extensions: ["png"] }],
      });
      if (typeof target !== "string") return;
      const canvas = canvasRef.current;
      if (!canvas) throw new Error("画布尚未就绪");
      const bytes = await encodePng(canvas);
      await writeFileBytes(target, bytes);
      setToast(zh.editor.exported);
    } catch (e) {
      setError(`${zh.error.exportFailed}：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc.name]);

  // 提示 2.4 秒自动消失
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(t);
  }, [toast]);

  // Ctrl + W / Ctrl + Shift + S / Ctrl + 0 / Ctrl + 1
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "w") {
        e.preventDefault();
        onClose();
      } else if (k === "s" && e.shiftKey) {
        e.preventDefault();
        void exportPng();
      } else if (k === "0") {
        e.preventDefault();
        fit();
      } else if (k === "1") {
        e.preventDefault();
        setScale(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exportPng, fit, onClose]);

  // 滚轮缩放（Ctrl + 滚轮）
  const onWheel = useCallback(
    (e: WheelEvent<HTMLDivElement>) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const next = scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1);
      setScale(Math.min(Math.max(next, MIN_SCALE), MAX_SCALE));
    },
    [scale],
  );

  return (
    <div className="editor">
      <header className="editor-top">
        <button className="btn-ghost" onClick={onClose}>
          ← {zh.editor.backToStart}
        </button>

        <div className="editor-doc">
          <span className="editor-doc-name">{doc.name}</span>
          <span className="editor-doc-meta">
            {doc.width} × {doc.height}
          </span>
        </div>

        <div className="editor-top-actions">
          <span className="zoom-label">{Math.round(scale * 100)}%</span>
          <button className="btn-ghost" onClick={fit}>
            {zh.editor.fit}
          </button>
          <button className="btn-ghost" onClick={() => setScale(1)}>
            {zh.editor.zoom100}
          </button>
          <button className="btn-primary btn-sm" onClick={exportPng}>
            {zh.editor.exportPng}
          </button>
        </div>
      </header>

      <div className="editor-viewport" ref={viewportRef} onWheel={onWheel}>
        <div
          className="editor-stage"
          style={{
            width: doc.width * scale,
            height: doc.height * scale,
          }}
        >
          <canvas ref={canvasRef} className="editor-canvas" />
        </div>
      </div>

      <footer className="editor-foot">
        <span>{zh.editor.unsavedHint}</span>
        {error && <span className="editor-error">{error}</span>}
      </footer>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
