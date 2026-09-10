import type { ProjectedMessage } from './chat-fold'

/**
 * **首屏尾页的工具结果侧表** —— 壳这一侧(工单 5 ①②;后端那一半在
 * `packages/backend/session/page-results.ts`,判据全文写在那儿)。
 *
 * ── 一句话 ────────────────────────────────────────────────────────────────
 * 页上每段工具结果**只走一次线**:后端把它抽进一张按 `toolCallId` 键的侧表,
 * 消息里 `toolCalls[].result` / `steps[].toolCall.result` / `steps[].result`
 * 三处只留一枚引用标记。这只文件把它们挂回去 —— **挂的是同一个值**,所以内存里
 * 仍然只有一份,与从前逐字相同的那棵树。变的只有线上的字节(真店夹具:一页
 * 3.59MB → 一位数百 KB)。
 *
 * ── 大结果:挂上去的是一枚**壳自己认得的**引用 ────────────────────────────
 * 超过页内联预算的那几格,侧表里根本没有正文。这里挂一个 `{'@toolResult': …}`
 * 上去 —— 它是**这台屏幕此刻的事实**:「这一格有多大、是哪一份、开头长这样,
 * 正文还没取」。工具卡照这个形画摘要;人点开的那一刻按 `session` 的 `toolResult`
 * 读法取正文,取回来经 `applyToolResultBody` **就地换掉那几条消息**(律①③:
 * 写就地更新,禁清屏)。
 *
 * ── 为什么不把正文塞回侧表就完了 ──────────────────────────────────────────
 * 因为屏幕上那棵树是 `compose()` 每帧现算的:侧表改了没人会重画。取回来的正文
 * 因此换的是**消息数组本身**,而且只换含它的那几条 —— 律④(身份稳定)在这里的
 * 落点:一页 24 条里换 1 条,另外 23 条连引用都不动,下游那些按引用短路的 memo
 * 一格没 miss。
 */

/** 同一次调用身上那三处结果。与后端 `SessionPageResultSlot` 是同一张表。 */
export type PageResultSlot = 'result' | 'text' | 'partial'

/** 一格还没取正文的大结果:卡上摘要要的全部事实。 */
export interface PageResultReference {
  readonly toolCallId: string
  readonly slot: PageResultSlot
  /** 正文有多大(字节)。卡上那句「N KB,点开取」的产地。 */
  readonly bytes: number
  /** 内容指纹。**缓存键,不是地址** —— 取正文问的是 `toolCallId`(见后端注)。 */
  readonly hash: string
  /** 开头那一段(后端摘的),卡上没展开时画它。 */
  readonly preview?: string
}

/**
 * 消息上那一格此刻是一枚引用。
 *
 * 形是**对象**而不是字符串:工具结果本身常常就是一段字符串,两者结构上分得开
 * 才不必约定前缀(与后端那一侧同一条判据)。
 */
export interface ChatToolResultRef {
  readonly '@toolResult': PageResultReference
}

/** 侧表里的一格。两支,与后端 `SessionPageResult` 一一对应。 */
export type PageResultEntry =
  | { readonly kind: 'inline'; readonly value: unknown }
  | ({ readonly kind: 'reference' } & PageResultReference)

/** 页那条读法交出来的整份东西(自述 `SESSION_TAIL_PAGE_SCHEMA` 的转手)。 */
export interface SessionTailPage {
  readonly messages: readonly unknown[]
  readonly results?: Record<string, PageResultEntry>
  readonly hasMoreBefore: boolean
  readonly nextBefore?: string
  readonly watermark: number
  /**
   * 水位那一刻还开着的那条 run。**在场 = 这一次不能走页**(判据在后端那一格的
   * 注上:它后面的 delta 在空状态上一条都折不下),壳退回整份账本那条老路。
   */
  readonly activeMessageId?: string
}

export function asToolResultRef(value: unknown): PageResultReference | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const ref = (value as Record<string, unknown>)['@toolResult']
  if (typeof ref !== 'object' || ref === null) return undefined
  const row = ref as Record<string, unknown>
  return typeof row.toolCallId === 'string' ? (ref as PageResultReference) : undefined
}

/**
 * 一枚引用在侧表里的键。**派生规则与后端那一侧逐字相同**(`result` 用调用 id
 * 本身,别的槽加后缀)—— 两处对不上就是同一件事两套地址。
 */
export function pageResultKey(ref: Pick<PageResultReference, 'toolCallId' | 'slot'>): string {
  return ref.slot === 'result' ? ref.toolCallId : `${ref.toolCallId}#${ref.slot}`
}

/** 后端留下的那枚标记(`{'@pageResult': key}`)。壳只在挂回去那一刻认它。 */
function pageRefKeyOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const key = (value as Record<string, unknown>)['@pageResult']
  return typeof key === 'string' ? key : undefined
}

/**
 * 把侧表挂回消息的三处。
 *
 * `bodies` 是已经取回来的大结果(键同侧表)——命中就直接挂正文,那正是
 * 「切走再切回、上翻又翻下来」时不必重取的机制。
 */
export function rehangPageResults(
  messages: readonly unknown[],
  results: Record<string, PageResultEntry> | undefined,
  bodies?: ReadonlyMap<string, unknown>,
): ProjectedMessage[] {
  /** 同一枚引用在三处挂的是**同一个对象** —— 那正是「内存里只有一份」。 */
  const hung = new Map<string, unknown>()
  const valueFor = (key: string): unknown => {
    if (hung.has(key)) return hung.get(key)
    const entry = results?.[key]
    let value: unknown
    if (bodies?.has(key)) value = bodies.get(key)
    else if (!entry) value = undefined
    else if (entry.kind === 'inline') value = entry.value
    else {
      const { kind: _kind, ...ref } = entry
      value = { '@toolResult': ref } satisfies ChatToolResultRef
    }
    hung.set(key, value)
    return value
  }
  return mapResultSlots(messages, value => {
    const key = pageRefKeyOf(value)
    return key === undefined ? value : valueFor(key)
  }) as ProjectedMessage[]
}

/**
 * 一格大结果的正文取回来了 —— 换掉挂着那枚引用的**那几条消息**,别的一格不动。
 */
export function applyToolResultBody(
  messages: readonly ProjectedMessage[],
  key: string,
  body: unknown,
): ProjectedMessage[] {
  return mapResultSlots(messages, value => {
    const ref = asToolResultRef(value)
    return ref && pageResultKey(ref) === key ? body : value
  }) as ProjectedMessage[]
}

/**
 * 走遍一页消息上的每一格结果,逐格问 `fn`。
 *
 * **只拷改过的那一层**:一条消息里没有一格变过就原样交回那只对象(律④ 在这里
 * 的落点 —— 下游 `assembleMessage` 的 memo 按消息对象引用做键,拷一次就是一次
 * 全条重装配)。
 */
function mapResultSlots(
  messages: readonly unknown[],
  fn: (value: unknown) => unknown,
): unknown[] {
  const mapCall = (call: unknown): unknown => {
    if (!isRecord(call) || call.result === undefined) return call
    const next = fn(call.result)
    return next === call.result ? call : { ...call, result: next }
  }

  const mapStep = (step: unknown): unknown => {
    if (!isRecord(step)) return step
    let next: Record<string, unknown> = step
    const call = mapCall(step.toolCall)
    if (call !== step.toolCall) next = { ...next, toolCall: call }
    if (step.result !== undefined) {
      const result = fn(step.result)
      if (result !== step.result) next = { ...next, result }
    }
    if (step.partialResult !== undefined) {
      const partial = fn(step.partialResult)
      if (partial !== step.partialResult) next = { ...next, partialResult: partial }
    }
    if (Array.isArray(step.childSteps)) {
      const kids = step.childSteps.map(mapStep)
      if (kids.some((kid, index) => kid !== (step.childSteps as unknown[])[index])) {
        next = { ...next, childSteps: kids }
      }
    }
    return next
  }

  return messages.map(message => {
    if (!isRecord(message)) return message
    let next: Record<string, unknown> = message
    if (Array.isArray(message.toolCalls)) {
      const calls = message.toolCalls.map(mapCall)
      if (calls.some((call, index) => call !== (message.toolCalls as unknown[])[index])) {
        next = { ...next, toolCalls: calls }
      }
    }
    if (Array.isArray(message.steps)) {
      const steps = message.steps.map(mapStep)
      if (steps.some((step, index) => step !== (message.steps as unknown[])[index])) {
        next = { ...next, steps }
      }
    }
    return next
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
