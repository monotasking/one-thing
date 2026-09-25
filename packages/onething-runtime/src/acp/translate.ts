import type {
  AgentFinishReason,
  AgentJsonObject,
  AgentProviderData,
  AgentToolCall,
  AgentToolResult,
  AgentToolResultContentPart,
  AgentTurnStreamEvent,
  AgentUsage,
} from '@onething/core/agent-loop'
import { buildTextDiffChange, type TextDiffChange } from '../external-agents/diff-changes.js'

/**
 * ACP 流事件 → 引擎回合事件的翻译(A0-3 从 `agent-loop/providers/acp.ts` 搬来)。
 *
 * 这里只收「一条 `session/prompt` 的在飞事件怎么变成 `AgentTurnStreamEvent`」这一件事:
 * 纯函数、不认识 `ACPManager`、不认识连接。连接器(`external-agents/acp-connector.ts`)
 * 负责把会话开起来、把事件流递进来。A2-a 起工具调用保真:diff / terminal / locations /
 * kind / 进行中状态走 `tool-metadata`(见 `ACPToolFacets`),压缩摘要走 `provider-data`。
 *
 * 入参用结构化子集而不是 SDK 的类型:测试夹具与回放文件可以直接写字面量,
 * SDK 的判别联合换版时这一层也不跟着抖。
 */

export interface ACPWireContentPart {
  type: string
  text?: string
}

/**
 * Structural subset of ACP `ToolCallContent`: an embedded content block
 * (`type: 'content'`), a diff (`type: 'diff'`) or a terminal ref
 * (`type: 'terminal'`;A2-a 起不再丢,它的 `terminalId` 进工具卡)。
 */
export interface ACPWireToolCallContentPart {
  type: string
  content?: ACPWireContentPart | null
  text?: string
  path?: string | null
  oldText?: string | null
  newText?: string | null
  terminalId?: string | null
}

/** ACP `ToolCallLocation` 的结构化子集:读了 / 改了哪个文件的哪一行(「跟着 agent 走」)。 */
export interface ACPWireToolCallLocation {
  path: string
  line?: number | null
}

/**
 * Structural subset of the ACP `tool_call` / `tool_call_update` session
 * update payloads (@agentclientprotocol/sdk ToolCall / ToolCallUpdate),
 * plus `compaction_summary_chunk`'s `compactionId`.
 */
export interface ACPWireSessionUpdate {
  sessionUpdate: string
  /**
   * Message/thought chunks carry a single content block; tool_call and
   * tool_call_update carry an array of ToolCallContent — same wire field.
   */
  content?: ACPWireContentPart | ACPWireToolCallContentPart[] | null
  toolCallId?: string
  title?: string | null
  /** 工具的程序名(协议里可选)。在场就当工具名用,缺席才退回 `kind`。 */
  name?: string | null
  kind?: string | null
  status?: string | null
  locations?: ACPWireToolCallLocation[] | null
  rawInput?: unknown
  rawOutput?: unknown
  compactionId?: string | null
}

export type ACPWireStreamEvent =
  | { type: 'warning'; message: string }
  | { type: 'finish'; stopReason: string; usage?: AgentUsage }
  | {
      type: 'update'
      notification: {
        update: ACPWireSessionUpdate
      }
    }

export function mapACPFinishReason(stopReason: string): AgentFinishReason {
  if (stopReason === 'end_turn') return 'stop'
  if (stopReason === 'max_tokens') return 'length'
  if (stopReason === 'refusal') return 'content_filter'
  return 'unknown'
}

function textFromACPContent(
  content: ACPWireContentPart | ACPWireToolCallContentPart[] | null | undefined,
): string | undefined {
  if (!content || Array.isArray(content)) return undefined
  return content.type === 'text' ? content.text : undefined
}

function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * 一次 `tool_call(_update)` 的内容块里,除了给正文的那几段文字,还带着的结构化事实。
 * 文字仍按旧口径进 `tool-partial-result`(diff 缩成一行 `[diff] <path>`,结局正文照旧读得懂);
 * diff 的原文与 terminal 的 id 从这里走 `tool-metadata`,壳才画得出 diff 视图与「打开终端」。
 */
interface ACPToolContentDigest {
  parts: AgentToolResultContentPart[]
  change?: TextDiffChange
  terminalId?: string
}

/**
 * 一次更新里的几段 diff 合成一份改动(`toolCall.changes` 只有一格)。
 * 统一 diff 本来就允许多段文件头首尾相接,所以正文直接拼;路径取第一段 —— 其余文件在
 * `locations` 与 diff 正文里都还在,不丢。
 */
function mergeChanges(changes: TextDiffChange[]): TextDiffChange | undefined {
  if (changes.length === 0) return undefined
  if (changes.length === 1) return changes[0]
  return {
    path: changes[0]!.path,
    diff: changes.map(change => change.diff.trimEnd()).join('\n'),
    additions: changes.reduce((sum, change) => sum + change.additions, 0),
    deletions: changes.reduce((sum, change) => sum + change.deletions, 0),
  }
}

function digestACPToolContent(
  content: ACPWireToolCallContentPart[] | null | undefined,
): ACPToolContentDigest {
  const parts: AgentToolResultContentPart[] = []
  const changes: TextDiffChange[] = []
  let terminalId: string | undefined
  for (const item of content ?? []) {
    if (item.type === 'content') {
      const text = item.content?.type === 'text' ? item.content.text : item.text
      if (text) parts.push({ type: 'text', text })
      continue
    }
    if (item.type === 'diff') {
      const path = item.path ?? ''
      parts.push({ type: 'text', text: `[diff] ${path}`.trim(), path: item.path ?? undefined })
      // 与 Claude 连接器、ACP 的 fs 写桥同一条链(`buildTextDiffChange`):新建文件时
      // `oldText` 缺席 = 从空文开始。前后一样答 null,那就没有 diff 可画。
      if (path && typeof item.newText === 'string') {
        const change = buildTextDiffChange(path, item.oldText ?? '', item.newText)
        if (change) changes.push(change)
      }
      continue
    }
    if (item.type === 'terminal' && typeof item.terminalId === 'string' && item.terminalId) {
      terminalId = item.terminalId
    }
  }
  const change = mergeChanges(changes)
  return { parts, ...(change ? { change } : {}), ...(terminalId ? { terminalId } : {}) }
}

function normalizeLocations(
  locations: ACPWireToolCallLocation[] | null | undefined,
): Array<{ path: string; line?: number }> | undefined {
  if (!Array.isArray(locations)) return undefined
  const out: Array<{ path: string; line?: number }> = []
  for (const location of locations) {
    if (!location || typeof location.path !== 'string' || !location.path) continue
    out.push({
      path: location.path,
      ...(typeof location.line === 'number' ? { line: location.line } : {}),
    })
  }
  return out
}

/**
 * 工具卡要的那几格事实(A2-a)。**只**走 `tool-metadata.update.metadata` —— core 的工具事件
 * 词汇一格没加:
 *
 *  - `kind` —— 协议的工具类别(read / edit / execute / search / fetch …),壳按它选 presenter;
 *  - `status` —— 只收 `pending` / `in_progress`(卡上「等待 / 进行中」);收尾由 `tool-result` 说;
 *  - `locations` —— `[{ path, line? }]`,卡脚可点;
 *  - `terminalId` —— 内容块里嵌的 agent 终端(A3-b 起它就是 onething 的终端),卡上「打开终端」;
 *  - `path` / `diff` / `additions` / `deletions` —— 与 Claude 连接器那条 `tool-metadata` 逐格同形,
 *    引擎的 `changesFromMetadata` 把它折成 `toolCall.changes`,账本经 `tool/result.changes` 落盘;
 *  - `output` —— 到这一刻为止的正文。**必须带**:引擎拿 metadata 当 step 结局正文时,
 *    有 `output` 读 `output`,没有就把整份 metadata 序列化成 JSON 上屏。
 */
interface ACPToolFacets {
  kind?: string
  status?: 'pending' | 'in_progress'
  locations?: Array<{ path: string; line?: number }>
  terminalId?: string
  change?: TextDiffChange
}

interface ACPToolCallState {
  toolCall: AgentToolCall
  settled: boolean
  resultParts: AgentToolResultContentPart[]
  title?: string
  facets: ACPToolFacets
}

function outputText(state: ACPToolCallState): string {
  return state.resultParts.map(part => part.text ?? '').filter(Boolean).join('\n')
}

function metadataOf(state: ACPToolCallState): AgentJsonObject {
  const { kind, status, locations, terminalId, change } = state.facets
  return {
    output: outputText(state),
    ...(kind ? { kind } : {}),
    ...(status ? { status } : {}),
    ...(locations && locations.length > 0 ? { locations } : {}),
    ...(terminalId ? { terminalId } : {}),
    ...(change
      ? { path: change.path, diff: change.diff, additions: change.additions, deletions: change.deletions }
      : {}),
  }
}

/**
 * 收尾时留在**结局**上的那几格(`tool-result.result.data.metadata`)。
 *
 * `tool-metadata` 的 metadata 在引擎里只改 step 标题 / 正文与 `toolCall.changes`,其余格既不进
 * 消息也不进账本;而结局的 `data` 会原样成为 `toolCall.result`(账本 `tool/result.resultData`)——
 * 与内置工具的 `{ output, metadata }` 同一个形状。于是 kind / locations / terminalId 在会话重开
 * 之后还在卡上。diff 不在这里:它有自己的一格(`changes`)。
 */
function settledMetadataOf(state: ACPToolCallState): AgentJsonObject | undefined {
  const { kind, locations, terminalId } = state.facets
  const metadata: AgentJsonObject = {
    ...(kind ? { kind } : {}),
    ...(locations && locations.length > 0 ? { locations } : {}),
    ...(terminalId ? { terminalId } : {}),
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined
}

/** Per-stream tracker mapping ACP tool_call notifications onto structured
 * externally-executed agent tool events. */
function createACPToolCallTracker(turn: number) {
  const states = new Map<string, ACPToolCallState>()

  const start = (update: ACPWireSessionUpdate): AgentTurnStreamEvent[] => {
    const id = update.toolCallId
    if (!id) return []
    const existing = states.get(id)
    if (existing) return progress(update)
    const toolCall: AgentToolCall = {
      id,
      // 协议 v1 的 `name` 是工具的程序名;在场就用它(`edit_file` 比 `edit` 说得清),
      // 类别照样进 metadata 供壳选 presenter。
      name: update.name || update.kind || 'tool',
      arguments: safeStringify(update.rawInput ?? {}) || '{}',
      externallyExecuted: true,
    }
    const state: ACPToolCallState = { toolCall, settled: false, resultParts: [], facets: {} }
    states.set(id, state)
    return [
      { type: 'tool-call-start', turn, toolCallId: id, toolName: toolCall.name },
      { type: 'tool-call-done', turn, toolCall },
      ...progressEvents(state, update),
    ]
  }

  const progress = (update: ACPWireSessionUpdate): AgentTurnStreamEvent[] => {
    const id = update.toolCallId
    if (!id) return []
    const state = states.get(id)
    // Defensive: some agents emit tool_call_update before tool_call.
    if (!state) return start({ ...update, sessionUpdate: 'tool_call' })
    if (state.settled) return []
    return progressEvents(state, update)
  }

  /**
   * 一条更新 → 至多三件事,顺序固定:metadata(标题或事实变了才发)→ 正文片段 → 收尾。
   * metadata 排在收尾前面,是因为 diff 要在 `tool-result` 落账之前挂上(记录器在那一刻才把
   * `changes` 写进 `tool/result`)。
   */
  const progressEvents = (
    state: ACPToolCallState,
    update: ACPWireSessionUpdate,
  ): AgentTurnStreamEvent[] => {
    const events: AgentTurnStreamEvent[] = []
    const digest = digestACPToolContent(Array.isArray(update.content) ? update.content : undefined)
    if (digest.parts.length > 0) state.resultParts.push(...digest.parts)

    let changed = false
    const title = update.title || undefined
    const titleChanged = Boolean(title && title !== state.title)
    if (titleChanged) state.title = title
    if (update.kind && update.kind !== state.facets.kind) {
      state.facets.kind = update.kind
      changed = true
    }
    if ((update.status === 'pending' || update.status === 'in_progress') && update.status !== state.facets.status) {
      state.facets.status = update.status
      changed = true
    }
    const locations = normalizeLocations(update.locations)
    if (locations && JSON.stringify(locations) !== JSON.stringify(state.facets.locations ?? [])) {
      state.facets.locations = locations
      changed = true
    }
    if (digest.terminalId && digest.terminalId !== state.facets.terminalId) {
      state.facets.terminalId = digest.terminalId
      changed = true
    }
    if (digest.change) {
      state.facets.change = digest.change
      changed = true
    }
    if (titleChanged || changed) {
      events.push({
        type: 'tool-metadata',
        turn,
        toolCall: state.toolCall,
        update: { ...(titleChanged && title ? { title } : {}), metadata: metadataOf(state) },
      })
    }

    if (digest.parts.length > 0) {
      events.push({
        type: 'tool-partial-result',
        turn,
        toolCall: state.toolCall,
        update: { content: digest.parts },
      })
    }
    if (update.status === 'completed' || update.status === 'failed') {
      events.push(settleEvent(state, {
        failed: update.status === 'failed',
        rawOutput: update.rawOutput,
      }))
    }
    return events
  }

  const settleEvent = (
    state: ACPToolCallState,
    outcome: { failed?: boolean; aborted?: boolean; rawOutput?: unknown },
  ): AgentTurnStreamEvent => {
    state.settled = true
    const content = safeStringify(outcome.rawOutput) || outputText(state)
    const metadata = settledMetadataOf(state)
    const result: AgentToolResult = {
      content,
      ...(outcome.failed ? { error: content || 'Tool call failed' } : {}),
      ...(outcome.aborted ? { aborted: true, error: content || 'Tool call cancelled' } : {}),
      ...(metadata ? { data: { output: content, metadata } } : {}),
    }
    return { type: 'tool-result', turn, toolCall: state.toolCall, result }
  }

  /** The stream is ending; every unsettled call must still reach a terminal
   * state so downstream step state machines never hang on "running". */
  const settleRemaining = (options: { aborted: boolean }): AgentTurnStreamEvent[] => {
    const events: AgentTurnStreamEvent[] = []
    for (const state of states.values()) {
      if (state.settled) continue
      events.push(settleEvent(state, { aborted: options.aborted }))
    }
    return events
  }

  return { start, progress, settleRemaining }
}

/**
 * 上下文压缩的摘要(`compaction_summary_chunk`)按压缩攒成一段,换别的更新或收场时交出去一条
 * `provider-data { provider: 'acp', kind: 'compaction-summary', compactionId, text }` ——
 * 一次压缩在消息上是一个部件,壳把它折成「上下文更新」折痕行(与本地 compact 同一个组件)。
 * 压缩的**状态**(进行中 / 完成)不归这里,归会话状态表(`session-state.ts`)。
 */
function createCompactionSummaryBuffer(turn: number) {
  let current: { compactionId: string; text: string } | undefined
  const flush = (): AgentTurnStreamEvent[] => {
    const done = current
    current = undefined
    if (!done?.text) return []
    const providerData: AgentProviderData = {
      provider: 'acp',
      kind: 'compaction-summary',
      ...(done.compactionId ? { compactionId: done.compactionId } : {}),
      text: done.text,
    }
    return [{ type: 'provider-data', turn, providerData }]
  }
  const append = (update: ACPWireSessionUpdate): AgentTurnStreamEvent[] => {
    const compactionId = update.compactionId ?? ''
    const events = current && current.compactionId !== compactionId ? flush() : []
    if (!current) current = { compactionId, text: '' }
    const text = textFromACPContent(update.content)
    if (text) current.text += text
    return events
  }
  return { append, flush }
}

/**
 * 一条 prompt 的事件流 → 引擎回合事件。工具调用跟踪器是这一轮的局部量,
 * 流收场时把没收尾的调用一律结算掉,下游的步骤状态机才不会永远挂在「运行中」。
 */
export async function* translateACPPromptStream(
  events: AsyncIterable<ACPWireStreamEvent>,
  turn: number,
): AsyncGenerator<AgentTurnStreamEvent, void, void> {
  const tracker = createACPToolCallTracker(turn)
  const compaction = createCompactionSummaryBuffer(turn)

  for await (const event of events) {
    if (event.type === 'update' && event.notification.update.sessionUpdate === 'compaction_summary_chunk') {
      yield* compaction.append(event.notification.update)
      continue
    }
    yield* compaction.flush()

    if (event.type === 'warning') {
      yield { type: 'reasoning-delta', turn, delta: event.message }
      continue
    }

    if (event.type === 'finish') {
      yield* tracker.settleRemaining({ aborted: event.stopReason === 'cancelled' })
      yield {
        type: 'finish',
        turn,
        finishReason: mapACPFinishReason(event.stopReason),
        usage: event.usage,
      }
      continue
    }

    const update = event.notification.update
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        {
          const text = textFromACPContent(update.content)
          if (text) yield { type: 'text-delta', turn, delta: text }
        }
        break
      case 'agent_thought_chunk':
        {
          const text = textFromACPContent(update.content)
          if (text) yield { type: 'reasoning-delta', turn, delta: text }
        }
        break
      case 'plan':
        yield { type: 'reasoning-delta', turn, delta: 'ACP plan updated.' }
        break
      case 'tool_call':
        yield* tracker.start(update)
        break
      case 'tool_call_update':
        yield* tracker.progress(update)
        break
      default:
        break
    }
  }
  // 流在压缩摘要之后直接断(没有 finish):攒着的那段也要交出去。
  yield* compaction.flush()
}
