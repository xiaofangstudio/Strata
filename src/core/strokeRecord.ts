/**
 * 绘制过程记录（真实笔画事件）与回放数据模型。
 *
 * 只记文档坐标、压感、颜色、尺寸、流量与修饰键，不记屏幕坐标；
 * 回放时把这些事件重新喂给同一支 Stroke，形状与落笔同源，不用近似折线冒充。
 * 存档是可读 JSON，带版本号，以后换格式还能认出来。
 */

export type StrokeTool = "brush" | "pencil" | "eraser" | "smudge";

export interface StrokeEvent {
  /** 同一笔的 id；换笔时递增 */
  strokeId: number;
  kind: "down" | "move" | "up";
  /** 相对录制开始的毫秒 */
  t: number;
  /** 文档坐标 */
  x: number;
  y: number;
  pressure: number;
  tool: StrokeTool;
  color: string;
  size: number;
  flow: number;
  /** 笔尖效果所需的少量快照，保证回放和落笔同源 */
  hardness?: number;
  tipMask?: string | null;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

export interface StrokeRecording {
  version: 1;
  docW: number;
  docH: number;
  fps: number;
  events: StrokeEvent[];
}

export function newRecording(docW: number, docH: number, fps = 60): StrokeRecording {
  return { version: 1, docW, docH, fps, events: [] };
}

/** 录制中追加事件：就地写入，避免每帧复制整段历史；坐标无效的事件直接丢。 */
export function pushStrokeEvent(
  rec: StrokeRecording,
  ev: StrokeEvent,
): boolean {
  if (!Number.isFinite(ev.x) || !Number.isFinite(ev.y)) return false;
  rec.events.push({ ...ev, t: Number.isFinite(ev.t) ? Math.max(0, ev.t) : 0 });
  return true;
}

/** 时间轴缩放：speed=2 表示回放 timelines 压缩一半。 */
export function scaleTimeline(events: readonly StrokeEvent[], speed: number): StrokeEvent[] {
  const k = Number.isFinite(speed) && speed > 0 ? speed : 1;
  return events.map((e) => ({ ...e, t: e.t / k }));
}

/**
 * 事件压缩：丢掉同一笔里几乎没动、时间也贴得太近的中间点。
 * down / up 永远保留；位移大、压感变化大的点绝不能丢，否则形状会走样。
 */
export function compressStrokeEvents(
  events: readonly StrokeEvent[],
  minDistance = 0.35,
  minTime = 4,
): StrokeEvent[] {
  const ordered = [...events].sort((a, b) => a.t - b.t);
  const out: StrokeEvent[] = [];
  const lastByStroke = new Map<number, StrokeEvent>();
  for (const e of ordered) {
    if (e.kind !== "move") {
      out.push(e);
      lastByStroke.set(e.strokeId, e);
      continue;
    }
    const last = lastByStroke.get(e.strokeId);
    const redundant =
      last !== undefined &&
      last.kind !== "up" &&
      e.t - last.t <= minTime &&
      Math.hypot(e.x - last.x, e.y - last.y) <= minDistance &&
      Math.abs(e.pressure - last.pressure) < 0.01;
    if (redundant) continue;
    out.push(e);
    lastByStroke.set(e.strokeId, e);
  }
  return out;
}

/** 按笔分组（按 timestamp 排序后切分），回放一支笔一段。 */
export function groupStrokes(events: readonly StrokeEvent[]): StrokeEvent[][] {
  const groups: StrokeEvent[][] = [];
  let current: StrokeEvent[] | null = null;
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (!current || e.strokeId !== current[0].strokeId) {
      current = [];
      groups.push(current);
    }
    current.push(e);
  }
  return groups;
}

/** 录制总时长（毫秒）：没有事件时为 0。 */
export function recordingDuration(rec: StrokeRecording): number {
  if (rec.events.length === 0) return 0;
  return Math.max(...rec.events.map((e) => e.t));
}

/** 读入存档：版本不对返回 null；坏事件按条丢弃，不让整段录制报废。 */
export function normalizeRecording(raw: unknown): StrokeRecording | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<StrokeRecording>;
  if (r.version !== 1 || !Array.isArray(r.events)) return null;
  const events: StrokeEvent[] = [];
  for (const item of r.events) {
    if (!item || typeof item !== "object") continue;
    const e = item as Partial<StrokeEvent>;
    if (e.kind !== "down" && e.kind !== "move" && e.kind !== "up") continue;
    if (typeof e.strokeId !== "number" || !Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
    events.push({
      strokeId: Math.max(0, Math.round(e.strokeId)),
      kind: e.kind,
      t: Number.isFinite(e.t) ? Math.max(0, e.t as number) : 0,
      x: e.x as number,
      y: e.y as number,
      pressure: Number.isFinite(e.pressure) ? Math.max(0, Math.min(1, e.pressure as number)) : 0.5,
      tool: (e.tool ?? "brush") as StrokeTool,
      color: typeof e.color === "string" ? e.color : "#17171c",
      size: Number.isFinite(e.size) ? Math.max(1, e.size as number) : 32,
      flow: Number.isFinite(e.flow) ? Math.max(1, Math.min(100, e.flow as number)) : 100,
      hardness: Number.isFinite(e.hardness)
        ? Math.max(0, Math.min(100, e.hardness as number))
        : 80,
      tipMask: typeof e.tipMask === "string" ? e.tipMask : null,
      shift: e.shift === true,
      alt: e.alt === true,
      ctrl: e.ctrl === true,
    });
  }
  return {
    version: 1,
    docW: Number.isFinite(r.docW) ? Math.max(1, r.docW as number) : 1,
    docH: Number.isFinite(r.docH) ? Math.max(1, r.docH as number) : 1,
    fps: Number.isFinite(r.fps) ? Math.max(1, Math.min(120, r.fps as number)) : 60,
    events: events.sort((a, b) => a.t - b.t),
  };
}

export function serializeRecording(rec: StrokeRecording): string {
  return JSON.stringify(rec);
}
