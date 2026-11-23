/**
 * 参数窗口底部的一对小撤销按钮。
 *
 * 键盘快捷键是主力，但按钮有两个作用：让「这个窗口有独立历史」变得可见，
 * 以及在没有键盘的场景（触控板 / 平板上）也能回退误调的参数。
 */
import { zh } from "../../i18n";
import "./DialogUndoButtons.css";

interface Props {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

export default function DialogUndoButtons({ canUndo, canRedo, onUndo, onRedo }: Props) {
  return (
    <span className="dub-group" role="group" aria-label={zh.dialog.duUndoTip}>
      <button
        type="button"
        className="btn-ghost dub-btn"
        title={zh.dialog.duUndoTip}
        disabled={!canUndo}
        onClick={onUndo}
      >
        <span aria-hidden="true">↶</span>
        {zh.dialog.duUndo}
      </button>
      <button
        type="button"
        className="btn-ghost dub-btn"
        title={zh.dialog.duRedoTip}
        disabled={!canRedo}
        onClick={onRedo}
      >
        <span aria-hidden="true">↷</span>
        {zh.dialog.duRedo}
      </button>
    </span>
  );
}
