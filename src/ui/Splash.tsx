/*
 * Strata 启动页 —— 应用正常启动的第一屏。
 * 注意：这不是欢迎页（StartPage），欢迎页在加载完成后出现，保持原样未动。
 * 大厂式布局：背景图 + 左侧黑色渐晕保白字可读 + 超粗应用名 + 应用信息 + 加载进度。
 */
import { useEffect, useRef, useState } from "react";
import bg from "../assets/splash-bg.jpg";
import "./Splash.css";

const STEPS = [
  "正在准备样式令牌",
  "正在加载字体",
  "正在准备调整图层引擎",
  "正在打开工作台",
];

export default function Splash({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [fading, setFading] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      const fontsReady = document.fonts?.ready ?? Promise.resolve();
      for (let i = 0; i < STEPS.length; i++) {
        if (!alive.current) return;
        await wait(340);
        if (!alive.current) return;
        setStep(i + 1);
      }
      await fontsReady;
      if (!alive.current) return;
      await wait(180);
      setFading(true);
      setTimeout(() => alive.current && onDone(), 520);
    })();
    return () => { alive.current = false; };
  }, [onDone]);

  const pct = Math.round((step / STEPS.length) * 100);

  return (
    <div className={"splash" + (fading ? " splash--fading" : "")} style={{ backgroundImage: `url(${bg})` }}>
      <div className="splash__inner">
        <div className="splash__name">Strata</div>
        <div className="splash__meta">小方工作室 · Fangwork 生态 · 修图与绘画一体的轻量图像应用</div>
        <div className="splash__loading">{STEPS[Math.min(step, STEPS.length - 1)]}…</div>
        <div className="splash__bar"><i style={{ width: `${pct}%` }} /></div>
      </div>
    </div>
  );
}
