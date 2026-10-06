import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 在开发模式下会注入该变量，用于移动端 / 局域网真机调试
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // Tauri 需要固定端口，且不允许 Vite 清屏吞掉 Rust 侧日志
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Rust 侧由 cargo 自己监视，避免前端 dev server 重复扫描
      ignored: ["**/src-tauri/**"],
    },
  },

  // 供前端读取的 Tauri 环境变量前缀
  envPrefix: ["VITE_", "TAURI_ENV_"],

  build: {
    // 目标为系统 WebView2（Windows 优先），可用较新的语法
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
    chunkSizeWarningLimit: 1024,
  },
});
