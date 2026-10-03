/**
 * 首屏尾页的**工具结果侧表**(工单 5 ①②;工单 4 A 的留账「页里工具结果三份变一份 /
 * 大结果带引用」就是这只文件)。
 *
 * ── 病 ────────────────────────────────────────────────────────────────────
 * 工单 4 量出来的那一页(24 条消息)3,590,461 字节里,**96.3% 是同一段工具结果被
 * 抄了三遍**:`toolCalls[].result` / `steps[].toolCall.result` / `steps[].result`
 * 各 1,152,501 字节,而正文 + contentParts 一共只有 133KB。
 *
 * 三遍不是 bug,是投影的形状:`materializeStep` 用**同一只** `materializeToolCall`
 * 建 `step.toolCall`(所以那两格从定义上就相等),而 `step.result` 是
 * `resultText(result)` —— 结局本来就是纯文本时(绝大多数工具),它与
 * `toolCall.result` 逐字是同一个字符串。**在内存里它们是同一个字符串实例**
 * (JS 的字符串共享),一进 JSON 就变成三份字节。
 *
 * ── 法 ────────────────────────────────────────────────────────────────────
 * 所以这只文件不改投影,也不改 `canonical.ts` 那位唯一判官 —— 它是**页这一层的
 * 形状**:把结果从消息上抽进一张按 `toolCallId` 键的侧表,消息那三格只留一枚
 * 引用标记。壳收到之后把同一个字符串挂回三处(`data/page-results.ts`),内存里
 * 仍然只有一份 —— 也就是说这一手只改**线上的字节**,两侧的内存形态一格没变。
 *
 * ## 一格「槽」是什么,为什么是三个
 *
 * 同一次调用身上有三处结果,而它们**不总是同一个值**:
 *
 *  · `result` —— `toolCall.result`。`toolCalls[]` 与 `steps[].toolCall` 两处共用
 *    这一格(同一只函数建的),所以两处指同一枚引用;
 *  · `text` —— `steps[].result`,给人看的那段正文;
 *  · `partial` —— `steps[].partialResult`,成功结局的结构化投影。
 *
 * 工具没有结构化结局(`resultData` 缺席)时 `result` 就是那段正文,三格逐字相同
 * —— 于是**跨槽去重**把它们折成一枚引用,一页里那 96.3% 正是这一支。有结构化结局
 * 时 `result` 是对象、`text` 是字符串,两枚引用,各是各的事实。
 *
 * ## 大结果:侧表也只带 `{ bytes, hash }`
 *
 * 超过 `SESSION_PAGE_INLINE_RESULT_BYTES` 的那一格,侧表里连正文都不带 ——
 * 带的是「有多大」「是哪一份」和一段 `preview`。正文由壳**展开工具卡的那一刻**
 * 按 `session` 的新读法 `toolResult` 单独取(判据写在自述上)。
 *
 * ### 为什么阈值是 16KB,而不是复用账本那条 64KB
 *
 * 两条线量的是两件事:64KB 是**账本行**装得下多少(超了落 `blobs/`),16KB 是
 * **一屏**该带多少 —— 一页 24 条消息里可能有几十次调用,每次带 16KB 就已经是
 * 几百 KB。两条线之间那一段(16–64KB)的结果**在账本里根本没有内容地址**
 * (它就写在事件行里,没有 hash),这也正是下面那条「为什么不复用 blob 读法」
 * 的理由。
 */

import { createHash } from 'node:crypto'

/**
 * 一格结果**内联**到几个字节为止。超过就只带引用。
 *
 * 16KB:一屏 24 条消息里几十次调用,每次 16KB 是 ~400KB 的上界 —— 而目标是
 * 整页 ≤ 300KB,所以实际上它是「绝大多数结果照常内联,少数几个大的走引用」的
 * 那条线,不是一条会天天被撞到的线。真店 900 张卡的夹具上量出来:撞线的是
 * 个位数。
 *
 * 它**不是** `blobs/` 那条 64KB(那条量的是账本行装不装得下)——判据全文写在
 * 文件头「为什么阈值是 16KB」那一节。
 */
export const SESSION_PAGE_INLINE_RESULT_BYTES = 16 * 1024

/** 引用里那段给人看的开头留多长(卡上摘要用)。 */
const PAGE_RESULT_PREVIEW_CHARS = 200

/** 同一次调用身上那三处结果。`toolResult` 读法收的就是这个词。 */
export type SessionPageResultSlot = 'result' | 'text' | 'partial'

/**
 * 消息上那三格被抽走之后留下的东西。
 *
 * 键选得又短又不可能自然出现(工具结果是工具自己的 JSON,不会长出一格
 * `@pageResult`);形是**一个对象而不是一个字符串**,所以「结果本来就是一个字符串」
 * 与「这是一枚引用」在壳那一侧结构上分得开,不必约定前缀。
 */
export interface SessionPageResultRef {
  readonly '@pageResult': string
}

export function isSessionPageResultRef(value: unknown): value is SessionPageResultRef {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>)['@pageResult'] === 'string'
}

/** 侧表里的一格。两支:带正文的,与只带尺寸的。 */
export type SessionPageResult =
  | { readonly kind: 'inline'; readonly value: unknown }
  | {
    readonly kind: 'reference'
    readonly toolCallId: string
    readonly slot: SessionPageResultSlot
    readonly bytes: number
    readonly hash: string
    readonly preview?: string
  }

export interface SessionPageResultTable {
  readonly messages: unknown[]
  readonly results: Record<string, SessionPageResult>
}

/**
 * 把一页消息里的工具结果抽进侧表。
 *
 * **不改入参**:消息 / `toolCalls` / `steps` 逐层**浅拷**再改那一格 —— 交进来的
 * 这一份是投影的 memo 缓存里那几只对象本体(`messagesFromState` 按 `(节点, rev)`
 * 记着它们),就地改会把缓存改成一份带引用标记的假账,下一个读者(模型历史、
 * 导出)拿到的就不是消息而是几枚引用。浅拷不复制那段大正文 —— 换的只是外壳。
 */
export function extractSessionPageResults(
  messages: readonly unknown[],
  inlineLimit = SESSION_PAGE_INLINE_RESULT_BYTES,
): SessionPageResultTable {
  const results: Record<string, SessionPageResult> = {}
  /** 同一次调用里「这段序列化过的正文已经有键了」—— 跨槽去重的全部机制。 */
  const seen = new Map<string, Map<string, string>>()

  function keyFor(toolCallId: string, slot: SessionPageResultSlot, value: unknown): string | undefined {
    const serialized = serialize(value)
    if (serialized === undefined) return undefined
    let byValue = seen.get(toolCallId)
    if (!byValue) {
      byValue = new Map()
      seen.set(toolCallId, byValue)
    }
    const hit = byValue.get(serialized)
    if (hit !== undefined) return hit
    const key = slot === 'result' ? toolCallId : `${toolCallId}#${slot}`
    byValue.set(serialized, key)
    const bytes = Buffer.byteLength(serialized, 'utf8')
    results[key] = bytes > inlineLimit
      ? {
        kind: 'reference',
        toolCallId,
        slot,
        bytes,
        hash: createHash('sha256').update(serialized).digest('hex').slice(0, 16),
        ...(previewOf(value) ? { preview: previewOf(value) } : {}),
      }
      : { kind: 'inline', value }
    return key
  }

  /** 一格 → 引用标记。抽不动(没有 id / 没有值)就原样留着。 */
  function take(
    holder: Record<string, unknown>,
    field: string,
    slot: SessionPageResultSlot,
    toolCallId: string | undefined,
  ): Record<string, unknown> {
    const value = holder[field]
    if (value === undefined || !toolCallId) return holder
    const key = keyFor(toolCallId, slot, value)
    if (key === undefined) return holder
    return { ...holder, [field]: { '@pageResult': key } satisfies SessionPageResultRef }
  }

  function rewriteToolCall(call: unknown): unknown {
    if (!isRecord(call)) return call
    return take(call, 'result', 'result', idOf(call.id))
  }

  function rewriteStep(step: unknown): unknown {
    if (!isRecord(step)) return step
    const toolCallId = idOf(step.toolCallId) ?? idOf((step.toolCall as Record<string, unknown> | undefined)?.id)
    let next: Record<string, unknown> = step
    // `step.toolCall` 与 `toolCalls[]` 那一格是同一个值(同一只 materializeToolCall
    // 建的),所以它们必然折成同一枚引用 —— 去重表管的正是这件事。
    if (isRecord(step.toolCall)) {
      const rewritten = rewriteToolCall(step.toolCall)
      if (rewritten !== step.toolCall) next = { ...next, toolCall: rewritten }
    }
    next = take(next, 'result', 'text', toolCallId)
    next = take(next, 'partialResult', 'partial', toolCallId)
    if (Array.isArray(step.childSteps) && step.childSteps.length > 0) {
      const children = step.childSteps.map(rewriteStep)
      if (children.some((child, index) => child !== (step.childSteps as unknown[])[index])) {
        next = { ...next, childSteps: children }
      }
    }
    return next
  }

  const rewritten = messages.map(message => {
    if (!isRecord(message)) return message
    let next: Record<string, unknown> = message
    if (Array.isArray(message.toolCalls)) {
      const calls = message.toolCalls.map(rewriteToolCall)
      if (calls.some((call, index) => call !== (message.toolCalls as unknown[])[index])) {
        next = { ...next, toolCalls: calls }
      }
    }
    if (Array.isArray(message.steps)) {
      const steps = message.steps.map(rewriteStep)
      if (steps.some((step, index) => step !== (message.steps as unknown[])[index])) {
        next = { ...next, steps }
      }
    }
    return next
  })

  return { messages: rewritten, results }
}

/**
 * 序列化一格结果。**炸了就返回 `undefined`** —— 抽不动的那一格原样留在消息上,
 * 它本来就要跟着整页过一次 `JSON.stringify`,在这里抛出去只会把整页读废掉。
 */
function serialize(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/** 引用那一格上给人看的开头。认得出正文的三种形态就取,认不出就没有。 */
function previewOf(value: unknown): string | undefined {
  const text = textOf(value)
  if (!text) return undefined
  return text.length > PAGE_RESULT_PREVIEW_CHARS ? text.slice(0, PAGE_RESULT_PREVIEW_CHARS) : text
}

/**
 * 结果里那段正文。三种形态与壳侧 `content/tools/result.ts` 的
 * `toolOutputText` 逐条同源 —— 这里只是**摘要**用,认不全就不摘。
 */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return undefined
  const content = value.content
  if (Array.isArray(content)) {
    const text = content
      .filter(isRecord)
      .filter(part => part.type === 'text')
      .map(part => (typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
    if (text) return text
  }
  return typeof value.output === 'string' ? value.output : undefined
}

function idOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
