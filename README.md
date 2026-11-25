# DSH·古法编程

## 引言

为了在 AI 编程的高度发展的今天，保护古法编程这一非物质文化遗产，DSH·古法编程被开发出来，让你可以在 DeepSeek Harness 中继续体验大脑的思考能力。

## 功能

- **编辑页面与预览完全一致**：进入修改不会换成另一个编辑器，看到的仍是同一份预览，字体、行高、行号、语法高亮与换行方式都不变，只多一个保存图标，滚动位置也不跳。
- **一个按键切换**：工具栏的「古」字按键进入修改，翻成倒写的「古」退出，Esc 也行。
- **原生查看打底**：文件始终交给 dsh 内置查看器，插件不注册 tab 类型，Markdown、图片、PDF 与代码预览都保持原样。
- **不带走自己的编辑器**：直接编辑预览正文的克隆，没有另起的编辑器面板；路径、查看器切换、换行与刷新仍由内置预览提供，保存后自动重读。
- **显式保存**：保存图标与 Ctrl+S 等效；内容没变时直接退出、不写盘，与常见 GUI 编辑器一致。
- **不静默覆盖**：保存前发现文件已被其他程序改过，会先问「是、否、放弃修改」，不会悄悄盖掉对方的修改。
- **切走也不丢修改**：切到别的标签页时，没改直接退出；改过就问「保存、放弃、保留」。

## 图标

| 图标 | 出现时机 | 作用 |
| :---: | --- | --- |
| ![「古」字按键](assets/icon-edit.webp) | 未编辑 | 进入修改模式 |
| ![倒写的「古」](assets/icon-cancel.webp) | 修改中 | 取消修改 |
| ![软盘](assets/icon-save.webp) | 修改中 | 保存并退出，Ctrl+S 等效 |

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

- 是**标准形态的 dsh 客户端插件**，声明 `dsh.client`，导出 `./client`。
- 同时声明 `dsh.bundle`，因此也是**自挂载的 bundle 层插件**：从 GitHub 安装后自动识别为 profile layer 并挂载，无需手工写组合 entry。
- 读取复用内置 `remote.workspaceFiles`；写入由 Host 经 `mountRpcChannel` 自注册 `/classic-coding/writeFile`，因为内置服务不提供修改操作。
- **UI 挂载点**：只注册 `sidebar.right.tab.document.action`，按渲染器 id 为内置的 `code`、`text` 提供修改与保存按键。
- **修改模式**：把正文克隆到预览之外的固定定位可滚动区并设为 `contenteditable`，原正文只隐藏不删除，官方预览重渲染冲不掉编辑状态。
- 构建型插件：`src/` 是 TypeScript 源码，`lib/` 是构建产物且不入库，安装或发布前由 `prepare` 构建。

## 开发

```powershell
pnpm install
pnpm typecheck   # 严格类型检查
pnpm build       # 产出 lib/index.js 与 lib/client.js
pnpm test        # 产物冒烟与编辑回归
```

## License

[MIT](./LICENSE)

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
