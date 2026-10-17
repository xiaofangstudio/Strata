import { defineConfig } from "vitest/config";

/**
 * Strata 前端单元测试配置。
 *
 * 刻意与 `vite.config.ts` 分离：主配置带着 React 插件与 Tauri 专用端口，
 * 而单元测试只针对不依赖 DOM / Canvas 的纯逻辑模块，用 node 环境即可 ——
 * 不为测试引入 jsdom，也就不会把浏览器 API 悄悄塞进被测代码的假设里。
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: true,
  },
});
