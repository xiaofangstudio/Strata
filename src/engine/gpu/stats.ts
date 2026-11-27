/**
 * GPU / CPU 合成耗时打点。
 *
 * 这不是装饰性的日志：主合成路径会用这里的配对样本做 A/B 判定。
 * 只有 GPU 端到端耗时（含像素上传与读回）稳定快于 CPU 时才继续启用，
 * 否则自动退回 Canvas2D —— 「接上了但更慢」不算真加速。
 */

export interface GpuTimingSample {
  cpuMs: number;
  gpuMs: number;
}

const WINDOW = 12;
const samples: GpuTimingSample[] = [];

/** 记录一对 CPU / GPU 端到端耗时；参数非法时直接丢弃。 */
export function recordComposeTiming(cpuMs: number, gpuMs: number): void {
  if (!Number.isFinite(cpuMs) || !Number.isFinite(gpuMs) || cpuMs <= 0 || gpuMs <= 0) return;
  samples.push({ cpuMs, gpuMs });
  if (samples.length > WINDOW) samples.shift();
}

export interface GpuTimingStats {
  samples: number;
  cpuAvgMs: number;
  gpuAvgMs: number;
  ratio: number;
  /** 样本不足时返回 true；样本充足且 GPU 明显更慢时返回 false。 */
  enabled: boolean;
}

/** 当前统计快照。 */
export function getComposeTiming(): GpuTimingStats {
  if (!samples.length) {
    return { samples: 0, cpuAvgMs: 0, gpuAvgMs: 0, ratio: 1, enabled: true };
  }
  let cpu = 0;
  let gpu = 0;
  for (const s of samples) {
    cpu += s.cpuMs;
    gpu += s.gpuMs;
  }
  cpu /= samples.length;
  gpu /= samples.length;
  const ratio = cpu > 0 ? gpu / cpu : 1;
  return {
    samples: samples.length,
    cpuAvgMs: cpu,
    gpuAvgMs: gpu,
    ratio,
    enabled: samples.length < 6 || ratio < 1.25,
  };
}

/** 仅供诊断 / 测试：清空样本。 */
export function resetComposeTiming(): void {
  samples.length = 0;
}
