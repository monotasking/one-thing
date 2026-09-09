import type {
  CoreContextCompactContent,
  CoreContextCompactProgress,
  CoreContextCompactStatus,
} from '@onething/core/engine'

/**
 * **压缩标记的唯一解析产地**(壳侧)。
 *
 * 一次压缩在账本上只是**一条 system 消息**,正文是后端
 * `buildContextCompactContent`(`packages/core/engine/context-compact-content.ts`)
 * 写出去的一段 JSON;压缩的三个阶段(在压 / 压完 / 失败)全靠**刷同一条消息的正文**
 * 表达。所以壳这边不需要第二套协议、不需要订 `context:compact-*` 事件 ——
 * 需要的只是「把这段正文读成一件事实」,而那件事必须只有一个产地:
 *
 *  - 折痕(下一单 `CompactSeam`)按它画三态;
 *  - 读数环按它决定要不要脉动。
 *
 * 两个消费方各自 `JSON.parse` 一次就是两份对协议的理解,后端哪天多写一格,
 * 修一处漏一处 —— 这里是那一处。
 *
 * 形状**以 core 的 `CoreContextCompactContent` 为准**:这只函数不发明字段,
 * 只做「看得懂就交出来,看不懂就交出 null」。
 */
export interface CompactMarker {
  status: CoreContextCompactStatus
  summary: string
  compactedMessageCount: number
  error?: string
  compactedThroughMessageId?: string
  progress?: CoreContextCompactProgress
  /** 压缩**开始那一刻**的 provider 输入读数(后端 2026-09-08 补的一格,只有 completed 带)。 */
  contextSizeBefore?: number
  /** 压完之后还看得见的读数(completed 才有):「701k → 96k」的后半截。 */
  retainedContextSize?: number
}

/**
 * 解析的入口只认结构,不认某一个具体的消息类型 —— 折叠产物
 * (`ProjectedMessage`)、账本原始行、测试里的字面量都喂得进来,
 * 而这只文件因此不必反向依赖 `data/chat-source`(那会绕成一个环)。
 */
export interface CompactMarkerSource {
  role?: string
  content?: unknown
}

/** 账本(某条会话的那台机器)里这只选择器要读的那一格。 */
export interface CompactFeedState {
  messages: readonly CompactMarkerSource[]
}

/** 环订阅到的那份读数:**扁平**,所以 `useShallow` 一次订阅就够(嵌套对象它比不动)。 */
export interface CompactingReadout {
  /** 账本上最新一条压缩标记正在压 */
  on: boolean
  /** 多块压缩的第几块;单块(或没在压)是 0 —— k/N 那一格因此**不出现** */
  chunk: number
  /** 总块数;同上 */
  totalChunks: number
}

const NOT_COMPACTING: CompactingReadout = { on: false, chunk: 0, totalChunks: 0 }

function isStatus(value: unknown): value is CoreContextCompactStatus {
  return value === 'compacting' || value === 'completed' || value === 'failed'
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

/**
 * 一条消息 → 压缩标记,不是就是 `null`。
 *
 * 三道闸,由便宜到贵:角色必须是 system(压缩标记只可能是它)、正文里必须出现
 * `"context-compact"` 这几个字(省掉对每条长正文的 `JSON.parse`)、最后才真解析。
 * 解析失败、`type` 对不上、`status` 不是那三个之一 —— 一律 `null`,
 * 不猜、不半信半疑地交出半件事实。
 */
export function parseCompactMarker(message: CompactMarkerSource | null | undefined): CompactMarker | null {
  if (!message || message.role !== 'system') return null
  const content = message.content
  if (typeof content !== 'string' || !content.includes('"context-compact"')) return null

  let parsed: Partial<CoreContextCompactContent> & { contextSizeBefore?: unknown; retainedContextSize?: unknown }
  try {
    parsed = JSON.parse(content) as typeof parsed
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  if (parsed.type !== 'context-compact' || !isStatus(parsed.status)) return null

  const marker: CompactMarker = {
    status: parsed.status,
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    compactedMessageCount: positiveInt(parsed.compactedMessageCount) ?? 0,
  }
  if (typeof parsed.error === 'string' && parsed.error) marker.error = parsed.error
  if (typeof parsed.compactedThroughMessageId === 'string' && parsed.compactedThroughMessageId) {
    marker.compactedThroughMessageId = parsed.compactedThroughMessageId
  }
  const chunk = positiveInt(parsed.progress?.chunk)
  const totalChunks = positiveInt(parsed.progress?.totalChunks)
  // 半个进度不是进度:缺一格就整格不出(k/N 那一行的判据是「有没有 progress」)。
  if (chunk !== undefined && totalChunks !== undefined) marker.progress = { chunk, totalChunks }
  const before = positiveInt(parsed.contextSizeBefore)
  if (before !== undefined) marker.contextSizeBefore = before
  const after = positiveInt(parsed.retainedContextSize)
  if (after !== undefined) marker.retainedContextSize = after

  return marker
}

/**
 * **「这条会话此刻在压缩吗」** —— 判据是账本上**最新一条**压缩标记的 status。
 *
 * 为什么是选择器而不是 store 里的一格:与 `selectEngineBusy`(`data/chat-source.ts`)
 * 同一条理由 —— 它是派生量,账本上已经写着了,多存一格就是多一个会跟真相对不上的
 * 真相。压完 / 失败那一下不需要谁来「关掉」它:那条 marker 的正文被后端刷成
 * completed / failed,这只函数下一次读就是假。
 *
 * 倒着扫,并且**只对 system 消息动手** —— 前面那道角色闸让整条扫描在长会话上
 * 也只是几百次指针比较(压缩标记本来就贴在尾巴上,通常第一条就命中)。
 */
export function selectCompacting(state: CompactFeedState): { progress?: CoreContextCompactProgress } | null {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const marker = parseCompactMarker(state.messages[i])
    if (!marker) continue
    if (marker.status !== 'compacting') return null
    return marker.progress ? { progress: marker.progress } : {}
  }
  return null
}

/**
 * 上一只的**扁平投影**,给 React 订阅用。
 *
 * `selectCompacting` 交出来的是对象(每次调用都是新身份),直接喂
 * `useSyncExternalStore` 会被 React 判成「快照没缓存」;`useShallow` 只比一层,
 * 嵌套的 `progress` 它也比不动。所以订阅读的是这份**三个原始值**的扁平读数。
 */
export function selectCompactingReadout(state: CompactFeedState): CompactingReadout {
  const compacting = selectCompacting(state)
  if (!compacting) return NOT_COMPACTING
  return {
    on: true,
    chunk: compacting.progress?.chunk ?? 0,
    totalChunks: compacting.progress?.totalChunks ?? 0,
  }
}
