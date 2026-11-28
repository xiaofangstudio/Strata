import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Splash from "./ui/Splash";
import { installContextMenuGuard } from "./ui/contextMenuGuard";
import "./styles/tokens.css";
import "./styles/themes.css";
import "./styles/global.css";
import "./styles/personal.css";
import "./styles/platform.css";
import "./styles/motion.css";

// 最先装守卫：从启动页开始，整个应用都不允许出现网页原生右键菜单。
// 需要右键的地方仍由 React 自己的自定义菜单接管。
installContextMenuGuard(window, document);

const container = document.getElementById("root");
if (!container) {
  throw new Error("找不到挂载节点 #root");
}

/**
 * 启动包装：启动页（Splash）是最先出现的正常启动画面，
 * 加载完成后淡出进入欢迎页（StartPage，在 App 内，保持原样）。
 * App 在启动页底下同步挂载初始化，加载进度对应的都是真实动作。
 */
function Boot() {
  const [splash, setSplash] = useState(true);
  return (
    <>
      <App />
      {splash && <Splash onDone={() => setSplash(false)} />}
    </>
  );
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <Boot />
  </React.StrictMode>,
);
