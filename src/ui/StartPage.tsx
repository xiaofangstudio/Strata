import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { zh } from "../i18n/zh-CN";
import { IMAGE_EXTENSIONS, loadImage, extOf } from "../engine/image";
import { baseName, nextDocId, type StrataDoc } from "../core/document";
import { formatWhen, useRecentFiles } from "../stores/recent";
import { platformLabel, type AppInfo } from "../core/appInfo";
import BrandMark from "./components/BrandMark";
import Modal from "./components/Modal";
import "./StartPage.css";

/** 常用画布尺寸。 */
const PRESETS = [
  { label: "全高清", w: 1920, h: 1080 },
  { label: "方形", w: 1080, h: 1080 },
  { label: "竖版", w: 1080, h: 1920 },
  { label: "4K", w: 3840, h: 2160 },
  { label: "A4 · 300dpi", w: 2480, h: 3508 },
];

const MIN_SIDE = 1;
const MAX_SIDE = 16384;

type ModalKind = "shortcuts" | "about" | null;

interface Props {
  info: AppInfo | null;
  themeMode: "light" | "dark";
  onToggleTheme: () => void;
  onOpenDoc: (doc: StrataDoc) => void;
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isImagePath(p: string): boolean {
  return IMAGE_EXTENSIONS.includes(extOf(p));
}

/** 生成一张纯色 / 透明的空白位图。 */
async function makeBlank(
  w: number,
  h: number,
  bg: "white" | "transparent",
): Promise<ImageBitmap> {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");
  if (bg === "white") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
  }
  return await createImageBitmap(c);
}

/** 开始页面：启动后的第一屏，与 Figma / Office 一致。 */
export default function StartPage({
  info,
  themeMode,
  onToggleTheme,
  onOpenDoc,
}: Props) {
  const recent = useRecentFiles();
  const [width, setWidth] = useState("1920");
  const [height, setHeight] = useState("1080");
  const [bg, setBg] = useState<"white" | "transparent">("white");
  const [modal, setModal] = useState<ModalKind>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const openPath = useCallback(
    async (path: string) => {
      setError(null);
      setBusy(true);
      try {
        const bitmap = await loadImage(path);
        recent.push(path);
        onOpenDoc({
          id: nextDocId(),
          name: baseName(path),
          width: bitmap.width,
          height: bitmap.height,
          bitmap,
          sourcePath: path,
        });
      } catch (e) {
        setError(`${zh.error.openFailed}：${msgOf(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [onOpenDoc, recent],
  );

  const pickFile = useCallback(async () => {
    try {
      const picked = await open({
        title: zh.dialog.openTitle,
        multiple: false,
        directory: false,
        filters: [{ name: "图片", extensions: [...IMAGE_EXTENSIONS] }],
      });
      if (typeof picked === "string") {
        await openPath(picked);
      }
    } catch (e) {
      setError(`${zh.error.openFailed}：${msgOf(e)}`);
    }
  }, [openPath]);

  const createBlank = useCallback(async () => {
    const w = Number.parseInt(width, 10);
    const h = Number.parseInt(height, 10);
    if (!Number.isFinite(w) || !Number.isFinite(h)) {
      setError("请输入有效的宽高");
      return;
    }
    if (w < MIN_SIDE || h < MIN_SIDE || w > MAX_SIDE || h > MAX_SIDE) {
      setError(`宽高需在 ${MIN_SIDE} ~ ${MAX_SIDE} 之间`);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const bitmap = await makeBlank(w, h, bg);
      onOpenDoc({
        id: nextDocId(),
        name: bg === "white" ? "未命名" : "未命名 · 透明",
        width: w,
        height: h,
        bitmap,
      });
    } catch (e) {
      setError(`新建失败：${msgOf(e)}`);
    } finally {
      setBusy(false);
    }
  }, [bg, height, onOpenDoc, width]);

  // Tauri 会接管窗口级拖放，需走 webview 事件而非 HTML5 drop
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWebview()
      .onDragDropEvent((ev) => {
        if (ev.payload.type === "over") {
          setDragging(true);
        } else if (ev.payload.type === "leave") {
          setDragging(false);
        } else if (ev.payload.type === "drop") {
          setDragging(false);
          const paths = ev.payload.paths;
          const target = paths.find(isImagePath) ?? paths[0];
          if (target) void openPath(target);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* 浏览器预览下没有该 API，忽略 */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openPath]);

  // Ctrl + O
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void pickFile();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickFile]);

  const infoFacts = [
    { k: "产品", v: "Strata" },
    { k: "版本", v: info ? `v${info.version}` : "读取中…" },
    { k: "运行环境", v: platformLabel(info) },
    { k: "界面语言", v: "简体中文" },
    { k: "协议", v: "MIT · 永久免费 · 不盈利" },
    { k: "仓库", v: "github.com/xiaofangstudio/Strata" },
  ];

  return (
    <div className="start">
      <header className="start-top">
        <div className="start-brand">
          <BrandMark size={28} />
          <div className="start-brand-text">
            <span className="start-brand-name">{zh.app.name}</span>
            <span className="start-brand-tag">{zh.app.tagline}</span>
          </div>
        </div>
        <nav className="start-top-actions">
          <button
            className="btn-ghost"
            onClick={onToggleTheme}
            title={
              themeMode === "light" ? zh.theme.toDark : zh.theme.toLight
            }
          >
            {themeMode === "light" ? "深色" : "浅色"}
          </button>
          <button className="btn-ghost" onClick={() => setModal("about")}>
            {zh.start.about}
          </button>
        </nav>
      </header>

      <main className="start-main">
        <section className="card">
          <h2 className="card-title">{zh.start.newCanvas}</h2>

          <div className="presets">
            {PRESETS.map((p) => {
              const active =
                width === String(p.w) && height === String(p.h);
              return (
                <button
                  key={p.label}
                  className={active ? "chip chip-on" : "chip"}
                  onClick={() => {
                    setWidth(String(p.w));
                    setHeight(String(p.h));
                  }}
                >
                  <span className="chip-label">{p.label}</span>
                  <span className="chip-note">
                    {p.w} × {p.h}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="field-row">
            <label className="field">
              <span className="field-label">{zh.start.width}</span>
              <span className="field-input">
                <input
                  type="number"
                  min={MIN_SIDE}
                  max={MAX_SIDE}
                  value={width}
                  onChange={(e) => setWidth(e.target.value)}
                />
                <span className="field-unit">{zh.start.unit}</span>
              </span>
            </label>
            <span className="field-x">×</span>
            <label className="field">
              <span className="field-label">{zh.start.height}</span>
              <span className="field-input">
                <input
                  type="number"
                  min={MIN_SIDE}
                  max={MAX_SIDE}
                  value={height}
                  onChange={(e) => setHeight(e.target.value)}
                />
                <span className="field-unit">{zh.start.unit}</span>
              </span>
            </label>
          </div>

          <div className="field">
            <span className="field-label">{zh.start.background}</span>
            <div className="segmented">
              <button
                className={bg === "white" ? "seg seg-on" : "seg"}
                onClick={() => setBg("white")}
              >
                {zh.start.bgWhite}
              </button>
              <button
                className={bg === "transparent" ? "seg seg-on" : "seg"}
                onClick={() => setBg("transparent")}
              >
                {zh.start.bgTransparent}
              </button>
            </div>
          </div>

          <button className="btn-primary" onClick={createBlank} disabled={busy}>
            {zh.start.create}
          </button>
        </section>

        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{zh.start.recent}</h2>
            {recent.items.length > 0 && (
              <button className="btn-link" onClick={recent.clear}>
                {zh.start.recentClear}
              </button>
            )}
          </div>

          {recent.items.length === 0 ? (
            <div className="empty">
              <div className="empty-mark">
                <BrandMark size={40} />
              </div>
              <p className="empty-title">{zh.start.recentEmptyTitle}</p>
              <p className="empty-hint">{zh.start.recentEmptyHint}</p>
            </div>
          ) : (
            <ul className="recent-list">
              {recent.items.map((it) => (
                <li key={it.path} className="recent-item">
                  <button
                    className="recent-open"
                    onClick={() => void openPath(it.path)}
                    title={it.path}
                  >
                    <span className="recent-name">{it.name}</span>
                    <span className="recent-path">{it.path}</span>
                  </button>
                  <span className="recent-when">{formatWhen(it.openedAt)}</span>
                  <button
                    className="recent-remove"
                    title={zh.start.recentRemove}
                    onClick={() => recent.remove(it.path)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <section className={dragging ? "import import-on" : "import"}>
        <div className="import-text">
          <h2 className="card-title">{zh.start.importTitle}</h2>
          <p className="import-hint">{zh.start.importHint}</p>
        </div>
        <button className="btn-primary" onClick={pickFile} disabled={busy}>
          {zh.start.importButton}
        </button>
      </section>

      {error && <div className="banner">{error}</div>}

      <footer className="start-foot">
        <span className="foot-label">{zh.start.others}</span>
        <button className="btn-ghost btn-disabled" disabled>
          {zh.start.sample}
          <span className="badge">{zh.start.sampleHint}</span>
        </button>
        <button className="btn-ghost" onClick={() => setModal("shortcuts")}>
          {zh.start.shortcuts}
        </button>
        <button className="btn-ghost" onClick={() => setModal("about")}>
          {zh.start.about}
        </button>
        <span className="foot-spacer" />
        <span className="foot-note">{zh.start.footerHint}</span>
      </footer>

      {modal === "shortcuts" && (
        <Modal
          title={zh.shortcuts.title}
          onClose={() => setModal(null)}
          footer={
            <button className="btn-primary" onClick={() => setModal(null)}>
              {zh.shortcuts.close}
            </button>
          }
        >
          <p className="modal-lead">{zh.shortcuts.hint}</p>
          <ul className="keys">
            {zh.shortcuts.rows.map((r) => (
              <li key={r.keys} className="keys-row">
                <kbd className="kbd">{r.keys}</kbd>
                <span>{r.desc}</span>
              </li>
            ))}
          </ul>
        </Modal>
      )}

      {modal === "about" && (
        <Modal
          title={zh.about.title}
          onClose={() => setModal(null)}
          width={520}
          footer={
            <button className="btn-primary" onClick={() => setModal(null)}>
              {zh.about.close}
            </button>
          }
        >
          <div className="about-head">
            <BrandMark size={52} />
            <div>
              <p className="about-name">{zh.app.name}</p>
              <p className="about-studio">
                {zh.app.studio}
                {info ? ` · v${info.version}` : ""}
              </p>
            </div>
          </div>
          <p className="modal-lead">{zh.about.intro}</p>
          <dl className="facts">
            {infoFacts.map((f) => (
              <div key={f.k} className="fact">
                <dt>{f.k}</dt>
                <dd>{f.v}</dd>
              </div>
            ))}
          </dl>
          <p className="about-noai">{zh.about.noAi}</p>
        </Modal>
      )}
    </div>
  );
}
