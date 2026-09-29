/**
 * 古法编程 - Client 端
 *
 * 向 dsh 内置右侧栏注册 tab 类型 code：文件默认仍由内置查看器展示，
 * 在内置文档预览头部点「编辑」图标才以 Monaco 打开。内容经内置 workspaceFiles 服务按会话读取，
 * 保存经 Host 自注册的 /classic-coding writeFile 端点，因为内置服务不提供修改操作。
 *
 * @module dsh-classic-coding/client
 */

import * as React from 'react'

// ─── 常量 ───────────────────────────────────────────────

/** 本插件在 tab 注册表里的类型身份，同时用作正文席位 key。 */
const TYPE_ID = 'dsh-classic-coding'

/** tab 类型的判别名。内置已有 guide、text、files、browser、subagentchat，code 不撞名。 */
const KIND = 'code'

/** 会话文件资源地址前缀，与 util/workspace-path 的语法一致。 */
const SESSION_FILE_PREFIX = 'dsh-resource://file/session/'

/** 代码扩展名到 Monaco 语言的映射，键同时也决定本类型认领哪些地址。 */
const LANG_MAP: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cs: 'csharp',
  html: 'html', css: 'css', scss: 'scss', less: 'less',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  xml: 'xml', sql: 'sql', sh: 'shell',
  ps1: 'powershell', bat: 'bat', cmd: 'bat', ini: 'ini', env: 'ini',
  vue: 'html', svelte: 'html',
}

/**
 * 按扩展名取 Monaco 语言。
 * @param path - 文件路径。
 */
function langByPath(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return 'plaintext'
  return LANG_MAP[path.slice(dot + 1).toLowerCase()] || 'plaintext'
}

/**
 * 取路径最后一段，兼容 Windows 与 POSIX 分隔符。
 * @param path - 绝对或相对路径。
 */
function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/**
 * 由会话 id 与绝对路径构造会话文件地址。
 *
 * 地址段逐段组件编码，盘符的冒号保留原样；Host 原样接收路径并自行解析，
 * 因此 Windows 的反斜杠先转成正斜杠，POSIX 的前导斜杠保留。
 * @param sessionId - 授权会话。
 * @param absolutePath - 文件在宿主执行环境中的绝对路径。
 */
function sessionFileAddress(sessionId: string, absolutePath: string): string {
  const prefix = SESSION_FILE_PREFIX + encodeURIComponent(sessionId) + '/'
  const segments = absolutePath.replace(/\\/g, '/').split('/').map(function (segment) {
    return encodeURIComponent(segment).replace(/%3A/gi, ':')
  })
  return prefix + segments.join('/')
}

/**
 * 从 dsh-resource 文件地址拆出会话 id 与相对路径。
 *
 * 只认领 session 地址：absolute 地址没有授权会话，内置读取会以 unknown-workspace 失败。
 * 地址各段做过组件编码，盘符的冒号保留原样，故逐段解码。
 * @param address - 资源地址。
 */
function parseFileAddress(address: string): { sessionId: string; path: string } | null {
  if (!address.startsWith(SESSION_FILE_PREFIX)) return null
  const rest = address.slice(SESSION_FILE_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const sessionId = decodeURIComponent(rest.slice(0, slash))
  const path = rest.slice(slash + 1).split('/').map(decodeURIComponent).join('/')
  if (!sessionId || !path) return null
  return { sessionId, path }
}

// ─── Host 服务面 ────────────────────────────────────────

/** 远端调用的统一结果：ok 分支携带业务值，error 分支携带失败帧。 */
type RemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message?: string } }

/** 内置 workspaceFiles 的重载读取：返回文件元数据与完整字节。 */
interface WorkspaceFilesFace {
  readBytes(
    sessionId: string,
    path: string,
    options: { range?: { offset?: number; length?: number }; baseFile?: string },
    signal?: AbortSignal,
  ): Promise<RemoteResult<{ absolutePath: string; version: string; bytes?: number; offset: number; data: Uint8Array; eof: boolean }>>
}

/** remote 命名空间最小面。 */
interface RemoteService {
  workspaceFiles: WorkspaceFilesFace
}

/** 右侧栏导航控制器最小面。 */
interface SidebarRightService {
  /** 打开一个 dsh-resource 地址；点名 kind 时跳过其 glob 但保留 canOpen。 */
  openResource(address: string, options?: { kind?: string; replaceTab?: string; revealIfOpened?: boolean }): void
  /** 活动 pane 的活动 tab；id 用于原地换掉它，contentId 即该 tab 的内容地址。 */
  active(): { id?: string; contentId?: string } | undefined
}

/** 右侧栏 tab 类型注册表最小面。 */
interface TabsService {
  register(definition: {
    id: string
    kind: string
    patterns?: string[]
    priority?: 'extension' | 'builtin' | 'fallback'
    canOpen?(address: string): boolean
    title(address: string): string
    keepMounted?: boolean
  }): () => void
}

/** 槽位服务最小面：keyed 席位按注册项 key 定址。 */
interface SlotsService {
  inject(name: string, callback: () => (() => void) | void): void
  register(
    options: { name: string; id?: string; key?: string; order?: number },
    component: (props: any) => React.ReactElement,
  ): () => void
}

/** 客户端插件上下文最小面。 */
interface ClientContext {
  get(service: string): unknown
  effect(callback: () => (() => void) | void): void
}

/** 框架注入正文组件的 tab 信息钩子，由 slot 声明里的 hooks.tabInfo 转换为 useTabInfo。 */
interface TabBodyProps {
  useTabInfo(): {
    tab: {
      /** 框架铸造的 tab 标识，用作原地替换的 replaceTab。 */
      id: string
      /** 打开时记录的地址，对资源 tab 即 contentId。 */
      navigation: { address: string }
      /** 仅在记录消失或插件卸载时中止。 */
      signal: AbortSignal
    }
  }
}

/** 当前 remote 服务，由 apply 赋值，正文组件经闭包外的它读取文件。 */
let remote: RemoteService | null = null

/** 当前右侧栏导航控制器，由 apply 赋值，供文档头部动作与编辑器切换视图。 */
let sidebarRight: SidebarRightService | null = null

// ─── RPC 调用 ──────────────────────────────────────────

let rpcIdCounter = 0

/**
 * 调用 Host 端 RPC 端点。
 * 格式：POST /classic-coding/<method>，独立 RPC 通道，
 * 遵循 DSH 四象限消息模型：body.method 必须等于 URL 中的端点名。
 * @param method - 端点名。
 * @param payload - 端点载荷。
 */
async function rpcCall<T>(method: string, payload: unknown): Promise<T> {
  const rpcId = 'cc-' + String(++rpcIdCounter)
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: rpcId,
    method: method,
    payload: payload,
  })
  const res = await fetch('/classic-coding/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body,
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const envelope = await res.json() as {
    result?: { ok?: boolean; value?: unknown; error?: { message?: string } }
  }
  if (envelope.result && envelope.result.ok) return envelope.result.value as T
  const errMsg = envelope.result && envelope.result.error
    ? envelope.result.error.message
    : 'RPC 调用失败'
  throw new Error(errMsg)
}

// ─── 样式注入 ──────────────────────────────────────────

/** 正文根节点撑满侧栏 tab 容器，工具栏固定、编辑器占余下空间。 */
const CSS = [
  '.dsh-cc-body{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-layer-1)}',
  '.dsh-cc-toolbar{display:flex;align-items:center;gap:8px;flex:none;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}',
  '.dsh-cc-filename{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}',
  '.dsh-cc-save{flex:none;padding:2px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;font-size:12px;line-height:16px}',
  '.dsh-cc-save:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-cc-save:disabled{opacity:.45;cursor:default}',
  '.dsh-cc-status{flex:none;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
  '.dsh-cc-editor{flex:1;min-height:0}',
  '.dsh-cc-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}',
  '.dsh-cc-edit-action{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
  '.dsh-cc-edit-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.dsh-cc-edit-action:disabled{opacity:.4;cursor:default}',
].join('\n')

/** 插件样式表元素，随插件生命周期存在。 */
let styleTag: HTMLStyleElement | null = null

/** 注入插件样式表，幂等。 */
function ensureStyle(): void {
  if (styleTag) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-classic-coding'
  tag.textContent = CSS
  document.head.appendChild(tag)
  styleTag = tag
}

/** 移除插件样式表。 */
function removeStyle(): void {
  if (styleTag && styleTag.parentNode) {
    styleTag.parentNode.removeChild(styleTag)
  }
  styleTag = null
}

// ─── Monaco Editor 加载 ────────────────────────────────

/** Monaco 加载 Promise，重复调用复用。 */
let monacoPromise: Promise<void> | null = null

/** DSH 暗色主题标记：ui-theme 在 body 上设置 data-ds-dark-theme。 */
function isDarkTheme(): boolean {
  return document.body.hasAttribute('data-ds-dark-theme')
}

/** 从 CDN 加载 Monaco，已就绪或加载中时直接复用。 */
function loadMonaco(): Promise<void> {
  if (window.monaco) return Promise.resolve()
  if (monacoPromise) return monacoPromise
  monacoPromise = new Promise<void>(function (resolve, reject) {
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.js'
    script.onload = function () {
      window.require.config({
        paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' },
      })
      window.require(['vs/editor/editor.main'], function () {
        resolve()
      })
    }
    script.onerror = function () {
      monacoPromise = null
      reject(new Error('Monaco Editor 加载失败'))
    }
    document.head.appendChild(script)
  })
  return monacoPromise
}

// ─── 编辑器正文 ────────────────────────────────────────

/** 内置文档预览头部动作的 owner 面：绝对路径必给，会话由 session scope 提供。 */
interface DocumentActionProps {
  absolutePath: string
  sessionId?: string
}

/**
 * 内置文档预览头部的「编辑」图标：把当前文件在右侧栏切换为古法编程编辑模式。
 *
 * 该席位的 owner 只交出绝对路径，会话由 scope 提供，故地址在此构造；
 * 没有会话时禁用，不猜当前会话。
 * @param props - 文档动作 owner 面。
 */
function EditAction(props: DocumentActionProps): React.ReactElement {
  function enter(): void {
    if (!sidebarRight) {
      console.error('[classic-coding] sidebarRight 服务不可用，无法进入编辑模式')
      return
    }
    // 活动 tab 的 contentId 就是当前预览的地址，最可靠；owner 只给绝对路径，故留构造作兜底。
    const active = sidebarRight.active()
    const activeAddress = active && active.contentId && active.contentId.startsWith(SESSION_FILE_PREFIX)
      ? active.contentId
      : null
    const address = activeAddress || (props.sessionId ? sessionFileAddress(props.sessionId, props.absolutePath) : null)
    if (!address) {
      console.error('[classic-coding] 无法确定当前文件地址', { active: active, sessionId: props.sessionId, absolutePath: props.absolutePath })
      return
    }
    try {
      // replaceTab 要的是活动 tab 的 id：新 tab 接替它的格与格位，并顺手关掉它。
      sidebarRight.openResource(address, {
        kind: KIND,
        replaceTab: active && active.id ? active.id : undefined,
      })
    } catch (e) {
      console.error('[classic-coding] 进入编辑模式失败', address, e)
    }
  }
  return React.createElement('button', {
    type: 'button',
    className: 'dsh-cc-edit-action',
    title: '用古法编程编辑',
    'aria-label': '用古法编程编辑',
    onClick: enter,
  },
    React.createElement('svg', {
      width: 14,
      height: 14,
      viewBox: '0 0 16 16',
      'aria-hidden': 'true',
      fill: 'currentColor',
    }, React.createElement('path', {
      d: 'M12.146 1.146a.5.5 0 0 1 .708 0l2 2a.5.5 0 0 1 0 .708l-9.5 9.5a.5.5 0 0 1-.233.131l-3 .75a.5.5 0 0 1-.606-.606l.75-3a.5.5 0 0 1 .131-.233l9.5-9.5Z',
    })),
  )
}

/**
 * 一个 code tab 的正文：读取文件、渲染 Monaco、保存回盘。
 *
 * 每个 tab 各挂载一份实例，keepMounted 让已访问正文跨隐藏保留。
 * 地址解析失败或缺少 remote 时只渲染错误提示，不抛错崩溃。
 * @param props - 框架注入的 tab 信息钩子。
 */
function CodeTabBody(props: TabBodyProps): React.ReactElement {
  const info = props.useTabInfo()
  const address = info.tab.navigation.address
  const signal = info.tab.signal
  const parsed = parseFileAddress(address)

  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const editorRef = React.useRef<MonacoEditorInstance | null>(null)
  const modelRef = React.useRef<MonacoTextModel | null>(null)
  const themeObserverRef = React.useRef<MutationObserver | null>(null)
  const saveRef = React.useRef<(() => void) | null>(null)

  const [content, setContent] = React.useState<string | null>(null)
  const [absolutePath, setAbsolutePath] = React.useState<string | null>(null)
  const [phase, setPhase] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = React.useState('')
  const [dirty, setDirty] = React.useState(false)

  // 读取内容：地址变化即重读。取消标记避免旧请求覆盖新 tab 的正文。
  React.useEffect(function () {
    if (!parsed || !remote) {
      setPhase('error')
      setMessage(parsed ? '缺少 remote 服务，无法读取工作区文件' : '无法识别的文件地址')
      return
    }
    let cancelled = false
    setPhase('loading')
    setMessage('')
    remote.workspaceFiles.readBytes(parsed.sessionId, parsed.path, {}, signal).then(function (result) {
      if (cancelled) return
      if (!result.ok) {
        setPhase('error')
        setMessage('读取失败: ' + (result.error && result.error.message ? result.error.message : String(result.error)))
        return
      }
      const file = result.value
      setAbsolutePath(file.absolutePath)
      setContent(new TextDecoder().decode(file.data))
      setPhase('ready')
    }).catch(function (e: unknown) {
      if (cancelled) return
      setPhase('error')
      setMessage(e instanceof Error ? e.message : String(e))
    })
    return function () { cancelled = true }
  }, [address])

  // 内容就绪后创建编辑器与模型；内容更新则重建模型，不重复建编辑器。
  React.useEffect(function () {
    const container = containerRef.current
    if (!container || content === null) return
    let disposed = false
    loadMonaco().then(function () {
      if (disposed) return
      if (!editorRef.current) {
        const editor = window.monaco.editor.create(container, {
          language: 'plaintext',
          theme: isDarkTheme() ? 'vs-dark' : 'vs',
          fontSize: 13,
          fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          wordWrap: 'on',
          lineNumbers: 'on',
        })
        editorRef.current = editor
        editor.addCommand(
          window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.KeyS,
          function () { if (saveRef.current) saveRef.current() },
        )
        editor.onDidChangeModelContent(function () { setDirty(true) })
        const observer = new MutationObserver(function () {
          if (editorRef.current) editorRef.current.setTheme(isDarkTheme() ? 'vs-dark' : 'vs')
        })
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        themeObserverRef.current = observer
      }
      if (modelRef.current) modelRef.current.dispose()
      modelRef.current = window.monaco.editor.createModel(content, langByPath(parsed ? parsed.path : ''))
      editorRef.current.setModel(modelRef.current)
    }).catch(function (e: unknown) {
      if (disposed) return
      setPhase('error')
      setMessage(e instanceof Error ? e.message : String(e))
    })
    return function () { disposed = true }
  }, [content])

  // tab 记录消失即卸载：断开主题观察、释放编辑器与模型。
  React.useEffect(function () {
    return function () {
      if (themeObserverRef.current) {
        themeObserverRef.current.disconnect()
        themeObserverRef.current = null
      }
      if (editorRef.current) {
        editorRef.current.dispose()
        editorRef.current = null
      }
      if (modelRef.current) {
        modelRef.current.dispose()
        modelRef.current = null
      }
    }
  }, [])

  /** 取编辑器当前内容写回绝对路径。 */
  function save(): void {
    if (!editorRef.current || !absolutePath) return
    setMessage('保存中...')
    rpcCall<unknown>('writeFile', { path: absolutePath, content: editorRef.current.getValue() })
      .then(function () {
        setDirty(false)
        setMessage('已保存')
      })
      .catch(function (e: unknown) {
        setMessage('保存失败: ' + (e instanceof Error ? e.message : String(e)))
      })
  }

  /** 切回内置查看器：不带 kind 时由注册表认领，code 类型不参与自动认领。 */
  function back(): void {
    if (!sidebarRight) return
    // 用自身 id 作 replaceTab：新 tab 落在同格同格位，本 tab 随即关闭。
    sidebarRight.openResource(address, { replaceTab: info.tab.id })
  }

  // Ctrl+S 命令只绑定一次，经 ref 拿到最新 save，避免闭包捕获旧 absolutePath。
  React.useEffect(function () {
    saveRef.current = save
  })

  const label = parsed ? basename(parsed.path) : address
  return React.createElement('div', { className: 'dsh-cc-body' },
    React.createElement('div', { className: 'dsh-cc-toolbar' },
      React.createElement('span', { className: 'dsh-cc-filename' }, dirty ? label + ' ●' : label),
      React.createElement('button', {
        type: 'button',
        className: 'dsh-cc-save',
        onClick: save,
        disabled: phase !== 'ready' || !dirty,
        title: '保存 Ctrl+S',
      }, '保存'),
      React.createElement('button', {
        type: 'button',
        className: 'dsh-cc-save',
        onClick: back,
        title: '返回查看',
      }, '查看'),
      React.createElement('span', { className: 'dsh-cc-status' }, message),
    ),
    React.createElement('div', { ref: containerRef, className: 'dsh-cc-editor' }),
    phase === 'loading' ? React.createElement('div', { className: 'dsh-cc-message' }, '加载中...') : null,
    phase === 'error' ? React.createElement('div', { className: 'dsh-cc-message' }, '打开失败: ' + message) : null,
  )
}

// ─── 插件入口 ──────────────────────────────────────────

/** 插件名，与 cordis.patch.yml 的 name 一致。 */
export const name = 'dsh-classic-coding'

/** 依赖的客户端服务：右侧栏 tab 注册表、槽位、远端命名空间及其 workspaceFiles 面。 */
export const inject: string[] = ['slots', 'sidebarRightTabs', 'sidebarRight', 'remote', 'remote.workspaceFiles']

/**
 * 客户端 apply：注册 code tab 类型与它的正文。
 *
 * 类型以 extension 优先级压过内置 text 的 fallback，但只认领代码扩展名与会话地址，
 * 其余文件仍由内置查看器处理。注册与插件同寿，故放进 ctx.effect。
 * @param ctx - 客户端插件上下文。
 */
export function apply(ctx: ClientContext): void {
  const slots = ctx.get('slots') as SlotsService | undefined
  if (!slots) return
  const tabs = ctx.get('sidebarRightTabs') as TabsService | undefined
  if (!tabs) throw new Error('[classic-coding] 缺少 sidebarRightTabs 服务，请确认 dsh-client-ui-sidebar-right 已加载')
  const remoteService = ctx.get('remote') as RemoteService | undefined
  if (!remoteService) throw new Error('[classic-coding] 缺少 remote 服务，请确认 dsh-api-workspace-files 已加载')
  const right = ctx.get('sidebarRight') as SidebarRightService | undefined
  if (!right) throw new Error('[classic-coding] 缺少 sidebarRight 服务，请确认 dsh-client-ui-sidebar-right 已加载')
  remote = remoteService
  sidebarRight = right

  ctx.effect(function () {
    ensureStyle()
    return function () { removeStyle() }
  })

  ctx.effect(function () {
    return tabs.register({
      id: TYPE_ID,
      kind: KIND,
      priority: 'extension',
      canOpen: function (address) { return address.startsWith(SESSION_FILE_PREFIX) },
      title: function (address) {
        const target = parseFileAddress(address)
        return target ? basename(target.path) : address
      },
      keepMounted: true,
    })
  })

  slots.inject('sidebar.right.pane.tab', function () {
    return slots.register({ name: 'sidebar.right.pane.tab', key: TYPE_ID }, CodeTabBody)
  })

  slots.inject('sidebar.right.tab.document.actions', function () {
    return slots.register(
      { name: 'sidebar.right.tab.document.actions', id: 'dsh-classic-coding-edit', order: 20 },
      EditAction,
    )
  })
}

const plugin = { name, inject, apply }
export default plugin

