/**
 * ACP agent 要问人(`elicitation/create`)时的落点(A3-c,方案 `docs/design/acp-integration-2026-09.md`
 * §3.5 / §11.3)。落成 onething 自己的交互卡(`Interaction.ask`,E1 的内核)—— 与 Claude Code 那条路的
 * AskUserQuestion 同一张卡、同一种 deadline、同一套「没人在场就当场 declined」。
 *
 * 为什么非做不可:claude-agent-acp 0.81 只在客户端声明了 `elicitation.form` 时才把 AskUserQuestion
 * 发成表单,不声明就退化成一次普通审批 —— 用户看到的是「允许 / 拒绝」,而不是那几个选项。
 *
 * form 型:agent 给的是一份 JSON Schema 子集(`requestedSchema.properties`),每个属性一道题:
 *
 * | 属性 | 题 | 答回去 |
 * | --- | --- | --- |
 * | `string` + `oneOf` / `enum` | 单选,label = `title` / `enumNames` / 值本身 | 选中那一格的值 |
 * | `array`(`items.enum` / `items.anyOf`)| 多选 | 值数组 |
 * | `boolean` | 两选「是 / 否」 | `true` / `false` |
 * | `string` / `number` / `integer` | 只许自由输入,无选项 | 原文 / 数字(解析不出算没答) |
 * | 认不出的类型 | 一道自由输入 | 原文 |
 *
 * `oneOf` 项上的 `_meta['_claude/askUserQuestionOption']`(claude-agent-acp 的扩展)带
 * `description` / `preview` 时照原样上卡。`required` 里的题没答 → 答 `cancel`(交一份缺格的
 * `accept` 就是违反 agent 自己的 schema);可选的题在题面上注「可选」,没答就不带那一格。
 *
 * 收场:answered → `accept` + content;用户点「不回答」(declined)→ `decline`;超时 / 回合中止 → `cancel`。
 *
 * url 型:一道两选「已完成 / 取消」。宿主有外壳能力(`hasShellHost()`)就先替人打开那个链接;
 * 没有(今天的 React 壳、server、daemon 都注的是 null)就把链接写进题面,让人自己去开 —— 题面
 * 里恒带链接,开没开成都说得清。只开 http(s)。agent 那边先走完(`elicitation/complete`)就收掉卡、
 * 答 `accept`。
 */
import { randomUUID } from 'node:crypto'
import { Interaction } from '@onething/backend/core/interaction'
import type {
  InteractionAnswer,
  InteractionAskInput,
  InteractionQuestion,
} from '@shared/interaction/types'
import type {
  AcpElicitationBridge,
  AcpElicitationContext,
  AcpElicitationRequest,
  AcpElicitationResponse,
} from '@onething/backend/runtime/acp'
import { getShellHost, hasShellHost } from '@onething/backend/runtime/shell/host-ports'
import { NO_HUMAN_DECLINE_REASON, noHumanInTheRoom } from '@onething/backend/runtime/interaction/no-human'
import { resolvePermissionMessageAnchor } from '@onething/backend/runtime/permission/message-anchor'
import { getLogger } from '@onething/backend/runtime/logging/configure-logging'

const log = getLogger('acp.elicitation')

/** claude-agent-acp 挂在 `oneOf` 选项上的扩展键。 */
export const CLAUDE_ASK_OPTION_META = '_claude/askUserQuestionOption'

export const ELICITATION_YES = '是'
export const ELICITATION_NO = '否'
export const ELICITATION_URL_DONE = '已完成'
export const ELICITATION_URL_CANCEL = '取消'
export const ELICITATION_URL_QUESTION_ID = 'url'

type ContentValue = string | number | boolean | string[]
type Json = Record<string, unknown>

/** 一道题怎么把答案译回 agent 要的值。 */
type Decoder =
  | { kind: 'single'; values: Map<string, string> }
  | { kind: 'multi'; values: Map<string, string> }
  | { kind: 'boolean' }
  | { kind: 'number'; integer: boolean }
  | { kind: 'text' }

export interface ElicitationFormPlan {
  questions: InteractionQuestion[]
  decoders: Map<string, Decoder>
  required: Set<string>
}

function asRecord(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** 选项:label 必须在这道题里唯一(答案按 label 回来);撞了就在后面带上值。 */
interface OptionDraft { value: string; label: string; description?: string; preview?: string }

function uniqueOptions(drafts: OptionDraft[]): { options: InteractionQuestion['options']; values: Map<string, string> } {
  const values = new Map<string, string>()
  const options: InteractionQuestion['options'] = []
  for (const draft of drafts) {
    let label = draft.label
    if (values.has(label)) label = `${draft.label} (${draft.value})`
    if (values.has(label)) continue
    values.set(label, draft.value)
    options.push({
      label,
      ...(draft.description ? { description: draft.description } : {}),
      ...(draft.preview ? { preview: draft.preview } : {}),
    })
  }
  return { options, values }
}

/** `oneOf` / `anyOf` 项(`{ const, title, description?, _meta? }`)→ 选项草稿;claude 的扩展格优先。 */
function titledOptions(items: unknown[]): OptionDraft[] {
  const drafts: OptionDraft[] = []
  for (const raw of items) {
    const item = asRecord(raw)
    const value = item && typeof item.const === 'string' ? item.const : undefined
    if (!item || value === undefined) continue
    const claude = asRecord(asRecord(item._meta)?.[CLAUDE_ASK_OPTION_META])
    drafts.push({
      value,
      label: str(item.title) ?? str(claude?.label) ?? value,
      ...(str(claude?.description) ?? str(item.description) ? { description: (str(claude?.description) ?? str(item.description))! } : {}),
      ...(str(claude?.preview) ? { preview: str(claude?.preview)! } : {}),
    })
  }
  return drafts
}

/** 裸 `enum`(可带老式 `enumNames`)→ 选项草稿。 */
function plainOptions(values: unknown[], names: unknown): OptionDraft[] {
  const labels = Array.isArray(names) ? names : []
  return values
    .filter((value): value is string => typeof value === 'string')
    .map((value, index) => ({ value, label: str(labels[index]) ?? value }))
}

/**
 * form 的 `requestedSchema` → 题目表 + 每题的解码器。纯函数(测试直接调)。
 * `message` 是 agent 给这张表的总说明,放在第一道题的题面前面。
 */
export function planElicitationForm(requestedSchema: unknown, message: string): ElicitationFormPlan {
  const schema = asRecord(requestedSchema)
  const properties = asRecord(schema?.properties) ?? {}
  const required = new Set((Array.isArray(schema?.required) ? schema.required : []).filter((key): key is string => typeof key === 'string'))
  const questions: InteractionQuestion[] = []
  const decoders = new Map<string, Decoder>()

  for (const [key, rawProperty] of Object.entries(properties)) {
    const property = asRecord(rawProperty) ?? {}
    const title = str(property.title)
    const optional = required.has(key) ? '' : '(可选)'
    const text = `${str(property.description) ?? title ?? key}${optional}`
    const base = { id: key, ...(title && title !== text ? { header: title } : {}), question: text }
    const type = property.type

    if (type === 'string' && (Array.isArray(property.oneOf) || Array.isArray(property.enum))) {
      const drafts = Array.isArray(property.oneOf)
        ? titledOptions(property.oneOf)
        : plainOptions(property.enum as unknown[], property.enumNames)
      const { options, values } = uniqueOptions(drafts)
      questions.push({ ...base, options, multiSelect: false })
      decoders.set(key, { kind: 'single', values })
      continue
    }
    if (type === 'array') {
      const items = asRecord(property.items) ?? {}
      const drafts = Array.isArray(items.anyOf)
        ? titledOptions(items.anyOf)
        : Array.isArray(items.enum) ? plainOptions(items.enum, items.enumNames) : []
      if (drafts.length > 0) {
        const { options, values } = uniqueOptions(drafts)
        questions.push({ ...base, options, multiSelect: true })
        decoders.set(key, { kind: 'multi', values })
        continue
      }
    }
    if (type === 'boolean') {
      questions.push({ ...base, options: [{ label: ELICITATION_YES }, { label: ELICITATION_NO }], multiSelect: false })
      decoders.set(key, { kind: 'boolean' })
      continue
    }
    if (type === 'number' || type === 'integer') {
      questions.push({ ...base, options: [], allowFreeText: true })
      decoders.set(key, { kind: 'number', integer: type === 'integer' })
      continue
    }
    // string(无枚举)与认不出的类型:一道自由输入,原文交回去。
    questions.push({ ...base, options: [], allowFreeText: true })
    decoders.set(key, { kind: 'text' })
  }

  const lead = message.trim()
  if (lead && questions[0] && questions[0].question !== lead) {
    questions[0] = { ...questions[0], question: `${lead}\n\n${questions[0].question}` }
  }
  return { questions, decoders, required }
}

function decodeOne(decoder: Decoder, entry: { selected: string[]; freeText?: string } | undefined): ContentValue | undefined {
  if (!entry) return undefined
  const selected = entry.selected.filter(Boolean)
  const text = entry.freeText?.trim() ? entry.freeText : undefined
  switch (decoder.kind) {
    case 'single': {
      const value = selected.map(label => decoder.values.get(label)).find(item => item !== undefined)
      return value
    }
    case 'multi': {
      const values = selected.map(label => decoder.values.get(label)).filter((item): item is string => item !== undefined)
      return selected.length > 0 ? values : undefined
    }
    case 'boolean':
      if (selected[0] === ELICITATION_YES) return true
      if (selected[0] === ELICITATION_NO) return false
      return undefined
    case 'number': {
      const raw = text ?? selected[0]
      if (raw === undefined) return undefined
      const parsed = Number(raw.trim())
      if (!Number.isFinite(parsed) || (decoder.integer && !Number.isInteger(parsed))) return undefined
      return parsed
    }
    case 'text':
      return text ?? selected[0]
  }
}

/** 交互卡的收场 → agent 要的答复。纯函数(测试直接调)。 */
export function decodeElicitationAnswer(plan: ElicitationFormPlan, answer: InteractionAnswer): AcpElicitationResponse {
  if (answer.outcome === 'declined') return { action: 'decline' }
  if (answer.outcome !== 'answered') return { action: 'cancel' }
  const content: Record<string, ContentValue> = {}
  for (const [key, decoder] of plan.decoders) {
    const value = decodeOne(decoder, answer.answers[key])
    if (value === undefined) {
      if (plan.required.has(key)) {
        log.info('required elicitation field unanswered; cancelling', { field: key })
        return { action: 'cancel' }
      }
      continue
    }
    content[key] = value
  }
  return { action: 'accept', content }
}

/** 桥用得着的外部件(测试换成假的)。 */
export interface AcpElicitationBridgeDeps {
  ask?: (input: InteractionAskInput) => Promise<InteractionAnswer>
  abort?: (input: { sessionId: string; toolCallId?: string; reason?: string }) => boolean
  noHuman?: (sessionId: string) => boolean
  anchor?: (sessionId: string, messageId?: string) => string | undefined
  /** 能不能替人打开链接、怎么开。缺省 = 外壳宿主端口。 */
  openExternal?: () => ((url: string) => Promise<{ success: boolean; error?: string }>) | undefined
}

function isWebUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function createAcpElicitationBridge(deps: AcpElicitationBridgeDeps = {}): AcpElicitationBridge {
  const ask = deps.ask ?? (input => Interaction.ask(input))
  const abort = deps.abort ?? (input => Interaction.abort(input))
  const noHuman = deps.noHuman ?? noHumanInTheRoom
  const anchor = deps.anchor ?? resolvePermissionMessageAnchor
  const openExternal = deps.openExternal ?? (() => (hasShellHost() ? (url: string) => getShellHost().openExternal(url) : undefined))
  /** url 型等 agent 那边走完的那几格:`agentId\0elicitationId` → 收卡。 */
  const awaitingCompletion = new Map<string, () => void>()

  /** 问一次:锚、toolCallId、回合中止时收卡,都在这里。 */
  async function askOnCard(
    context: AcpElicitationContext,
    request: AcpElicitationRequest,
    questions: InteractionQuestion[],
    extra?: Promise<'completed'>,
  ): Promise<InteractionAnswer | 'completed'> {
    const scoped = request as { toolCallId?: unknown; _meta?: unknown }
    const toolCallId = str(scoped.toolCallId) ?? str(asRecord(scoped._meta)?.toolCallId) ?? `acp-elicit-${randomUUID()}`
    const messageId = anchor(context.localSessionId, context.messageId)
    const pending = ask({
      sessionId: context.localSessionId,
      origin: 'external-agent',
      questions,
      toolCallId,
      ...(messageId ? { messageId } : {}),
    })
    const abortCard = (reason: string) => { abort({ sessionId: context.localSessionId, toolCallId, reason }) }
    const onAbort = () => abortCard('回合已停止')
    if (context.abortSignal?.aborted) onAbort()
    else context.abortSignal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (!extra) return await pending
      const first = await Promise.race([pending, extra])
      if (first === 'completed') abortCard(`${context.agentName} 那边已经完成`)
      return first
    } finally {
      context.abortSignal?.removeEventListener('abort', onAbort)
    }
  }

  async function createForm(context: AcpElicitationContext, request: AcpElicitationRequest): Promise<AcpElicitationResponse> {
    const plan = planElicitationForm((request as { requestedSchema?: unknown }).requestedSchema, request.message ?? '')
    if (plan.questions.length === 0) {
      log.info('elicitation form carried no field; cancelling', { agentId: context.agentId })
      return { action: 'cancel' }
    }
    const answer = await askOnCard(context, request, plan.questions)
    return answer === 'completed' ? { action: 'cancel' } : decodeElicitationAnswer(plan, answer)
  }

  async function createUrl(context: AcpElicitationContext, request: AcpElicitationRequest): Promise<AcpElicitationResponse> {
    const { url, elicitationId } = request as { url?: unknown; elicitationId?: unknown }
    if (typeof url !== 'string' || !isWebUrl(url)) {
      log.info('elicitation url refused (not http/https)', { agentId: context.agentId })
      return { action: 'decline' }
    }
    const open = openExternal()
    let opened = false
    if (open) {
      try {
        opened = (await open(url)).success
      } catch (error) {
        log.warn('opening elicitation url failed', { agentId: context.agentId }, error)
      }
    }
    const lead = request.message?.trim() ? `${request.message.trim()}\n\n` : ''
    const question = opened
      ? `${lead}已在浏览器里打开 ${url} 。在那边完成之后点「${ELICITATION_URL_DONE}」。`
      : `${lead}请在浏览器里打开 ${url} ,在那边完成之后点「${ELICITATION_URL_DONE}」。`
    const key = typeof elicitationId === 'string' ? `${context.agentId}\0${elicitationId}` : undefined
    const completed = key
      ? new Promise<'completed'>(resolve => { awaitingCompletion.set(key, () => resolve('completed')) })
      : undefined
    try {
      const answer = await askOnCard(context, request, [{
        id: ELICITATION_URL_QUESTION_ID,
        header: context.agentName,
        question,
        options: [{ label: ELICITATION_URL_DONE }, { label: ELICITATION_URL_CANCEL }],
        multiSelect: false,
      }], completed)
      if (answer === 'completed') return { action: 'accept' }
      if (answer.outcome === 'declined') return { action: 'decline' }
      if (answer.outcome !== 'answered') return { action: 'cancel' }
      const picked = answer.answers[ELICITATION_URL_QUESTION_ID]?.selected[0]
      return picked === ELICITATION_URL_DONE ? { action: 'accept' } : { action: 'decline' }
    } finally {
      if (key) awaitingCompletion.delete(key)
    }
  }

  return {
    async create(context, request) {
      if (noHuman(context.localSessionId)) {
        log.info('elicitation declined: no human in the room', { agentId: context.agentId, reason: NO_HUMAN_DECLINE_REASON })
        return { action: 'decline' }
      }
      if (request.mode === 'form') return createForm(context, request)
      if (request.mode === 'url') return createUrl(context, request)
      log.info('elicitation mode not supported; cancelling', { agentId: context.agentId, mode: request.mode })
      return { action: 'cancel' }
    },

    complete(agentId, elicitationId) {
      awaitingCompletion.get(`${agentId}\0${elicitationId}`)?.()
    },
  }
}
