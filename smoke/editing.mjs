/**
 * 修改模式的显式保存回归测试。
 *
 * 用 happy-dom 搭一个内置预览的最小 DOM，真实 React 渲染工具栏组件，
 * 覆盖进入、显式保存、取消与未改动保存四条路径。
 *
 * 前置：先执行 pnpm build 生成 lib/。
 * 用法：pnpm test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { Window } from 'happy-dom'
import React from 'react'

let failed = 0
function check(label, cond, extra) {
  if (cond) console.log('  OK   ' + label)
  else { failed++; console.log('  FAIL ' + label + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra))) }
}
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

const window = new Window({ url: 'http://localhost/' })
const alerts = []
window.alert = (message) => { alerts.push(message) }
const document = window.document
globalThis.window = window
globalThis.document = document
const { createRoot } = await import('react-dom/client')

const original = 'const a = 1\n\nconst b = 2\n'
const address = 'dsh-resource://file/session/s1/notes.ts'

// 内置纯文本预览的真实结构：正文是 div[data-textpreview-plain] > pre > 每行一个块级
// div[data-textpreview-line]，行文本带行尾换行，空行只有换行。
let pre = null
function setLines(lines) {
  pre.textContent = ''
  lines.forEach((text, index) => {
    const line = document.createElement('div')
    line.setAttribute('data-textpreview-line', String(index + 1))
    line.append(text + '\n')
    pre.append(line)
  })
}

/** 当前修改会话的克隆正文，挂在预览之外的定位容器里。 */
function cloneHost() {
  const clip = document.querySelector('.dsh-cc-clip')
  return clip === null ? null : clip.firstElementChild
}

function setLine(index, text) {
  const clone = cloneHost()
  const line = clone.querySelectorAll('[data-textpreview-line]')[index]
  line.textContent = text + '\n'
}

document.body.innerHTML = ''
const root = document.createElement('div')
root.setAttribute('data-textpreview-state', 'text')
root.setAttribute('data-textpreview-url', address)
const content = document.createElement('div')
content.setAttribute('data-textpreview-content', '')
const body = document.createElement('div')
body.setAttribute('data-textpreview-body', '')
const plain = document.createElement('div')
plain.setAttribute('data-textpreview-plain', '')
pre = document.createElement('pre')
pre.className = 'page'
setLines(['const a = 1', '', 'const b = 2'])
plain.append(pre)
body.append(plain)
content.append(body)
root.append(content)
const toolbar = document.createElement('div')
root.append(toolbar)
document.body.append(root)

// 加载构建产物，注入真实 React 与远端 mock。
let entry = null
window.__ModuleLoader__ = { load(value) { entry = value } }
const writes = []
let reads = 0
let fileVersion = 'v1'
const remote = {
  workspaceFiles: {
    async readBytes() {
      reads++
      return {
        ok: true,
        value: {
          absolutePath: 'C:/x/notes.ts',
          version: fileVersion,
          offset: 0,
          data: new TextEncoder().encode(original),
          eof: true,
        },
      }
    },
  },
}
const registrations = []
const slots = {
  inject(name, callback) { callback() },
  register(options, component) { registrations.push({ options, component }); return () => {} },
}
const clientCtx = {
  get(service) {
    if (service === 'slots') return slots
    if (service === 'remote') return remote
    return undefined
  },
  effect(callback) { callback() },
}
const fetchMock = async (url, init) => {
  writes.push(JSON.parse(init.body))
  return { ok: true, status: 200, json: async () => ({ result: { ok: true, value: { ok: true } } }) }
}
const sandbox = {
  window, document,
  Node: window.Node, Text: window.Text, Element: window.Element, HTMLElement: window.HTMLElement,
  NodeFilter: window.NodeFilter, TextEncoder, TextDecoder, AbortController,
  fetch: fetchMock, console, setTimeout, clearTimeout, setInterval, clearInterval,
}
vm.createContext(sandbox)
vm.runInContext(readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8'), sandbox)

const mod = entry.factory((id) => {
  if (id === 'react') return React
  throw new Error('未预期的外部模块: ' + id)
})
mod.apply(clientCtx)
check('注册两个渲染器', registrations.length === 2, registrations.map(r => r.options.key))

const component = registrations.find(r => /\/text$/.test(r.options.key)).component
const props = {
  content: { kind: 'text', eof: true },
  useTabInfo: () => ({ tab: { contentId: address, signal: new AbortController().signal } }),
}
const reactRoot = createRoot(toolbar)
reactRoot.render(React.createElement(component, props))
await tick()

console.log('[编辑] 进入')
const editButton = toolbar.querySelector('.dsh-cc-edit-action')
check('修改按键已渲染', editButton !== null)
check('未编辑时没有保存按钮', toolbar.querySelector('.dsh-cc-save') === null)
editButton.click()
await tick()
check('读取一次整份文件', reads === 1, reads)
const entered = cloneHost()
check('正文变为可编辑', entered !== null && entered.getAttribute('contenteditable') === 'plaintext-only', entered === null ? null : entered.getAttribute('contenteditable'))
check('原正文仍在，编辑区盖在上面', plain.style.visibility !== 'hidden' && document.querySelector('.dsh-cc-clip') !== null)
check('出现显式保存按钮', toolbar.querySelector('.dsh-cc-save') !== null)
check('进入时不写盘', writes.length === 0)
check('克隆保留原文行结构', entered !== null && entered.innerText.replace(/\u200b/g, '').replace(/\n+$/, '') === 'const a = 1\n\nconst b = 2', entered === null ? null : JSON.stringify(entered.innerText))

console.log('[编辑] 显式保存')
setLine(0, 'const a = 3')
toolbar.querySelector('.dsh-cc-save').click()
await tick(40)
check('显式保存调用一次写盘', writes.length === 1, writes.length)
const payload = writes[0] && writes[0].payload
check('保存内容逐字节正确且保留空行', payload && payload.content === 'const a = 3\n\nconst b = 2\n', payload && payload.content)
check('保存后退出可编辑', cloneHost() === null)
check('保存后原正文恢复可见', plain.style.visibility !== 'hidden', plain.style.visibility)
check('保存后保存按钮消失', toolbar.querySelector('.dsh-cc-save') === null)

console.log('[编辑] 取消')
editButton.click()
await tick()
check('再次进入', cloneHost() !== null && cloneHost().getAttribute('contenteditable') === 'plaintext-only')
setLine(0, 'const a = 9')
toolbar.querySelector('.dsh-cc-edit-action').click()
await tick()
const cancelMask = document.querySelector('.dsh-cc-conflict-mask')
check('改过之后取消要先确认', cancelMask !== null)
cancelMask.querySelector('[data-choice="discard"]').click()
await tick()
check('取消不写盘', writes.length === 1, writes.length)
check('取消后退出可编辑', cloneHost() === null)
check('取消后原正文恢复可见', plain.style.visibility !== 'hidden', plain.style.visibility)

console.log('[编辑] 取消确认')
editButton.click()
await tick()
setLine(0, 'const a = 7')
toolbar.querySelector('.dsh-cc-edit-action').click()
await tick()
const keepMask = document.querySelector('.dsh-cc-conflict-mask')
check('取消时弹出应用内确认框', keepMask !== null)
keepMask.querySelector('[data-choice="keep"]').click()
await tick()
check('不确认时留在编辑模式', cloneHost() !== null && cloneHost().getAttribute('contenteditable') === 'plaintext-only')
check('不确认时修改还在', cloneHost() !== null && cloneHost().textContent.includes('const a = 7'))
toolbar.querySelector('.dsh-cc-edit-action').click()
await tick()
const discardMask = document.querySelector('.dsh-cc-conflict-mask')
check('再次取消仍弹确认框', discardMask !== null)
discardMask.querySelector('[data-choice="discard"]').click()
await tick()
check('确认后退出编辑', cloneHost() === null)
check('确认后不写盘', writes.length === 1, writes.length)

console.log('[编辑] 未改动保存')
// 真实预览在取消后会由内置刷新重读；这里直接恢复 DOM 代替刷新按钮。
setLines(['const a = 1', '', 'const b = 2'])
editButton.click()
await tick()
toolbar.querySelector('.dsh-cc-save').click()
await tick(40)
check('未改动保存不写盘', writes.length === 1, writes.length)
check('未改动保存后退出可编辑', cloneHost() === null)

console.log('[编辑] 文件被外部修改')
setLines(['const a = 1', '', 'const b = 2'])
editButton.click()
await tick()
setLine(0, 'const a = 5')
fileVersion = 'v2'
toolbar.querySelector('.dsh-cc-save').click()
await tick(60)
let conflict = document.querySelector('.dsh-cc-conflict')
check('外部改动时弹确认框', conflict !== null)
check('确认前不写盘', writes.length === 1, writes.length)
conflict.querySelector('[data-choice="cancel"]').click()
await tick(40)
check('选否留在编辑模式', cloneHost() !== null)
check('选否不写盘', writes.length === 1, writes.length)
toolbar.querySelector('.dsh-cc-save').click()
await tick(60)
conflict = document.querySelector('.dsh-cc-conflict')
check('再次保存仍弹确认框', conflict !== null)
conflict.querySelector('[data-choice="discard"]').click()
await tick(40)
check('放弃修改后退出编辑', cloneHost() === null)
check('放弃修改不写盘', writes.length === 1, writes.length)
fileVersion = 'v2'
editButton.click()
await tick()
setLine(0, 'const a = 6')
fileVersion = 'v3'
toolbar.querySelector('.dsh-cc-save').click()
await tick(60)
conflict = document.querySelector('.dsh-cc-conflict')
check('覆盖前弹确认框', conflict !== null)
conflict.querySelector('[data-choice="overwrite"]').click()
await tick(60)
check('选是写盘', writes.length === 2, writes.length)
check('选是退出编辑', cloneHost() === null)

console.log('[编辑] 切走标签页')
check('切走用例开始前已写盘 2 次', writes.length === 2, writes.length)
const tabOwn = document.createElement('div')
tabOwn.setAttribute('role', 'tab')
tabOwn.setAttribute('aria-selected', 'true')
tabOwn.textContent = 'notes.ts'
const tabOther = document.createElement('div')
tabOther.setAttribute('role', 'tab')
tabOther.setAttribute('aria-selected', 'false')
tabOther.textContent = '其他'
document.body.append(tabOwn, tabOther)
setLines(['const a = 1', '', 'const b = 2'])
// 有修改切走：先选保留，再选放弃。
editButton.click()
await tick()
setLine(0, 'const a = 8')
tabOwn.setAttribute('aria-selected', 'false')
tabOther.setAttribute('aria-selected', 'true')
await tick(420)
const away = document.querySelector('.dsh-cc-conflict')
check('有修改切走弹选择框', away !== null && away.textContent.includes('保存'))
away.querySelector('[data-choice="keep"]').click()
await tick(60)
check('选保留留在编辑模式', cloneHost() !== null)
check('选保留不写盘', writes.length === 2, writes.length)
tabOwn.setAttribute('aria-selected', 'true')
tabOther.setAttribute('aria-selected', 'false')
await tick(420)
check('切回后编辑区恢复可见', cloneHost() !== null && document.querySelector('.dsh-cc-clip').style.display === '')
check('切回不写盘', writes.length === 2, writes.length)
tabOwn.setAttribute('aria-selected', 'false')
tabOther.setAttribute('aria-selected', 'true')
await tick(420)
document.querySelector('.dsh-cc-conflict').querySelector('[data-choice="discard"]').click()
await tick(60)
check('选放弃退出编辑', cloneHost() === null)
check('切走放弃不写盘', writes.length === 2, writes.length)
tabOwn.remove()
tabOther.remove()

console.log('[编辑] 切走后保存')
const writesBeforeAwaySave = writes.length
const tabKeep = document.createElement('div')
tabKeep.setAttribute('role', 'tab')
tabKeep.setAttribute('aria-selected', 'true')
tabKeep.textContent = 'notes.ts'
const tabLeave = document.createElement('div')
tabLeave.setAttribute('role', 'tab')
tabLeave.setAttribute('aria-selected', 'false')
tabLeave.textContent = '其他'
document.body.append(tabKeep, tabLeave)
setLines(['const a = 1', '', 'const b = 2'])
editButton.click()
await tick(60)
setLine(0, 'const a = 2')
tabKeep.setAttribute('aria-selected', 'false')
tabLeave.setAttribute('aria-selected', 'true')
await tick(420)
const awaySave = document.querySelector('.dsh-cc-conflict')
check('切走弹选择框', awaySave !== null)
awaySave.querySelector('[data-choice="save"]').click()
await tick(150)
const awayPayload = writes.length > writesBeforeAwaySave ? writes[writes.length - 1].payload : null
check('切走后保存保留换行', awayPayload !== null && awayPayload.content === 'const a = 2\n\nconst b = 2\n', awayPayload === null ? null : awayPayload.content)
check('切走后保存退出可编辑', cloneHost() === null)
tabKeep.remove()
tabLeave.remove()

console.log('[编辑] 切走后编辑区被摘下仍保留换行')
// 预览重渲染会换掉父容器，编辑区可能连同一起被摘出文档；此时读正文不能依赖布局。
const writesBeforeDetached = writes.length
const tabKeep2 = document.createElement('div')
tabKeep2.setAttribute('role', 'tab')
tabKeep2.setAttribute('aria-selected', 'true')
tabKeep2.textContent = 'notes.ts'
const tabLeave2 = document.createElement('div')
tabLeave2.setAttribute('role', 'tab')
tabLeave2.setAttribute('aria-selected', 'false')
tabLeave2.textContent = '其他'
document.body.append(tabKeep2, tabLeave2)
setLines(['const a = 1', '', 'const b = 2'])
editButton.click()
await tick(60)
setLine(0, 'const a = 8')
tabKeep2.setAttribute('aria-selected', 'false')
tabLeave2.setAttribute('aria-selected', 'true')
await tick(420)
const detachedChoice = document.querySelector('.dsh-cc-conflict')
check('摘下前弹出选择框', detachedChoice !== null)
const detachedClip = document.querySelector('.dsh-cc-clip')
detachedClip.remove()
detachedChoice.querySelector('[data-choice="save"]').click()
await tick(150)
const detachedPayload = writes.length > writesBeforeDetached ? writes[writes.length - 1].payload : null
check('编辑区被摘下后保存仍保留换行', detachedPayload !== null && detachedPayload.content === 'const a = 8\n\nconst b = 2\n', detachedPayload === null ? null : detachedPayload.content)
tabKeep2.remove()
tabLeave2.remove()

console.log('[编辑] 取消时选保存')
const writesBeforeCancel = writes.length
setLines(['const a = 1', '', 'const b = 2'])
editButton.click()
await tick(60)
setLine(0, 'const a = 4')
toolbar.querySelector('.dsh-cc-edit-action').click()
await tick()
const saveMask = document.querySelector('.dsh-cc-conflict-mask')
check('取消时给出保存分支', saveMask !== null && saveMask.textContent.includes('保存'))
saveMask.querySelector('[data-choice="save"]').click()
await tick(100)
check('选保存后写盘', writes.length === writesBeforeCancel + 1, writes.length)
check('选保存后退出可编辑', cloneHost() === null)

console.log('[编辑] 代码视图整份文本')
const writesBeforeCode = writes.length
// 代码视图把整份源码放在一个 span.line 里，换行是文本内容本身，不能再被整理掉。
const codeOriginal = 'const a = 1\n\nconst b = 2\n'
const codeAddress = 'dsh-resource://file/session/s1/sample.ts'
const codeRoot = document.createElement('div')
codeRoot.setAttribute('data-textpreview-state', 'text')
codeRoot.setAttribute('data-textpreview-url', codeAddress)
const codeContent = document.createElement('div')
codeContent.setAttribute('data-textpreview-content', '')
const codeBody = document.createElement('div')
codeBody.setAttribute('data-textpreview-body', '')
const codeWrap = document.createElement('div')
codeWrap.setAttribute('data-code-preview', '')
const shiki = document.createElement('pre')
shiki.className = 'shiki css-variables'
const shikiCode = document.createElement('code')
// 真实代码预览：每个源码行一个块级 span.line，行尾带换行，行与行之间还夹一个换行文本节点。
const shikiLines = ['const a = 1', '', 'const b = 2'].map(text => {
  const line = document.createElement('span')
  line.className = 'line'
  // 真实样式里 shiki 的 .line 是块级；happy-dom 不加载样式表，这里直接标出来。
  line.style.display = 'block'
  line.append(text + '\n')
  return line
})
shikiCode.append(shikiLines[0], '\n', shikiLines[1], '\n', shikiLines[2], '\n')
shiki.append(shikiCode)
codeWrap.append(shiki)
codeBody.append(codeWrap)
codeContent.append(codeBody)
codeRoot.append(codeContent)
const codeToolbar = document.createElement('div')
codeRoot.append(codeToolbar)
document.body.append(codeRoot)

const codeProps = {
  content: { kind: 'text', eof: true },
  useTabInfo: () => ({ tab: { contentId: codeAddress, signal: new AbortController().signal } }),
}
const codeReactRoot = createRoot(codeToolbar)
codeReactRoot.render(React.createElement(component, codeProps))
await tick()
const codeEditButton = codeToolbar.querySelector('.dsh-cc-edit-action')
check('代码视图出现修改按键', codeEditButton !== null)
codeEditButton.click()
await tick()
const codeEntered = cloneHost()
check('代码视图正文可编辑', codeEntered !== null && codeEntered.getAttribute('contenteditable') === 'plaintext-only', codeEntered === null ? null : codeEntered.getAttribute('contenteditable'))
const codeLinesNow = codeEntered === null ? null : [...codeEntered.querySelectorAll('.line')].map(line => line.textContent)
check('代码视图行结构与换行保留', codeLinesNow !== null && JSON.stringify(codeLinesNow) === JSON.stringify(['const a = 1', '\u200b', 'const b = 2']), codeLinesNow)
check('代码视图进入时不写盘', writes.length === writesBeforeCode, writes.length)
codeToolbar.querySelector('.dsh-cc-save').click()
await tick(40)
check('代码视图未改动保存不写盘', writes.length === writesBeforeCode, writes.length)
check('代码视图保存后退出可编辑', cloneHost() === null)
codeReactRoot.unmount()

reactRoot.unmount()
window.close()

console.log(failed === 0 ? '\n全部通过' : '\n失败 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)
