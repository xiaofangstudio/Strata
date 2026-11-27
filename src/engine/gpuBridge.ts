/**
 * WebGPU 合成接线。
 *
 * 资格判定非常保守：只有「纯像素层 + 无蒙版/剪贴/图层样式/Blend If + 已知混合模式」
 * 才交给 GPU。任何拿不准的结构都回退 Canvas2D，宁可少加速也不能算错。
 *
 * 主路径的调用顺序是「CPU 先出即时帧 → 后台 GPU 异步复算 → 结果更新且更快才替换」，
 * 因为 GPU 有上传/读回延迟，不能让画面等到异步结果。
 */
import type { StrataDoc } from "../core/document";
import type { StrataLayer } from "../core/layer";
import { createLayer } from "../core/layer";
import { flattenImage } from "../core/layerOps";
import { createSurface, mustCtx, readPixels } from "./surface";
import { gpuFlattenDetailed, type GpuFlattenReport, type GpuLayerInput } from "./gpu/compose";
import { SUPPORTED_GPU_BLENDS } from "./gpu/blendIds";
import { blendIfActive } from "./blendIf";
import { getComposeTiming, recordComposeTiming } from "./gpu/stats";

/** 一层能否安全交给 GPU 合成。 */
function layerEligible(l: StrataLayer, w: number, h: number): boolean {
  if (l.kind !== "pixel") return false;
  if (l.mask && l.maskActive !== false) return false;
  if (l.clip) return false;
  if (l.styles?.some((s) => s.enabled)) return false;
  if (blendIfActive(l.blendIf)) return false;
  if (l.blend !== "normal" && !SUPPORTED_GPU_BLENDS.includes(l.blend)) return false;
  return l.surface.width === w && l.surface.height === h && l.surface.width > 0 && l.surface.height > 0;
}

/** 这份文档能不能安全交给 GPU 合成（结果必须与 CPU 逐像素一致）。 */
export function gpuCanCompose(doc: StrataDoc): boolean {
  if (!doc.layers.length) return false;
  return doc.layers.every((l) => layerEligible(l, doc.width, doc.height));
}

/** 兼容旧名：拼合路径沿用。 */
export const gpuCanFlatten = gpuCanCompose;

/** 现成的显示层数组能否走 GPU（尺寸已按显示比例缩好）。 */
export function gpuCanComposeLayers(layers: readonly StrataLayer[], w: number, h: number): boolean {
  if (!layers.length) return false;
  return layers.every((l) => layerEligible(l, w, h));
}

/** 把已经缩放好的显示层读成独立的 GPU 输入副本（必须在同步栈里调用）。 */
export function gpuInputsFromLayers(layers: readonly StrataLayer[]): GpuLayerInput[] {
  return layers.map((l) => ({
    pixels: readPixels(l.surface).data,
    opacity: Math.max(0, Math.min(1, l.opacity / 100)),
    blend: l.blend,
    visible: l.visible,
  }));
}

function usable(report: GpuFlattenReport): boolean {
  return report.image !== null && report.fallbackMask === 0 && report.fallbackBlendIds.length === 0;
}

export interface FlattenOutcome {
  doc: StrataDoc;
  /** 这次是否真的走了 WebGPU */
  gpu: boolean;
}

/**
 * 拼合图像：能走 GPU 就走，任何一步失败静默回退 CPU。
 * 调用方是菜单命令（async），不需要同步返回。
 */
export async function flattenImageBestEffort(doc: StrataDoc): Promise<FlattenOutcome> {
  if (gpuCanCompose(doc)) {
    try {
      const inputs = gpuInputsFromLayers(doc.layers);
      const report = await gpuFlattenDetailed(inputs, doc.width, doc.height);
      if (usable(report) && report.image) {
        const surface = createSurface(doc.width, doc.height);
        mustCtx(surface).putImageData(report.image, 0, 0);
        const out = createLayer(doc.width, doc.height, "背景");
        return {
          doc: {
            ...doc,
            layers: [{ ...out, surface }],
            activeLayerId: out.id,
            dirty: true,
          },
          gpu: true,
        };
      }
    } catch {
      // 设备丢失 / 读回失败：不做任何提示，直接走 CPU，用户不该被硬件细节打扰
    }
  }
  return { doc: flattenImage(doc), gpu: false };
}

export interface ComposeBestEffortResult {
  /** GPU 结果是否真的写进了 target；false 表示调用方必须保留 CPU 结果。 */
  used: boolean;
  /** 端到端耗时（含像素上传与读回），未执行时 0。 */
  ms: number;
}

/**
 * 把一份已经准备好的合成输入交给 GPU；成功时直接覆盖 target。
 *
 * 不在这里做 CPU 回退：调用方已经画过一次 CPU 即时帧，GPU 失败就保留那一帧。
 * 这样异步失败不会让画面闪一下空白。
 */
export async function gpuComposeToTarget(
  inputs: GpuLayerInput[],
  width: number,
  height: number,
  target: HTMLCanvasElement,
): Promise<ComposeBestEffortResult> {
  if (!getComposeTiming().enabled) return { used: false, ms: 0 };
  const started = performance.now();
  try {
    const report = await gpuFlattenDetailed(inputs, width, height);
    const ms = performance.now() - started;
    if (!usable(report) || !report.image) return { used: false, ms };
    if (target.width !== width || target.height !== height) return { used: false, ms };
    mustCtx(target).putImageData(report.image, 0, 0);
    return { used: true, ms };
  } catch {
    return { used: false, ms: performance.now() - started };
  }
}

/**
 * 记录配对的 CPU / GPU 样本。显示主路径每次都会调：
 * CPU 即时帧耗时与 GPU 复算耗时成对进来，连续偏慢就自动关掉 GPU 主路径。
 */
export function recordDisplayTiming(cpuMs: number, gpuMs: number): void {
  recordComposeTiming(cpuMs, gpuMs);
}
