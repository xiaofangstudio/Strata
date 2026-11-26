/**
 * 绘制过程录制 / 回放小窗。
 * 录制只收真实笔画事件；回放画在独立临时画布上，不碰文档，
 * 只有用户明确点「烙到新图层」才写回文档。
 */
import { zh } from "../../i18n";
import { recordingDuration, type StrokeRecording } from "../../core/strokeRecord";
import "./StrokePlaybackPanel.css";

interface Props {
  recording: StrokeRecording | null;
  recordingActive: boolean;
  playing: boolean;
  progress: number;
  speed: number;
  onStart: () => void;
  onStop: () => void;
  onPlayPause: () => void;
  onSpeed: (speed: number) => void;
  onSeek: (fraction: number) => void;
  onBake: () => void;
  onClose: () => void;
}

export default function StrokePlaybackPanel({
  recording,
  recordingActive,
  playing,
  progress,
  speed,
  onStart,
  onStop,
  onPlayPause,
  onSpeed,
  onSeek,
  onBake,
  onClose,
}: Props) {
  const duration = recording ? recordingDuration(recording) : 0;
  const seconds = (duration * progress) / 1000;
  return (
    <div className="pbw" role="dialog" aria-label={zh.playback.title}>
      <div className="pbw-head">
        <strong>{zh.playback.title}</strong>
        <button type="button" className="pbw-close" onClick={onClose} aria-label={zh.playback.close}>
          ×
        </button>
      </div>
      <p className="pbw-hint">{zh.playback.hint}</p>
      <div className="pbw-row">
        {recordingActive ? (
          <button type="button" className="pbw-btn is-rec" onClick={onStop}>
            ■ {zh.playback.stop}
          </button>
        ) : (
          <button type="button" className="pbw-btn" onClick={onStart}>
            ● {zh.playback.start}
          </button>
        )}
        <button
          type="button"
          className="pbw-btn"
          disabled={!recording}
          onClick={onPlayPause}
        >
          {playing ? `❚❚ ${zh.playback.pause}` : `▶ ${zh.playback.play}`}
        </button>
        <button
          type="button"
          className="pbw-btn"
          disabled={!recording}
          onClick={onBake}
        >
          {zh.playback.bake}
        </button>
      </div>
      <div className="pbw-row">
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(progress * 1000)}
          disabled={!recording}
          onChange={(e) => onSeek(Number(e.target.value) / 1000)}
        />
        <span className="pbw-time">
          {seconds.toFixed(2)}s / {(duration / 1000).toFixed(2)}s
        </span>
      </div>
      <div className="pbw-row">
        <span>{zh.playback.speed}</span>
        {[0.5, 1, 2, 4].map((v) => (
          <button
            key={v}
            type="button"
            className={`pbw-speed${speed === v ? " is-on" : ""}`}
            onClick={() => onSpeed(v)}
          >
            {v}×
          </button>
        ))}
      </div>
      <p className="pbw-status">
        {recording
          ? `${recording.events.length} ${zh.playback.events}`
          : zh.playback.empty}
      </p>
    </div>
  );
}
