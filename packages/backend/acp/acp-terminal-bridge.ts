/**
 * ACP agent 要终端(`terminal/create` / `output` / `wait_for_exit` / `kill` / `release`)时的落点
 * (A3-b,方案 `docs/design/acp-integration-2026-09.md` §3.5 / §11.3)。
 *
 * 从前 `ACPClient` 自己 `spawn` 一条管道子进程、自己攒输出 —— 那条进程在 onething 里看不见、
 * 进不去,环境只是裸进程环境(没有代理),也不问任何人。现在命令跑在 onething 的
 * `TerminalService` 里(真 PTY,owner = `{ kind: 'acp', agentId, sessionId }`):
 *
 *  - 起之前按 `execute` 效果问一次(命令走 bash 分类器,与本地 bash 工具、与 agent 的
 *    `request_permission` 同一份分析 —— `describeAcpToolPermission`);这台 agent 被用户显式设成
 *    `unattended: 'allow'` 才前置放行;
 *  - 环境 = 登录 shell 环境(服务自己的底)⊕ 应用代理 ⊕ agent 递来的 env;
 *  - 输出读服务的回放环(不动流控),壳的终端列表里看得见这一格、`attach` 得进去,
 *    输出与死讯照常走 `terminal:data` / `terminal:exit` 全局事件;
 *  - `kill` 只结束进程、留下这一格(协议要求杀了之后仍能读输出、等结局);`release` 是
 *    「我不要了」—— 还活着就杀,并从列表摘掉。
 *
 * agent 进程死了终端不跟着死(方案 §3.7:用户可能正看着输出);每台 agent 同时最多
 * {@link ACP_TERMINAL_MAX_PER_AGENT} 格,多了就让它先 release。
 */
import { randomUUID } from 'node:crypto'
import { constants as osConstants } from 'node:os'
import type { Authorizer } from '@onething/backend/toolkit'
import type {
  AcpClientRequestContext,
  AcpTerminalBridge,
  AcpTerminalExitStatus,
} from '@onething/backend/acp'
import { describeAcpToolPermission } from '@onething/backend/external-agent'
import {
  getTerminalService,
  hasTerminalHost,
  type TerminalExitStatus,
  type TerminalService,
} from '@onething/backend/terminal/terminal-service'
import { resolveExternalAgentSpawnEnv } from '@onething/backend/external-agent/external-agent-spawn-env'
import { authorizeAcpRequest } from './acp-request-authorize.js'

/** 每台 agent 同时持有的终端上限(从前是每台 agent 配置里的 `maxTerminals`,A3-b 变常量)。 */
export const ACP_TERMINAL_MAX_PER_AGENT = 32
/** `terminal/output` 一次最多答多少字节(从前的 `maxTerminalOutputBytes`,A3-b 变常量)。 */
export const ACP_TERMINAL_MAX_OUTPUT_BYTES = 1024 * 1024
/** 审计 / per-tool 设置里起终端的「工具名」。 */
export const ACP_TERMINAL_TOOL_ID = 'acp-terminal'

/** 桥用得着的服务面(测试换一只假的)。 */
export type AcpTerminalServicePort = Pick<TerminalService, 'create' | 'readOutput' | 'onExit' | 'terminate' | 'kill'>

export interface AcpTerminalBridgeDeps {
  authorizer: () => Authorizer
  /** 缺省 = 进程里那只懒单例(第一次真起终端时才 load node-pty)。 */
  service?: () => AcpTerminalServicePort
  /** 缺省 = 宿主注没注入终端输出通道(`hasTerminalHost()`)。 */
  available?: () => boolean
  /** 缺省 = 外部 agent 子进程的那份环境(进程环境 + 应用代理)。 */
  spawnEnv?: () => Record<string, string | undefined>
}

interface OwnedTerminal {
  agentId: string
  sessionId: string
  outputLimit: number
  exitStatus?: AcpTerminalExitStatus
  exited: Promise<AcpTerminalExitStatus>
}

const SIGNAL_NAMES = new Map<number, string>(
  Object.entries(osConstants.signals).map(([name, number]) => [number, name]),
)

function toAcpExitStatus(status: TerminalExitStatus): AcpTerminalExitStatus {
  return {
    exitCode: status.exitCode,
    signal: status.signal ? (SIGNAL_NAMES.get(status.signal) ?? String(status.signal)) : null,
  }
}

/** 从头截:协议要求超限时丢**最早**的输出,且截在字符边界上。 */
function keepTailBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return { text, truncated: false }
  let start = buffer.length - maxBytes
  // 落在一个多字节字符的中间(10xxxxxx 续字节)就往后挪到下一个字符的开头。
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1
  return { text: buffer.subarray(start).toString('utf8'), truncated: true }
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

export function createAcpTerminalBridge(deps: AcpTerminalBridgeDeps): AcpTerminalBridge {
  const service = deps.service ?? getTerminalService
  const available = deps.available ?? hasTerminalHost
  const spawnEnv = deps.spawnEnv ?? resolveExternalAgentSpawnEnv
  // 这只桥开过的终端:只认它自己开的那几格,别的 agent / 用户的终端一律答「不存在」。
  const owned = new Map<string, OwnedTerminal>()

  const ownedBy = (context: AcpClientRequestContext, terminalId: string): OwnedTerminal => {
    const entry = owned.get(terminalId)
    if (!entry || entry.agentId !== context.agentId) {
      throw new Error(`Terminal ${terminalId} was not created by this agent or has been released.`)
    }
    return entry
  }

  return {
    available: () => available(),

    async create(context, params) {
      const mine = [...owned.values()].filter(entry => entry.agentId === context.agentId).length
      if (mine >= ACP_TERMINAL_MAX_PER_AGENT) {
        throw new Error(`Too many open terminals (${ACP_TERMINAL_MAX_PER_AGENT}); release finished ones first.`)
      }
      const cwd = params.cwd?.trim() || context.cwd

      if (context.unattended !== 'allow') {
        const shape = describeAcpToolPermission({
          kind: 'execute',
          name: params.command,
          rawInput: { command: params.command, args: params.args ?? [] },
          cwd,
          agentId: context.agentId,
          agentName: context.agentName,
        })
        const commandLine = [params.command, ...(params.args ?? [])].join(' ')
        const decision = await authorizeAcpRequest(deps.authorizer(), {
          localSessionId: context.localSessionId,
          messageId: context.messageId,
          cwd,
          callId: `acp-terminal-${randomUUID()}`,
          toolId: ACP_TERMINAL_TOOL_ID,
          input: { command: params.command, args: params.args ?? [], cwd },
          effects: shape.effects,
          preview: {
            ...(shape.preview ?? {}),
            title: `${context.agentName}: ${shape.preview?.title ?? commandLine}`,
            metadata: {
              agentId: context.agentId,
              agentName: context.agentName,
              toolKind: 'execute',
              ...(shape.preview?.metadata ?? {}),
            },
          },
        })
        if (decision.kind === 'deny') {
          throw new Error(`onething denied running "${commandLine}"${decision.reason ? ` (${decision.reason})` : ''}.`)
        }
      }

      const terminals = service()
      const info = terminals.create({
        command: params.command,
        ...(params.args ? { args: params.args } : {}),
        cwd,
        env: { ...definedEnv(spawnEnv()), ...(params.env ?? {}) },
        owner: { kind: 'acp', agentId: context.agentId, sessionId: context.localSessionId },
      })
      let settle!: (status: AcpTerminalExitStatus) => void
      const entry: OwnedTerminal = {
        agentId: context.agentId,
        sessionId: context.localSessionId,
        outputLimit: Math.min(params.outputByteLimit ?? ACP_TERMINAL_MAX_OUTPUT_BYTES, ACP_TERMINAL_MAX_OUTPUT_BYTES),
        exited: new Promise(resolve => { settle = resolve }),
      }
      owned.set(info.id, entry)
      terminals.onExit(info.id, status => {
        entry.exitStatus = toAcpExitStatus(status)
        settle(entry.exitStatus)
      })
      return { terminalId: info.id }
    },

    async output(context, params) {
      const entry = ownedBy(context, params.terminalId)
      const snapshot = service().readOutput(params.terminalId)
      if (!snapshot) throw new Error(`Terminal ${params.terminalId} is no longer available.`)
      const kept = keepTailBytes(snapshot.output, entry.outputLimit)
      const exitStatus = entry.exitStatus ?? (snapshot.exit ? toAcpExitStatus(snapshot.exit) : undefined)
      return {
        output: kept.text,
        truncated: kept.truncated || snapshot.truncated,
        exitStatus: exitStatus ?? null,
      }
    },

    async waitForExit(context, params) {
      return ownedBy(context, params.terminalId).exited
    },

    async kill(context, params) {
      ownedBy(context, params.terminalId)
      service().terminate(params.terminalId)
    },

    async release(context, params) {
      ownedBy(context, params.terminalId)
      owned.delete(params.terminalId)
      // 「我不要了」:还活着就杀,并从列表摘掉(`kill` 对已退出的那一格只是摘表)。
      await service().kill(params.terminalId)
    },
  }
}
