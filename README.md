# dsh·古法编程插件

## 引言

为了在 AI 编程的高度发展的今天，保护古法编程这一非物质文化遗产，dsh·古法编程插件被开发出来，让你可以在 DeepSeek Harness 中继续体验大脑的思考能力。

## 功能

- **原生查看打底**：文件默认完全交给 dsh 内置查看器，插件不参与自动认领，Markdown、图片、PDF 与代码预览都保持原样。
- **按需进入编辑**：内置文档预览头部出现铅笔图标，点击把当前文件切换为 Monaco 编辑模式；编辑模式工具栏里的「查看」按钮切回内置预览。
- **复用内置文件树与 tab**：不再自建文件树与覆盖层面板，编辑 tab 与内置 tab 一起分栏、浮出、跨会话切换保活。
- **编辑器**：Monaco 经 CDN 动态加载，按扩展名自动选语言，随 DSH 明暗主题实时切换。
- **保存**：Ctrl+S 或工具栏「保存」按钮写回原文件。写入走插件自己的保存端点，不经过 agent 沙箱与权限链。

## 演示视频

| 古法编程插件演示 · 42 秒 |
| :---: |
| [![古法编程插件演示](https://i2.hdslb.com/bfs/archive/0d8bde731b526538d69ec983883a4bf755d6cf81.jpg)](https://www.bilibili.com/video/BV1d28i6rEEz/) |

> 视频录制于旧版覆盖层面板时期，交互入口已改为 dsh 内置右侧栏 tab。

## 安装

**从 GitHub 安装**：源码在 `src/`，`lib/` 不入仓库，安装时 npm 会触发 `prepare` 脚本现场构建。

```powershell
dsh plugin --profile web add github:better-er/dsh-classic-coding
```

**从 npm 安装**：包内已含构建产物 `lib/index.js` 与 `lib/client.js`，安装时不再构建。

```powershell
dsh plugin --profile web add dsh-classic-coding
```

两种方式装完都会自动挂载，重启 DSH web 后启用，无需手工编辑任何文件。

## 卸载

```powershell
dsh plugin --profile web remove dsh-classic-coding
```

彻底移除，重启 DSH web 后不再加载。

## 要求与开发

- **标准形态**：dsh 客户端插件，声明 `dsh.client`、导出 `./client`。
- **自挂载 bundle**：同时声明 `dsh.bundle`，用 `dsh plugin --profile web add` 从 GitHub 安装后自动识别为 profile layer 并挂载，无需手工写组合 entry。
- **读取复用内置**：文件内容与目录列举交给 `@deepseek-ai/dsh-api-workspace-files`，正文经地址 `dsh-resource://file/session/<会话>/<路径>` 调 `remote.workspaceFiles.readBytes` 读取，文件树用内置 `files` 类型，插件不再自建 describe / listDir / readFile。
- **写入自带端点**：内置服务不提供修改操作，故 Host 端经 `mountRpcChannel` 向 `webServer` 自注册 `/classic-coding` 前缀路由，只保留 `writeFile` 一个端点，复用 `connection.requestRejection` 做 Host 校验与浏览器鉴权，并实现官方 `client-request` / `server-response` 信封。保存刻意走 Node 原生 `fs.writeFile`，不经 `ctx.fs` 的 agent 沙箱。
- **构建产物**：源码在 `src/`，用 tsdown 构建出 `lib/index.js`、`lib/index.d.ts` 与 `lib/client.js`。`lib/` 不入库，从 GitHub 安装时由 `prepare` 自动构建；本地开发跑 `pnpm install` 后 `pnpm build`，类型检查用 `pnpm typecheck`，产物冒烟用 `pnpm smoke`。`package.json` 声明 `dsh.client.platform: "web"`、`exports["./client"] → ./lib/client.js`。
- **UI 挂载点**：`ctx.sidebarRightTabs.register` 注册 tab 类型 `code`，不写 `patterns`，因此不参与自动认领，只能由 `sidebarRight.openResource(address, { kind: 'code' })` 点名打开；`sidebar.right.tab.document.actions` 提供内置预览头部的「编辑」图标，`sidebar.right.pane.tab` 按类型 id 注册正文。不再占用 `sidebar.footer.action` 与 `shell.overlay`。
- **样式**：DSH 主题 CSS 变量 `--dsw-alias-*`，明暗主题自适应，`data-ds-dark-theme` 属性变化时实时跟随切换 Monaco 主题。
- **编辑器加载**：Monaco Editor 经 CDN 动态加载，React 组件从 loader 的 module table 获取，不引入任何额外 npm 依赖。

## License

[MIT](./LICENSE)
