# dsh·古法编程插件

为了在 AI 编程的高度发展的今天，保护古法编程这一非物质文化遗产，dsh·古法编程插件被开发出来，让你可以在 DeepSeek Harness 中继续体验大脑的思考能力。

## 功能

在 DSH 对话界面右侧滑出一个 Monaco 编辑器 + 文件树面板，直接在对话里改本地工作区代码，不用切到外部编辑器。

- 侧栏底部「⌨️ 古法编程」按钮，点击展开/收起编辑器面板。
- 文件树左侧 250px，懒加载目录、支持折叠/展开，过滤 `.git` / `node_modules` 等。
- Monaco 编辑器（CDN 动态加载），多文件 Tab、语法高亮、`Ctrl+S` 保存。
- 底部状态栏显示当前文件路径和保存结果。
- 点击遮罩 / 按 `Esc` / 点 × 关闭面板，随 DSH 明/暗主题自动适配。
- 侧栏收起成窄 rail 时自动切换为单图标按钮，展开时恢复完整两行结构。
- 消息流里的文件按钮（工具行路径、产物区文件）后跟一个「古法编程」尾巴：点击尾巴即可在插件内打开该文件，点击按钮本身保持原有外部打开行为。

## 截图

### 侧边栏开关

![侧边栏触发按钮](docs/screenshots/侧边栏开关.png)

侧栏底部的「⌨️ 古法编程」按钮，点击展开/收起编辑器面板。

### 消息流文件按钮的古法编程后缀

![消息流文件按钮后缀](docs/screenshots/古法编程后缀.png)

消息流中工具行路径与产物区文件按钮后追加的「古法编程」尾巴：点击尾巴在插件内打开，点击按钮本身保持外部打开。

### 编辑器面板

![编辑器面板](docs/screenshots/编辑区大图.png)

右侧滑入的完整编辑面板：左侧文件树、顶部多文件 Tab、中部 Monaco 编辑器、底部状态栏。

## 演示视频

| 古法编程插件演示（42 秒） |
| :---: |
| [![古法编程插件演示](https://i2.hdslb.com/bfs/archive/0d8bde731b526538d69ec983883a4bf755d6cf81.jpg)](https://www.bilibili.com/video/BV1d28i6rEEz/) |

## 要求

- 是**标准形态的 dsh 客户端插件**（声明 `dsh.client`、导出 `./client`）。
- 同时声明了 `dsh.bundle`，因此也是一个**自挂载的 bundle 层插件**：用 `dsh plugin --profile <name> add` 从 GitHub 安装后，会被自动识别为 profile layer 并挂载，无需手工写组合 entry。
- Host 端通过 `ctx.connection.rpc.handle('/classic-coding', ...)` 注册**独立 RPC 通道**（`/api` 共享通道的唯一拦截器槽位已被官方 gateway 占用，插件端点必须走 handle 独立通道），提供 `describe` / `listDir` / `readFile` / `writeFile` 四个端点，底层走 DSH 内置的 `ctx.fs` 文件系统服务。

## 安装

```powershell
dsh plugin --profile web add github:better-er/dsh-classic-coding
```

一条命令装完即生效（自动挂载，重启 DSH web 后启用），无需手工编辑任何组合文件。

## 卸载

```powershell
dsh plugin --profile web remove dsh-classic-coding
```

彻底移除，重启 DSH web 后不再加载。

## 构建与原理

DSH 客户端 + 主机双半身插件：Host 端注册文件系统 RPC，Client 端提供编辑器 UI。

- **无构建**：`lib/client.js`（`dsh.client.platform: "web"`、`exports["./client"] → ./lib/client.js`）与 `lib/index.js` 均为源码即产物。
- **UI 挂载点**：`sidebar.footer.action`（触发按钮）+ `shell.overlay`（编辑器面板）两个插槽注入。
- **样式**：DSH 主题 CSS 变量（`--dsw-alias-*`），明暗主题自适应；`data-ds-dark-theme` 属性变化时实时跟随切换 Monaco 主题。
- **编辑器**：Monaco Editor 经 CDN 动态加载，React 组件从 loader 的 module table 获取，不引入任何额外 npm 依赖。
- **硬性约束**：`lib/client.js` 的 `factory` 必须以 `return module.exports` 结尾，否则模块导出为 `undefined`，DSH 启动即 fail-loud。

## License

[MIT](./LICENSE)
