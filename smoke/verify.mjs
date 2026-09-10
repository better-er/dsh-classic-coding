/**
 * 产物冒烟验证：host 端 RPC 行为 + client 端模块注册。
 *
 * 前置：先执行 pnpm build 生成 lib/，本脚本直接消费构建产物。
 * 用法：pnpm smoke
 */
import { apply as hostApply, name as hostName, inject as hostInject } from '../lib/index.js'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
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
check('inject', Array.isArray(hostInject) && hostInject.join(',') === 'fs', hostInject)

const root = await mkdtemp(join(tmpdir(), 'cc-verify-'))
await writeFile(join(root, 'b.txt'), '内容B', 'utf8')
await writeFile(join(root, 'a.txt'), '内容A', 'utf8')
await writeFile(join(root, '.hidden'), 'x', 'utf8')
await mkdir(join(root, 'sub'))
await mkdir(join(root, 'node_modules'))

let routeHandler = null
let rejection = undefined
const scope = {
  connection: { requestRejection: () => rejection },
  webServer: { register(route) { routeHandler = route.handler; return () => {} } },
  effect(cb) { return cb() },
  inject(deps, cb) { cb(scope) },
  sessions: { get: (id) => (id === 'live-1' ? { header: { cwd: root } } : id === 'live-empty' ? { header: {} } : undefined) },
  sessionPersistence: { stat: async (id) => (id === 'cold-1' ? { header: { cwd: root } } : undefined) },
}
const ctx = {
  fs: {
    resolve: async (p) => p,
    processPath: (t) => t,
    readText: async (t) => readFile(t, 'utf8'),
  },
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

const describeLive = (await rpc('describe', { sessionId: 'live-1' })).body.result
check('describe live', describeLive.ok === true && describeLive.value.root === root, describeLive)
const describeCold = (await rpc('describe', { sessionId: 'cold-1' })).body.result
check('describe cold', describeCold.ok === true && describeCold.value.root === root, describeCold)
const describeMiss = (await rpc('describe', { sessionId: 'nope' })).body.result
check('describe 未知会话报错', describeMiss.ok === false && /会话不存在/.test(describeMiss.error.message), describeMiss)
const describeEmpty = (await rpc('describe', { sessionId: 'live-empty' })).body.result
check('describe 空 cwd 报错', describeEmpty.ok === false && /工作目录缺失/.test(describeEmpty.error.message), describeEmpty)
const describeNoId = (await rpc('describe', {})).body.result
check('describe 缺 sessionId 报错', describeNoId.ok === false && /缺少 sessionId/.test(describeNoId.error.message), describeNoId)

const list = (await rpc('listDir', { path: root })).body.result
check('listDir 成功', list.ok === true, list)
if (list.ok) {
  const names = list.value.entries.map((e) => e.name)
  check('listDir 过滤隐藏与 node_modules', names.join(',') === 'sub,a.txt,b.txt', names)
  check('listDir 目录优先', list.value.entries[0].type === 'directory', list.value.entries[0])
}
const listRel = (await rpc('listDir', { path: 'relative/x' })).body.result
check('listDir 拒绝相对路径', listRel.ok === false && /绝对路径/.test(listRel.error.message), listRel)

const read = (await rpc('readFile', { path: join(root, 'a.txt') })).body.result
check('readFile 内容', read.ok === true && read.value.content === '内容A', read)

const target = join(root, 'out.txt')
const wrote = (await rpc('writeFile', { path: target, content: '写入成功' })).body.result
check('writeFile 返回 ok', wrote.ok === true && wrote.value.ok === true, wrote)
check('writeFile 落盘', (await readFile(target, 'utf8')) === '写入成功')
const wroteBad = (await rpc('writeFile', { path: target })).body.result
check('writeFile 缺 content 报错', wroteBad.ok === false && /缺少 content/.test(wroteBad.error.message), wroteBad)

const unknown = (await rpc('no-such', {})).body.result
check('未知端点 bad-request', unknown.ok === false && unknown.error.code === 'bad-request', unknown)

const notFound = await fetch('http://127.0.0.1:' + port + '/classic-coding/')
check('空端点 404', notFound.status === 404, notFound.status)
rejection = 401
const unauth = await fetch('http://127.0.0.1:' + port + '/classic-coding/describe', { method: 'POST', body: '{}' })
check('未授权 401', unauth.status === 401, unauth.status)
rejection = undefined
const plain = await fetch('http://127.0.0.1:' + port + '/classic-coding/describe', {
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: '{}',
})
check('非 JSON content-type 返回 415', plain.status === 415, plain.status)
const oversized = await rawRequest(port, 'POST /classic-coding/describe HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ' + (400 * 1024 * 1024) + '\r\n\r\n')
check('超限请求体返回 413', /^HTTP\/1\.1 413/.test(oversized), oversized.split('\r\n')[0])
server.close()

// ─── client 端 ─────────────────────────────────────────
console.log('[client] 模块注册')
const code = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
let entry = null
let styleAppended = 0
let observerCount = 0
const fakeElement = () => ({
  dataset: {}, className: '', title: '', textContent: '',
  appendChild() {}, hasAttribute: () => false, setAttribute() {},
  querySelector: () => null, querySelectorAll: () => [],
})
const documentMock = {
  head: { appendChild() { styleAppended++ } },
  body: { hasAttribute: () => false },
  createElement: fakeElement,
  createTextNode: () => ({}),
  addEventListener() {}, removeEventListener() {},
  querySelectorAll: () => [],
}
class MutationObserverMock {
  constructor() { observerCount++ }
  observe() {}
  disconnect() {}
}
const windowMock = { __ModuleLoader__: { load(e) { entry = e } } }
const sandbox = {
  window: windowMock, document: documentMock, MutationObserver: MutationObserverMock,
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
check('具名导出 inject', Array.isArray(mod.inject) && mod.inject.join(',') === 'slots,sessions', mod.inject)

const injections = []
const registrations = []
let effectFn = null
const clientCtx = {
  get(service) {
    if (service === 'slots') return {
      inject(n, cb) { injections.push(n); cb() },
      register(opts, comp) { registrations.push({ opts, comp }); return () => {} },
    }
    if (service === 'sessions') return { list: { getSnapshot: () => ({ current: 'live-1' }) } }
    return undefined
  },
  effect(cb) { effectFn = cb },
}
mod.apply(clientCtx)
check('注入两个槽位', injections.join(',') === 'sidebar.footer.action,shell.overlay', injections)
check('注册两个组件', registrations.length === 2, registrations.map((r) => r.opts.id))
check('触发按钮 order 15', registrations[0]?.opts.order === 15, registrations[0]?.opts)
check('effect 已注册', typeof effectFn === 'function')
if (typeof effectFn === 'function') {
  const dispose = effectFn()
  check('样式已注入', styleAppended === 1, styleAppended)
  check('尾巴 observer 已启动', observerCount === 1, observerCount)
  check('effect 返回清理函数', typeof dispose === 'function')
  dispose()
  check('清理后移除样式', documentMock.head !== null)
}
for (const r of registrations) {
  const el = r.comp()
  check('组件可渲染 ' + r.opts.id, el && typeof el === 'object', el)
}

console.log(failed === 0 ? '\n全部通过' : '\n失败 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)