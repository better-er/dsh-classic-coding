/**
 * 产物冒烟验证：host 端保存端点 + client 端 tab 类型注册。
 *
 * 前置：先执行 pnpm build 生成 lib/，本脚本直接消费构建产物。
 * 用法：pnpm smoke
 */
import { apply as hostApply, name as hostName, inject as hostInject } from '../lib/index.js'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import net from 'node:net'
import vm from 'node:vm'

let failed = 0
function check(label, cond, extra) {
  if (cond) console.log('  OK   ' + label)
  else { failed++; console.log('  FAIL ' + label + (extra ? ' -> ' + JSON.stringify(extra) : '')) }
}

// ─── host 端 ───────────────────────────────────────────
console.log('[host] 导出面')
check('name', hostName === 'dsh-classic-coding', hostName)
check('inject 为空，读写交给内置与自注册通道', Array.isArray(hostInject) && hostInject.length === 0, hostInject)

const root = await mkdtemp(join(tmpdir(), 'cc-verify-'))

let routeHandler = null
let rejection = undefined
const scope = {
  connection: { requestRejection: () => rejection },
  webServer: { register(route) { routeHandler = route.handler; return () => {} } },
  effect(cb) { return cb() },
  inject(deps, cb) { cb(scope) },
}
const ctx = {
  inject(deps, cb) { cb(scope) },
}
hostApply(ctx)

console.log('[host] RPC 通道')
check('注册 prefix 路由', routeHandler !== null)
if (routeHandler === null) {
  console.log('\n失败 ' + ++failed + ' 项')
  process.exit(1)
}

const server = http.createServer((req, res) => routeHandler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

/** 打一次本通道 RPC，返回 HTTP 状态与信封。 */
async function rpc(method, payload) {
  const res = await fetch('http://127.0.0.1:' + port + '/classic-coding/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method, payload }),
  })
  return { status: res.status, body: await res.json() }
}

/**
 * 用原始 socket 只发请求头：超限 content-length 触发的是快速拒绝，没必要真发满整份 body。
 */
function rawRequest(port, head) {
  return new Promise(function (resolve, reject) {
    const socket = net.connect(port, '127.0.0.1')
    let text = ''
    socket.setEncoding('utf8')
    socket.setTimeout(5000, function () { socket.destroy(); reject(new Error('raw request timeout')) })
    socket.on('data', function (chunk) { text += chunk })
    socket.on('end', function () { resolve(text) })
    // 服务端先回 413 再 destroy，连接可能以 RST 收尾；只要已收到响应就交给断言判断。
    socket.on('error', function (err) { if (text.length > 0) resolve(text); else reject(err) })
    socket.write(head)
  })
}

const target = join(root, 'out.txt')
const wrote = (await rpc('writeFile', { path: target, content: '写入成功' })).body.result
check('writeFile 返回 ok', wrote.ok === true && wrote.value.ok === true, wrote)
let landed = false
try { landed = (await readFile(target, 'utf8')) === '写入成功' } catch { landed = false }
check('writeFile 落盘', landed)
const wroteBad = (await rpc('writeFile', { path: target })).body.result
check('writeFile 缺 content 报错', wroteBad.ok === false && /缺少 content/.test(wroteBad.error.message), wroteBad)
const wroteRel = (await rpc('writeFile', { path: 'relative/x.txt', content: 'x' })).body.result
check('writeFile 拒绝相对路径', wroteRel.ok === false && /绝对路径/.test(wroteRel.error.message), wroteRel)

const removed = (await rpc('describe', { sessionId: 'x' })).body.result
check('已下线的 describe 报 bad-request', removed.ok === false && removed.error.code === 'bad-request', removed)

const unknown = (await rpc('no-such', {})).body.result
check('未知端点 bad-request', unknown.ok === false && unknown.error.code === 'bad-request', unknown)

const notFound = await fetch('http://127.0.0.1:' + port + '/classic-coding/')
check('空端点 404', notFound.status === 404, notFound.status)
rejection = 401
const unauth = await fetch('http://127.0.0.1:' + port + '/classic-coding/writeFile', { method: 'POST', body: '{}' })
check('未授权 401', unauth.status === 401, unauth.status)
rejection = undefined
const plain = await fetch('http://127.0.0.1:' + port + '/classic-coding/writeFile', {
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: '{}',
})
check('非 JSON content-type 返回 415', plain.status === 415, plain.status)
const oversized = await rawRequest(port, 'POST /classic-coding/writeFile HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ' + (400 * 1024 * 1024) + '\r\n\r\n')
check('超限请求体返回 413', /^HTTP\/1\.1 413/.test(oversized), oversized.split('\r\n')[0])
server.close()

// ─── client 端 ─────────────────────────────────────────
console.log('[client] 模块注册')
const code = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
let entry = null
let styleAppended = 0
const fakeElement = () => ({
  dataset: {}, className: '', title: '', textContent: '',
  appendChild() {}, hasAttribute: () => false, setAttribute() {},
  querySelector: () => null, querySelectorAll: () => [],
})
const documentMock = {
  head: { appendChild() { styleAppended++ } },
  body: { hasAttribute: () => false },
  createElement: fakeElement,
  addEventListener() {}, removeEventListener() {},
  querySelectorAll: () => [],
}
const windowMock = { __ModuleLoader__: { load(e) { entry = e } } }
const sandbox = {
  window: windowMock, document: documentMock,
  fetch: () => Promise.reject(new Error('不该调用 fetch')),
  console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Object, Symbol, Error, RegExp, String, Number, Array,
}
vm.createContext(sandbox)
vm.runInContext(code, sandbox)
check('注册到模块表', entry !== null && entry.id === 'dsh-classic-coding', entry && entry.id)

const ReactMock = {
  createElement: (...args) => ({ type: args[0], props: args[1], children: args.slice(2) }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  Fragment: Symbol('Fragment'),
}
const mod = entry.factory((id) => {
  if (id === 'react') return ReactMock
  throw new Error('未预期的外部模块: ' + id)
})
check('默认导出为插件', mod.default && mod.default.name === 'dsh-classic-coding', mod.default && mod.default.name)
check('具名导出 apply', typeof mod.apply === 'function')
check('具名导出 inject', Array.isArray(mod.inject) && mod.inject.join(',') === 'slots,sidebarRightTabs,sidebarRight,remote,remote.workspaceFiles', mod.inject)

const injections = []
const registrations = []
const typeDefinitions = []
let effectCount = 0
const clientCtx = {
  get(service) {
    if (service === 'slots') return {
      inject(n, cb) { injections.push(n); cb() },
      register(opts, comp) { registrations.push({ opts, comp }); return () => {} },
    }
    if (service === 'sidebarRightTabs') return {
      register(def) { typeDefinitions.push(def); return () => {} },
    }
    if (service === 'sidebarRight') return { openResource() {}, active() { return undefined } }
    if (service === 'remote') return { workspaceFiles: { readBytes: async () => ({ absolutePath: 'C:/x/a.ts', version: 'v', offset: 0, data: new Uint8Array(), eof: true }) } }
    return undefined
  },
  effect(cb) { effectCount++; cb() },
}
mod.apply(clientCtx)
check('注入正文与文档动作席位', injections.join(',') === 'sidebar.right.pane.tab,sidebar.right.tab.document.actions', injections)
check('注册两个组件', registrations.length === 2, registrations.map((r) => r.opts.key || r.opts.id))
check('正文席位 key 与类型 id 一致', registrations[0]?.opts.key === 'dsh-classic-coding', registrations[0]?.opts)
check('文档动作席位 id', registrations[1]?.opts.id === 'dsh-classic-coding-edit', registrations[1]?.opts)
check('注册一个 tab 类型', typeDefinitions.length === 1, typeDefinitions)
const def = typeDefinitions[0]
if (def) {
  check('类型 id', def.id === 'dsh-classic-coding', def.id)
  check('类型 kind', def.kind === 'code', def.kind)
  check('类型优先级 extension', def.priority === 'extension', def.priority)
  check('类型保活', def.keepMounted === true, def.keepMounted)
  check('不参与自动认领，默认走内置查看', def.patterns === undefined, def.patterns)
  check('只认领会话地址', def.canOpen('dsh-resource://file/session/s1/a.ts') === true && def.canOpen('dsh-resource://file/absolute/C:/a.ts') === false)
  check('标题取文件名', def.title('dsh-resource://file/session/s1/dir/a.ts') === 'a.ts', def.title('dsh-resource://file/session/s1/dir/a.ts'))
}
check('effect 已注册', effectCount === 2, effectCount)

const bodyProps = {
  useTabInfo: () => ({
    tab: {
      navigation: { address: 'dsh-resource://file/session/s1/dir/a.ts' },
      signal: new AbortController().signal,
    },
  }),
}
const el = registrations[0]?.comp(bodyProps)
check('正文可渲染', el && typeof el === 'object', el && el.type)
const suspicious = registrations[0]?.comp({
  useTabInfo: () => ({ tab: { navigation: { address: 'sidebar://code' }, signal: new AbortController().signal } }),
})
check('非文件地址落到错误提示', suspicious && typeof suspicious === 'object', suspicious && suspicious.type)
const action = registrations[1]?.comp({ absolutePath: 'C:\\CCC_nospace\\x\\a.ts', sessionId: 's1' })
check('文档动作图标可渲染', action && typeof action === 'object', action && action.type)
const actionNoSession = registrations[1]?.comp({ absolutePath: 'C:\\x\\a.ts' })
check('无会话时仍可点击，地址在点击时兜底', actionNoSession && actionNoSession.props.disabled === undefined, actionNoSession && actionNoSession.props)

console.log(failed === 0 ? '\n全部通过' : '\n失败 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)
