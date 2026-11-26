/**
 * 笔画回放：把记录的事件重新喂给真实的 Stroke，而不是拿折线画个近似图。
 *
 * 回放只写调用方给的临时画布，不碰文档图层；调用方可以边播边画，
 * 也可以把这块画布烙到新图层。涂抹工具的取样依赖当时画布状态，
 * 无法在空白回放层上重现，录制端就不记它——不提供假回放。
 */
import { groupStrokes, type StrokeRecording } from "../core/strokeRecord";
import { DEFAULT_BRUSH, Stroke } from "./paint";
import { mustCtx } from "./surface";

export function renderRecording(
  canvas: HTMLCanvasElement,
  rec: StrokeRecording,
  untilMs: number,
): void {
  const ctx = mustCtx(canvas);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const group of groupStrokes(rec.events)) {
    const down = group.find((e) => e.kind === "down");
    if (!down || down.t > untilMs) continue;
    if (down.tool === "smudge") continue;
    const settings = {
      ...DEFAULT_BRUSH,
      size: down.size,
      color: down.color,
      flow: down.flow,
      hardness: down.hardness ?? DEFAULT_BRUSH.hardness,
      tipMask: down.tipMask ?? null,
      ...(down.tool === "pencil"
        ? { hardness: 100, flow: 100, spacing: 4, smoothing: 0, jitter: 0 }
        : {}),
    };
    const s = new Stroke(rec.docW, rec.docH, settings, down.tool === "eraser", null);
    s.begin(down.x, down.y, down.pressure, down.t);
    for (const e of group) {
      if (e.kind !== "move" || e.t > untilMs) continue;
      s.extend(e.x, e.y, e.pressure, e.t);
    }
    ctx.drawImage(s.buffer, 0, 0);
  }
}
