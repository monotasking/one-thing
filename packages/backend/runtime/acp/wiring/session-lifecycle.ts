/**
 * ACP 会话生命的装配半边(A5,方案 `docs/design/acp-integration-2026-09.md` §3.7 / §11.6):
 * 列 agent 那边的会话、认领一条、分叉一条。
 *
 * 产品层(`ACPClient`)只管协议:`session/list` 翻页、`session/load` 时把回放交出来、`session/fork`、
 * 链接落盘。这里管 onething 这一侧的事实:本地会话怎么建(与 `sessions.create` 同一条路,端口由
 * RPC 域递)、回放怎么折成消息(`foldAcpReplay`,纯函数)、折好的消息怎么进账本(端口 =
 * `sessionCommands.replaceAll({ reason: 'replaced' })`,一条消息一条 `message/imported`)、
 * 认领怎么查重(链接表里有、本地会话也还在 = 已认领,答那一条)。
 *
 * 失败一律答 `{ ok: false, code, error }`,不抛:`unsupported`(没自报那项能力)/
 * `unavailable`(连不上、停用、名册里没有、崩溃退避锁着)/ `failed`(agent 拒了、本地落不下)。
 */
import { randomUUID } from 'node:crypto'
import type { SessionUpdate, ToolCallContent, ToolCallStatus } from '@agentclientprotocol/sdk'
import type { AcpRemoteSessionInfo } from '@shared/contracts/acp'
import type { ChatMessage, ContentPart } from '@shared/ipc/chat.js'
import type { ToolCall } from '@shared/ipc/tools.js'
import type { JsonObject, JsonValue } from '@shared/json.js'
import type {
  ACPAdoptSessionResponse,
  ACPForkSessionResponse,
  ACPListRemoteSessionsResponse,
  AcpSessionLifecycleFailure,
} from '@shared/ipc/acp.js'
import { getLogger } from '@onething/backend/wiring/logging/index.js'

const log = getLogger('app.acp.lifecycle')

/** 认领来的消息在 `origin.source` 上带的戳。 */
export const ACP_IMPORT_ORIGIN_SOURCE = 'acp-import'

// ── 回放 → 消息(纯) ─────────────────────────────────────────────────────

export interface FoldAcpReplayOptions {
  /** 助手消息的 `model`(= agent id,与发消息那条路记的同一格)。 */
  agentId: string
  /** 第一条消息的时刻;之后每条 +1ms,保证顺序稳定。缺省 = 现在。 */
  startAt?: number
  /** 消息 id 的来源;单测递确定的。 */
  newId?: () => string
}

const TOOL_STATUS: Record<ToolCallStatus, ToolCall['status']> = {
  pending: 'pending',
  in_progress: 'executing',
  completed: 'completed',
  failed: 'failed',
}

function blockText(content: unknown): string {
  if (!content || typeof content !== 'object') return ''
  const block = content as { type?: unknown; text?: unknown; uri?: unknown; name?: unknown; resource?: { text?: unknown; uri?: unknown } }
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  if (block.type === 'resource_link' && typeof block.uri === 'string') {
    return `[${typeof block.name === 'string' ? block.name : block.uri}](${block.uri})`
  }
  if (block.type === 'resource' && block.resource) {
    if (typeof block.resource.text === 'string') return block.resource.text
    if (typeof block.resource.uri === 'string') return block.resource.uri
  }
  return ''
}

function toJsonObject(value: unknown): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) return JSON.parse(JSON.stringify(value)) as JsonObject
  return value === undefined ? {} : { value: JSON.parse(JSON.stringify(value)) as JsonValue }
}

function toolContentText(content: ToolCallContent[] | null | undefined): string | undefined {
  const text = (content ?? [])
    .map(item => (item.type === 'content' ? blockText(item.content) : ''))
    .filter(Boolean)
    .join('\n')
  return text || undefined
}

/**
 * 折叠途中的草稿。**故意不长成消息 / 工具调用的形状**(没有 `role` / `status`):会话消息的字段
 * 只许 core 的归约器改(`bun run session:gate`),这里改的是自己的草稿,收尾时一次性构造出
 * 全新的 `ChatMessage` / `ToolCall`。
 */
interface ToolDraft {
  callId: string
  kind?: string
  title?: string
  input: JsonObject
  phase: ToolCall['status']
  output?: string
}

type PartDraft =
  | { part: 'text' | 'reasoning'; text: string }
  | { part: 'tool'; callId: string }

interface TurnDraft {
  speaker: 'user' | 'assistant'
  text: string
  thought: string
  parts: PartDraft[]
  toolIds: string[]
  at: number
}

/**
 * agent 在 `session/load` 里回放的更新,按到达顺序折成消息:
 *  - `user_message_chunk` 连着的几段是一条用户消息;
 *  - `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` 连着的是一条助手消息
 *    (正文、思考、工具按出现顺序进 `contentParts`,工具同时进 `toolCalls`);
 *  - 别的种类(命令表、模式、计划、用量、标题…)是会话状态,不是消息 —— 跳过。
 * `tool_call_update` 找不到对应的 `tool_call` 也照样开一格(agent 只回放了结局的那种)。
 */
export function foldAcpReplay(updates: readonly SessionUpdate[], options: FoldAcpReplayOptions): ChatMessage[] {
  const newId = options.newId ?? randomUUID
  const startAt = options.startAt ?? Date.now()
  const turns: TurnDraft[] = []
  const tools = new Map<string, ToolDraft>()
  const toolAt = new Map<string, number>()
  let clock = 0

  const turnOf = (speaker: TurnDraft['speaker']): TurnDraft => {
    const last = turns[turns.length - 1]
    if (last && last.speaker === speaker) return last
    const turn: TurnDraft = { speaker, text: '', thought: '', parts: [], toolIds: [], at: startAt + clock++ }
    turns.push(turn)
    return turn
  }
  const appendPart = (turn: TurnDraft, part: 'text' | 'reasoning', text: string) => {
    const last = turn.parts[turn.parts.length - 1]
    if (last && last.part === part) last.text += text
    else turn.parts.push({ part, text })
  }
  const toolOf = (turn: TurnDraft, callId: string): ToolDraft => {
    const existing = tools.get(callId)
    if (existing) return existing
    const draft: ToolDraft = { callId, input: {}, phase: 'pending' }
    tools.set(callId, draft)
    toolAt.set(callId, startAt + clock++)
    turn.toolIds.push(callId)
    turn.parts.push({ part: 'tool', callId })
    return draft
  }
  const patchTool = (draft: ToolDraft, update: {
    title?: string | null
    kind?: string | null
    status?: ToolCallStatus | null
    rawInput?: unknown
    rawOutput?: unknown
    content?: ToolCallContent[] | null
  }) => {
    if (update.title) draft.title = update.title
    if (update.kind) draft.kind = update.kind
    if (update.status) draft.phase = TOOL_STATUS[update.status] ?? draft.phase
    if (update.rawInput !== undefined) draft.input = toJsonObject(update.rawInput)
    if (update.rawOutput !== undefined) draft.output = JSON.stringify(update.rawOutput)
    else {
      const text = toolContentText(update.content)
      if (text !== undefined) draft.output = text
    }
  }

  for (const update of updates) {
    switch (update.sessionUpdate) {
      case 'user_message_chunk': {
        const text = blockText(update.content)
        if (text) turnOf('user').text += text
        break
      }
      case 'agent_message_chunk': {
        const text = blockText(update.content)
        if (!text) break
        const turn = turnOf('assistant')
        turn.text += text
        appendPart(turn, 'text', text)
        break
      }
      case 'agent_thought_chunk': {
        const text = blockText(update.content)
        if (!text) break
        const turn = turnOf('assistant')
        turn.thought += text
        appendPart(turn, 'reasoning', text)
        break
      }
      case 'tool_call': {
        patchTool(toolOf(turnOf('assistant'), update.toolCallId), update)
        break
      }
      case 'tool_call_update': {
        patchTool(tools.get(update.toolCallId) ?? toolOf(turnOf('assistant'), update.toolCallId), update)
        break
      }
      default:
        break
    }
  }

  const origin = { transport: 'api' as const, source: ACP_IMPORT_ORIGIN_SOURCE, receivedAt: startAt }
  const built = new Map<string, ToolCall>()
  const toolCallOf = (callId: string): ToolCall => {
    const cached = built.get(callId)
    if (cached) return cached
    const draft = tools.get(callId)!
    const call: ToolCall = {
      id: draft.callId,
      toolId: draft.kind ?? 'acp',
      toolName: draft.title ?? draft.kind ?? 'tool',
      arguments: draft.input,
      status: draft.phase,
      timestamp: toolAt.get(callId) ?? startAt,
      ...(draft.output !== undefined ? { result: draft.output } : {}),
      ...(draft.phase === 'failed' && draft.output !== undefined ? { error: draft.output } : {}),
    }
    built.set(callId, call)
    return call
  }
  const out: ChatMessage[] = []
  for (const turn of turns) {
    // 空壳(只有空白)的消息不进账本;带工具调用的助手消息留着。
    if (!turn.text.trim() && turn.toolIds.length === 0 && !turn.thought.trim()) continue
    if (turn.speaker === 'user') {
      out.push({ id: newId(), role: 'user', content: turn.text, timestamp: turn.at, origin })
      continue
    }
    const contentParts: ContentPart[] = turn.parts.map(part => (part.part === 'tool'
      ? { type: 'tool-call' as const, toolCalls: [toolCallOf(part.callId)] }
      : { type: part.part, content: part.text }))
    out.push({
      id: newId(),
      role: 'assistant',
      content: turn.text,
      timestamp: turn.at,
      origin,
      provider: 'acp',
      model: options.agentId,
      ...(turn.thought ? { reasoning: turn.thought } : {}),
      ...(turn.toolIds.length > 0 ? { toolCalls: turn.toolIds.map(toolCallOf) } : {}),
      ...(contentParts.length > 0 ? { contentParts } : {}),
    })
  }
  return out
}

/**
 * 分叉抄本地历史:每条换新 id,去掉只对源会话有意义的几格(页内序号、执行 id、流式标记、会话 id);
 * 流式中的那条(还没收场)不抄。整条重新构造,不改源那一份。
 */
export function copyMessagesForFork(messages: readonly ChatMessage[], newId: () => string): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const message of messages) {
    if (message.isStreaming) continue
    const { seq: _seq, runId: _runId, sessionId: _sessionId, isStreaming: _streaming, ...rest } = structuredClone(message) as ChatMessage
    out.push({ ...rest, id: newId() })
  }
  return out
}

// ── 生命周期(端口式,单测递假的) ───────────────────────────────────────

export interface AcpSessionLifecycleManagerPort {
  listRemoteSessions(agentId: string, cwd?: string): Promise<AcpRemoteSessionInfo[]>
  adoptRemoteSession(
    agentId: string,
    localSessionId: string,
    acpSessionId: string,
    cwd: string,
  ): Promise<{ acpSessionId: string; cwd: string; replay: SessionUpdate[] }>
  forkSession(agentId: string, sourceLocalSessionId: string, targetLocalSessionId: string, cwd?: string): Promise<{ acpSessionId: string; cwd: string }>
  linkedLocalSessions(agentId: string, acpSessionId: string): string[]
  canonicalAgentId(agentId: string): string
}

export interface AcpLocalSessionFacts {
  workingDirectory?: string
  lastProvider?: string
  lastModel?: string
  name?: string
}

export interface AcpSessionLifecyclePorts {
  manager: AcpSessionLifecycleManagerPort
  /** 本地会话在不在、它的目录与模型;不在 = undefined。 */
  getSession(sessionId: string): AcpLocalSessionFacts | undefined
  /**
   * 建一条本地会话(与 `sessions.create` 同一条路),绑目录、模型指到 `acp` / 这台 agent。
   * 答真正落下的 id。
   */
  createSession(input: {
    sessionId: string
    name: string
    cwd: string
    agentId: string
  }): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>
  /** 一条本地会话此刻的消息(投影);分叉抄本地历史用。 */
  listMessages(sessionId: string): readonly ChatMessage[]
  /** 消息进账本(`sessionCommands.replaceAll({ reason: 'replaced' })` + 落盘检查点)。 */
  importMessages(sessionId: string, messages: ChatMessage[]): Promise<void>
  /** 建出来却没接上时收回那条本地会话;缺席 = 不收。 */
  discardSession?(sessionId: string): Promise<void>
  newId?(): string
}

function failure(code: AcpSessionLifecycleFailure['code'], error: unknown): AcpSessionLifecycleFailure {
  return { ok: false, code, error: error instanceof Error ? error.message : String(error) }
}

/**
 * 错误 → 码。产品层抛的两种带着 `code`(没自报能力 = `unsupported`,退避锁着 = `unavailable`);
 * 管家自己的「停用 / 找不到 / 连不上」按原话认;其余是 `failed`。
 */
export function classifyAcpLifecycleError(error: unknown, stage: 'connect' | 'request'): AcpSessionLifecycleFailure {
  const code = (error as { code?: unknown } | undefined)?.code
  if (code === 'unsupported' || code === 'unavailable') return failure(code, error)
  const message = error instanceof Error ? error.message : String(error)
  if (/is disabled|not found|ACP is disabled|connection is not available|did not initialize|was not found on PATH/i.test(message)) {
    return failure('unavailable', error)
  }
  return failure(stage === 'connect' ? 'unavailable' : 'failed', error)
}

export class AcpSessionLifecycle {
  /**
   * 同一条 agent 会话的认领在飞时,第二发复用第一发(连点两下不建两条)。RPC 域每次调用按调用方
   * 造一只(端口带着调用方身份),所以这张表由它递进来共用。
   */
  private readonly adopting: Map<string, Promise<ACPAdoptSessionResponse>>

  constructor(
    private readonly ports: AcpSessionLifecyclePorts,
    adopting: Map<string, Promise<ACPAdoptSessionResponse>> = new Map(),
  ) {
    this.adopting = adopting
  }

  /** 这条 agent 会话已经对应着的、还在的本地会话。 */
  private adoptedLocal(agentId: string, acpSessionId: string): string | undefined {
    return this.ports.manager.linkedLocalSessions(agentId, acpSessionId)
      .find(localSessionId => Boolean(this.ports.getSession(localSessionId)))
  }

  async listRemoteSessions(request: { agentId: string; cwd?: string }): Promise<ACPListRemoteSessionsResponse> {
    if (!request?.agentId) return failure('failed', 'agentId is required')
    let sessions: AcpRemoteSessionInfo[]
    try {
      sessions = await this.ports.manager.listRemoteSessions(request.agentId, request.cwd || undefined)
    } catch (error) {
      log.warn('acp listRemoteSessions failed', { agentId: request.agentId }, error)
      return classifyAcpLifecycleError(error, 'request')
    }
    return {
      ok: true,
      sessions: sessions.map(info => {
        const adoptedSessionId = this.adoptedLocal(request.agentId, info.acpSessionId)
        return adoptedSessionId ? { ...info, adoptedSessionId } : info
      }),
    }
  }

  adoptSession(request: { agentId: string; acpSessionId: string; cwd: string }): Promise<ACPAdoptSessionResponse> {
    if (!request?.agentId || !request.acpSessionId || !request.cwd) {
      return Promise.resolve(failure('failed', 'agentId, acpSessionId and cwd are required'))
    }
    const key = `${this.ports.manager.canonicalAgentId(request.agentId)}\u0000${request.acpSessionId}`
    const inflight = this.adopting.get(key)
    if (inflight) return inflight.then(result => (result.ok ? { ...result, imported: 0, alreadyAdopted: true } : result))
    const run = this.runAdopt(request).finally(() => {
      if (this.adopting.get(key) === run) this.adopting.delete(key)
    })
    this.adopting.set(key, run)
    return run
  }

  private async runAdopt(request: { agentId: string; acpSessionId: string; cwd: string }): Promise<ACPAdoptSessionResponse> {
    const agentId = this.ports.manager.canonicalAgentId(request.agentId)
    const existing = this.adoptedLocal(agentId, request.acpSessionId)
    if (existing) return { ok: true, sessionId: existing, imported: 0, alreadyAdopted: true }

    const sessionId = this.ports.newId?.() ?? randomUUID()
    let adopted: { acpSessionId: string; cwd: string; replay: SessionUpdate[] }
    try {
      adopted = await this.ports.manager.adoptRemoteSession(agentId, sessionId, request.acpSessionId, request.cwd)
    } catch (error) {
      log.warn('acp adopt: load failed', { agentId, acpSessionId: request.acpSessionId }, error)
      return classifyAcpLifecycleError(error, 'request')
    }

    const messages = foldAcpReplay(adopted.replay, { agentId })
    const title = this.remoteTitle(adopted.replay) ?? `Imported from ${agentId}`
    const created = await this.createLocal({ sessionId, name: title, cwd: adopted.cwd, agentId })
    if (!created.ok) return failure('failed', created.error)
    try {
      if (messages.length > 0) await this.ports.importMessages(created.sessionId, messages)
    } catch (error) {
      log.warn('acp adopt: import failed', { agentId, sessionId: created.sessionId }, error)
      await this.ports.discardSession?.(created.sessionId).catch(() => undefined)
      return failure('failed', error)
    }
    log.info('acp session adopted', {
      agentId,
      acpSessionId: request.acpSessionId,
      sessionId: created.sessionId,
      replayed: adopted.replay.length,
      imported: messages.length,
    })
    return { ok: true, sessionId: created.sessionId, imported: messages.length, alreadyAdopted: false }
  }

  /** 建本地会话;端口抛了也折成失败答复(域的约定是不抛)。 */
  private async createLocal(
    input: Parameters<AcpSessionLifecyclePorts['createSession']>[0],
  ): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
    try {
      return await this.ports.createSession(input)
    } catch (error) {
      log.warn('acp: creating the local session failed', { sessionId: input.sessionId }, error)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 回放里最后一次 `session_info_update.title`(agent 自己的标题)。 */
  private remoteTitle(replay: readonly SessionUpdate[]): string | undefined {
    let title: string | undefined
    for (const update of replay) {
      if (update.sessionUpdate === 'session_info_update' && typeof update.title === 'string' && update.title.trim()) {
        title = update.title.replace(/\s+/g, ' ').trim()
      }
    }
    return title
  }

  /**
   * 分叉:先建一条本地会话(同目录、同一台 agent),再让 agent 把源那条 fork 到它名下(链接由产品层
   * 在 fork 答复后落下;agent 那边失败 → 收回刚建的本地会话),最后把源会话此刻的本地历史抄进来
   * (换新 id,同一扇 `replaceAll` 门 → `message/imported`)。抄历史失败只记一行:分叉本身已成立,
   * agent 那边的上下文是完整的。
   *
   * 不走 `sessions.createBranch`:那条路把继承的消息交给仓库而不落账本,投影里读到 0 条
   * (gate:acp ㉑ 实测)。
   */
  async forkSession(request: { sessionId: string; agentId?: string }): Promise<ACPForkSessionResponse> {
    if (!request?.sessionId) return failure('failed', 'sessionId is required')
    const source = this.ports.getSession(request.sessionId)
    if (!source) return failure('failed', `Session "${request.sessionId}" not found`)
    const agentId = request.agentId
      || (source.lastProvider === 'acp' ? source.lastModel : undefined)
    if (!agentId) return failure('unavailable', `Session "${request.sessionId}" is not an ACP agent session`)
    const cwd = source.workingDirectory?.trim()
    if (!cwd) return failure('failed', `Session "${request.sessionId}" has no working directory`)

    const created = await this.createLocal({
      sessionId: this.ports.newId?.() ?? randomUUID(),
      name: `${source.name?.trim() || 'Session'} (fork)`,
      cwd,
      agentId: this.ports.manager.canonicalAgentId(agentId),
    })
    if (!created.ok) return failure('failed', created.error)
    try {
      await this.ports.manager.forkSession(agentId, request.sessionId, created.sessionId, cwd)
    } catch (error) {
      log.warn('acp fork failed', { agentId, sessionId: request.sessionId }, error)
      await this.ports.discardSession?.(created.sessionId).catch(() => undefined)
      return classifyAcpLifecycleError(error, 'request')
    }
    let inherited = 0
    try {
      const copies = copyMessagesForFork(this.ports.listMessages(request.sessionId), this.ports.newId ?? randomUUID)
      if (copies.length > 0) await this.ports.importMessages(created.sessionId, copies)
      inherited = copies.length
    } catch (error) {
      log.warn('acp fork: copying the local history failed', { from: request.sessionId, to: created.sessionId }, error)
    }
    log.info('acp session forked', { agentId, from: request.sessionId, to: created.sessionId, inherited })
    return { ok: true, sessionId: created.sessionId }
  }
}
