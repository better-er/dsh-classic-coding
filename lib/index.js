/**
 * 古法编程 - Host 端
 *
 * Node half: 注册 RPC 端点，为 Client 端提供文件系统操作能力。
 * 通过 ctx.connection.rpc.handle('/classic-coding', ...) 注册独立
 * RPC 通道（/api 共享通道的唯一拦截器槽位已被官方 gateway 占用，
 * 插件端点必须走 handle 独立通道），使用 ctx.fs 执行实际文件操作。
 *
 * @module dsh-classic-coding
 */

import { readdir } from 'node:fs/promises'

/** 绝对路径校验：Windows 盘符或 UNC 前缀 */
const ABS_RE = /^[A-Za-z]:[\\/]|^\\\\/

/**
 * 强制要求绝对路径：防止相对路径被 fs.resolve 按进程 cwd 误解析。
 * 文件树根由当前会话的 cwd 决定（不再依赖 dsh 进程启动目录）。
 */
function requireAbsolute(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('path 必须是非空字符串')
  }
  if (!ABS_RE.test(path)) {
    throw new Error(`path 必须是绝对路径（收到: ${path}）`)
  }
}

/** 插件名（= cordis.yml 配置条目 id） */
const name = 'dsh-classic-coding'

/** 依赖的服务：fs（文件系统）；connection 在 apply 内显式等待 */
const inject = ['fs']

/** 需要隐藏的目录 */
const HIDDEN_DIRS = new Set([
  '.git', 'node_modules', '.next', '.cache',
  '__pycache__', '.venv', 'dist', 'build', '.dsh',
])

/**
 * Host 端 apply：注册文件系统 RPC 端点。
 *
 * 使用 ctx.inject(['connection'], ...) 延迟获取 connection 服务，
 * 通过 ctx.connection.rpc.handle 注册独立的 /classic-coding 通道。
 * （共享通道 /api 的唯一拦截器槽位已被官方 gateway 占用，尝试
 * intercept 会抛出 'already has an interceptor'，因此插件端点
 * 必须走 handle 独立通道。）
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function apply(ctx) {
  ctx.inject(['connection', 'sessions', 'sessionPersistence'], function (connectionCtx) {
    connectionCtx.connection.rpc.handle(
      '/classic-coding',
      async function (endpoint, payload, signal) {
        // handle 独立通道下 endpoint 即方法名（不含通道前缀）
        const method = endpoint
        try {
          switch (method) {
            case 'describe':
              return { ok: true, value: await handleDescribe(connectionCtx.sessions, connectionCtx.sessionPersistence, payload, signal) }
            case 'listDir':
              return { ok: true, value: await handleListDir(ctx, payload, signal) }
            case 'readFile':
              return { ok: true, value: await handleReadFile(ctx, payload) }
            case 'writeFile':
              return { ok: true, value: await handleWriteFile(ctx, payload) }
            default:
              return {
                ok: false,
                error: { code: 'bad-request', message: `未知端点: ${method}`, details: { issues: [] } },
              }
          }
        } catch (e) {
          return {
            ok: false,
            error: {
              code: 'internal',
              message: e instanceof Error ? e.message : String(e),
              details: {},
            },
          }
        }
      },
      { authority: 'trusted-host' },
    )
  })
}

/**
 * 处理 describe：返回当前会话工作区的绝对路径作为文件树根。
 * 会话 id 由客户端从注入的 sessions 服务读取（sessions.list.current，
 * 与侧栏选择同步）。
 *
 * 会话已挂载为 live（内存 SessionStore 命中）时直接取 header.cwd；
 * 否则（如浏览器刷新、会话尚未被 host resume 进 live 表）回退到
 * sessionPersistence.inspect 从磁盘冷读 meta.cwd。两者都拿不到才抛错，
 * 绝不静默回退到进程目录。
 *
 * @param {import('@deepseek-ai/dsh-session').SessionStore} sessions
 * @param {import('@deepseek-ai/dsh-session-persistence').SessionPersistence} sessionPersistence
 * @param {{ sessionId?: string }} payload
 */
async function handleDescribe(sessions, sessionPersistence, payload, signal) {
  const sessionId = payload && payload.sessionId
  if (!sessionId) throw new Error('describe 缺少 sessionId')

  // 快路径：会话已在 host 内存 live 表中
  const live = sessions.get(sessionId)
  if (live && live.header && live.header.cwd) {
    return { root: live.header.cwd }
  }

  // 兜底：从持久化冷读会话 header，覆盖刷新后尚未 resume 的会话。
  if (sessionPersistence && typeof sessionPersistence.inspect === 'function') {
    const inspection = await sessionPersistence.inspect(sessionId, signal)
    const cwd = inspection && inspection.meta && inspection.meta.cwd
    if (cwd) return { root: cwd }
    throw new Error(`会话 ${sessionId} 工作目录缺失（header.cwd 为空）`)
  }

  throw new Error(`会话不存在: ${sessionId}`)
}

/**
 * 处理 listDir：列出目录内容。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ path?: string }} payload
 * @param {AbortSignal} signal
 */
async function handleListDir(ctx, payload, signal) {
  const path = payload && payload.path
  requireAbsolute(path)
  const target = await ctx.fs.resolve(path, { signal })
  const dirPath = ctx.fs.processPath(target)
  const items = await readdir(dirPath, { withFileTypes: true })

  const entries = items
    .filter(function (item) { return !HIDDEN_DIRS.has(item.name) && !item.name.startsWith('.') })
    .map(function (item) {
      return {
        name: item.name,
        type: item.isDirectory() ? 'directory' : 'file',
        size: 0,
      }
    })
    .sort(function (a, b) {
      if (a.type === b.type) return a.name.localeCompare(b.name)
      return a.type === 'directory' ? -1 : 1
    })

  return { entries }
}

/**
 * 处理 readFile：读取文件内容。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ path: string }} payload
 */
async function handleReadFile(ctx, payload) {
  requireAbsolute(payload && payload.path)
  const target = await ctx.fs.resolve(payload.path)
  const content = await ctx.fs.readText(target)
  return { content }
}

/**
 * 处理 writeFile：写入文件内容。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ path: string; content: string }} payload
 */
async function handleWriteFile(ctx, payload) {
  requireAbsolute(payload && payload.path)
  const target = await ctx.fs.resolve(payload.path)
  await ctx.fs.writeText(target, payload.content)
  return { ok: true }
}

export { apply, inject, name }
