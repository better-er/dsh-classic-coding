/**
 * 在 webServer 上自注册一条 connection 风格的 RPC 通道。
 *
 * dsh 0.1.5 的 connection.rpc.handle 会在登记路由时解析 webServer，实测任何插件上下文都抛
 * `cannot get property "webServer" without inject`，官方自身也从不走该路径。
 * 因此这里直接向 webServer 注册 prefix 路由，复用 connection.requestRejection 的
 * Host 校验与浏览器鉴权，并实现同样的 client-request/server-response 信封。
 *
 * @module dsh-classic-coding/rpc-channel
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** RPC 处理器的统一结果信封。 */
export type RpcChannelResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: object } }

/** 通道端点处理器：endpoint 与请求体，返回结果信封。 */
export type RpcChannelHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<RpcChannelResult>

/** webServer 服务的最小面，仅注册 prefix 路由。 */
interface WebServerFace {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** connection 服务的最小面，仅用请求信任判定。 */
interface ConnectionFace {
  requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** 可注入上下文的最小面。 */
interface Injectable {
  inject(deps: string[], callback: (scope: unknown) => void): unknown
}

/** 注入作用域的最小面。 */
interface Scope {
  connection: ConnectionFace
  webServer: WebServerFace
  effect(callback: () => (() => void) | undefined, label: string): unknown
}

/** 端点路径段的合法字符集，与官方 ENDPOINT_SEGMENT_PATTERN 一致。 */
const SEGMENT = /^[A-Za-z0-9_$.-]+$/
/** 请求体上限，RPC 信封远小于此值。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * 挂载一条 RPC 通道。webServer 或 connection 缺席时不挂载，其余功能不受影响。
 * @param ctx - 插件上下文。
 * @param channel - 绝对通道前缀，例如 /dsh-pause。
 * @param handler - 端点处理器。
 */
export function mountRpcChannel(ctx: Injectable, channel: string, handler: RpcChannelHandler): void {
  ctx.inject(['connection', 'webServer'], (raw) => {
    const scope = raw as Scope
    scope.effect(
      () => scope.webServer.register({
        kind: 'prefix',
        path: channel,
        handler: (req, res) => serve(scope.connection, channel, handler, req, res),
      }),
      `${channel}: rpc channel`,
    )
  })
}

/**
 * 处理一次 HTTP 请求：信任与鉴权、端点解析、信封校验、结果回写。
 * @param connection - connection 服务，用其信任判定。
 * @param channel - 本通道前缀。
 * @param handler - 端点处理器。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function serve(
  connection: ConnectionFace,
  channel: string,
  handler: RpcChannelHandler,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rejection = connection.requestRejection(req)
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  if (req.method !== 'POST') return missing(res)
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  const prefix = `${channel}/`
  if (!pathname.startsWith(prefix)) return missing(res)
  const endpoint = pathname.slice(prefix.length)
  if (!endpoint.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && SEGMENT.test(part))) return missing(res)

  let raw: string
  try {
    raw = await readBody(req)
  } catch (error) {
    res.writeHead(413)
    res.end('payload too large')
    return
  }
  let message: { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
  try {
    message = JSON.parse(raw) as typeof message
  } catch (error) {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }
  const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
  if (message.type !== 'client-request' || typeof message.method !== 'string') {
    return reply(res, rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} } })
  }
  if (message.method !== endpoint) {
    return reply(res, rpcId, {
      ok: false,
      error: { code: 'gateway/bad-request', message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`, details: {} },
    })
  }
  let result: RpcChannelResult
  try {
    result = await handler(endpoint, message.payload, new AbortController().signal)
  } catch (error) {
    result = { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} } }
  }
  reply(res, rpcId, result)
}

/** 路径不匹配或方法不符时统一 404，与官方未认领端点一致。 */
function missing(res: ServerResponse): void {
  res.writeHead(404)
  res.end('not found')
}

/** 回写一个 server-response 信封。 */
function reply(res: ServerResponse, rpcId: string, result: RpcChannelResult): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
}

/** 读取并限长请求体。 */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      req.destroy()
      throw new Error('rpc channel: request body exceeds limit')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}