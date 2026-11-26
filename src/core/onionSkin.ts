/**
 * 洋葱皮（动画帧幽灵预览）的纯函数。
 *
 * 洋葱皮是**视图状态**：只算出「该显示哪几帧、染什么色、多透明」，
 * 实际绘制由浮层做，绝不改帧内容，也不进撤销历史 / 导出结果。
 */

export interface OnionSettings {
  enabled: boolean;
  /** 往前显示几帧 */
  prev: number;
  /** 往后显示几帧 */
  next: number;
  /** 基础不透明度 0–100 */
  opacity: number;
  /** 前帧染色（默认红） */
  colorPrev: string;
  /** 后帧染色（默认蓝） */
  colorNext: string;
  /** 只显示标记为关键帧的帧 */
  keyframesOnly: boolean;
}

export const DEFAULT_ONION: OnionSettings = {
  enabled: false,
  prev: 1,
  next: 1,
  opacity: 35,
  colorPrev: "#ff5b5b",
  colorNext: "#5b9bff",
  keyframesOnly: false,
};

export interface OnionGhost {
  index: number;
  /** 与当前帧的距离，1 表示紧邻 */
  delta: number;
  kind: "prev" | "next";
  alpha: number;
  tint: string;
}

const clampInt = (v: number, min: number, max: number): number => {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
};

/** 时间轴环绕：负极取尾帧，超长回到开头。 */
export function wrapFrameIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  const i = Number.isFinite(index) ? Math.trunc(index) : 0;
  return ((i % total) + total) % total;
}

/** 按每帧停留时长换算该帧起始时间（秒）。 */
export function frameSeconds(index: number, holds: readonly number[]): number {
  if (holds.length === 0) return 0;
  let t = 0;
  for (let i = 0; i < Math.min(wrapFrameIndex(index, holds.length), holds.length); i += 1) {
    t += Math.max(0, holds[i] || 0);
  }
  return t;
}

/** 秒 → 帧下标（时间轴按秒拖动时用），超出总时长取最后一帧。 */
export function frameAtSeconds(seconds: number, holds: readonly number[]): number {
  if (holds.length === 0) return 0;
  let t = 0;
  for (let i = 0; i < holds.length; i += 1) {
    const hold = Math.max(0, holds[i] || 0);
    if (seconds < t + hold) return i;
    t += hold;
  }
  return holds.length - 1;
}

/** 缩略图缓存键：帧内容改了要换 key，别拿旧缩略图冒充。 */
export function thumbnailKey(layerId: string, index: number, revision = 0): string {
  return `strata.frame.${layerId}.${index}.${Math.max(0, Math.round(revision))}`;
}

/**
 * 该显示哪些幽灵帧。边界**不环绕**：第 0 帧前面没有帧，就不画前帧幽灵，
 * 免得动画首尾在两个不相干的画面间假衔接。
 */
export function onionGhosts(
  total: number,
  current: number,
  settings: OnionSettings,
  isKeyframe: (index: number) => boolean = () => true,
): OnionGhost[] {
  if (!settings.enabled || total <= 0) return [];
  const cur = wrapFrameIndex(current, total);
  const base = clampInt(settings.opacity, 0, 100) / 100;
  if (base <= 0) return [];
  const out: OnionGhost[] = [];
  const push = (index: number, delta: number, kind: "prev" | "next") => {
    if (settings.keyframesOnly && !isKeyframe(index)) return;
    // 每远一帧淡 25%，最低留一点点，保证多帧时仍能看清
    const alpha = Math.max(0.06, base * Math.max(0.15, 1 - (delta - 1) * 0.25));
    out.push({
      index,
      delta,
      kind,
      alpha,
      tint: kind === "prev" ? settings.colorPrev : settings.colorNext,
    });
  };
  for (let d = 1; d <= clampInt(settings.prev, 0, 8); d += 1) {
    const i = cur - d;
    if (i >= 0) push(i, d, "prev");
  }
  for (let d = 1; d <= clampInt(settings.next, 0, 8); d += 1) {
    const i = cur + d;
    if (i < total) push(i, d, "next");
  }
  // 远的先画、近的后画，近处幽灵压在上面
  return out.sort((a, b) => b.delta - a.delta);
}
