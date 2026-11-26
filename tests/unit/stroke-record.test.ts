import { describe, expect, it } from "vitest";
import {
  compressStrokeEvents,
  groupStrokes,
  newRecording,
  normalizeRecording,
  pushStrokeEvent,
  recordingDuration,
  scaleTimeline,
  serializeRecording,
  type StrokeEvent,
} from "../../src/core/strokeRecord";

const ev = (over: Partial<StrokeEvent> = {}): StrokeEvent => ({
  strokeId: 1,
  kind: "move",
  t: 10,
  x: 10,
  y: 10,
  pressure: 0.5,
  tool: "brush",
  color: "#000000",
  size: 20,
  flow: 100,
  shift: false,
  alt: false,
  ctrl: false,
  ...over,
});

describe("绘制过程记录与回放", () => {
  it("录制只收合法坐标，时间戳缺失按 0 兜底", () => {
    const rec = newRecording(800, 600);
    expect(pushStrokeEvent(rec, ev({ x: Number.NaN }))).toBe(false);
    expect(pushStrokeEvent(rec, ev({ t: Number.NaN }))).toBe(true);
    expect(rec.events[0].t).toBe(0);
    expect(rec.events[0].x).toBe(10);
    expect(recordingDuration(rec)).toBe(0);
  });

  it("压缩丢掉几乎不动的中间点，永远保留落笔与抬笔", () => {
    const events = [
      ev({ strokeId: 1, kind: "down", t: 0, x: 0, y: 0 }),
      ev({ t: 1, x: 0.1, y: 0 }),
      ev({ t: 2, x: 0.2, y: 0 }),
      ev({ t: 50, x: 40, y: 0 }),
      ev({ strokeId: 1, kind: "up", t: 60, x: 40, y: 0 }),
    ];
    const out = compressStrokeEvents(events);
    expect(out.map((e) => e.kind)).toEqual(["down", "move", "up"]);
    expect(out[1].x).toBe(40);
  });

  it("时间轴缩放按倍率压缩，speed 非法时保持原样", () => {
    const events = [ev({ t: 0 }), ev({ t: 100 })];
    expect(scaleTimeline(events, 2)[1].t).toBe(50);
    expect(scaleTimeline(events, 0)[1].t).toBe(100);
    expect(scaleTimeline(events, Number.NaN)[1].t).toBe(100);
  });

  it("乱序事件按时间排序并按笔分组", () => {
    const events = [
      ev({ strokeId: 2, kind: "down", t: 100 }),
      ev({ strokeId: 1, kind: "down", t: 0 }),
      ev({ strokeId: 1, kind: "up", t: 20 }),
      ev({ strokeId: 2, kind: "up", t: 140 }),
    ];
    const out = compressStrokeEvents(events);
    expect(out[0].t).toBe(0);
    expect(groupStrokes(out).map((g) => g[0].strokeId)).toEqual([1, 2]);
  });

  it("存档带版本，坏事件按条丢弃，JSON 可往返", () => {
    const rec = newRecording(800, 600);
    pushStrokeEvent(rec, ev({ kind: "down", t: 0 }));
    pushStrokeEvent(rec, ev({ t: 20 }));
    const round = normalizeRecording(JSON.parse(serializeRecording(rec)));
    expect(round?.events).toHaveLength(2);
    expect(round?.docW).toBe(800);
    expect(normalizeRecording({ version: 99, events: [] })).toBeNull();
    const dirty = normalizeRecording({
      version: 1,
      docW: 10,
      docH: 10,
      fps: 24,
      events: [ev({ t: Number.NaN }), { kind: "???", t: 1 }],
    });
    expect(dirty?.events).toHaveLength(1);
    expect(dirty?.events[0].t).toBe(0);
  });
});
