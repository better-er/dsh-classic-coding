/**
 * 古法编程 - Client 端
 * Monaco 编辑器 + 文件树覆盖层面板。
 *
 * 构建产物经 DSH 的 __ModuleLoader__ 机制注册为浏览器端插件，
 * 侧边栏底部按钮触发覆盖层，覆盖层包含文件树、标签栏和 Monaco 编辑器。
 *
 * @module dsh-classic-coding/client
 */

import * as React from 'react'

/** 文件树条目。 */
interface FileEntry {
  name: string
  type: 'directory' | 'file'
  size: number
}

/** 已打开的标签。 */
interface OpenTab {
  path: string
  content: string
  modified: boolean
}

/** listDir 端点返回值。 */
interface ListDirResult { entries: FileEntry[] }

/** describe 端点返回值。 */
interface DescribeResult { root: string }

/** readFile 端点返回值。 */
interface ReadFileResult { content: string }

/** 会话列表快照：current 即侧栏选中会话。 */
interface SessionsSnapshot { current?: string | null }

/** 会话服务最小面。 */
interface SessionsService {
  list: {
    getSnapshot(): SessionsSnapshot | null | undefined
    subscribe?(listener: () => void): () => void
  }
}

/** 槽位服务最小面。 */
interface SlotsService {
  inject(name: string, callback: () => (() => void) | void): void
  register(
    options: { name: string; id: string; order?: number },
    component: () => React.ReactElement,
  ): () => void
}

/** 客户端插件上下文最小面。 */
interface ClientContext {
  get(service: string): unknown
  effect(callback: () => () => void): void
}

/** 插件全局状态：跨组件共享的可变单例。 */
interface PluginState {
  isOpen: boolean
  root: string | null
  monacoLoaded: boolean
  monacoLoading: boolean
  /** dirPath → 条目列表 */
  files: Record<string, FileEntry[]>
  openTabs: OpenTab[]
  activeTab: string | null
  /** Monaco 未就绪时等待显示的文件路径，内容必达 */
  _pendingShowPath: string | null
  /** dirPath → true */
  expandedDirs: Record<string, true>
  styleTag: HTMLStyleElement | null
  sessionId: string | null
  _linkTailStarted: boolean
  _linkTailObserver: MutationObserver | null
  _refresh: (() => void) | null
  _setIsOpen: ((open: boolean) => void) | null
  _openFile: ((path: string) => void) | null
  _saveFile: ((path: string) => void) | null
  _editorInstance: MonacoEditorInstance | null
  _themeObserver: MutationObserver | null
  _monacoPromise: Promise<void> | null
}

// ─── 常量 ───────────────────────────────────────────────

/** 文件扩展名到 Monaco 语言的映射 */
const LANG_MAP: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', go: 'go', rs: 'rust', java: 'java',
  c: 'c', cpp: 'cpp', h: 'c', cs: 'csharp',
  html: 'html', css: 'css', scss: 'scss',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  md: 'markdown', xml: 'xml', sql: 'sql', sh: 'shell',
  ps1: 'powershell', bat: 'bat', cmd: 'bat',
}

/**
 * 根据文件扩展名获取语言。
 * @param path - 文件路径。
 */
function langByPath(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return 'plaintext'
  return LANG_MAP[path.slice(dot + 1).toLowerCase()] || 'plaintext'
}

/**
 * 根据文件名获取图标。
 * @param name - 文件或目录名。
 * @param type - 条目类型。
 */
function iconFor(name: string, type: 'directory' | 'file'): string {
  if (type === 'directory') return '\uD83D\uDCC1'
  const ext = name.split('.').pop() || ''
  const map: Record<string, string> = {
    js: '\uD83D\uDFE8', jsx: '\uD83D\uDFE8', ts: '\u26A1', tsx: '\u26A1',
    py: '\uD83D\uDC0D', go: '\uD83E\uDDA6', rs: '\u2699\uFE0F',
    html: '\uD83C\uDF10', css: '\uD83C\uDFA8',
    md: '\uD83D\uDCDD', yaml: '\uD83D\uDCCB', yml: '\uD83D\uDCCB',
    sh: '\u2328\uFE0F', txt: '\uD83D\uDCC4',
  }
  return map[ext.toLowerCase()] || '\uD83D\uDCC4'
}

/**
 * 把含 data-* 的属性表收窄成 React 可接受的属性类型。
 * @param value - 属性表。
 */
function attrs(value: Record<string, unknown>): React.HTMLAttributes<HTMLElement> {
  return value as React.HTMLAttributes<HTMLElement>
}

// ─── RPC 调用 ──────────────────────────────────────────

let rpcIdCounter = 0

/**
 * 调用 Host 端 RPC 端点。
 * 格式：POST /classic-coding/<method>，独立 RPC 通道，
 * 遵循 DSH 四象限消息模型：body.method 必须等于 URL 中的端点名。
 * @param method - 端点名。
 * @param payload - 端点载荷。
 */
async function rpcCall<T>(method: string, payload?: unknown): Promise<T> {
  const rpcId = 'cc-' + String(++rpcIdCounter)
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: rpcId,
    method: method,
    payload: payload || {},
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

// ─── 插件状态 ──────────────────────────────────────────

/** 当前会话服务，注入获取：sessions.list.current 即侧栏选中的会话 */
let sessions: SessionsService | null = null

const state: PluginState = {
  isOpen: false,
  root: null,
  monacoLoaded: false,
  monacoLoading: false,
  files: {},
  openTabs: [],
  activeTab: null,
  _pendingShowPath: null,
  expandedDirs: {},
  styleTag: null,
  sessionId: null,
  _linkTailStarted: false,
  _linkTailObserver: null,
  _refresh: null,
  _setIsOpen: null,
  _openFile: null,
  _saveFile: null,
  _editorInstance: null,
  _themeObserver: null,
  _monacoPromise: null,
}

/**
 * 触发主面板重渲染：所有直接修改全局 state 的调用点用它刷新 UI。
 * 面板未挂载时 state._refresh 为 null，安全跳过。
 */
function refresh(): void {
  if (state._refresh) state._refresh()
}

// ─── 会话与路径 ────────────────────────────────────────

/**
 * 当前会话 id 从注入的 sessions 服务读取 list.current，
 * 不抓取 DSH 内部 localStorage。官方 API 的 current 与侧栏选择同步，切工作区即变。
 * 返回 null 表示尚无当前会话，页面刚加载或连接未建立时。
 */
function getCurrentSessionId(): string | null {
  if (!sessions) return null
  const snap = sessions.list.getSnapshot()
  const id = snap && snap.current
  return id || null
}

/**
 * 相对路径即文件树内转绝对路径即 RPC 用，Windows 分隔符。
 * 已是绝对路径即盘符或 UNC 时原样返回：消息流尾巴传入的路径可能是绝对路径，
 * 不能再用 root 拼接。
 * @param relPath - 文件树内相对路径或绝对路径。
 */
function toAbs(relPath: string): string {
  if (!relPath) return state.root || ''
  const p = String(relPath)
  if (/^[A-Za-z]:[\\/]|^\\\\/.test(p)) return p
  return (state.root || '') + '\\' + p.replace(/\//g, '\\')
}

// ─── 样式注入 ──────────────────────────────────────────

const CSS = [
  /* 触发按钮：两行结构，图标+标题 / 描述。动作按钮无开关状态，故不设 pill 胶囊 */
  '.dsh-cc-trigger{display:flex;flex-direction:column;gap:5px;width:100%;min-width:0;padding:7px 9px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:transparent;cursor:pointer;text-align:left;color:var(--dsw-alias-label-primary);font-family:inherit;transition:background .12s ease,border-color .12s ease}',
  '.dsh-cc-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}',
  '.dsh-cc-trigger:active{background:var(--dsw-alias-interactive-bg-active)}',
  '.dsh-cc-trigger-head{display:flex;align-items:center;gap:7px;min-width:0}',
  '.dsh-cc-trigger-icon{display:inline-flex;flex:none;width:16px;height:16px;align-items:center;justify-content:center;font-style:normal;opacity:.85}',
  '.dsh-cc-trigger-title{font-size:12.5px;font-weight:600;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-cc-trigger-desc{font-size:11px;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}',
  /* 侧面板容器：全屏透明遮罩 + 右侧面板 */
  '.dsh-cc-overlay{position:fixed;inset:0;z-index:100;display:none;pointer-events:none}',
  '.dsh-cc-overlay[data-open="true"]{display:block}',
  /* 半透明遮罩：点击关闭面板 */
  '.dsh-cc-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.3);pointer-events:auto;transition:opacity .2s ease}',
  '.dsh-cc-backdrop:hover{background:rgba(0,0,0,.35)}',
  /* 右侧面板主体 */
  '.dsh-cc-panel{position:absolute;top:0;right:0;bottom:0;width:72vw;max-width:1400px;min-width:400px;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#333);box-shadow:-4px 0 20px rgba(0,0,0,.15);pointer-events:auto;transform:translateX(0);transition:transform .2s ease}',
  /* 头部 */
  '.dsh-cc-header{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-shrink:0}',
  '.dsh-cc-header-title{font-size:14px;font-weight:600;display:flex;align-items:center;gap:6px}',
  '.dsh-cc-close{cursor:pointer;font-size:20px;line-height:1;padding:2px 6px;border-radius:4px;background:transparent;border:none;color:inherit}',
  '.dsh-cc-close:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  /* 标签栏 */
  '.dsh-cc-tabs{display:flex;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-l1);flex-shrink:0}',
  '.dsh-cc-tab{display:flex;align-items:center;gap:5px;padding:6px 12px;font-size:12px;cursor:pointer;border-right:1px solid var(--dsw-alias-border-l1);white-space:nowrap;color:var(--dsw-alias-label-secondary);background:transparent;border-top:none;border-bottom:none;border-left:none;font-family:inherit}',
  '.dsh-cc-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-cc-tab[data-active="true"]{color:var(--dsw-alias-label-primary);font-weight:500;border-bottom:2px solid var(--dsw-alias-brand-primary)}',
  '.dsh-cc-tab-modified{color:var(--dsw-alias-state-error-primary)}',
  '.dsh-cc-tab-close{font-size:14px;padding:0 2px;border-radius:3px;opacity:.5;cursor:pointer;background:transparent;border:none;color:inherit;line-height:1}',
  '.dsh-cc-tab-close:hover{opacity:1;background:rgba(255,0,0,.1)}',
  /* 主体 */
  '.dsh-cc-body{display:flex;flex:1;overflow:hidden}',
  /* 文件树 */
  '.dsh-cc-tree-panel{width:250px;min-width:150px;max-width:500px;overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l1);flex-shrink:0}',
  '.dsh-cc-tree-item{padding:3px 8px;font-size:13px;line-height:1.6;display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-cc-tree-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-cc-tree-loading{padding:12px;font-size:13px;color:var(--dsw-alias-label-secondary)}',
  /* 编辑器 */
  '.dsh-cc-editor-panel{flex:1;overflow:hidden;position:relative}',
  '.dsh-cc-editor{width:100%;height:100%}',
  '.dsh-cc-editor-placeholder{display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:var(--dsw-alias-label-tertiary);font-size:14px}',
  /* 状态栏 */
  '.dsh-cc-status{padding:4px 16px;font-size:11px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);flex-shrink:0}',
  /* 响应式 */
  '@media(max-width:768px){.dsh-cc-panel{width:92vw;min-width:0}.dsh-cc-tree-panel{width:160px}}',
  /* sidebar footer action 是行方向 flex 容器，多个插件按钮会被左右挤压；容器内含本插件按钮时转纵向排列 */
  '[class*="footerActions"]:has(button.dsh-cc-trigger){flex-direction:column;align-items:stretch}',
  /* 侧栏收起时切换单图标模式，frame 根节点的 data-sidebar-collapsed 属性：隐藏标题与描述，按钮收成 36x36 图标方块，避免溢出窄 rail；尺寸与边缘样式对齐 DSH 原生「新建会话」图标按钮，36x36、radius 12px、透明边框，收起态 specificity 高于 .dsh-cc-trigger:hover，故 hover 时边框保持透明、仅背景变化 */
  '[data-sidebar-collapsed] [class*="footerActions"]:has(button.dsh-cc-trigger){align-items:center}',
  '[data-sidebar-collapsed] button.dsh-cc-trigger{width:36px;height:36px;padding:0;align-items:center;justify-content:center;border-radius:12px;border-color:transparent}',
  '[data-sidebar-collapsed] .dsh-cc-trigger-title,[data-sidebar-collapsed] .dsh-cc-trigger-desc{display:none}',
  '[data-sidebar-collapsed] .dsh-cc-trigger-head{gap:0}',
  /* 消息流 fileLink 后的「古法编程」尾巴 */
  '.dsh-cc-open-here{margin-left:6px;cursor:pointer;font-size:12px;color:var(--dsw-alias-brand-primary);text-decoration:underline dotted;white-space:nowrap;user-select:none}',
  '.dsh-cc-open-here:hover{text-decoration:underline;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);border-radius:3px}',
].join('\n')

/** 注入插件样式表，幂等。 */
function ensureStyle(): void {
  if (state.styleTag) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-classic-coding'
  tag.textContent = CSS
  document.head.appendChild(tag)
  state.styleTag = tag
}

/** 移除插件样式表。 */
function removeStyle(): void {
  if (state.styleTag && state.styleTag.parentNode) {
    state.styleTag.parentNode.removeChild(state.styleTag)
  }
  state.styleTag = null
}

// ─── Monaco Editor 加载 ────────────────────────────────

/** DSH 暗色主题标记：ui-theme 在 body 上设置 data-ds-dark-theme。 */
function isDarkTheme(): boolean {
  return document.body.hasAttribute('data-ds-dark-theme')
}

/** 从 CDN 加载 Monaco，重复调用复用同一个 Promise。 */
function loadMonaco(): Promise<void> {
  if (state.monacoLoaded) return Promise.resolve()
  if (state.monacoLoading && state._monacoPromise) return state._monacoPromise
  state.monacoLoading = true

  state._monacoPromise = new Promise<void>(function (resolve, reject) {
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.js'
    script.onload = function () {
      window.require.config({
        paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' },
      })
      window.require(['vs/editor/editor.main'], function () {
        state.monacoLoaded = true
        state.monacoLoading = false
        resolve()
      })
    }
    script.onerror = function () {
      state.monacoLoading = false
      reject(new Error('Monaco Editor 加载失败'))
    }
    document.head.appendChild(script)
  })
  return state._monacoPromise
}

// ─── 文件树组件 ────────────────────────────────────────

/** 文件树条目 props。 */
interface FileTreeEntryProps {
  entry: FileEntry
  parentPath: string
  level: number
  onEntryClick: () => void
  onFileOpen: (path: string) => void
}

/**
 * 单个文件树条目，目录展开时递归渲染子条目。
 * @param props - 条目 props。
 */
function FileTreeEntry(props: FileTreeEntryProps): React.ReactElement {
  const entry = props.entry
  const parentPath = props.parentPath
  const level = props.level
  const onEntryClick = props.onEntryClick

  const fullPath = parentPath ? parentPath + '/' + entry.name : entry.name
  const isDir = entry.type === 'directory'
  const icon = isDir ? '\uD83D\uDCC1' : iconFor(entry.name, entry.type)
  const paddingLeft = 8 + level * 16

  // 目录展开/折叠状态
  const expanded = state.expandedDirs[fullPath] || false
  const children = state.files[fullPath] || null
  const [loading, setLoading] = React.useState(false)

  function handleClick(): void {
    if (isDir) {
      if (state.expandedDirs[fullPath]) {
        delete state.expandedDirs[fullPath]
        onEntryClick() // 触发重渲染
      } else {
        state.expandedDirs[fullPath] = true
        onEntryClick() // 先展开，再加载
        if (!children) {
          setLoading(true)
          rpcCall<ListDirResult>('listDir', { path: toAbs(fullPath) }).then(function (result) {
            state.files[fullPath] = result.entries
            setLoading(false)
            onEntryClick() // 加载完成，触发重渲染
          }).catch(function (e: unknown) {
            console.error('[classic-coding] listDir error:', e)
            setLoading(false)
            delete state.expandedDirs[fullPath]
            onEntryClick()
          })
        }
      }
    } else {
      props.onFileOpen(fullPath)
    }
  }

  const items: React.ReactElement[] = []
  // 条目本身
  items.push(React.createElement('div', {
    key: 'item-' + fullPath,
    className: 'dsh-cc-tree-item',
    style: { paddingLeft: paddingLeft + 'px' },
    title: fullPath,
    onClick: handleClick,
  },
    React.createElement('span', null, isDir ? (expanded ? '\u25BC ' : '\u25B6 ') : ''),
    React.createElement('span', null, icon + ' '),
    React.createElement('span', null, entry.name),
  ))

  // 子目录内容
  if (isDir && expanded) {
    if (loading) {
      items.push(React.createElement('div', {
        key: 'loading-' + fullPath,
        className: 'dsh-cc-tree-loading',
        style: { paddingLeft: (paddingLeft + 20) + 'px' },
      }, '加载中...'))
    } else if (children) {
      children.forEach(function (child) {
        items.push(React.createElement(FileTreeEntry, {
          key: child.name,
          entry: child,
          parentPath: fullPath,
          level: level + 1,
          onEntryClick: onEntryClick,
          onFileOpen: props.onFileOpen,
        }))
      })
    }
  }

  return React.createElement(React.Fragment, null, items)
}

/** 文件树 props。 */
interface FileTreeProps {
  onFileOpen: (path: string) => void
}

/**
 * 文件树根组件：跟随当前会话工作区加载根目录。
 * @param props - 组件 props。
 */
function FileTree(props: FileTreeProps): React.ReactElement {
  const onFileOpen = props.onFileOpen
  const [, forceUpdate] = React.useState(0)
  const [rootEntries, setRootEntries] = React.useState<FileEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  // 当前会话 id：作为重载依赖。侧栏切工作区后会话变更，触发重新 describe + listDir，树跟随工作区。
  // 会话未就绪时为 null：页面刚加载或连接未建立，显示等待并轮询，就绪后自动加载，绝不抛错崩溃。
  const sessionId = getCurrentSessionId()
  const [pendingSession, setPendingSession] = React.useState<string | null>(sessionId)

  // 订阅 sessions 列表：侧栏切工作区即当前会话变更时自动重载，面板保持打开也能跟随。
  React.useEffect(function () {
    if (!sessions || !sessions.list || typeof sessions.list.subscribe !== 'function') return
    return sessions.list.subscribe(function () {
      const id = getCurrentSessionId()
      setPendingSession(function (prev) { return prev === id ? prev : id })
    })
  }, [])

  React.useEffect(function () {
    if (pendingSession) {
      state.sessionId = pendingSession
      // 根变化后清空旧的目录缓存与展开状态，避免串台
      state.files = {}
      state.expandedDirs = {}
      setLoading(true)
      setError(null)
      setRootEntries([])

      rpcCall<DescribeResult>('describe', { sessionId: pendingSession }).then(function (result) {
        state.root = result.root
        return rpcCall<ListDirResult>('listDir', { path: result.root })
      }).then(function (result) {
        setRootEntries(result.entries)
        setLoading(false)
      }).catch(function (e: unknown) {
        console.error('[classic-coding] 初始化失败:', e)
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    } else {
      // 会话未就绪：每 500ms 重试，sessions 服务初始化完成后即加载
      const timer = setInterval(function () {
        const id = getCurrentSessionId()
        if (id) {
          clearInterval(timer)
          setPendingSession(id)
        }
      }, 500)
      return function () { clearInterval(timer) }
    }
  }, [pendingSession])

  function triggerUpdate(): void {
    forceUpdate(function (n) { return n + 1 })
  }

  if (!pendingSession) {
    return React.createElement('div', { className: 'dsh-cc-tree-loading' }, '等待会话就绪...')
  }

  if (loading) {
    return React.createElement('div', { className: 'dsh-cc-tree-loading' }, '加载中...')
  }

  if (error) {
    return React.createElement('div', { className: 'dsh-cc-tree-loading' }, '文件树加载失败: ' + error)
  }

  return React.createElement('div', null,
    rootEntries.map(function (entry) {
      return React.createElement(FileTreeEntry, {
        key: entry.name,
        entry: entry,
        parentPath: '',
        level: 0,
        onEntryClick: triggerUpdate,
        onFileOpen: onFileOpen,
      })
    }),
  )
}

// ─── 标签栏组件 ────────────────────────────────────────

/** 标签栏 props。 */
interface TabBarProps {
  onTabSelect: (path: string) => void
  onTabClose: (path: string) => void
}

/**
 * 标签栏：渲染已打开文件，含修改标记与关闭按钮。
 * @param props - 组件 props。
 */
function TabBar(props: TabBarProps): React.ReactElement {
  return React.createElement('div', { className: 'dsh-cc-tabs' },
    state.openTabs.map(function (tab) {
      const name = tab.path.split(/[\\/]/).pop() || ''
      const isActive = tab.path === state.activeTab
      return React.createElement('div', attrs({
        key: tab.path,
        className: 'dsh-cc-tab',
        'data-active': isActive ? 'true' : 'false',
        onClick: function () { props.onTabSelect(tab.path) },
      }),
        React.createElement('span', null, iconFor(name, 'file') + ' '),
        React.createElement('span', null, name),
        tab.modified ? React.createElement('span', { className: 'dsh-cc-tab-modified' }, ' \u25CF') : null,
        React.createElement('button', {
          className: 'dsh-cc-tab-close',
          onClick: function (e: React.MouseEvent) {
            e.stopPropagation()
            props.onTabClose(tab.path)
          },
        }, '\u00D7'),
      )
    }),
  )
}

// ─── 编辑器面板组件 ────────────────────────────────────

/** 编辑器面板 props。 */
interface EditorPanelProps {
  onStatusChange: (status: string) => void
}

/**
 * Monaco 编辑器面板：负责编辑器实例生命周期、文件打开与保存。
 * @param props - 组件 props。
 */
function EditorPanel(props: EditorPanelProps): React.ReactElement {
  const editorRef = React.useRef<HTMLDivElement | null>(null)
  const editorInstanceRef = React.useRef<MonacoEditorInstance | null>(null)
  const currentModelRef = React.useRef<MonacoTextModel | null>(null)

  // 每次渲染后检查编辑器容器是否就绪：挂载时渲染的是占位符，
  // .dsh-cc-editor 容器要等第一个 Tab 打开才出现，因此不能只用 mount 一次的 effect。幂等：已创建则跳过。
  React.useEffect(function () {
    if (editorRef.current && !editorInstanceRef.current) {
      loadMonaco().then(function () {
        if (editorRef.current && !editorInstanceRef.current) {
          createEditor(editorRef.current)
        }
      }).catch(function (e: unknown) {
        console.error('[classic-coding] Monaco 加载失败:', e)
      })
    }
  })

  // 组件卸载时释放编辑器实例
  React.useEffect(function () {
    // 主题动态跟随：DSH 切换明/暗时实时更新编辑器主题。
    // 回调读取全局 state._editorInstance，面板关闭重开也不会失效。
    if (!state._themeObserver) {
      state._themeObserver = new MutationObserver(function () {
        if (state._editorInstance) {
          state._editorInstance.setTheme(isDarkTheme() ? 'vs-dark' : 'vs')
        }
      })
      state._themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-ds-dark-theme'],
      })
    }
    return function () {
      if (editorInstanceRef.current) {
        editorInstanceRef.current.dispose()
        editorInstanceRef.current = null
      }
      if (state._editorInstance) state._editorInstance = null
    }
  }, [])

  // 最后一个标签关闭后，.dsh-cc-editor 容器会从 DOM 移除，改渲染占位符。
  // 若此层面板组件并未卸载，DSH overlay 保持挂载、仅靠 data-open 显隐，
  // editorInstanceRef 会残留指向已分离容器的旧实例，再次打开时因实例非空而跳过重建，
  // 导致「标签在、内容无」。故在无标签时主动销毁实例，让下次打开走 createEditor 重建 + 冲刷 pending，保证内容必达。
  const hasTabs = state.openTabs.length > 0
  React.useEffect(function () {
    if (!hasTabs && editorInstanceRef.current) {
      editorInstanceRef.current.dispose()
      editorInstanceRef.current = null
      if (state._editorInstance) state._editorInstance = null
      if (currentModelRef.current) {
        currentModelRef.current.dispose()
        currentModelRef.current = null
      }
    }
  }, [hasTabs])

  /**
   * 创建 Monaco 实例并接线 Ctrl+S、内容变更与挂起文件。
   * @param container - 编辑器容器元素。
   */
  function createEditor(container: HTMLDivElement): void {
    editorInstanceRef.current = window.monaco.editor.create(container, {
      value: '// 欢迎使用古法编程!\n// 从左侧文件树打开文件开始编辑\n// Ctrl+S 保存文件\n',
      language: 'plaintext',
      theme: isDarkTheme() ? 'vs-dark' : 'vs',
      fontSize: 14,
      fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      tabSize: 2,
      wordWrap: 'on',
      lineNumbers: 'on',
    })
    // 同步到全局 state：主题 observer 与状态栏等跨组件读取
    state._editorInstance = editorInstanceRef.current

    // Ctrl+S 保存
    editorInstanceRef.current.addCommand(
      window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.KeyS,
      function () {
        if (state.activeTab) saveFile(state.activeTab)
      },
    )

    // 若已有打开的文件，Monaco 晚于 openFile 加载完成时直接显示当前 Tab
    if (state.activeTab) {
      const current = state.openTabs.find(function (t) { return t.path === state.activeTab })
      if (current) {
        currentModelRef.current = window.monaco.editor.createModel(current.content, langByPath(state.activeTab))
        editorInstanceRef.current.setModel(currentModelRef.current)
      }
    }

    // 冲刷挂起的待显示路径，尾巴点击时 Monaco 未就绪挂起的文件
    if (state._pendingShowPath) {
      const pending = state._pendingShowPath
      state._pendingShowPath = null
      showFileInEditor(pending)
    }

    // 监听内容变化
    editorInstanceRef.current.onDidChangeModelContent(function () {
      if (!state.activeTab) return
      const tab = state.openTabs.find(function (t) { return t.path === state.activeTab })
      if (tab && editorInstanceRef.current) {
        tab.content = editorInstanceRef.current.getValue()
        tab.modified = true
        refresh()
      }
    })
  }

  /**
   * 打开文件：已打开则切标签，否则读盘后新建标签。
   * @param filePath - 文件树内相对路径。
   */
  function openFile(filePath: string): void {
    const existing = state.openTabs.find(function (t) { return t.path === filePath })
    if (existing) {
      state.activeTab = filePath
      showFileInEditor(filePath)
      refresh()
      return
    }

    rpcCall<ReadFileResult>('readFile', { path: toAbs(filePath) }).then(function (result) {
      state.openTabs.push({ path: filePath, content: result.content, modified: false })
      state.activeTab = filePath
      showFileInEditor(filePath)
      refresh()
    }).catch(function (e: unknown) {
      console.error('[classic-coding] 读取文件失败:', filePath, e)
      refresh()
    })
  }

  /**
   * 保存文件：写盘后清修改标记。
   * @param filePath - 文件树内相对路径。
   */
  function saveFile(filePath: string): void {
    const tab = state.openTabs.find(function (t) { return t.path === filePath })
    if (!tab) return

    if (editorInstanceRef.current && state.activeTab === filePath) {
      tab.content = editorInstanceRef.current.getValue()
    }

    rpcCall<unknown>('writeFile', { path: toAbs(filePath), content: tab.content }).then(function () {
      tab.modified = false
      props.onStatusChange('\u2705 已保存: ' + filePath)
      refresh()
    }).catch(function (e: unknown) {
      console.error('[classic-coding] 保存失败:', filePath, e)
      props.onStatusChange('\u274C 保存失败: ' + filePath)
    })
  }

  /**
   * 在编辑器中显示文件，Monaco 未就绪时挂起待显示。
   * @param filePath - 文件树内相对路径。
   */
  function showFileInEditor(filePath: string): void {
    // Monaco 尚未就绪时挂起待显示，编辑器创建完成后统一冲刷，保证内容必达
    if (!editorInstanceRef.current) {
      state._pendingShowPath = filePath
      return
    }
    const tab = state.openTabs.find(function (t) { return t.path === filePath })
    if (!tab) return

    if (currentModelRef.current) currentModelRef.current.dispose()
    currentModelRef.current = window.monaco.editor.createModel(tab.content, langByPath(filePath))
    editorInstanceRef.current.setModel(currentModelRef.current)
    props.onStatusChange(filePath)
    refresh()
  }

  // 暴露方法给父组件：经全局 state 桥接，forwardRef 不可用
  React.useEffect(function () {
    state._openFile = openFile
    state._saveFile = saveFile
    return function () {
      state._openFile = null
      state._saveFile = null
    }
  })

  return React.createElement('div', { className: 'dsh-cc-editor-panel' },
    hasTabs
      ? React.createElement('div', { ref: editorRef, className: 'dsh-cc-editor' })
      : React.createElement('div', { className: 'dsh-cc-editor-placeholder' }, '从左侧文件树打开文件开始编辑'),
  )
}

// ─── 状态栏组件 ────────────────────────────────────────

/** 状态栏 props。 */
interface StatusBarProps {
  status: string
}

/**
 * 底部状态栏：显示当前文件路径或保存结果。
 * @param props - 组件 props。
 */
function StatusBar(props: StatusBarProps): React.ReactElement {
  return React.createElement('div', { className: 'dsh-cc-status' }, props.status)
}

// ─── 主面板组件 ────────────────────────────────────────

/** 右侧覆盖层面板：文件树 + 标签栏 + 编辑器 + 状态栏。 */
function ClassicCodingPanel(): React.ReactElement {
  const [status, setStatus] = React.useState('就绪')
  const [isOpen, setIsOpen] = React.useState(state.isOpen)
  const [, forceUpdate] = React.useState(0)

  // 同步 state.isOpen 和 React 状态
  React.useEffect(function () {
    state._setIsOpen = setIsOpen
    state._refresh = function () { forceUpdate(function (n) { return n + 1 }) }
    return function () {
      state._setIsOpen = null
      state._refresh = null
    }
  }, [])

  function handleFileOpen(filePath: string): void {
    if (state._openFile) state._openFile(filePath)
  }

  function handleTabSelect(path: string): void {
    state.activeTab = path
    if (state._openFile) state._openFile(path)
  }

  function handleTabClose(path: string): void {
    state.openTabs = state.openTabs.filter(function (t) { return t.path !== path })
    if (state.activeTab === path) {
      const last = state.openTabs[state.openTabs.length - 1]
      state.activeTab = last ? last.path : null
      if (state.activeTab) handleTabSelect(state.activeTab)
    }
    refresh()
  }

  function handleClose(): void {
    state.isOpen = false
    setIsOpen(false)
  }

  // Esc 关闭
  React.useEffect(function () {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape' && state.isOpen) {
        handleClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return function () { document.removeEventListener('keydown', onKeyDown) }
  }, [])

  return React.createElement('div', attrs({
    className: 'dsh-cc-overlay',
    'data-open': isOpen ? 'true' : 'false',
  }),
    // 半透明遮罩：点击关闭面板
    React.createElement('div', {
      className: 'dsh-cc-backdrop',
      onClick: handleClose,
    }),
    // 右侧滑入面板
    React.createElement('div', { className: 'dsh-cc-panel' },
      React.createElement('div', { className: 'dsh-cc-header' },
        React.createElement('span', { className: 'dsh-cc-header-title' },
          '\u2328\uFE0F 古法编程',
        ),
        React.createElement('button', {
          className: 'dsh-cc-close',
          onClick: handleClose,
          title: '关闭 Esc',
        }, '\u00D7'),
      ),
      React.createElement(TabBar, {
        onTabSelect: handleTabSelect,
        onTabClose: handleTabClose,
      }),
      React.createElement('div', { className: 'dsh-cc-body' },
        React.createElement('div', { className: 'dsh-cc-tree-panel' },
          React.createElement(FileTree, { onFileOpen: handleFileOpen }),
        ),
        React.createElement(EditorPanel, {
          onStatusChange: setStatus,
        }),
      ),
      React.createElement(StatusBar, { status: status }),
    ),
  )
}

// ─── 侧边栏触发按钮 ────────────────────────────────────

/** 侧边栏底部触发按钮。 */
function TriggerButton(): React.ReactElement {
  function toggle(): void {
    const next = !state.isOpen
    state.isOpen = next
    if (state._setIsOpen) state._setIsOpen(next)
  }

  return React.createElement('button', attrs({
    className: 'dsh-cc-trigger',
    title: '古法编程 Classic Coding',
    type: 'button',
    'aria-label': '古法编程 Classic Coding',
    onClick: toggle,
  }),
    React.createElement(
      'div',
      { className: 'dsh-cc-trigger-head' },
      React.createElement('span', attrs({ className: 'dsh-cc-trigger-icon', 'aria-hidden': 'true' }), '\u2328'),
      React.createElement('span', { className: 'dsh-cc-trigger-title' }, '古法编程'),
    ),
    React.createElement('div', { className: 'dsh-cc-trigger-desc' }, '打开文件编辑器'),
  )
}

// ─── 消息流 fileLink 尾巴注入 ──────────────────────────

/**
 * DSH 对话消息流中需要尾巴注入的两种文件按钮：
 * 1. 工具行 fileLink，CSS module hash 类名以 fileLink 结尾如 o3BgMG_fileLink，
 *    按钮文本是相对会话 cwd 的路径，显示层已 relativizeToCwd，点击默认由 Host 用系统默认应用打开。
 * 2. 产物区文件按钮，data-produced-files-row 容器内的 button，文本是 basename，完整绝对路径在 title 属性里。
 * 统一规则：在按钮后追加「古法编程」尾巴——点击路径本身保持原行为，外部打开，
 * 点击「古法编程」四字则在插件内打开该文件。
 */
const LINK_BTN_SELECTOR = 'button[class*="fileLink"], [data-produced-files-row="true"] button[title]'

/**
 * 从按钮提取目标路径：优先用注入时缓存的干净路径即 data-cc-path，
 * 其次产物区按钮的 title 即绝对路径，否则用文本即相对路径。
 * 不直接读 textContent——尾巴 span 注入后 textContent 会带上「古法编程」，
 * 重扫时若据此覆盖 dataset.path 会污染路径。
 * @param btn - 文件按钮元素。
 */
function btnPath(btn: Element): string {
  const cached = btn.getAttribute('data-cc-path')
  if (cached) return cached
  const title = btn.getAttribute('title')
  if (title && /^[A-Za-z]:[\\/]|^\\\\/.test(title)) return title
  return (btn.textContent || '').trim()
}

/**
 * 为指定容器内的所有 fileLink 按钮注入尾巴 span。幂等：已注入且路径未变则跳过。
 * 注入时把路径快照存到 span.dataset.path 供点击用，并把干净路径缓存到
 * 按钮 data-cc-path，重扫时从此读，避免尾巴文本污染 textContent 后误覆盖。
 * @param root - 待扫描的容器。
 */
function injectLinkTails(root: ParentNode): void {
  if (!root || !root.querySelectorAll) return
  const buttons = root.querySelectorAll(LINK_BTN_SELECTOR)
  for (let i = 0; i < buttons.length; i++) {
    const btn = buttons[i]
    if (!btn) continue
    const path = btnPath(btn)
    // 把干净路径缓存到按钮上，避免后续尾巴文本污染 textContent 后误覆盖 dataset.path
    if (!btn.hasAttribute('data-cc-path')) btn.setAttribute('data-cc-path', path)
    if (!path) continue
    const existing = btn.querySelector<HTMLElement>('.dsh-cc-open-here')
    if (existing) {
      // 重渲染后按钮文本可能更新，同步路径快照，优先取缓存的干净路径
      if (existing.dataset.path !== path) existing.dataset.path = path
      continue
    }
    const span = document.createElement('span')
    span.className = 'dsh-cc-open-here'
    span.textContent = '古法编程'
    span.title = '在古法编程中打开'
    span.dataset.path = path
    btn.appendChild(document.createTextNode('\u00A0'))
    btn.appendChild(span)
  }
}

/**
 * 在插件内打开消息流 fileLink 指出的文件：打开面板 → 等 root 就绪 → 读文件。
 * 路径可能相对当前会话 cwd，DSH 显示层已 relativizeToCwd，也可能本身就是绝对路径。
 * @param rawPath - 尾巴携带的路径快照。
 */
function openPathInPicker(rawPath: string): void {
  state.isOpen = true
  if (state._setIsOpen) state._setIsOpen(true)

  // 面板首次打开时 root 尚未加载，轮询等待就绪
  let attempts = 0
  function tryOpen(): void {
    if (!state.root || !state._openFile) {
      if (attempts++ < 40) { setTimeout(tryOpen, 250); return }
      console.error('[classic-coding] 文件树根未就绪，无法在插件内打开:', rawPath)
      return
    }
    if (state._openFile) state._openFile(rawPath)
  }
  tryOpen()
}

/**
 * 捕获阶段拦截点击：点击「古法编程」尾巴时阻止默认外部打开，改为插件内打开。
 * @param e - 点击事件。
 */
function onDocClickCapture(e: MouseEvent): void {
  const target = e.target as Element | null
  const pill = target && target.closest ? target.closest<HTMLElement>('.dsh-cc-open-here') : null
  if (!pill) return
  const rawPath = pill.dataset.path
  if (!rawPath) return
  e.preventDefault()
  e.stopPropagation()
  if (e.stopImmediatePropagation) e.stopImmediatePropagation()
  openPathInPicker(rawPath)
}

/** 启动消息流尾巴注入：MutationObserver 监听 DOM 变化 + 文档级点击拦截。 */
function startLinkTailWatcher(): void {
  if (state._linkTailStarted) return
  state._linkTailStarted = true
  injectLinkTails(document)
  state._linkTailObserver = new MutationObserver(function () {
    // React 更新按钮文本时可能用 textContent 整体覆盖，清掉尾巴且只产生
    // Text 节点变更，因此每次变更全文档重扫，幂等保证不重复注入。
    injectLinkTails(document)
  })
  state._linkTailObserver.observe(document.body, { childList: true, subtree: true, characterData: true })
  document.addEventListener('click', onDocClickCapture, true)
}

/** 停止尾巴注入：断开 observer、移除注入的 span、移除点击拦截。 */
function stopLinkTailWatcher(): void {
  if (state._linkTailObserver) {
    state._linkTailObserver.disconnect()
    state._linkTailObserver = null
  }
  document.removeEventListener('click', onDocClickCapture, true)
  state._linkTailStarted = false
  // 移除已注入的尾巴，恢复按钮原始外观
  const pills = document.querySelectorAll<HTMLElement>('.dsh-cc-open-here')
  for (let i = 0; i < pills.length; i++) {
    const pill = pills[i]
    if (!pill) continue
    const prev = pill.previousSibling
    if (prev && prev.nodeType === 3 && /^\u00A0+$/.test(prev.textContent || '')) {
      if (prev.parentNode) prev.parentNode.removeChild(prev)
    }
    if (pill.parentNode) pill.parentNode.removeChild(pill)
  }
}

// ─── 插件入口 ──────────────────────────────────────────

/** 插件名，与 cordis.patch.yml 的 name 一致。 */
export const name = 'dsh-classic-coding'

/** 依赖的客户端服务：slots 与 sessions 都由客户端核心插件提供。 */
export const inject: string[] = ['slots', 'sessions']

/**
 * 客户端 apply：注册侧边栏按钮与覆盖层面板，并启动样式与尾巴注入。
 * @param ctx - 客户端插件上下文。
 */
export function apply(ctx: ClientContext): void {
  const slots = ctx.get('slots') as SlotsService | undefined
  if (!slots) return
  const sessionsService = ctx.get('sessions') as SessionsService | undefined
  if (!sessionsService) throw new Error('[classic-coding] 缺少 sessions 服务，请确认 dsh-client-runtime 已加载')
  sessions = sessionsService

  // 注入样式 + 消息流尾巴，effect 管理生命周期
  ctx.effect(function () {
    ensureStyle()
    startLinkTailWatcher()
    return function () {
      removeStyle()
      stopLinkTailWatcher()
    }
  })

  // 注册侧边栏按钮
  slots.inject('sidebar.footer.action', function () {
    return slots.register(
      { name: 'sidebar.footer.action', id: 'dsh-classic-coding-trigger', order: 15 },
      function () { return React.createElement(TriggerButton) },
    )
  })

  // 注册覆盖层面板
  slots.inject('shell.overlay', function () {
    return slots.register(
      { name: 'shell.overlay', id: 'dsh-classic-coding-panel' },
      function () { return React.createElement(ClassicCodingPanel) },
    )
  })
}

const plugin = { name, inject, apply }

export default plugin
