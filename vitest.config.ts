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
    /**
     * 用 vmThreads 而不是默认的 threads 池：threads 池在 worker 线程里
     * 初始化运行时上下文会失败（describe 一进来就报
     * "Cannot read properties of undefined (reading 'config')"，
     * 连零导入的探针测试都跑不起来；list 模式与 forks/vmThreads 都正常）。
     * 对这里的纯逻辑测试而言三种池没有可感知的差别，选能跑的。
     */
    pool: "vmThreads",
  },
});
