# Electron 壳

- **主进程** `src/main/index.ts`：创建窗口、开发态加载 `VITE_DEV_SERVER_URL`、生产态加载 `dist/renderer/index.html`。
- **预加载** `src/preload/preload.ts`：`window.shell` 示例 API。
- **渲染** `src/renderer/*`：Vite + React。

打包配置见根目录上一级的 `electron-builder.yml`（本包内为 `apps/electron/electron-builder.yml`）。
