/**
 * 屏幕合成主路径的 GPU 复算调度。
 *
 * 铁律：
 *  1. CPU 永远先画一帧，GPU 只做后台复算，绝不阻塞交互；
 *  2. 像素快照在同步栈里读完，await 之后不碰画布池；
 *  3. 单调 generation + 文档 id 双校验，过期结果直接丢弃；
 *  4. 同一时刻只允许一个 GPU 任务，避免多帧重复上传；
 *  5. CPU / GPU 成对计时，GPU 持续更慢就自动停用主路径。
 */
import type { StrataDoc } from "../core/document";
import { captureDisplayForGpu } from "./displayCompose";
import {
  gpuCanComposeLayers,
  gpuComposeToTarget,
  gpuInputsFromLayers,
  recordDisplayTiming,
} from "./gpuBridge";
import { getComposeTiming } from "./gpu/stats";

export interface GpuDisplayJob {
  doc: StrataDoc;
  viewScale: number;
  target: HTMLCanvasElement;
  generation: number;
  /** 同一帧 CPU 即时合成的耗时，用于配对 A/B。 */
  cpuMs: number;
  /**
   * 调用方判断「这一帧现在还是不是最新」。GPU 是异步的，若期间已经出了
   * 更新的 CPU 帧，旧结果必须丢弃，绝不能回头覆盖新画面。
   */
  isCurrent?: () => boolean;
  /** GPU 成功替换画面后调用，让 UI 重新呈递这一帧。 */
  onApplied: () => void;
  /** GPU 任务结束（成功/失败/过期）后调用，通常用来补排一帧。 */
  onSettled: () => void;
}

let busy = false;

/** 尝试排一个 GPU 显示复算任务；返回是否真的排上。 */
export function scheduleGpuDisplay(job: GpuDisplayJob): boolean {
  if (busy || !getComposeTiming().enabled) return false;
  const { doc, viewScale, target, generation } = job;
  const snap = captureDisplayForGpu(doc, viewScale, null);
  if (!snap || snap.width !== target.width || snap.height !== target.height) return false;
  if (!gpuCanComposeLayers(snap.layers, snap.width, snap.height)) return false;
  // 池画布只能活到这一行：立刻读成独立副本。
  const inputs = gpuInputsFromLayers(snap.layers);
  busy = true;
  void gpuComposeToTarget(inputs, snap.width, snap.height, target)
    .then(({ used, ms }) => {
      recordDisplayTiming(job.cpuMs, ms);
      const current = !job.isCurrent || job.isCurrent();
      if (used && current && generation === job.generation && doc.id === job.doc.id) {
        job.onApplied();
      }
    })
    .catch(() => undefined)
    .finally(() => {
      busy = false;
      job.onSettled();
    });
  return true;
}

/** 仅供诊断：当前是否有 GPU 任务在飞。 */
export function gpuDisplayBusy(): boolean {
  return busy;
}
