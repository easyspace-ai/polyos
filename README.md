# polyzeng


## 常用命令

| 命令 | 说明 |
|------|------|
| `bun install` | 安装依赖 |
| `bun run electron:dev` | 开发：主进程 / preload esbuild + Vite + Electron |
| `bun run electron:build` | 生产构建（main、preload、渲染、resources） |
| `bun run electron:start` | 先 build 再以桌面应用启动 |
| `bun run electron:dist` | 构建并调用 `electron-builder`（当前目录在 `apps/electron`） |
| `bun run typecheck` | TypeScript 检查（`apps/electron`） |

## 目录

- `apps/electron` — 唯一应用：`src/main`（主进程）、`src/preload`（预加载）、`src/renderer`（React 界面）、`electron-builder.yml`（打包）
- `scripts` — 根目录构建与开发脚本

预加载通过 `contextBridge` 暴露 `window.shell`（示例含 `ping`）。主进程在 `app:ping` 上响应。可按需扩展 IPC 与 UI。
 