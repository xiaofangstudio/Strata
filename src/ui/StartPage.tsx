import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { zh } from "../i18n/zh-CN";
import {
  IMAGE_EXTENSIONS,
  extOf,
  fileStat,
  loadImage,
  makeThumbnail,
} from "../engine/image";
import {
  baseName,
  docFromBitmap,
  docFromBlank,
  type StrataDoc,
} from "../core/document";
import {
  DEFAULT_DPI,
  MAX_DPI,
  MAX_SIDE,
  MIN_DPI,
  MIN_SIDE,
  PRESETS,
} from "../core/presets";
import { createLayer } from "../core/layer";
import {
  formatSize,
  formatWhen,
  useRecentFiles,
  type RecentEntry,
} from "../stores/recent";
import { quitApp, type AppInfo } from "../core/appInfo";
import AppMenuBar, { type MenuAction, type MenuGroup } from "./components/AppMenuBar";
import BrandMark from "./components/BrandMark";
import InfoModals, { type InfoModalKind } from "./components/InfoModals";
import "./StartPage.css";

/** 画布预览框的可用区域（像素），矩形按比例缩放后居中。 */
const PREVIEW_W = 228;
const PREVIEW_H = 138;

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

function toInt(v: string): number {
  return Number.parseInt(v, 10);
}

/**
 * 开始页面：启动后的第一屏。
 *
 * 对齐立项规划书 §7.5：顶部保留应用标识与主菜单（文件 / 编辑 / 帮助），
 * 主体分「新建画布（预设 + 自定义宽高 / 分辨率 / 背景）」「最近文件（缩略图 +
 * 文件名 + 路径 + 修改时间）」「导入（含拖放）」「其它入口」四块。
 */
export default function StartPage({
  info,
  themeMode,
  onToggleTheme,
  onOpenDoc,
}: Props) {
  const { items: recentItems, push, patch, remove, clear } = useRecentFiles();

  const [width, setWidth] = useState("1920");
  const [height, setHeight] = useState("1080");
  const [dpi, setDpi] = useState(DEFAULT_DPI);
  const [bg, setBg] = useState<"white" | "transparent">("white");
  const [modal, setModal] = useState<InfoModalKind>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  /** 打开一个本地文件并进入编辑壳。 */
  const openPath = useCallback(
    async (path: string) => {
      setError(null);
      setBusy(true);
      setOpening(path);
      try {
        const bitmap = await loadImage(path);
        // 缩略图与文件属性顺手取好，下次进开始页面就不用再解一遍大图。
        const [stat, thumb] = await Promise.all([
          fileStat(path),
          makeThumbnail(bitmap),
        ]);
        push(path, {
          thumb: thumb || undefined,
          mtime: stat.modified ?? undefined,
          size: stat.exists ? stat.size : undefined,
        });
        onOpenDoc(docFromBitmap(bitmap, baseName(path), path));
      } catch (e) {
        setError(`${zh.error.openFailed}：${msgOf(e)}`);
      } finally {
        setBusy(false);
        setOpening(null);
      }
    },
    [onOpenDoc, push],
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
    const w = toInt(width);
    const h = toInt(height);
    if (!Number.isFinite(w) || !Number.isFinite(h)) {
      setError("请输入有效的宽高");
      return;
    }
    if (w < MIN_SIDE || h < MIN_SIDE || w > MAX_SIDE || h > MAX_SIDE) {
      setError(`宽高需在 ${MIN_SIDE} ~ ${MAX_SIDE} 之间`);
      return;
    }
    const d = toInt(dpi);
    if (!Number.isFinite(d) || d < MIN_DPI || d > MAX_DPI) {
      setError(`分辨率需在 ${MIN_DPI} ~ ${MAX_DPI} 之间`);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const name =
        bg === "white"
          ? zh.editor.untitled
          : `${zh.editor.untitled} · ${zh.start.bgTransparent}`;
      onOpenDoc(docFromBlank(w, h, name, bg, d));
    } catch (e) {
      setError(`新建失败：${msgOf(e)}`);
    } finally {
      setBusy(false);
    }
  }, [bg, dpi, height, onOpenDoc, width]);

  /**
   * 造一份内置示例工程：底色 / 光晕 / 图形 三层。
   *
   * 现画现取，不塞二进制资源 —— 一来省体积，二来用户一进编辑界面就能亲手
   * 拖动图层、改混合模式，当场看清「滤色」这类模式到底在干什么，
   * 不必先去导一张图才能明白。三层名字走 i18n，和新建文档的「背景」分开。
   */
  const openSample = useCallback(() => {
    try {
      setError(null);
      const w = 1280;
      const h = 800;

      // 底层：夜色渐变，当作画布底色。
      const base = createLayer(w, h, zh.start.sampleBase);
      const bctx = base.surface.getContext("2d");
      if (bctx) {
        const g = bctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, "#0a1020");
        g.addColorStop(0.55, "#152238");
        g.addColorStop(1, "#1d2f52");
        bctx.fillStyle = g;
        bctx.fillRect(0, 0, w, h);
      }

      // 中层：一团品牌蓝光晕，走「滤色」。把它改成别的模式立刻能看出差别。
      const glow = createLayer(w, h, zh.start.sampleGlow);
      glow.blend = "screen";
      glow.opacity = 85;
      const gctx = glow.surface.getContext("2d");
      if (gctx) {
        const r = Math.round(Math.min(w, h) * 0.42);
        const cx = Math.round(w * 0.62);
        const cy = Math.round(h * 0.46);
        const rg = gctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        rg.addColorStop(0, "rgba(111, 192, 255, 0.95)");
        rg.addColorStop(0.45, "rgba(111, 192, 255, 0.35)");
        rg.addColorStop(1, "rgba(111, 192, 255, 0)");
        gctx.fillStyle = rg;
        gctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      }

      // 顶层：几个几何图形，用来试画笔、变换与图层样式。
      const ink = createLayer(w, h, zh.start.sampleInk);
      const ictx = ink.surface.getContext("2d");
      if (ictx) {
        ictx.fillStyle = "#6fc0ff";
        ictx.beginPath();
        ictx.arc(Math.round(w * 0.3), Math.round(h * 0.5), 96, 0, Math.PI * 2);
        ictx.fill();
        ictx.lineWidth = 12;
        ictx.strokeStyle = "#ffffff";
        ictx.strokeRect(Math.round(w * 0.55), Math.round(h * 0.28), 320, 300);
      }

      const doc = docFromBlank(w, h, zh.start.sample, "transparent", toInt(DEFAULT_DPI));
      doc.layers = [base, glow, ink];
      doc.activeLayerId = ink.id;
      doc.dirty = false;
      onOpenDoc(doc);
    } catch (e) {
      setError(`打开示例工程失败：${msgOf(e)}`);
    }
  }, [onOpenDoc]);

  // 启动时刷新最近文件的真实属性，并为缺图的记录补一张缩略图。
  // 只跑一次、串行解码，避免一上来就把十几张大图同时丢进解码器。
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    let cancelled = false;
    const snapshot = recentItems;

    void (async () => {
      // 1) 校验文件是否还在，并刷新修改时间与体积。
      const stats = await Promise.all(snapshot.map((it) => fileStat(it.path)));
      if (cancelled) return;

      const alive: RecentEntry[] = [];
      snapshot.forEach((it, i) => {
        const s = stats[i];
        if (!s.exists) {
          if (!it.missing) patch(it.path, { missing: true });
          return;
        }
        alive.push(it);
        const mtime = s.modified ?? undefined;
        const changed = it.missing || it.mtime !== mtime || it.size !== s.size;
        if (changed) patch(it.path, { missing: false, mtime, size: s.size });
      });

      // 2) 串行补齐缩略图。
      for (const it of alive) {
        if (cancelled) return;
        if (it.thumb) continue;
        try {
          const bmp = await loadImage(it.path);
          const thumb = await makeThumbnail(bmp);
          bmp.close();
          if (cancelled) return;
          if (thumb) patch(it.path, { thumb });
        } catch {
          if (cancelled) return;
          patch(it.path, { missing: true });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // 只在挂载时跑一次：快照取的是首次渲染读到的列表。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tauri 会接管窗口级拖放，需走 webview 事件而非 HTML5 drop。
  // 该 API 在非 Tauri 环境（浏览器预览）下会同步抛错，必须整体兜住，
  // 否则异常会冒泡到 React 并导致整个界面卸载白屏。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    const subscribe = async () => {
      try {
        const fn = await getCurrentWebview().onDragDropEvent((ev) => {
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
        });
        if (disposed) fn();
        else unlisten = fn;
      } catch {
        /* 浏览器预览等场景下没有该 API，降级为不接管拖放 */
      }
    };

    void subscribe();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openPath]);

  // Ctrl + O 打开图片；Ctrl + N 新建画布。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "o") {
        e.preventDefault();
        void pickFile();
      } else if (key === "n") {
        e.preventDefault();
        void createBlank();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createBlank, pickFile]);

  /** 画布预览的等比缩放结果。 */
  const preview = useMemo(() => {
    const w = toInt(width);
    const h = toInt(height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
      return null;
    }
    const s = Math.min(PREVIEW_W / w, PREVIEW_H / h);
    return {
      w: Math.max(12, Math.round(w * s)),
      h: Math.max(12, Math.round(h * s)),
      label: `${w} × ${h}`,
      mp: `${((w * h) / 1_000_000).toFixed(1)} ${zh.start.mp}`,
    };
  }, [height, width]);

  const onQuit = useCallback(() => {
    void quitApp().catch(() => {
      setError("退出失败，请直接关闭窗口");
    });
  }, []);

  /**
   * 开始页还没有文档，编辑类命令一律禁用，并说明真正的原因 —— 这些命令
   * 在编辑界面里其实都已经能用了，这里只是缺一份文档，绝不再挂「待接入」。
   */
  const needDocItem = (label: string, keys: string): MenuAction => ({
    label,
    disabled: true,
    hint: `${keys} · ${zh.menu.needDoc}`,
  });

  const menuGroups: MenuGroup[] = [
    {
      key: "file",
      label: zh.menu.file,
      items: [
        { label: zh.menu.newCanvas, hint: "Ctrl + N", onSelect: () => void createBlank() },
        { label: zh.menu.openImage, hint: "Ctrl + O", onSelect: () => void pickFile() },
        { kind: "sep" },
        { label: zh.menu.exportPng, disabled: true, hint: zh.menu.needDoc },
        { label: zh.menu.closeDoc, disabled: true, hint: zh.menu.needDoc },
        { kind: "sep" },
        { label: zh.menu.quit, onSelect: onQuit },
      ],
    },
    {
      key: "edit",
      label: zh.menu.edit,
      items: [
        needDocItem(zh.menu.undo, "Ctrl + Z"),
        needDocItem(zh.menu.redo, "Ctrl + Shift + Z"),
        { kind: "sep" },
        needDocItem(zh.menu.cut, "Ctrl + X"),
        needDocItem(zh.menu.copy, "Ctrl + C"),
        needDocItem(zh.menu.paste, "Ctrl + V"),
        { kind: "sep" },
        needDocItem(zh.menu.selectAll, "Ctrl + A"),
      ],
    },
    {
      key: "help",
      label: zh.menu.help,
      items: [
        { label: zh.menu.shortcuts, onSelect: () => setModal("shortcuts") },
        { kind: "sep" },
        { label: zh.menu.about, onSelect: () => setModal("about") },
      ],
    },
  ];

  return (
    <div className="start">
      <header className="start-top">
        <div className="start-brand">
          <BrandMark size={26} />
          <span className="start-brand-name">{zh.app.name}</span>
          <span className="start-brand-tag">{zh.app.tagline}</span>
        </div>
        <AppMenuBar groups={menuGroups} />
        <span className="top-spacer" />
        <button
          className="btn-ghost"
          onClick={onToggleTheme}
          title={themeMode === "light" ? zh.theme.toDark : zh.theme.toLight}
        >
          {themeMode === "light" ? zh.theme.dark : zh.theme.light}
        </button>
      </header>

      <main className="start-main">
        {/* ---------- 新建画布 ---------- */}
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{zh.start.newCanvas}</h2>
            <span className="card-note">{zh.start.presets}</span>
          </div>

          <div className="presets">
            {PRESETS.map((p) => {
              const active = width === String(p.w) && height === String(p.h);
              return (
                <button
                  key={p.key}
                  className={active ? "chip chip-on" : "chip"}
                  onClick={() => {
                    setWidth(String(p.w));
                    setHeight(String(p.h));
                    if (p.dpi) setDpi(String(p.dpi));
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

          <div className="canvas-body">
            <div className="canvas-form">
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

              <label className="field" title={zh.start.resolutionHint}>
                <span className="field-label">{zh.start.resolution}</span>
                <span className="field-input">
                  <input
                    type="number"
                    min={MIN_DPI}
                    max={MAX_DPI}
                    value={dpi}
                    onChange={(e) => setDpi(e.target.value)}
                  />
                  <span className="field-unit">{zh.start.dpiUnit}</span>
                </span>
              </label>

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
            </div>

            <figure className="canvas-preview">
              <div className="preview-stage">
                {preview && (
                  <span
                    className={
                      bg === "white" ? "preview-rect" : "preview-rect is-checker"
                    }
                    style={{ width: preview.w, height: preview.h }}
                  />
                )}
              </div>
              <figcaption className="preview-meta">
                {preview ? `${preview.label} · ${preview.mp}` : zh.start.unknownSize}
              </figcaption>
            </figure>
          </div>

          <button className="btn-primary btn-block" onClick={createBlank} disabled={busy}>
            {zh.start.create}
          </button>
        </section>

        {/* ---------- 最近文件 ---------- */}
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{zh.start.recent}</h2>
            {recentItems.length > 0 && (
              <button className="btn-link" onClick={clear}>
                {zh.start.recentClear}
              </button>
            )}
          </div>

          {recentItems.length === 0 ? (
            <div className="empty">
              <div className="empty-mark">
                <BrandMark size={40} />
              </div>
              <p className="empty-title">{zh.start.recentEmptyTitle}</p>
              <p className="empty-hint">{zh.start.recentEmptyHint}</p>
            </div>
          ) : (
            <ul className="recent-list">
              {recentItems.map((it) => (
                <li
                  key={it.path}
                  className={it.missing ? "recent-item is-missing" : "recent-item"}
                >
                  <button
                    className="recent-open"
                    disabled={it.missing || busy}
                    onClick={() => void openPath(it.path)}
                    title={it.missing ? zh.start.missingHint : it.path}
                  >
                    <span className="recent-thumb">
                      {it.thumb ? (
                        <img src={it.thumb} alt={zh.start.thumbAlt} />
                      ) : (
                        <BrandMark size={20} />
                      )}
                    </span>
                    <span className="recent-text">
                      <span className="recent-name">
                        <span className="recent-name-text">{it.name}</span>
                        {it.missing && (
                          <span className="recent-tag">{zh.start.missing}</span>
                        )}
                        {opening === it.path && (
                          <span className="recent-tag is-busy">打开中…</span>
                        )}
                      </span>
                      <span className="recent-path">{it.path}</span>
                    </span>
                  </button>
                  <span className="recent-meta">
                    <span className="recent-when">
                      {formatWhen(it.mtime ?? it.openedAt)}
                    </span>
                    <span className="recent-size">
                      {it.size ? formatSize(it.size) : zh.start.unknownSize}
                    </span>
                  </span>
                  <button
                    className="recent-remove"
                    title={zh.start.recentRemove}
                    onClick={() => remove(it.path)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      {/* ---------- 导入 ---------- */}
      <section className={dragging ? "import import-on" : "import"}>
        <div className="import-text">
          <h2 className="card-title">{zh.start.importTitle}</h2>
          <p className="import-hint">{zh.start.importHint}</p>
        </div>
        <button className="btn-primary" onClick={pickFile} disabled={busy}>
          {zh.start.importButton}
        </button>
      </section>

      {error && (
        <div className="banner">
          <span className="banner-text">{error}</span>
          <button className="banner-close" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      <footer className="start-foot">
        <span className="foot-label">{zh.start.others}</span>
        <button className="btn-ghost" onClick={openSample} title={zh.start.sampleHint}>
          {zh.start.sample}
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

      <InfoModals which={modal} info={info} onClose={() => setModal(null)} />
    </div>
  );
}
