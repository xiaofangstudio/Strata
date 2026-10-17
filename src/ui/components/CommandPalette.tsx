/**
 * 命令面板（立项规划书 §7.1 的第 ② 条：菜单入口保留 + Ctrl + K）。
 *
 * 菜单是「知道命令在哪」的人的路径，命令面板是「知道命令叫什么」的人的
 * 路径。两者共用同一份命令表，因此不会出现「菜单里有、面板里找不到」。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { zh } from "../../i18n/zh-CN";
import "./CommandPalette.css";

export interface Command {
  id: string;
  label: string;
  /** 快捷键或补充说明，右对齐展示 */
  hint?: string;
  /** 分组名，仅用于视觉分隔与排序 */
  group?: string;
  run: () => void;
}

interface Props {
  commands: Command[];
  onClose: () => void;
}

export default function CommandPalette({ commands, onClose }: Props) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const hits = useMemo(() => {
    const key = q.trim().toLowerCase();
    if (!key) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(key) ||
        (c.group ?? "").toLowerCase().includes(key),
    );
  }, [commands, q]);

  // 结果集变化时把光标收回顶部，否则会停在越界的位置上
  useEffect(() => {
    setCursor(0);
  }, [q]);

  // 键盘操作时把选中项滚进视野
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((i) => (hits.length === 0 ? 0 : (i + 1) % hits.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((i) => (hits.length === 0 ? 0 : (i - 1 + hits.length) % hits.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(hits[cursor]);
    }
  };

  return (
    <div className="cp-mask" onMouseDown={onClose}>
      <div
        className="cp"
        role="dialog"
        aria-label={zh.palette.title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          className="cp-input"
          value={q}
          autoFocus
          spellCheck={false}
          placeholder={zh.palette.placeholder}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
        />

        <div className="cp-list" ref={listRef}>
          {hits.length === 0 && <p className="cp-empty">{zh.palette.empty}</p>}
          {hits.map((c, i) => (
            <button
              key={c.id}
              type="button"
              data-idx={i}
              className={i === cursor ? "cp-item is-on" : "cp-item"}
              onMouseEnter={() => setCursor(i)}
              onClick={() => run(c)}
            >
              {c.group && <span className="cp-group">{c.group}</span>}
              <span className="cp-label">{c.label}</span>
              {c.hint && <span className="cp-hint">{c.hint}</span>}
            </button>
          ))}
        </div>

        <div className="cp-foot">{zh.palette.hint}</div>
      </div>
    </div>
  );
}
