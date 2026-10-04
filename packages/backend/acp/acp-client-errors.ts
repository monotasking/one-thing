// ACP 客户端的错误分类(2026-10-04 从 `acp-client.ts` 原样拆出,拆分批 3,D227):两种「不是失败」的错误
// (能力没声明 / 崩溃退避锁着)、对端 JSON-RPC 错误的形状与错误码、以及交给会话的那句人话。
import * as acp from '@agentclientprotocol/sdk'

/**
 * 这台 agent 没自报这项能力(A5:`sessionCapabilities.list` / `fork`,认领要的 `loadSession`)。
 * 装配层据它答 `code: 'unsupported'`,而不是把它当成一次失败。
 */
export class AcpCapabilityMissingError extends Error {
  readonly code = 'unsupported' as const
  constructor(agentName: string, capability: string) {
    super(`ACP agent "${agentName}" does not advertise ${capability}`)
    this.name = 'AcpCapabilityMissingError'
  }
}

/** 崩溃退避锁着,自动重连被拒(A5)。装配层据它答 `code: 'unavailable'`。 */
export class AcpReconnectPausedError extends Error {
  readonly code = 'unavailable' as const
  constructor(message: string) {
    super(message)
    this.name = 'AcpReconnectPausedError'
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  const rpc = rpcErrorShape(error)
  return rpc ? rpc.message : String(error)
}

/** ACP 规范给 `authRequired` 的 JSON-RPC 错误码。 */
export const ACP_AUTH_REQUIRED_CODE = -32000

/**
 * 对端回来的 JSON-RPC 错误:0.x 的 SDK 原样 reject 成**普通对象**(`{code, message, data}`),
 * 1.x 包成 `RequestError`(是 `Error`,但 agent 的原话在 `data` 里)—— 两种都认。
 */
function rpcErrorShape(error: unknown): { code?: number; message: string; data?: unknown } | undefined {
  if (!error || typeof error !== 'object') return undefined
  if (error instanceof Error && !(error instanceof acp.RequestError)) return undefined
  const { code, message, data } = error as { code?: unknown; message?: unknown; data?: unknown }
  if (typeof message !== 'string') return undefined
  return { ...(typeof code === 'number' ? { code } : {}), message, ...(data === undefined ? {} : { data }) }
}

/** 对端答的是不是 `-32000 auth_required`(那台 agent 自己没登录)。 */
export function isAcpAuthRequired(error: unknown): boolean {
  if (error instanceof Error && error.cause !== undefined && rpcErrorShape(error) === undefined) {
    return isAcpAuthRequired(error.cause)
  }
  return rpcErrorShape(error)?.code === ACP_AUTH_REQUIRED_CODE
}

/** JSON-RPC 规范的 `invalid params`:值本身不对,重开会话也还是不对。 */
export const JSON_RPC_INVALID_PARAMS_CODE = -32602

/**
 * 对端答的 JSON-RPC 错误码;已经换成人话的错误(原话挂在 `cause` 上)顺着 `cause` 找。
 * 不是对端答的(连接断了、本地抛的)= undefined。
 */
export function acpRpcErrorCode(error: unknown): number | undefined {
  if (error instanceof Error && error.cause !== undefined && rpcErrorShape(error) === undefined) {
    return acpRpcErrorCode(error.cause)
  }
  return rpcErrorShape(error)?.code
}

function describeRpcData(data: unknown): string {
  if (data === undefined || data === null) return ''
  if (typeof data === 'string') return data
  const text = (data as { message?: unknown; details?: unknown }).message ?? (data as { details?: unknown }).details
  if (typeof text === 'string') return text
  try {
    return JSON.stringify(data).slice(0, 500)
  } catch {
    return ''
  }
}

/**
 * 一轮 prompt 失败时交给会话的那句话(2026-09-24:真机上这里显示的是 `[object Object]` ——
 * SDK 把对端的 JSON-RPC 错误原样 reject 成普通对象,`String()` 一下什么都没了)。
 * `authRequired` 单独说人话:它不是 onething 的错,是那台 agent 自己的登录过期了,
 * 要去**它自己的** CLI 里登录;`authLabel` 是 agent 经 `_auth/status_update` 推来的原话。
 */
export function toAcpPromptError(error: unknown, agentName: string, authLabel?: string): Error {
  const rpc = rpcErrorShape(error)
  if (!rpc) return error instanceof Error ? error : new Error(String(error))
  const detail = describeRpcData(rpc.data)
  if (rpc.code === ACP_AUTH_REQUIRED_CODE) {
    const why = authLabel || detail || rpc.message
    return new Error(
      `ACP agent "${agentName}" is not logged in (${why}). Log in with the agent's own CLI and retry.`,
      { cause: error },
    )
  }
  const message = detail && !rpc.message.includes(detail) ? `${rpc.message}: ${detail}` : rpc.message
  return new Error(message, { cause: error })
}

/**
 * 连不上时交给会话的那句话。ENOENT 单独说人话:它几乎总是「适配器没装」或
 * 「GUI 起的 app 没拿到登录 shell 的 PATH」,而 Node 原话 `spawn x ENOENT` 两件都没说。
 * 进程起了但握手前就退了,把 stderr 尾巴带上 —— 适配器自己的报错多半就在那里。
 */
export function describeConnectFailure(command: string, error: unknown, stderrTail = ''): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') {
    return new Error(
      `ACP agent command "${command}" was not found on PATH. `
      + 'Install the ACP adapter or set the agent command to an absolute path.',
      { cause: error },
    )
  }
  const tail = stderrTail.trim()
  const base = errorMessage(error)
  if (!tail || base.includes(tail.slice(-200))) return error instanceof Error ? error : new Error(base)
  return new Error(`${base} stderr: ${tail.slice(-1000)}`, { cause: error })
}
