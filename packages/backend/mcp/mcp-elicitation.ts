/**
 * MCP 服务器发起的询问(`elicitation/create`)→ onething 的权限卡。
 *
 * 一台服务器在跑一次工具调用的途中可以反过来要用户点头 —— Codex 电脑操控那台就是这样问
 * 「Allow ChatGPT to use Calculator?」的(`docs/design/computer-use-2026-10.md` §2)。这只文件
 * 把那一句翻成 onething 自己的权限卡,答案再翻回 MCP 的 `{ action }`。
 *
 * 它不认识任何一台服务器:读的只有 MCP 协议里 elicitation 的形状,与「这次调用是谁发起的」
 * (客户端运行时在调用期间挂着的 `inFlightCall`,坐标由 toolkit 的 `McpTool` 从 `RunContext` 填)。
 *
 * 这一期只答**空表单**(`requestedSchema.properties` 为空 = 只要同意 / 拒绝):
 *  · URL 模式 → 拒绝(要开浏览器走 OAuth 一类,不是一张卡能答的);
 *  · 带字段的表单 → 拒绝(要出表单得走 `Interaction.ask`,另开单);
 *  · 没有在飞的调用(服务器自发问人)→ 拒绝:没有会话就没有卡可画。
 * 每一条拒绝都记一行日志,原因写在 `reason` 字段里。
 *
 * **「记住」由 onething 记,不交给服务器**:卡上的「本会话」/「本工作目录」落的是 onething 自己的
 * grant,type 是 `mcp_consent`(效果表 `packages/shared/toolkit/effects.ts` 那一行),pattern 是
 * 「哪台服务器 × 问的哪一句」。下次同一台服务器再问同一句,先查 grant,命中就直接同意不出卡。
 * 服务器那边 `_meta.persist` 的回包形状没有文档,不猜。
 */
import type { JsonObject } from '@shared/json'
import { Permission, matchGrant } from '@onething/backend/permission'
import type { Principal } from '@shared/permission/principal'
import { getLogger } from '../logging/logging.js'
import type { MCPInFlightToolCall } from './kernel/mcp-kernel-client-runtime.js'

const log = getLogger('mcp.elicitation')

/** 权限卡与 grant 的 `type`;效果表里的那一行同名。 */
export const MCP_CONSENT_PERMISSION_TYPE = 'mcp_consent'

/** 回给服务器的答案:MCP `ElicitResult` 的子集(同意时 `content` 是空表单)。 */
export type MCPElicitationAnswer =
  | { readonly action: 'accept'; readonly content: Record<string, never> }
  | { readonly action: 'decline' }

export interface MCPElicitationPorts {
  ask(input: Parameters<typeof Permission.ask>[0]): Promise<Permission.Response | undefined>
  matchGrant(input: { type: string; pattern: string; sessionId: string; workspaceRoot?: string }): unknown
}

const defaultPorts: MCPElicitationPorts = {
  ask: input => Permission.ask(input),
  matchGrant: input => matchGrant(input),
}

/** grant 的 pattern:哪台服务器 × 问的哪一句(空白折成一个空格,免得同一句话因换行记成两条)。 */
export function mcpConsentPattern(serverId: string, message: string): string {
  return `${serverId}:${message.trim().replace(/\s+/g, ' ')}`
}

interface ParsedElicitation {
  readonly message: string
  readonly mode: 'form' | 'url'
  readonly fieldCount: number
}

function parseElicitation(params: unknown): ParsedElicitation | undefined {
  if (!params || typeof params !== 'object') return undefined
  const record = params as Record<string, unknown>
  const message = typeof record.message === 'string' ? record.message : undefined
  if (message === undefined) return undefined
  const mode = record.mode === 'url' || typeof record.url === 'string' ? 'url' : 'form'
  const schema = record.requestedSchema
  const properties = schema && typeof schema === 'object'
    ? (schema as Record<string, unknown>).properties
    : undefined
  const fieldCount = properties && typeof properties === 'object' ? Object.keys(properties).length : 0
  return { message, mode, fieldCount }
}

export interface AnswerMCPElicitationInput {
  readonly serverId: string
  readonly serverName: string
  /** `elicitation/create` 的 `params`,原样。 */
  readonly params: unknown
  /** 客户端运行时此刻在飞的那一次调用;没有 = 服务器自发问人。 */
  readonly inFlight: MCPInFlightToolCall | null
}

export async function answerMCPElicitation(
  input: AnswerMCPElicitationInput,
  ports: MCPElicitationPorts = defaultPorts,
): Promise<MCPElicitationAnswer> {
  const { serverId } = input
  const decline = (reason: string, fields: JsonObject = {}): MCPElicitationAnswer => {
    log.info('mcp elicitation declined', { serverId, reason, ...fields })
    return { action: 'decline' }
  }

  const parsed = parseElicitation(input.params)
  if (!parsed) return decline('malformed')
  if (parsed.mode === 'url') return decline('url-mode-unsupported')
  if (parsed.fieldCount > 0) return decline('form-fields-unsupported', { fieldCount: parsed.fieldCount })

  const caller = input.inFlight?.caller
  if (!input.inFlight || !caller) return decline('no-in-flight-call')

  const pattern = mcpConsentPattern(serverId, parsed.message)
  const remembered = ports.matchGrant({
    type: MCP_CONSENT_PERMISSION_TYPE,
    pattern,
    sessionId: caller.sessionId,
    ...(caller.workingDirectory ? { workspaceRoot: caller.workingDirectory } : {}),
  })
  if (remembered) {
    log.debug('mcp elicitation accepted by grant', { serverId, sessionId: caller.sessionId, pattern })
    return { action: 'accept', content: {} }
  }

  try {
    const answer = await ports.ask({
      type: MCP_CONSENT_PERMISSION_TYPE,
      title: parsed.message,
      pattern,
      sessionId: caller.sessionId,
      messageId: caller.messageId ?? '',
      ...(caller.callId ? { callId: caller.callId } : {}),
      ...(caller.workingDirectory ? { workingDirectory: caller.workingDirectory } : {}),
      ...(caller.principal ? { principal: caller.principal as Principal } : {}),
      metadata: {
        serverId,
        serverName: input.serverName,
        toolName: input.inFlight.toolName,
        message: parsed.message,
        elicitation: true,
      },
    })
    // `undefined` = 别处新落的一条 grant 顺手把这张卡结了:那就是同意。
    if (answer === undefined || answer === 'once' || answer === 'session' || answer === 'workdir' || answer === 'always') {
      log.info('mcp elicitation accepted', { serverId, sessionId: caller.sessionId, answer: answer ?? 'settled-by-grant' })
      return { action: 'accept', content: {} }
    }
    return decline(`answered:${answer}`, { sessionId: caller.sessionId })
  } catch (error) {
    // 人按了拒绝(`RejectedError`)、无人值守到点、会话被拆 —— 对服务器都是同一个答案。
    return decline('rejected', {
      sessionId: caller.sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
