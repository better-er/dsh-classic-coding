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
  ctx.inject(['connection'], function (connectionCtx) {
    connectionCtx.connection.rpc.handle(
      '/classic-coding',
      async function (endpoint, payload, signal) {
        // handle 独立通道下 endpoint 即方法名（不含通道前缀）
        const method = endpoint
        try {
          switch (method) {
            case 'describe':
              return { ok: true, value: await handleDescribe(ctx) }
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
 * 处理 describe：返回工作区根路径。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
async function handleDescribe(ctx) {
  const target = await ctx.fs.resolve('.')
  return { root: ctx.fs.processPath(target) }
}

/**
 * 处理 listDir：列出目录内容。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ path?: string }} payload
 * @param {AbortSignal} signal
 */
async function handleListDir(ctx, payload, signal) {
  // 空字符串视为根目录（fs.resolve 拒绝空路径）
  const target = await ctx.fs.resolve(payload.path || '.', { signal })
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
  const target = await ctx.fs.resolve(payload.path)
  await ctx.fs.writeText(target, payload.content)
  return { ok: true }
}

export { apply, inject, name }
