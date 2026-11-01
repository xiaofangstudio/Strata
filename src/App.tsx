import { useCallback, useEffect, useRef, useState } from "react";
import StartPage from "./ui/StartPage";
import EditorShell from "./ui/EditorShell";
import BootScreen from "./ui/components/BootScreen";
import DropletRunner from "./ui/components/DropletRunner";
import { loadScriptEvents } from "./ui/components/AutomationDialogs";
import { useTheme } from "./stores/theme";
import { loadAppInfo, type AppInfo } from "./core/appInfo";
import { applyEntry, captureDoc, History } from "./core/history";
import { zh } from "./i18n/zh-CN";
import { currentPrefs } from "./stores/prefs";
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

  const { push } = useRecentFiles();
  const stacks = useRef(new Map<string, History>());
  const activeRef = useRef<string | null>(null);
  const docsRef = useRef<StrataDoc[]>([]);
  activeRef.current = activeId;
  docsRef.current = docs;

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

  if (doc) {
    const stack = stacks.current.get(doc.id);
    return (
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
    );
  }

  // 带文件启动但没打开成：说清楚原因，并给一条回欢迎页的路。
  if (bootError) {
    return (
      <BootScreen
        error={bootError}
        path={launch?.kind === "file" ? launch.path : null}
        onBack={() => {
          setBootError(null);
          setLaunch({ kind: "home" });
        }}
      />
    );
  }

  // 正在打开（带文件启动 / 单实例转发）或还在判意图：只显示占位。
  if (bootPath) {
    return <BootScreen label={`${zh.launch.opening}：${bootPath}`} />;
  }
  if (launch === null) return <BootScreen />;

  // Droplet 已装载：进入批处理界面，关掉即卸下配方回到普通启动。
  if (droplet) {
    return (
      <DropletRunner
        recipe={droplet}
        onClose={() => {
          setDroplet(null);
          setLaunch({ kind: "home" });
        }}
      />
    );
  }

  return (
    <StartPage
      info={info}
      themeMode={mode}
      onToggleTheme={toggle}
      onOpenDoc={openDoc}
    />
  );
}
