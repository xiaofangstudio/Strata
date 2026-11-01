/**
 * 启动占位 / 启动失败屏。
 *
 * 出现在「还没判出这次启动要干什么」以及「带文件启动但没打开成功」两种情况。
 * 刻意做成一屏独占：既挡住欢迎页的一闪而过，也让打开失败有个说清楚的地方，
 * 而不是静默退回欢迎页让人以为没反应。
 */
import BrandMark from "./BrandMark";
import { zh } from "../../i18n/zh-CN";
import "./BootScreen.css";

interface Props {
  /** 正在做什么；缺省显示通用的启动文案。 */
  label?: string;
  /** 有值时渲染成失败屏（带返回按钮）。 */
  error?: string | null;
  /** 失败屏上出错的那个文件路径。 */
  path?: string | null;
  onBack?: () => void;
}

export default function BootScreen({ label, error, path, onBack }: Props) {
  const failed = Boolean(error);

  return (
    <div className={failed ? "boot boot-fail" : "boot"}>
      <div className="boot-card">
        <div className="boot-mark">
          <BrandMark size={44} />
        </div>

        {failed ? (
          <>
            <h1 className="boot-title">{zh.launch.failedTitle}</h1>
            {path && <p className="boot-path">{path}</p>}
            <p className="boot-error">{error}</p>
            <p className="boot-hint">{zh.launch.failedHint}</p>
            <button className="btn-primary" onClick={onBack}>
              {zh.launch.backHome}
            </button>
          </>
        ) : (
          <>
            <span className="boot-spinner" aria-hidden="true" />
            <p className="boot-label">{label || zh.launch.judging}</p>
          </>
        )}
      </div>
    </div>
  );
}
