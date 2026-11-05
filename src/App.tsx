import { useCallback, useEffect, useRef, useState } from "react";
import StartPage from "./ui/StartPage";
import EditorShell from "./ui/EditorShell";
import BootScreen from "./ui/components/BootScreen";
import DropletRunner from "./ui/components/DropletRunner";
import { loadScriptEvents } from "./ui/components/AutomationDialogs";
import { useTheme } from "./stores/theme";
import { loadAppInfo, type AppInfo } from "./core/appInfo";
import { applyEntry, captureDoc, History } from "./core/history";
import { zh, useLang, resolveLang } from "./i18n";
import { currentPrefs, usePrefs, UI_FONT_STACKS } from "./stores/prefs";
import type { StrataDoc } from "./core/document";
import { useRecentFiles } from "./stores/recent";
import { openFileToDoc } from "./engine/openFile";
import { readFileBytes } from "./engine/image";
import {
  parseRecipe,
  RECIPE_EXTENSION,
  runRecipeDocOps,
  type Recipe,
} from "./core/recipe";
import { extOf } from "./engine/image";
import {
  onExternalOpen,
  readLaunchIntent,
  type LaunchIntent,
} from "./core/launch";

/** 把 #rrggbb 解析成 0–255 的 RGB（磨砂色传给 Tauri Acrylic 用）。 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 61, g: 107, b: 255 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * 应用根组件。
 *
 * 启动先判意图（见 core/launch.ts）：带文件启动的直接进编辑壳，
 * 主动打开软件的才进开始页面。判定出结果之前只显示启动占位，
 * 不让欢迎页抢在前面一闪。
 *
 * 文档以多标签页并存，每一份各带一套撤销栈（History），互不干扰。
 * 全部文档关闭后回到开始页面 —— 程序不退出。
 */
export default function App() {
  const { mode, skin, setMode, setTheme, toggle } = useTheme();
  const [docs, setDocs] = useState<StrataDoc[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  /** 撤销栈状态变更的计数器：History 是可变对象，靠它触发重渲染 */
  const [revision, setRevision] = useState(0);
  /**
   * 本次启动的意图。null 表示「还没判出来」，此时不渲染欢迎页。
   * 判定失败一律降级为 home —— 最多是让用户自己点，不能卡在空白屏。
   */
  const [launch, setLaunch] = useState<LaunchIntent | null>(null);
  /** 正在打开的文件路径（带文件启动时的进度提示）。 */
  const [bootPath, setBootPath] = useState<string | null>(null);
  /** 带文件启动但没打开成功时的原因。 */
  const [bootError, setBootError] = useState<string | null>(null);
  /** 已装载的 Droplet 配方（双击 .strata-droplet 触发）。 */
  const [droplet, setDroplet] = useState<Recipe | null>(null);
  /** 原生解码提示：CR3 只取到内嵌预览、显影失败降级等，必须让用户看见。 */
  const [decodeNotice, setDecodeNotice] = useState<string | null>(null);

  const { push } = useRecentFiles();
  const stacks = useRef(new Map<string, History>());
  const activeRef = useRef<string | null>(null);
  const docsRef = useRef<StrataDoc[]>([]);
  activeRef.current = activeId;
  docsRef.current = docs;

  // 订阅界面语言：变化后整棵树重渲染，并从 zh 代理读到新语言。
  const lang = useLang();
  useEffect(() => {
    const code = resolveLang(lang);
    document.documentElement.dataset.lang = code;
    document.documentElement.lang = code;
  }, [lang]);

  // 订阅个性化偏好：背景图 / 磨砂 / 字体 / 缩放。
  const prefs = usePrefs();

  // 把个性化偏好写进 :root 的属性与 CSS 变量，CSS 侧据此切换外观。
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.globalFrost = prefs.globalFrost ? "on" : "off";
    root.dataset.windowFrost = prefs.windowFrost ? "on" : "off";
    root.dataset.motion = prefs.motion;
    root.style.setProperty("--frost-color", prefs.frostColor || "#3d6bff");
    root.style.setProperty("--app-bg-frost", String(prefs.bgFrost));
    root.style.setProperty("--ui-scale", String(prefs.uiScale / 100));
    const stack = UI_FONT_STACKS[prefs.uiFont ?? ""] ?? UI_FONT_STACKS[""];
    root.style.setProperty("--ui-font", stack);

    // 真正半透明玻璃：底色透明度、模糊、饱和、高光全部由偏好驱动（CSS 只消费）。
    const c = hexToRgb(prefs.frostColor || "#3d6bff");
    root.style.setProperty("--glass-tint-rgb", `${c.r}, ${c.g}, ${c.b}`);
    root.style.setProperty("--glass-alpha", String(prefs.glassAlpha / 100));
    root.style.setProperty("--glass-blur", `${prefs.glassBlur}px`);
    root.style.setProperty("--glass-sat", `${prefs.glassSat}%`);
    root.style.setProperty("--glass-sheen", String(prefs.glassSheen / 100));
  }, [
    prefs.globalFrost,
    prefs.windowFrost,
    prefs.frostColor,
    prefs.bgFrost,
    prefs.uiFont,
    prefs.uiScale,
    prefs.glassAlpha,
    prefs.glassBlur,
    prefs.glassSat,
    prefs.glassSheen,
    prefs.motion,
  ]);

  // 背景图需要 Tauri 的 convertFileSrc；浏览器里拿不到就退化成无背景图。
  useEffect(() => {
    const root = document.documentElement;
    if (!prefs.bgImage) {
      root.style.setProperty("--app-bg-image", "none");
      return;
    }
    let alive = true;
    import("@tauri-apps/api/core")
      .then(({ convertFileSrc }) => {
        if (!alive) return;
        try {
          root.style.setProperty("--app-bg-image", `url("${convertFileSrc(prefs.bgImage!)}")`);
        } catch {
          root.style.setProperty("--app-bg-image", "none");
        }
      })
      .catch(() => {
        if (alive) root.style.setProperty("--app-bg-image", "none");
      });
    return () => {
      alive = false;
    };
  }, [prefs.bgImage]);

  // 窗口磨砂：开 → Tauri Acrylic（透出桌面并磨砂）；关 → 清除。
  useEffect(() => {
    let cancelled = false;
    import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow, Effect }) => {
        if (cancelled) return;
        const win = getCurrentWindow();
        if (!prefs.windowFrost) {
          await win.clearEffects();
          return;
        }
        const c = hexToRgb(prefs.frostColor || "#3d6bff");
        // Acrylic 的 alpha 跟玻璃透明度联动：越「透」越能看见桌面，不再固定 170。
        const alpha = Math.round(80 + prefs.glassAlpha * 3);
        await win.setEffects({
          effects: [Effect.Acrylic],
          color: [c.r, c.g, c.b, alpha] as [number, number, number, number],
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [prefs.windowFrost, prefs.frostColor, prefs.glassAlpha]);

  // 解码警告来自 Rust 侧的 source/warning，欢迎页 / 双击启动 / 编辑器内打开
  // 三条链路都会经过 loadImage，用全局事件统一兜住，不依赖某一条路径去消费。
  useEffect(() => {
    const onWarn = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (typeof detail === "string" && detail) setDecodeNotice(detail);
    };
    window.addEventListener("strata:decode-warning", onWarn);
    return () => window.removeEventListener("strata:decode-warning", onWarn);
  }, []);

  useEffect(() => {
    if (!decodeNotice) return;
    const t = window.setTimeout(() => setDecodeNotice(null), 8000);
    return () => window.clearTimeout(t);
  }, [decodeNotice]);

  useEffect(() => {
    let alive = true;
    loadAppInfo().then((it) => {
      if (alive) setInfo(it);
    });
    return () => {
      alive = false;
    };
  }, []);

  /** 打开一份新文档：挂上它自己的撤销栈，并置为当前标签页。 */
  const openDoc = useCallback((doc: StrataDoc) => {
    // 脚本事件管理器：打开 / 新建事件上挂了配方就先执行。
    // 这是全应用唯一的文档入口漏斗，覆盖启动参数、拖入、最近文件等所有来路。
    let final = doc;
    try {
      const events = loadScriptEvents();
      const recipe = doc.sourcePath ? events.open : events.new;
      if (recipe) final = runRecipeDocOps(doc, recipe).doc;
    } catch {
      /* 事件配方失败不能拦住正常打开 */
    }
    const stack = new History(currentPrefs().historyLimit);
    stack.reset(captureDoc(final, zh.editor.open));
    stacks.current.set(final.id, stack);
    setDocs((prev) => [...prev, final]);
    setActiveId(final.id);
    setRevision((n) => n + 1);
  }, []);

  /** 打开一个本地文件并进编辑器。开始页面与启动流程共用这一条通路。 */
  const handleOpenPath = useCallback(
    async (path: string) => {
      // Droplet 配方文件：不是文档，装载成批处理模式
      if (extOf(path) === RECIPE_EXTENSION) {
        try {
          const bytes = await readFileBytes(path);
          const recipe = parseRecipe(new TextDecoder().decode(bytes));
          if (!recipe) {
            setBootError(`${zh.error.openFailed}：这不是一份合法的 Strata Droplet 配方`);
            return;
          }
          setDroplet(recipe);
        } catch (e) {
          setBootError(`${zh.error.openFailed}：${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }
      setBootPath(path);
      try {
        const opened = await openFileToDoc(path);
        push(path, {
          thumb: opened.thumb,
          mtime: opened.mtime,
          size: opened.size,
        });
        openDoc(opened.doc);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        setBootError(`${zh.error.openFailed}：${why}`);
      } finally {
        setBootPath(null);
      }
    },
    [openDoc, push],
  );

  /**
   * 浮动窗口交接：主窗口把文档塞进 localStorage，新窗口用 `?float=<key>` 取回。
   *
   * 为什么用 localStorage 而不是 URL 参数：工程可能有几 MB，
   * 塞进 URL 会被长度限制截断；localStorage 容量够，且同源共享。
   */
  const takeFloatDoc = useCallback(
    async (key: string) => {
      try {
        const raw = localStorage.getItem(`strata.floatdoc.${key}`);
        if (!raw) {
          setLaunch({ kind: "home" });
          return;
        }
        localStorage.removeItem(`strata.floatdoc.${key}`);
        const bin = atob(raw);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const { decodeProject } = await import("./engine/project");
        openDoc(await decodeProject(bytes));
      } catch {
        /* 交接失败就当普通启动：回到欢迎页，而不是停在占位屏 */
        setLaunch({ kind: "home" });
      }
    },
    [openDoc],
  );

  // 启动意图判定：必须在第一帧界面出来之前跑完，
  // 否则「双击图片打开」会先闪一下欢迎页，看着就像没打开。
  useEffect(() => {
    let alive = true;
    void (async () => {
      const intent = await readLaunchIntent();
      if (!alive) return;
      setLaunch(intent);
      if (intent.kind === "file") {
        await handleOpenPath(intent.path);
      } else if (intent.kind === "float") {
        await takeFloatDoc(intent.key);
      }
    })();
    return () => {
      alive = false;
    };
  }, [handleOpenPath, takeFloatDoc]);

  // 单实例转发：Strata 已经在跑时再双击一张图，内核把路径转给本窗口，
  // 这里接着打开，不再新起一个进程。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onExternalOpen((p) => {
      void handleOpenPath(p);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [handleOpenPath]);

  /** 关闭某份文档；关掉的是当前页时，焦点落到剩下的最后一份。 */
  const closeDoc = useCallback((id: string) => {
    stacks.current.delete(id);
    const next = docsRef.current.filter((d) => d.id !== id);
    setDocs(next);
    if (activeRef.current === id) {
      setActiveId(next.length > 0 ? next[next.length - 1].id : null);
    }
    setRevision((n) => n + 1);
  }, []);

  const selectDoc = useCallback((id: string) => setActiveId(id), []);

  /** 关闭全部文档：一次性清空标签与各自的撤销栈，回到开始页面。 */
  const closeAll = useCallback(() => {
    stacks.current.clear();
    setDocs([]);
    setActiveId(null);
    setRevision((n) => n + 1);
  }, []);

  /** 清理某份文档的历史记录（编辑 > 清理 > 历史记录）。当前状态成为新的起点。 */
  const clearHistory = useCallback((id: string) => {
    const stack = stacks.current.get(id);
    const d = docsRef.current.find((x) => x.id === id);
    if (stack && d) stack.reset(captureDoc(d, "清理历史记录"));
    setRevision((n) => n + 1);
  }, []);

  /** 落一步可撤销的改动：先入栈，再更新文档。 */
  const commit = useCallback((next: StrataDoc, label: string) => {
    stacks.current.get(next.id)?.commit(captureDoc(next, label));
    setDocs((prev) => prev.map((d) => (d.id === next.id ? next : d)));
    setRevision((n) => n + 1);
  }, []);

  /** 只改画面、不入栈（拖滑杆、切选中这类即时预览）。 */
  /**
   * "正在拖滑块"的全局标记。
   *
   * 弹窗里的参数滑块一按下，就把 body 标成 is-tuning ——
   * CSS 那边据此撤掉模态遮罩的虚化与压暗，让用户能一边拖一边看画面在变。
   * 用事件委托挂一次，不必给每个滑块加监听。
   */
  useEffect(() => {
    const mark = (on: boolean) => document.body.classList.toggle("is-tuning", on);
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest('input[type="range"]')) mark(true);
    };
    const up = () => mark(false);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      mark(false);
    };
  }, []);

  const preview = useCallback((next: StrataDoc) => {
    setDocs((prev) => prev.map((d) => (d.id === next.id ? next : d)));
  }, []);

  const step = useCallback((dir: "undo" | "redo") => {
    const id = activeRef.current;
    if (!id) return;
    const stack = stacks.current.get(id);
    const entry = dir === "undo" ? stack?.undo() : stack?.redo();
    if (!entry) return;
    setDocs((prev) => prev.map((d) => (d.id === id ? applyEntry(d, entry) : d)));
    setRevision((n) => n + 1);
  }, []);

  const undo = useCallback(() => step("undo"), [step]);
  const redo = useCallback(() => step("redo"), [step]);

  /**
   * 历史面板点某一步：不认方向，只认落点。
   * 越界或点的是当前这一步，jumpTo 返回 null，这里直接跳过，不做无谓重绘。
   */
  const jumpHistory = useCallback((index: number) => {
    const id = activeRef.current;
    if (!id) return;
    const entry = stacks.current.get(id)?.jumpTo(index);
    if (!entry) return;
    setDocs((prev) => prev.map((d) => (d.id === id ? applyEntry(d, entry) : d)));
    setRevision((n) => n + 1);
  }, []);

  /**
   * 只读地取「某个历史步骤的文档状态」，不移动撤销游标。
   * 编辑 > 渐隐 需要拿上一步当混合底图，所以必须有这条只读通道。
   */
  const peekHistory = useCallback((index: number): StrataDoc | null => {
    const id = activeRef.current;
    if (!id) return null;
    const base = docsRef.current.find((d) => d.id === id);
    const entry = stacks.current.get(id)?.peek(index);
    if (!base || !entry) return null;
    return applyEntry(base, entry);
  }, []);

  const doc = activeId === null ? null : docs.find((d) => d.id === activeId) ?? null;

  // 固定背景层：基色 + 背景图 + 磨砂，始终铺底；上方内容透明处即可透出。
  // 顺带承载全局解码提示（独立于任何页面，所有启动分支都能看到）。
  const bgLayer = (
    <>
      <div className="app-bg" aria-hidden="true">
        <div className="app-bg-img" />
      </div>
      {decodeNotice && (
        <div className="decode-notice" role="status">
          <span className="decode-notice__dot" aria-hidden="true" />
          <span>{decodeNotice}</span>
          <button
            type="button"
            className="decode-notice__x"
            aria-label="关闭提示"
            onClick={() => setDecodeNotice(null)}
          >
            ×
          </button>
        </div>
      )}
    </>
  );

  if (doc) {
    const stack = stacks.current.get(doc.id);
    return (
      <>
        {bgLayer}
        <EditorShell
          docs={docs}
          doc={doc}
          info={info}
          themeMode={mode}
          onSetTheme={setMode}
          themeSkin={skin}
          onSetThemeId={setTheme}
          onSelectDoc={selectDoc}
          onCloseDoc={closeDoc}
          onCloseAll={closeAll}
          onClearHistory={clearHistory}
          onOpenDoc={openDoc}
          onCommit={commit}
          onPreview={preview}
          onUndo={undo}
          onRedo={redo}
          canUndo={Boolean(stack?.canUndo)}
          canRedo={Boolean(stack?.canRedo)}
          historyLabels={stack ? stack.labels() : []}
          historyIndex={stack ? stack.index : -1}
          onHistoryJump={jumpHistory}
          onPeekHistory={peekHistory}
          revision={revision}
        />
      </>
    );
  }

  // 带文件启动但没打开成：说清楚原因，并给一条回欢迎页的路。
  if (bootError) {
    return (
      <>
        {bgLayer}
        <BootScreen
          error={bootError}
          path={launch?.kind === "file" ? launch.path : null}
          onBack={() => {
            setBootError(null);
            setLaunch({ kind: "home" });
          }}
        />
      </>
    );
  }

  // 正在打开（带文件启动 / 单实例转发）或还在判意图：只显示占位。
  if (bootPath) {
    return <>{bgLayer}<BootScreen label={`${zh.launch.opening}：${bootPath}`} /></>;
  }
  if (launch === null) return <>{bgLayer}<BootScreen /></>;

  // Droplet 已装载：进入批处理界面，关掉即卸下配方回到普通启动。
  if (droplet) {
    return (
      <>
        {bgLayer}
        <DropletRunner
          recipe={droplet}
          onClose={() => {
            setDroplet(null);
            setLaunch({ kind: "home" });
          }}
        />
      </>
    );
  }

  return (
    <>
      {bgLayer}
      <StartPage
        info={info}
        themeMode={mode}
        onToggleTheme={toggle}
        onOpenDoc={openDoc}
      />
    </>
  );
}
