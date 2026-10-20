/**
 * 历史面板（右侧 Dock 的独立一组）。
 *
 * 与 PS 一样：最新的步骤排在顶上，当前所处的那一步高亮；在它之上（更早的）
 * 是「撤销得到」的，在它之下是「重做得到」的 —— 后者压暗，一眼能看出
 * 「继续画一笔会把这条分支冲掉」。
 *
 * 点击任意一步即跳过去，跳过去之后再画一笔就从那里长出新分支。
 */
import { zh } from "../../i18n/zh-CN";
import "./LayersPanel.css";

interface Props {
  /** 步骤名（下标 0 是最早那一步，与撤销栈一一对应） */
  labels: string[];
  /** 当前停在第几步；-1 表示栈尚未就绪 */
  index: number;
  /** 点历史里的某一步，直接跳过去 */
  onJump: (index: number) => void;
}

export default function HistoryPanel({ labels, index, onJump }: Props) {
  return (
    <section className="dock-panel" aria-label={zh.panel.history}>
      <div className="dock-head">
        <span>{zh.panel.history}</span>
        {labels.length > 0 && (
          <span className="dock-head-count">
            {index + 1} / {labels.length}
          </span>
        )}
      </div>

      {labels.length === 0 ? (
        <p className="dock-hint hist-empty">{zh.panel.historyEmpty}</p>
      ) : (
        <div className="dock-scroll hist-scroll">
          <ol className="hist-list">
            {/* 倒序渲染：最新的在最上面，符合「刚做的就在眼前」的直觉 */}
            {labels
              .map((label, i) => ({ label, i }))
              .reverse()
              .map(({ label, i }) => (
                <li key={i}>
                  <button
                    type="button"
                    className={
                      i === index
                        ? "hist-step is-now"
                        : i > index
                          ? "hist-step is-future"
                          : "hist-step"
                    }
                    aria-current={i === index ? "step" : undefined}
                    title={label}
                    onClick={() => onJump(i)}
                  >
                    <span className="hist-dot" aria-hidden />
                    <span className="hist-label">{label}</span>
                  </button>
                </li>
              ))}
          </ol>
        </div>
      )}
    </section>
  );
}
