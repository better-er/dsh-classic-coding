/**
 * 古法编程 - Host 端
 *
 * 注册 RPC 端点，为 Client 端提供文件系统操作能力。
 * 经 mountRpcChannel 直接向 webServer 自注册 /classic-coding 前缀路由，复用 connection 的信任判定，
 * 实现官方 client-request/server-response 信封。共享通道 /api 的唯一拦截器槽位已被官方 gateway 占用。
 *
 * 官方 @deepseek-ai 服务面在此以最小结构接口描述，插件运行时由 host 注入真实实现，
 * 不引入任何官方类型包依赖，避免版本漂移。
 *
 * @module dsh-classic-coding
 */

import { readdir, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { mountRpcChannel, type RpcChannelResult } from './rpc-channel.ts'

/** 文件系统服务：仅用到解析、路径转换与读文本三个方法。 */
interface FsService {
  /** 把路径解析成后端路径对象，受 signal 取消。 */
  resolve(path: string, options?: { signal?: AbortSignal }): Promise<unknown>
  /** 把后端路径对象转成本机进程可用的字符串路径。 */
  processPath(target: unknown): string
  /** 读取文本文件。 */
  readText(target: unknown): Promise<string>
}

/** 会话记录的最小面：只需要 header.cwd。 */
interface SessionRecord {
  header?: { cwd?: string }
}

/** 会话服务：按 id 取内存中的 live 会话。 */
interface SessionsService {
  get(sessionId: string): SessionRecord | undefined
}

/** 会话持久化：按 id 冷读存储快照，只需要 header.cwd。 */
interface SessionPersistenceService {
  stat(sessionId: string, options?: { signal?: AbortSignal }): Promise<{ header?: { cwd?: string } } | undefined>
}

/** 插件上下文：apply 与 inject 回调共同可见的服务面。 */
interface PluginContext {
  fs: FsService
  inject(
    dependencies: string[],
    callback: (scope: PluginContext & {
      sessions: SessionsService
      sessionPersistence: SessionPersistenceService
    }) => void,
  ): void
}

/** 插件名，即 cordis.yml 配置条目 id */
const name = 'dsh-classic-coding'

/** 依赖的服务：fs 即文件系统；sessions、sessionPersistence 在 apply 内显式等待 */
const inject = ['fs']

/** 需要隐藏的目录 */
const HIDDEN_DIRS = new Set([
  '.git', 'node_modules', '.next', '.cache',
  '__pycache__', '.venv', 'dist', 'build', '.dsh',
])

/**
 * 强制要求绝对路径：防止相对路径被 fs.resolve 按进程 cwd 误解析。
 * 文件树根由当前会话的 cwd 决定，不依赖 dsh 进程启动目录。
 * @param path - 待校验路径。
 */
function requireAbsolute(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('path 必须是非空字符串')
  }
  if (!isAbsolute(path)) {
    throw new Error(`path 必须是绝对路径：收到 ${path}`)
  }
}

/** 把未知 payload 收窄成字符串字段表。 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** 从字符串字段表里取字符串字段，缺失或类型不符返回 undefined。 */
function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Host 端 apply：注册文件系统 RPC 端点。
 *
 * 用 ctx.inject(['sessions', 'sessionPersistence'], ...) 延迟获取服务，
 * 再经 mountRpcChannel 自注册独立的 /classic-coding 通道。
 * dsh 0.1.5 的 connection.rpc.handle 在登记路由时解析 webServer 会抛 without inject，因此自行注册 prefix 路由。
 * @param ctx - 插件上下文。
 */
function apply(ctx: PluginContext): void {
  ctx.inject(['sessions', 'sessionPersistence'], function (scope) {
    mountRpcChannel(scope, '/classic-coding', async function (endpoint, payload, signal): Promise<RpcChannelResult> {
      // 独立通道下 endpoint 即方法名，不含通道前缀
      const method = endpoint
      try {
        switch (method) {
          case 'describe':
            return { ok: true, value: await handleDescribe(scope.sessions, scope.sessionPersistence, payload, signal) }
          case 'listDir':
            return { ok: true, value: await handleListDir(ctx, payload, signal) }
          case 'readFile':
            return { ok: true, value: await handleReadFile(ctx, payload) }
          case 'writeFile':
            return { ok: true, value: await handleWriteFile(payload) }
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
    })
  })
}

/**
 * 处理 describe：返回当前会话工作区的绝对路径作为文件树根。
 * 会话 id 由客户端从注入的 sessions 服务读取 sessions.list.current，与侧栏选择同步。
 *
 * 会话已挂载为 live 即内存 SessionStore 命中时直接取 header.cwd；
 * 否则，如浏览器刷新、会话尚未被 host resume 进 live 表时回退到
 * sessionPersistence.stat 从磁盘冷读快照 header.cwd。两者都拿不到才抛错，
 * 绝不静默回退到进程目录。
 * @param sessions - 会话服务。
 * @param sessionPersistence - 会话持久化服务。
 * @param payload - RPC 载荷，需带 sessionId。
 * @param signal - 取消信号。
 */
async function handleDescribe(
  sessions: SessionsService,
  sessionPersistence: SessionPersistenceService,
  payload: unknown,
  signal: AbortSignal,
): Promise<{ root: string }> {
  const sessionId = readString(asRecord(payload), 'sessionId')
  if (!sessionId) throw new Error('describe 缺少 sessionId')

  // 快路径：会话已在 host 内存 live 表中
  const live = sessions.get(sessionId)
  const liveCwd = live?.header?.cwd
  if (liveCwd) {
    return { root: liveCwd }
  }

  // 兜底：从持久化冷读会话 header，覆盖刷新后尚未 resume 的会话
  const snapshot = await sessionPersistence.stat(sessionId, { signal })
  const coldCwd = snapshot?.header?.cwd
  if (coldCwd) return { root: coldCwd }
  if (live) throw new Error(`会话 ${sessionId} 工作目录缺失：header.cwd 为空`)
  throw new Error(`会话不存在: ${sessionId}`)
}

/**
 * 处理 listDir：列出目录内容。
 * @param ctx - 插件上下文。
 * @param payload - RPC 载荷，需带绝对 path。
 * @param signal - 取消信号。
 */
async function handleListDir(
  ctx: PluginContext,
  payload: unknown,
  signal: AbortSignal,
): Promise<{ entries: { name: string; type: 'directory' | 'file'; size: number }[] }> {
  const path = readString(asRecord(payload), 'path')
  requireAbsolute(path)
  const target = await ctx.fs.resolve(path, { signal })
  const dirPath = ctx.fs.processPath(target)
  const items = await readdir(dirPath, { withFileTypes: true })

  const entries = items
    .filter(function (item) { return !HIDDEN_DIRS.has(item.name) && !item.name.startsWith('.') })
    .map(function (item) {
      return {
        name: item.name,
        type: item.isDirectory() ? 'directory' as const : 'file' as const,
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
 * @param ctx - 插件上下文。
 * @param payload - RPC 载荷，需带绝对 path。
 */
async function handleReadFile(ctx: PluginContext, payload: unknown): Promise<{ content: string }> {
  const path = readString(asRecord(payload), 'path')
  requireAbsolute(path)
  const target = await ctx.fs.resolve(path)
  const content = await ctx.fs.readText(target)
  return { content }
}

/**
 * 处理 writeFile：写入文件内容。
 *
 * 刻意不走 ctx.fs：那是被 DSH 文件沙箱包过、按 agent 权限裁决的实现，
 * 这里改用 Node 原生 fs.writeFile 直接写盘。
 * 本插件本质是本地编辑器，Ctrl+S 保存与 agent 无关，不应被 agent 沙箱/权限链拦截，
 * 否则会报 file access denied under workspace-write mode。
 * 保存操作因此与 agent 的访问模式、会话 override 都无关，就是普通本地磁盘写入。
 * @param payload - RPC 载荷，需带绝对 path 与 content。
 */
async function handleWriteFile(payload: unknown): Promise<{ ok: true }> {
  const record = asRecord(payload)
  const path = readString(record, 'path')
  const content = readString(record, 'content')
  requireAbsolute(path)
  if (typeof content !== 'string') throw new Error('writeFile 缺少 content')
  await writeFile(path, content, 'utf8')
  return { ok: true }
}

export { apply, inject, name }
