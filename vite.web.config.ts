import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/* ============================================================================
   Nexus OS 26 · Strata 网页内嵌版构建配置
   ----------------------------------------------------------------------------
   为什么不能直接用 vite.config.ts 的产物：
     桌面版产物是 ES module（<script type="module" crossorigin src=...>）+ 外部 CSS。
     在 file:// 协议下，浏览器把页面 origin 当成 null，
     于是「module 脚本」和「带 crossorigin 的 CSS」都会被 CORS 拦掉 →
     整个应用白屏（控制台一片 ERR_FAILED）。这不是应用坏了，是加载方式不被允许。

   所以这里改成：**单文件 + 经典脚本**
     · 所有 JS 内联成 <script>（不带 type=module，file:// 下可执行）
     · 所有 CSS 内联成 <style>
     · 图片等资源 base64 内联（assetsInlineLimit 拉满）
     · 产物只有一个 index.html，双击可开，放进 iframe 也能开

   用法：node node_modules/vite/bin/vite.js build --config vite.web.config.ts
   ========================================================================== */

function n26SingleFile(): Plugin {
  return {
    name: "n26-single-file",
    enforce: "post",
    generateBundle(_options, bundle) {
      const html = bundle["index.html"];
      if (!html || html.type !== "asset") return;

      let css = "";
      let js = "";
      for (const [file, item] of Object.entries(bundle)) {
        if (item.type === "asset" && file.endsWith(".css")) {
          css += String(item.source);
        } else if (item.type === "chunk" && item.isEntry) {
          js = item.code;
        }
      }

      let s = String(html.source);
      // 去掉所有外部脚本 / 样式 / 预加载标签（内容待会儿内联）
      s = s.replace(/<script\b[^>]*><\/script>/gi, "");
      s = s.replace(/<link\b[^>]*rel="(stylesheet|modulepreload|preload)"[^>]*>/gi, "");

      // 内联 JS：先转义 </script，避免提前闭合
      const safeJs = js.replace(/<\/script/gi, "<\\/script");
      /* ★ 必须用「函数」做替换串，不能直接传字符串：
         String.replace 会把替换串里的 $&、$'、$`、$1 当成占位符解释，
         而压缩后的 JS 里几乎必然出现 `$` 序列 —— 直接传字符会把代码替换坏，
         表现为加载时报 "Unexpected token '<'"、整个应用白屏。 */
      s = s.replace("</head>", () => `<style>${css}</style>\n</head>`);
      s = s.replace("</body>", () => `<script>${safeJs}</script>\n</body>`);

      html.source = s;

      // 其余产物全部丢弃，只留 index.html
      for (const file of Object.keys(bundle)) {
        if (file !== "index.html") delete bundle[file];
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), n26SingleFile()],
  base: "./",
  envPrefix: ["VITE_"],
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
    // 单文件必须关掉代码分割
    cssCodeSplit: false,
    assetsInlineLimit: 100 * 1024 * 1024,
    chunkSizeWarningLimit: 100000,
    outDir: process.env.N26_OUT || "dist-web",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: "iife",
        inlineDynamicImports: true,
        // 单文件模式下不需要分包（manualChunks 和 inlineDynamicImports 互斥）
        entryFileNames: "app.js",
        assetFileNames: "app.[ext]",
      },
    },
  },
});
