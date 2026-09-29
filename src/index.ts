/**
 * 古法编程 - Host 端
 *
 * 只注册一个保存端点。文件内容与目录列举交给 DSH 内置 workspaceFiles 服务，
 * 该服务官方不提供修改操作，故写入保留自注册的 /classic-coding writeFile。
 *
 * 经 mountRpcChannel 直接向 webServer 自注册前缀路由，复用 connection 的信任判定，
 * 实现官方 client-request/server-response 信封。共享通道 /api 的唯一拦截器槽位已被官方 gateway 占用。
 *
 * 官方 @deepseek-ai 服务面在此以最小结构接口描述，插件运行时由 host 注入真实实现，
 * 不引入任何官方类型包依赖，避免版本漂移。
 *
 * @module dsh-classic-coding
 */

import { writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { mountRpcChannel, type RpcChannelResult } from './rpc-channel.ts'

/** 插件上下文：connection 与 webServer 由 mountRpcChannel 延迟注入。 */
interface PluginContext {
  inject(dependencies: string[], callback: (scope: unknown) => void): unknown
}

/** 插件名，即 cordis.yml 配置条目 id */
const name = 'dsh-classic-coding'

/** 依赖的服务：仅 connection 与 webServer，且延迟到挂载通道时注入。 */
const inject: string[] = []

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
 * 强制要求绝对路径：防止相对路径按 dsh 进程启动目录误写。
 * 客户端传入的绝对路径来自内置 workspaceFiles 的 stat.absolutePath，与工作区根一致。
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

/**
 * Host 端 apply：注册保存端点。
 * @param ctx - 插件上下文。
 */
function apply(ctx: PluginContext): void {
  mountRpcChannel(ctx, '/classic-coding', async function (endpoint, payload): Promise<RpcChannelResult> {
    try {
      switch (endpoint) {
        case 'writeFile':
          return { ok: true, value: await handleWriteFile(payload) }
        default:
          return {
            ok: false,
            error: { code: 'bad-request', message: `未知端点: ${endpoint}`, details: { issues: [] } },
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
}

export { apply, inject, name }

