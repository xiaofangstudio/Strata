/**
 * WebGPU 合成接线（六项差距全修 · 第 6 项）。
 *
 * 把 `src/engine/gpu/` 的独立 GPU 合成能力接到「拼合图像」这条一次性操作上：
 * 纯像素层文档走 WebGPU，其它文档（调整层 / 组 / 蒙版 / 样式 / 剪贴蒙版 /
 * GPU 还不支持的混合模式）一律回退现有 Canvas2D 合成，保证结果一致。
 *
 * 为什么不改实时渲染管线：composeDoc 是同步的、每帧都调；GPU 是异步的。
 * 强行改成异步会把整条预览链路（画笔、滤镜实时预览、校样）全部重写，
 * 风险远大于收益。先让最重、最不频繁、最能体现加速的「拼合」吃上 GPU，
 * 后续再按同一套 GpuLayerInput 扩到滤镜预览。
 */
import type { StrataDoc } from "../core/document";
import { createLayer } from "../core/layer";
import { flattenImage } from "../core/layerOps";
import { createSurface, mustCtx, readPixels } from "./surface";
import { gpuFlatten, type GpuLayerInput } from "./gpu/compose";
import { SUPPORTED_GPU_BLENDS } from "./gpu/blendIds";

/** 这份文档能不能安全交给 GPU 合成（结果必须与 CPU 逐像素一致）。 */
export function gpuCanFlatten(doc: StrataDoc): boolean {
  if (!doc.layers.length) return false;
  return doc.layers.every((l) => {
    if (l.kind !== "pixel") return false;
    if (l.mask || l.clip) return false;
    if ((l.styles?.length ?? 0) > 0) return false;
    if (l.blend !== "normal" && !SUPPORTED_GPU_BLENDS.includes(l.blend)) return false;
    return l.surface.width === doc.width && l.surface.height === doc.height;
  });
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
  if (gpuCanFlatten(doc)) {
    try {
      const inputs: GpuLayerInput[] = doc.layers.map((l) => ({
        pixels: readPixels(l.surface).data,
        opacity: Math.max(0, Math.min(1, l.opacity / 100)),
        blend: l.blend,
        visible: l.visible,
      }));
      const img = await gpuFlatten(inputs, doc.width, doc.height);
      if (img) {
        const surface = createSurface(doc.width, doc.height);
        mustCtx(surface).putImageData(img, 0, 0);
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
