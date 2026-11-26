/**
 * 古法编程 - Client 端
 *
 * 不注册 tab 类型，也不自带编辑器：文件始终由 dsh 内置文档预览展示，
 * 只在预览工具栏加一个按键，把正文临时换成原生输入框，再按一次即保存并退出。
 * 内容经内置 workspaceFiles 服务按会话整份读取，
 * 保存经 Host 自注册的 /classic-coding writeFile 端点，因为内置服务不提供修改操作。
 *
 * @module dsh-classic-coding/client
 */

import * as React from 'react'

// ─── 常量 ───────────────────────────────────────────────

/** 会话文件资源地址前缀，与 util/workspace-path 的语法一致。 */
const SESSION_FILE_PREFIX = 'dsh-resource://file/session/'

/** 允许进入修改模式的内置文档渲染器：代码与纯文本。Markdown 预览渲染的是成品，不能直接改写源码。 */
const EDITABLE_RENDERERS: string[] = [
  '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/code',
  '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/text',
]

/** 修改模式下 Tab 键插入的空格数。 */
const TAB_SPACES = '  '

/**
 * 从 dsh-resource 文件地址拆出会话 id 与相对路径。
 *
 * 只解析 session 地址：absolute 地址没有授权会话，内置读取会以 unknown-workspace 失败。
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

/** 框架注入文档动作组件的 tab 信息钩子，由 slot 声明里的 hooks.tabInfo 转换为 useTabInfo。 */
interface DocumentActionProps {
  /** 文档预览当前交付的正文；只对文本类渲染器注册本动作。 */
  content: { kind: 'text' | 'bytes' | 'renderer'; eof?: boolean }
  useTabInfo(): {
    tab: {
      /** 当前 tab 的内容地址，地址变化即换文件。 */
      contentId: string
      /** 仅在记录消失或插件卸载时中止。 */
      signal: AbortSignal
    }
  }
}

/** 当前 remote 服务，由 apply 赋值，文档动作经闭包外的它读取整份文件。 */
let remote: RemoteService | null = null

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

/** 文档工具栏的修改按键与覆盖在预览正文上的纯原生输入框，尺寸与配色都取 DSH 主题变量。 */
const CSS = [
  '.dsh-cc-edit-action{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:6px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);line-height:1;cursor:pointer}',
  '.dsh-cc-edit-action svg{width:15px;height:15px}',
  '.dsh-cc-glyph{display:inline-block;font-family:inherit;font-size:13px;font-weight:600;line-height:1;letter-spacing:0}',
  '.dsh-cc-glyph-flip{transform:rotate(180deg)}',
  '.dsh-cc-edit-action:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-cc-edit-action[aria-pressed="true"]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-cc-edit-action:disabled{opacity:.4;cursor:default}',
  '.dsh-cc-save{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:6px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);line-height:1;cursor:pointer}',
  '.dsh-cc-save svg{width:15px;height:15px}',
  '.dsh-cc-save:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-cc-editing{outline:none;caret-color:var(--dsw-alias-label-primary)}',
  '.dsh-cc-editing:focus{outline:none}',
  '.dsh-cc-clip{position:fixed;z-index:1000;overflow:auto;overscroll-behavior:contain}',
  '.dsh-cc-clip>*{min-height:100%}',
  '.dsh-cc-conflict-mask{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}',
  '.dsh-cc-conflict{width:min(360px,calc(100vw - 48px));padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;box-shadow:0 12px 32px rgba(0,0,0,.35)}',
  '.dsh-cc-conflict-title{margin:0 0 6px;font-size:14px;font-weight:600;line-height:1.5}',
  '.dsh-cc-conflict-text{margin:0 0 14px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
  '.dsh-cc-conflict-actions{display:flex;justify-content:flex-end;gap:8px}',
  '.dsh-cc-conflict-action{height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:1;cursor:pointer}',
  '.dsh-cc-conflict-action:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-cc-conflict-primary{border-color:transparent;background:var(--dsw-alias-interactive-bg-hover);font-weight:600}',
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

// ─── 修改模式 ──────────────────────────────────────────

/**
 * 一次修改会话。
 *
 * 官方预览会在文件版本变化、重读或自身状态更新时重渲染正文，把 contenteditable
 * 连同已输入的内容一起换掉，所以不能直接编辑预览里的节点。进入修改时把正文整体
 * 克隆到预览之外，克隆保持原样跟随原正文的位置与尺寸，编辑都落在克隆上；
 * 原正文只隐藏不删除，未编辑时的视觉仍由它决定。
 */
interface EditSession {
  /** 打开时的文档地址，用于识别换文件。 */
  address: string
  /** Host 侧绝对路径，保存时写这里。 */
  absolutePath: string
  /** 原文件内容，未改动时直接退出而不写盘。 */
  original: string
  /** 打开时的文件版本，保存前用它判断文件是否被外部改过。 */
  version: string
  /** 会话 id 与相对路径，保存前重读版本要用。 */
  sessionId: string
  path: string
  /** 文档预览根节点，用于保存后刷新与地址校验。 */
  root: HTMLElement
  /** 内置预览的正文节点，编辑期间隐藏，被预览重渲染替换后指向新节点。 */
  host: HTMLElement
  /** 可编辑的正文克隆，挂在预览之外。 */
  clone: HTMLElement
  /** 克隆的可视区容器，固定定位并裁剪在预览正文的可视范围内，可自行滚动。 */
  clip: HTMLElement
  /** 位置同步的定时器句柄。 */
  timer: number
  /** 位置同步函数，退出时解除监听。 */
  onSync: () => void
  /** 编辑期间的按键监听，退出时移除。 */
  onKeyDown: (event: KeyboardEvent) => void
  /** 切到别的标签页时触发，由组件挂上处理函数。 */
  onAway: () => void
  /** 已切走并询问过，避免轮询重复弹窗。 */
  away: boolean
  /** 已关闭，避免重复清理。 */
  closed: boolean
}

/** 当前生效的会话。组件随官方预览重挂时靠它恢复状态，不因一次重渲染丢掉编辑。 */
let activeSession: EditSession | null = null

/** 取错误消息，兼容非 Error 抛出。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 按文档地址找当前的预览根；页面上的预览可能已被重渲染换掉。 */
function findPreviewRoot(address: string): HTMLElement | null {
  const roots = Array.from(document.querySelectorAll<HTMLElement>('[data-textpreview-state]'))
  return roots.find(function (root): boolean {
    return root.getAttribute('data-textpreview-url') === address
  }) ?? null
}

/**
 * 取当前文档预览根；官方预览重渲染后旧根可能已脱离文档。
 * 只认地址匹配的根，不拿别的文件的预览顶替，否则定位与保存都会写错对象。
 * @param session - 当前会话。
 */
function currentRoot(session: EditSession): HTMLElement {
  const matched = findPreviewRoot(session.address)
  if (matched !== null) return matched
  return session.root
}

/** 统一换行并忽略末尾空行，比较两份文本是否只差文件末尾的换行。 */
function sameText(a: string, b: string): boolean {
  return a.replace(/\r\n?/g, '\n').replace(/\n+$/, '') === b.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
}

/** 取写回文本：换行统一为 LF，并保留原文件末尾的换行。 */
function saveText(current: string, original: string): string {
  const body = current.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
  const trailing = /\n*$/.exec(original)?.[0] ?? ''
  return body + trailing
}

/** 退出修改：移除克隆与监听，恢复原正文可见。 */
function closeSession(session: EditSession): void {
  if (session.closed) return
  session.closed = true
  window.clearInterval(session.timer)
  window.removeEventListener('scroll', session.onSync, true)
  window.removeEventListener('resize', session.onSync)
  session.clone.removeEventListener('keydown', session.onKeyDown)
  session.clip.remove()
  session.host.style.visibility = ''
  session.clone.removeAttribute('contenteditable')
  session.clone.classList.remove('dsh-cc-editing')
  if (activeSession === session) activeSession = null
}

/** 找到当前预览里承载源码的节点。 */
function editableHost(root: HTMLElement): HTMLElement | null {
  const code = root.querySelector('[data-code-preview] pre')
  if (code instanceof HTMLElement) return code
  const plain = root.querySelector('[data-textpreview-plain]')
  return plain instanceof HTMLElement ? plain : null
}

/** 把光标放到正文开头，进入修改后可以直接输入。 */
function placeCaret(host: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(host)
  range.collapse(true)
  const selection = window.getSelection()
  if (selection === null) return
  selection.removeAllRanges()
  selection.addRange(range)
}

// ─── 克隆与定位 ────────────────────────────────────────

/**
 * 克隆与原正文是同一父容器下的兄弟节点，字体、行高、行号都由同一套样式提供，
 * 所以只把定位改掉，不复制计算样式，避免覆盖掉类的原本效果；宽度交给 syncClip 固定。
 */
function copyLayoutStyles(host: HTMLElement, clone: HTMLElement): void {
  clone.style.margin = '0'
  clone.style.position = 'static'
  clone.style.overflow = 'visible'
  clone.style.boxSizing = 'border-box'
}

/** 找正文所在的可滚动祖先，编辑区只占它的可视范围。 */
function scrollportOf(host: HTMLElement): HTMLElement | null {
  let node = host.parentElement
  while (node !== null) {
    const style = window.getComputedStyle(node)
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return node
    node = node.parentElement
  }
  return null
}

/** 取原正文背后第一个完全不透明的背景色，编辑区靠它挡住原正文。 */
function backgroundOf(host: HTMLElement): string {
  let node: HTMLElement | null = host
  while (node !== null) {
    const color = window.getComputedStyle(node).backgroundColor
    // 半透明色挡不住下面的原正文，会露出两层文字，继续往上找。
    const alpha = /^rgba\([^)]*,\s*([\d.]+)\)$/.exec(color)
    if (color && color !== 'transparent' && (alpha === null || Number(alpha[1]) >= 1)) return color
    node = node.parentElement
  }
  const base = window.getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base').trim()
  return base || '#ffffff'
}

/**
 * 把编辑区裁到「原正文与预览可视区的交集」。
 * 只按原正文的矩形铺会盖住工具栏，因为正文滚到上方后它的矩形会跑到视口顶部之外。
 * @param clip - 编辑区容器。
 * @param clone - 编辑区里的正文克隆。
 * @param host - 原正文节点。
 * @returns 编辑区是否拿到了可用的尺寸。
 */
function layoutClip(clip: HTMLElement, clone: HTMLElement, host: HTMLElement): boolean {
  const hostRect = host.getBoundingClientRect()
  const view = scrollportOf(host)
  const viewRect = view === null
    ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
    : view.getBoundingClientRect()
  const left = Math.round(Math.max(hostRect.left, viewRect.left))
  const top = Math.round(Math.max(hostRect.top, viewRect.top))
  // 右边界取到可视区右缘，正好把预览自己的滚动条盖在下面，免得出现两条滚动条。
  const baseWidth = Math.max(0, Math.round(viewRect.right - left))
  const hostWidth = Math.round(hostRect.width)
  const height = Math.max(0, Math.round(Math.min(hostRect.bottom, viewRect.bottom) - top))
  const style = clip.style
  style.left = left + 'px'
  style.top = top + 'px'
  style.height = height + 'px'
  // 克隆宽度固定成原正文的宽度，裁剪区变宽不会改变代码折行位置。
  clone.style.width = hostWidth + 'px'
  // 自动换行时编辑区不能横向滚动：纵向滚动条会占掉一部分宽度，
  // 先把编辑区补宽，再把溢出的部分裁掉；没开自动换行就保留横向滚动。
  const wrapped = host.closest('[data-textpreview-wrap]') !== null && hostWidth <= baseWidth
  style.overflowX = wrapped ? 'hidden' : 'auto'
  style.width = baseWidth + 'px'
  if (!wrapped) return height > 0 && baseWidth > 0
  const scrollbar = clip.offsetWidth - clip.clientWidth
  const needed = hostWidth + scrollbar
  if (needed > baseWidth) style.width = needed + 'px'
  return height > 0 && baseWidth > 0
}

/** 摆好当前会话的编辑区；返回编辑区是否拿到了可用的尺寸。 */
function syncClip(session: EditSession): boolean {
  return layoutClip(session.clip, session.clone, session.host)
}

/**
 * 本文件所在标签页是否已不是当前活动页；页面没有标签页结构时一律当作仍在编辑。
 *
 * 先按标签标题匹配文件名。右栏窄时标题会被截断成「client (2 ...」，
 * 完整文件名匹配不上，这时退回看预览根是否还可见，否则一碰正文就会被误判成切走。
 * @param session - 当前会话。
 * @param root - 当前预览根。
 */
function isAway(session: EditSession, root: HTMLElement): boolean {
  const name = session.address.split('/').pop() ?? ''
  if (name === '') return false
  const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'))
  if (tabs.length === 0) return false
  const own = tabs.find(function (tab): boolean {
    return (tab.textContent ?? '').includes(name)
  })
  if (own !== undefined) return own.getAttribute('aria-selected') !== 'true'
  return root.getClientRects().length === 0
}

/**
 * 把光标放到可见区域的第一行，不放文件开头。
 * 浏览器会为选区自动滚动，光标留在文件开头时滚动位置会被拉回顶部，看起来像跳了一下。
 * @param clip - 编辑区容器。
 * @param clone - 编辑区里的正文克隆。
 */
function placeCaretAtVisibleStart(clip: HTMLElement, clone: HTMLElement): void {
  const rect = clip.getBoundingClientRect()
  const pick = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint
  const range = typeof pick === 'function' ? pick.call(document, rect.left + 60, rect.top + 25) : null
  const selection = window.getSelection()
  if (range !== null && selection !== null && clone.contains(range.startContainer)) {
    selection.removeAllRanges()
    selection.addRange(range)
    return
  }
  placeCaret(clone)
}

/**
 * 按原正文的当前位置摆放编辑区，并跟随滚动、缩放与预览重渲染。
 * 不用 requestAnimationFrame：页面不可见时它会被暂停，重渲染换掉的正文就再也找不回来。
 * @param session - 当前会话。
 */
function trackClip(session: EditSession): void {
  const sync = function (): void {
    if (session.closed) return
    const root = currentRoot(session)
    // 切到别的标签页时把编辑区藏起来，并按「无修改直接退出、有修改问用户」处理。
    if (isAway(session, root)) {
      session.clip.style.display = 'none'
      if (!session.away) {
        session.away = true
        session.onAway()
      }
      return
    }
    session.away = false
    const current = editableHost(root)
    if (current !== null && current !== session.host) session.host = current
    if (!session.clip.isConnected) {
      // 预览连父容器一起换了，把克隆挂回新正文旁边，样式上下文随之恢复。
      const mount = session.host.parentElement ?? document.body
      mount.append(session.clip)
    }
    // 原正文不隐藏，编辑区用不透明背景盖住它。算不出可用尺寸时就把编辑区收起来，
    // 让原正文露出来；预览重渲染期间会短暂量不到尺寸，下一轮同步自己恢复。
    session.clip.style.display = ''
    const hostRect = session.host.getBoundingClientRect()
    // 两边都量不出几何说明当前环境没有布局，不能据此判定失败，交给真实渲染去量。
    const measurable = hostRect.width > 1 && hostRect.height > 1
    if (measurable && !syncClip(session)) {
      session.clip.style.display = 'none'
      console.error('[classic-coding] 编辑区算不出尺寸，暂时退回预览', session.clip.getAttribute('style'))
    } else {
      syncClip(session)
    }
  }
  session.onSync = sync
  sync()
  session.timer = window.setInterval(sync, 300)
  window.addEventListener('scroll', sync, true)
  window.addEventListener('resize', sync)
}

/**
 * 两种预览的换行都要整理。
 *
 * 纯文本预览每行是块级元素，行文本带行尾换行；代码预览每行是块级 span.line，
 * 行内带尾随换行，行与行之间还夹一个只有换行的文本节点。可编辑区被套上 pre-wrap 后，
 * 这些换行都会再占一行，表现为双倍行距，读回文本也多出空行。
 *
 * 所以先删掉只有换行的文本节点，再去掉每行的行尾换行；空行补零宽字符撑住高度，保存时移除。
 * @param host - 可编辑的预览正文。
 */
function prepareHost(host: HTMLElement): void {
  // 可编辑区会被浏览器套上 pre-wrap，块级行之间单独成节点的换行会再占一行。
  removeNewlineText(host)
  // 纯文本预览的行带 data-textpreview-line，代码预览的行是 shiki 的 .line。
  // 两者都把换行写进行文本，可编辑状态下行尾换行同样会再占一行。
  for (const line of Array.from(host.querySelectorAll<HTMLElement>('[data-textpreview-line], .line'))) {
    trimTrailingNewline(line)
    if ((line.textContent ?? '') === '') line.textContent = '\u200b'
    // 进入时样式可算，把行盒判定记在元素上。切走后编辑区可能连同父容器被摘出文档，
    // 那时读不回计算样式，代码预览的 .line 会被误判成行内元素，换行就全丢了。
    if (isBlockElement(line)) line.dataset.ccBlock = '1'
  }
}

/** 删掉内容只有换行的文本节点；行与行之间的换行由块级行自己承担。 */
function removeNewlineText(host: HTMLElement): void {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  const victims: Text[] = []
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node instanceof Text && node.data === '\n') victims.push(node)
  }
  for (const node of victims) node.remove()
}

/** 去掉节点末尾文本里的换行，空掉的文本节点一并删除。 */
function trimTrailingNewline(line: Element): void {
  const last = line.lastChild
  if (last === null) return
  if (last instanceof Text) {
    last.data = last.data.replace(/\n+$/, '')
    if (last.data === '') last.remove()
    return
  }
  if (last instanceof HTMLElement) trimTrailingNewline(last)
}

/** 块级元素判定：优先用计算样式，取不到时按常见标签兜底。 */
function isBlockElement(el: Element): boolean {
  const display = window.getComputedStyle(el).display
  if (display) return display !== 'inline' && display !== 'inline-block' && display !== 'contents'
  return /^(DIV|P|LI|PRE|BLOCKQUOTE|SECTION|ARTICLE|H[1-6]|TR|TABLE|UL|OL)$/.test(el.tagName)
}

/** 记下行盒判定；必须在元素已挂进文档时调用，脱离文档读不到计算样式。 */
function markBlockLines(host: HTMLElement): void {
  for (const line of Array.from(host.querySelectorAll<HTMLElement>('[data-textpreview-line], .line'))) {
    if (isBlockElement(line)) line.dataset.ccBlock = '1'
  }
}

/**
 * 读出可编辑正文的纯文本。不用 innerText：两种预览的行结构不同，
 * 而且编辑器对块级换行与行尾换行的处理会随浏览器实现漂移。
 * 这里文本节点原样保留，BR 算一个换行，块级元素收尾补一个换行。
 * @param host - 可编辑的预览正文。
 */
function readHostText(host: HTMLElement): string {
  let text = ''
  const walk = function (node: Node, isRoot: boolean): void {
    if (node.nodeType === Node.TEXT_NODE) {
      text += (node as Text).data.replace(/\u200b/g, '')
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    if (el.tagName === 'BR') {
      text += '\n'
      return
    }
    const start = text.length
    for (const child of Array.from(el.childNodes)) walk(child, false)
    const block = el.dataset.ccBlock === '1' || isBlockElement(el)
    // 空块级元素也要占一行，否则整份内容里的空行会被相邻块级之间的一次换行吞掉。
    if (!isRoot && block && (text.length === start || !text.endsWith('\n'))) text += '\n'
  }
  walk(host, true)
  return text
}

/** 在当前选区插入纯文本，供 Tab 缩进使用。 */
function insertTextAtCaret(text: string): void {
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0) return
  const range = selection.getRangeAt(0)
  range.deleteContents()
  const node = document.createTextNode(text)
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

/**
 * 进入修改：整理正文换行并把正文设为可编辑，返回会话或错误原因。
 * @param root - 文档预览根节点。
 * @param address - 当前文档地址。
 * @param absolutePath - 写回目标。
 * @param text - 完整文件内容。
 */
function openSession(
  root: HTMLElement,
  address: string,
  sessionId: string,
  path: string,
  absolutePath: string,
  version: string,
  text: string,
): EditSession | string {
  const host = editableHost(root)
  if (host === null) return '当前预览没有可编辑的正文'
  const clone = host.cloneNode(true)
  if (!(clone instanceof HTMLElement)) return '当前预览的正文无法复制'
  copyLayoutStyles(host, clone)
  prepareHost(clone)

  const clip = document.createElement('div')
  clip.className = 'dsh-cc-clip'
  clip.dataset.plugin = 'dsh-classic-coding'
  clip.style.background = backgroundOf(host)
  clip.append(clone)
  // 先按当前矩形摆好再挂上去，第一帧就不会闪到别处。
  layoutClip(clip, clone, host)
  // 挂在原正文的父容器里，克隆才能继承 .md-code-block 之类提供的行样式与行号；
  // 定位仍用固定定位，不占文档流。
  const mount = host.parentElement ?? document.body
  mount.append(clip)
  // 挂进文档之后才读得到计算样式，行盒判定补记在这里才准。
  markBlockLines(clone)

  const session: EditSession = {
    address: address,
    absolutePath: absolutePath,
    original: text,
    version: version,
    sessionId: sessionId,
    path: path,
    root: root,
    host: host,
    clone: clone,
    clip: clip,
    timer: 0,
    onSync: function (): void {},
    onKeyDown: function (): void {},
    onAway: function (): void {},
    away: false,
    closed: false,
  }
  clone.setAttribute('contenteditable', 'plaintext-only')
  clone.classList.add('dsh-cc-editing')
  clone.spellcheck = false
  // 先按原预览的滚动位置摆好编辑区，再放光标：光标落在可见区首行，
  // 浏览器就不会为显示光标把编辑区滚回顶部，切换时位置不会跳。
  const view = scrollportOf(host)
  const scrollTop = view === null ? 0 : Math.max(0, Math.round(view.getBoundingClientRect().top - host.getBoundingClientRect().top))
  clip.scrollTop = scrollTop
  clone.focus({ preventScroll: true })
  placeCaretAtVisibleStart(clip, clone)
  clip.scrollTop = scrollTop
  trackClip(session)
  activeSession = session
  return session
}

/**
 * 内置文档预览工具栏上的修改按键：进入修改模式，再按一次保存并退出。
 *
 * 进入时整份读取文件并覆盖预览正文，不注册 tab、不引入编辑器库；
 * 保存走 Host 自注册端点，成功后触发内置预览重读。
 * @param props - 文档动作 owner 面与框架注入的 tab 读取器。
 */
function EditAction(props: DocumentActionProps): React.ReactElement {
  const info = props.useTabInfo()
  const buttonRef = React.useRef<HTMLButtonElement | null>(null)
  const sessionRef = React.useRef<EditSession | null>(activeSession)
  const mountedRef = React.useRef(true)
  const [editing, setEditing] = React.useState(activeSession !== null && activeSession.address === info.tab.contentId)
  const [busy, setBusy] = React.useState(false)

  /** 关闭会话并同步按键状态。 */
  function closeAndReset(session: EditSession): void {
    closeSession(session)
    if (sessionRef.current === session) sessionRef.current = null
    if (mountedRef.current) setEditing(false)
  }

  /** 让内置预览立刻重读；自动刷新之外再补一次，重复无害。 */
  function refreshPreview(root: Element): void {
    const reload = root.querySelector('[data-textpreview-tool="reload"]')
    if (reload instanceof HTMLElement) reload.click()
  }

  /**
   * 放弃修改：未改直接退出；有未保存的修改先确认，用户不确认就留在编辑模式，
   * 不能静默丢掉。确认后再用内置刷新恢复预览。
   */
  async function cancelSession(session: EditSession): Promise<void> {
    const root = currentRoot(session)
    prepareHost(session.clone)
    const changed = !sameText(readHostText(session.clone), session.original)
    if (changed) {
      // 和切走标签时同一套选择：能直接保存，也能留在编辑模式。
      const choice = await askAway()
      if (session.closed) return
      if (choice === 'keep') return
      if (choice === 'save') {
        void saveSession(session)
        return
      }
    }
    closeAndReset(session)
    if (changed) refreshPreview(root)
  }

  /** 只带一个确定按钮的提示，替代会弹出原生框的 window.alert。 */
  function notify(titleText: string, bodyText: string): Promise<void> {
    return showChoice(titleText, bodyText, [{ label: '确定', value: 'ok', primary: true }])
      .then(function (): void {})
  }

  /**
   * 读当前磁盘上的文件版本；读不到就返回 null，按没有冲突处理。
   * @param session - 当前会话。
   */
  async function readFileVersion(session: EditSession): Promise<string | null> {
    if (remote === null) return null
    try {
      const result = await remote.workspaceFiles.readBytes(
        session.sessionId,
        session.path,
        { range: { offset: 0, length: 1 } },
      )
      if (!result.ok) return null
      return result.value.version
    } catch (e) {
      console.error('[classic-coding] 读取文件版本失败', e)
      return null
    }
  }

  /**
   * 文件被外部改动时问用户：覆盖保存、回到编辑，还是放弃本地修改。
   * @returns 用户的选择。
   */
  /**
   * 弹出带若干按钮的选择框，返回所选值。
   * @param titleText - 标题。
   * @param bodyText - 说明文字。
   * @param choices - 按钮与返回值。
   */
  function showChoice(
    titleText: string,
    bodyText: string,
    choices: Array<{ label: string; value: string; primary: boolean }>,
  ): Promise<string> {
    return new Promise(function (resolve): void {
      const mask = document.createElement('div')
      mask.className = 'dsh-cc-conflict-mask'
      mask.dataset.plugin = 'dsh-classic-coding'
      const panel = document.createElement('div')
      panel.className = 'dsh-cc-conflict'
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-modal', 'true')
      panel.setAttribute('aria-label', titleText)
      const title = document.createElement('p')
      title.className = 'dsh-cc-conflict-title'
      title.textContent = titleText
      const text = document.createElement('p')
      text.className = 'dsh-cc-conflict-text'
      text.textContent = bodyText
      const actions = document.createElement('div')
      actions.className = 'dsh-cc-conflict-actions'
      const close = function (value: string): void {
        mask.remove()
        resolve(value)
      }
      for (const choice of choices) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = choice.primary ? 'dsh-cc-conflict-action dsh-cc-conflict-primary' : 'dsh-cc-conflict-action'
        button.dataset.choice = choice.value
        button.textContent = choice.label
        button.addEventListener('click', function (): void { close(choice.value) })
        actions.append(button)
      }
      panel.append(title, text, actions)
      mask.append(panel)
      mask.addEventListener('keydown', function (event: KeyboardEvent): void {
        if (event.key !== 'Escape') return
        event.preventDefault()
        const last = choices[choices.length - 1]
        if (last !== undefined) close(last.value)
      })
      document.body.append(mask)
      const first = actions.firstElementChild
      if (first instanceof HTMLElement) first.focus()
    })
  }

  function askOverwrite(): Promise<'overwrite' | 'cancel' | 'discard'> {
    return showChoice('文件已被其他程序修改', '继续保存会覆盖对方的修改。要覆盖吗？', [
      { label: '是', value: 'overwrite', primary: true },
      { label: '否', value: 'cancel', primary: false },
      { label: '放弃修改', value: 'discard', primary: false },
    ]).then(function (value): 'overwrite' | 'cancel' | 'discard' {
      return value as 'overwrite' | 'cancel' | 'discard'
    })
  }

  function askAway(): Promise<'save' | 'discard' | 'keep'> {
    return showChoice('文件有未保存的修改', '离开修改模式前要保存吗？', [
      { label: '保存', value: 'save', primary: true },
      { label: '放弃', value: 'discard', primary: false },
      { label: '保留', value: 'keep', primary: false },
    ]).then(function (value): 'save' | 'discard' | 'keep' {
      return value as 'save' | 'discard' | 'keep'
    })
  }

  /** 切到别的标签页：没改直接退出，有改问保存、放弃还是保留。 */
  async function handleAway(session: EditSession): Promise<void> {
    if (session.closed) return
    if (sameText(readHostText(session.clone), session.original)) {
      closeAndReset(session)
      return
    }
    const choice = await askAway()
    if (choice === 'discard') {
      // 必须一并复位工具栏状态，否则按钮还是「取消修改」，下次点击会走取消而不是进入。
      closeAndReset(session)
      return
    }
    if (choice === 'save') await saveSession(session)
  }

  /**
   * 写回绝对路径；成功后退出修改并刷新预览。
   * 内容没变时按 VS Code 一类 GUI 编辑器的习惯直接退出，不写盘也不刷新。
   */
  async function saveSession(session: EditSession): Promise<void> {
    const root = currentRoot(session)
    if (root.getAttribute('data-textpreview-url') !== session.address) {
      closeAndReset(session)
      void notify('修改未保存', '预览已切换到别的文件，这次修改没有保存')
      return
    }
    const liveHost = editableHost(root)
    if (liveHost !== null) session.host = liveHost
    // 切走时预览可能重渲染换掉了父容器，编辑区跟着被摘出文档。那时读不回计算样式，
    // 行盒会被误判，换行全丢；先挂回文档再整理正文。
    if (!session.clip.isConnected) {
      const mount = session.host.parentElement ?? document.body
      mount.append(session.clip)
    }
    prepareHost(session.clone)
    markBlockLines(session.clone)
    const current = readHostText(session.clone)
    if (sameText(current, session.original)) {
      closeAndReset(session)
      return
    }
    const version = await readFileVersion(session)
    if (version !== null && version !== session.version) {
      const choice = await askOverwrite()
      if (choice === 'cancel') return
      if (choice === 'discard') {
        closeAndReset(session)
        refreshPreview(root)
        return
      }
    }
    try {
      await rpcCall<unknown>('writeFile', { path: session.absolutePath, content: saveText(current, session.original) })
      closeAndReset(session)
      refreshPreview(root)
    } catch (e) {
      // 保留可编辑状态与已改内容，用户可再按一次重试。
      console.error('[classic-coding] 保存失败', e)
      void notify('保存失败', messageOf(e))
    }
  }

  /** 把预览正文设为可编辑；text 为完整原文。返回错误原因或 null。 */
  function installEditor(
    root: HTMLElement,
    address: string,
    sessionId: string,
    path: string,
    absolutePath: string,
    version: string,
    text: string,
  ): string | null {
    const opened = openSession(root, address, sessionId, path, absolutePath, version, text)
    if (typeof opened === 'string') return opened
    const session = opened
    session.onAway = function (): void { void handleAway(session) }
    const onKeyDown = function (event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        void cancelSession(session)
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        event.stopPropagation()
        void saveSession(session)
        return
      }
      if (event.key !== 'Tab') return
      // 代码里 Tab 应当缩进而不是跳焦点。
      event.preventDefault()
      insertTextAtCaret(TAB_SPACES)
    }
    session.onKeyDown = onKeyDown
    session.clone.addEventListener('keydown', onKeyDown)
    sessionRef.current = session
    setEditing(true)
    return null
  }

  /** 进入修改：读取整份文件后把预览正文设为可编辑。 */
  async function enter(): Promise<void> {
    if (busy) return
    const button = buttonRef.current
    const root = button === null ? null : button.closest('[data-textpreview-state]')
    if (!(root instanceof HTMLElement)) {
      console.error('[classic-coding] 找不到文档预览根节点')
      return
    }
    const address = root.getAttribute('data-textpreview-url')
    const parsed = address === null ? null : parseFileAddress(address)
    if (address === null || parsed === null || remote === null) {
      console.error('[classic-coding] 无法确定当前预览的文件地址', { address: address })
      return
    }
    // 另一个文件还在编辑中：先确认放弃，别把那份没保存的修改静默丢掉。
    const other = activeSession
    if (other !== null && other.address !== address) {
      const changed = !sameText(readHostText(other.clone), other.original)
      if (changed) {
        const choice = await showChoice('另一个文件还有未保存的修改', '放弃这些修改才能打开新的文件。要放弃吗？', [
          { label: '确定', value: 'discard', primary: true },
          { label: '取消', value: 'keep', primary: false },
        ])
        if (choice !== 'discard') return
      }
      closeSession(other)
      sessionRef.current = null
      setEditing(false)
    }
    const api = remote
    setBusy(true)
    try {
      const result = await api.workspaceFiles.readBytes(parsed.sessionId, parsed.path, {}, info.tab.signal)
      if (!mountedRef.current) return
      if (!result.ok) throw new Error(result.error.message ?? '读取失败')
      const file = result.value
      // 读取是异步的，期间预览可能已经重渲染或关掉，重新按地址取当前的根。
      const live = findPreviewRoot(address)
      if (live === null || !live.isConnected) throw new Error('预览已关闭')
      const error = installEditor(
        live,
        address,
        parsed.sessionId,
        parsed.path,
        file.absolutePath,
        file.version,
        new TextDecoder().decode(file.data),
      )
      if (error !== null) throw new Error(error)
    } catch (e: unknown) {
      console.error('[classic-coding] 进入修改模式失败', e)
      void notify('无法进入修改模式', messageOf(e))
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  /** 取消修改：退出可编辑，已改过的 DOM 由内置刷新恢复。 */
  function cancel(): void {
    const session = sessionRef.current
    if (session !== null) void cancelSession(session)
  }

  // 组件会随官方预览重渲染重挂；会话放模块级，卸载时只清本地引用。
  React.useEffect(function () {
    mountedRef.current = true
    return function (): void {
      mountedRef.current = false
      sessionRef.current = null
    }
  }, [])

  // 会话是全局的，切到别的文件时按钮不能还显示「编辑中」。
  React.useEffect(function (): void {
    const session = activeSession
    setEditing(session !== null && session.address === info.tab.contentId)
  }, [info.tab.contentId])

  const editButton = React.createElement('button', {
    ref: buttonRef,
    type: 'button',
    className: 'dsh-cc-edit-action',
    title: editing ? '古法编程：取消修改' : '古法编程：修改文件',
    'aria-label': editing ? '古法编程：取消修改' : '古法编程：修改文件',
    'aria-pressed': editing,
    disabled: busy,
    onClick: editing ? cancel : function (): void { void enter() },
  },
  // 修改按键是「古」字，进入修改后翻成倒写的「古」表示退出。
  React.createElement('span', {
    className: editing ? 'dsh-cc-glyph dsh-cc-glyph-flip' : 'dsh-cc-glyph',
    'aria-hidden': 'true',
  }, '古'))
  if (!editing) return editButton
  const saveButton = React.createElement('button', {
    type: 'button',
    className: 'dsh-cc-save',
    title: '保存 Ctrl+S',
    'aria-label': '保存',
    // 按下时不要把焦点从正文移走：失焦会让浏览器重排可编辑区，读回的换行会变。
    onMouseDown: function (event: React.MouseEvent<HTMLButtonElement>): void { event.preventDefault() },
    onClick: function (): void {
      const session = sessionRef.current
      if (session !== null) void saveSession(session)
    },
  }, React.createElement('svg', {
    width: 15,
    height: 15,
    viewBox: '0 0 16 16',
    'aria-hidden': 'true',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.2,
    strokeLinejoin: 'round',
  },
  // 经典软盘轮廓：右上切角、顶部写保护滑片、底部标签。
  React.createElement('path', { d: 'M3.8 2.3h6.6l2.8 2.8v8.1a1 1 0 0 1-1 1H3.8a1 1 0 0 1-1-1V3.3a1 1 0 0 1 1-1Z' }),
  React.createElement('path', { d: 'M5.6 2.3v3.1h4.5V2.3' }),
  React.createElement('path', { d: 'M5.1 14.2v-4.4h5.8v4.4' })))
  return React.createElement(React.Fragment, null, saveButton, editButton)
}


// ─── 插件入口 ──────────────────────────────────────────

/** 插件名，与 cordis.patch.yml 的 name 一致。 */
export const name = 'dsh-classic-coding'

/** 依赖的客户端服务：槽位与远端命名空间及其 workspaceFiles 面。 */
export const inject: string[] = ['slots', 'remote', 'remote.workspaceFiles']

/**
 * 客户端 apply：给内置文档预览的工具栏加修改按键。
 *
 * 只对内置的代码与纯文本渲染器注册，不碰正文席位与 tab 类型；
 * 注册与插件同寿，故放进 ctx.effect。
 * @param ctx - 客户端插件上下文。
 */
export function apply(ctx: ClientContext): void {
  const slots = ctx.get('slots') as SlotsService | undefined
  if (!slots) return
  const remoteService = ctx.get('remote') as RemoteService | undefined
  if (!remoteService) throw new Error('[classic-coding] 缺少 remote 服务，请确认 dsh-api-workspace-files 已加载')
  remote = remoteService

  ctx.effect(function () {
    ensureStyle()
    return function () { removeStyle() }
  })

  for (const renderer of EDITABLE_RENDERERS) {
    const suffix = renderer.slice(renderer.lastIndexOf('/') + 1)
    ctx.effect(function () {
      return slots.inject('sidebar.right.tab.document.action', function () {
        return slots.register(
          { name: 'sidebar.right.tab.document.action', key: renderer, id: 'dsh-classic-coding-' + suffix },
          EditAction,
        )
      })
    })
  }
}

const plugin = { name, inject, apply }
export default plugin

