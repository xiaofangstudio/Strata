/**
 * 参数窗「窗口内独立预览」的离屏合成画布。
 *
 * 工作文档一变就重合成一张画布，喂给 FilterPreview / 直方图。
 * 走尾随节流（铁律，绝不用防抖）：距上次计算够 gapMs 就立刻算一帧，
 * 不够就排一个定时器，pending 永远指向最新 doc —— 连续拖动时画面持续刷新，
 * 停手后最后一帧保证画。卸载清 timer。
 */
import { useEffect, useRef, useState } from "react";
import type { StrataDoc } from "../../core/document";
import { composeDoc } from "../../engine/compositor";

/**
 * 一次性合成「未应用参数」的原图画布，供按住对比用。
 * base 在对话框生命周期内不变，所以只算一次，不跟参数拖动重算。
 */
export function useBaseComposite(base: StrataDoc): HTMLCanvasElement | null {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = document.createElement("canvas");
    composeDoc(base, cv);
    setCanvas(cv);
  }, [base]);
  return canvas;
}

export function useComposedPreview(doc: StrataDoc, gapMs = 120) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [version, setVersion] = useState(0);
  const owner = useRef<HTMLCanvasElement | null>(null);
  const last = useRef(0);
  const timer = useRef<number | null>(null);
  const pending = useRef<StrataDoc | null>(null);

  useEffect(() => {
    pending.current = doc;
    const run = () => {
      const next = pending.current;
      if (!next) return;
      const cv = owner.current ?? document.createElement("canvas");
      owner.current = cv;
      composeDoc(next, cv);
      setCanvas(cv);
      setVersion((v) => v + 1);
    };
    const elapsed = Date.now() - last.current;
    if (elapsed >= gapMs) {
      last.current = Date.now();
      run();
      return;
    }
    if (timer.current !== null) return; // 已排定帧，它会取最新的 pending
    timer.current = window.setTimeout(() => {
      timer.current = null;
      last.current = Date.now();
      run();
    }, gapMs - elapsed);
  }, [doc, gapMs]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return { canvas, version };
}
