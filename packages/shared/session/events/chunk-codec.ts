/**
 * **打包编解码器**(F4-c 定律二,`docs/design/session-event-sourcing-2026-08.md` §16.19)。
 *
 * > 定律二:**打包是压缩,不是语义**。
 *
 * `events.jsonl` 里那条 `assistant/chunks`(一行攒 N 条 delta)从来不是一种事实,
 * 它是**存储编码**。逻辑层只有一种词汇:一条 delta = 模型吐出的一段字。于是:
 *
 * - **写入端**:逻辑 delta 进编码器,编码器按段落边界与两道闸(2s / 64 条)刷出
 *   打包行 —— **时机与字节与从前逐字节相同**(这一条由 recorder 的字节回归钉);
 * - **读取端**:打包行经解码器展开回逻辑 delta 流,再交给投影 reducer 折。
 *
 * 唯一合同:**decode(encode(x)) ≡ x**(`session-chunk-codec.test.ts` 的性质测试)。
 *
 * ## 谁住在这里,谁不住
 *
 * 住在这里的是**编码**那件事的全部:段边界判定(U0 的状态机,从
 * `core/session/part-boundary.ts` 迁居而来)、攒批、两道闸、刷行。
 *
 * **不**住在这里的是"这一段身上挂着什么"(runId / messageId / turnIndex /
 * 正文累计 / len+hash / UI 流 / 掉账记账)—— 那些是调用方的账,每个落点各不相同,
 * 而编码规则只有一条。编码器通过 `resolvePart` 向调用方问身份,通过
 * `onPartOpened` / `onPartEnded` / `onDelta` / `onPartDropped` 把判定回吐给它。
 *
 * 本模块**零依赖、零 node 引用**:定时器由 `schedule` 注入(缺省 `setTimeout`),
 * 时钟由 `now` 注入(缺省 `Date.now`)—— 测试因此不必碰假时钟就能钉住字节。
 */

import type { SessionAssistantChunksEventData, SessionAssistantDeltaPartKind } from './types.js'

// ---------------------------------------------------------------------------
// 段边界状态机(U0 迁居:原 `core/session/part-boundary.ts`,逐字保留)
// ---------------------------------------------------------------------------

/**
 * 助手输出的 **part 边界判定** —— 一台状态机,两处落点(U 线 U0,
 * `docs/design/ui-event-stream-2026-08.md` §1 规则 1 / §3 U0 行)。
 *
 * 从前这套判定只活在采集点里(`session-event-recorder.ts` 的
 * `currentTextPart` / `currentReasoningPart` / `toolInputPartByCallId` +
 * `deltaInto` / `endAllOpenParts`);U0 把它提成一件零依赖的纯件,让落盘打包器
 * 与 UI 小批发器共用同一份判定(**边界只判一次**是这条线的第一条规矩)。
 *
 * F4-c 定律二把它请进编码器:**边界判定本来就是编码的一部分** —— "这条 delta
 * 落在哪一段、哪一段该收了"决定的正是"刷哪一行"。它仍然是纯的,仍然只回答
 * 两个问题:
 *
 * 1. **这条 delta 属于哪一段**(`partIndex` + `kind`);
 * 2. **这一步收掉了哪几段**(按收的先后)。
 *
 * ## 三条边界规则(与从前逐字相同)
 *
 * - **换 kind 就换段**:一段 `text` 与一段 `reasoning` 不共用一个 `partIndex`,
 *   换过去之前先把对面那一段收了;
 * - **一次工具调用的参数流自成一段**,由 `toolInputStart` 开、`toolInputDone` 收;
 * - **分界一到全收**(`endAll`):请求收尾 / 回合分界 / steering 的响应边界。
 *
 * 号由调用方给(`allocate`)—— 它是"这次执行的第几段输出",住在执行的账上。
 * 分不到号时这一段在账本上整格消失,机器如实说 `dropped: true`,由调用方记账。
 */

/** 带 delta 的三种段(`image` / `provider-data` 不吐 delta,不经这台机器开段)。 */
export type CoreAssistantPartBoundaryKind = 'text' | 'reasoning' | 'tool-input'

/** 一段的身份(边界判定的全部产出)。 */
export interface CoreAssistantPartRef {
  partIndex: number
  kind: CoreAssistantPartBoundaryKind
  toolCallId?: string
  toolName?: string
}

export interface CoreAssistantPartBoundaryResult {
  /** 这一步收掉的段,**按收的先后**(调用方照这个顺序写 part-end)。 */
  ended: CoreAssistantPartRef[]
  /** 这条 delta 落在哪一段;分不到号时缺席。 */
  current?: CoreAssistantPartRef
  /** `current` 是这一步新开的(调用方据此登记段上的元信息)。 */
  opened?: CoreAssistantPartRef
  /** 该开一段却分不到号 —— 这一段整格消失,调用方记一笔掉账。 */
  dropped?: boolean
}

export interface CoreAssistantPartBoundaryOptions {
  /**
   * 分配下一个 `partIndex`。返回 `undefined` = 现在开不出段
   * (没有活跃执行 / 没有请求号),机器不开段并如实报 `dropped`。
   */
  allocate: () => number | undefined
}

export interface CoreAssistantPartBoundaryMachine {
  /** 一条正文 / 推理 delta:先收对面那一段,再落到自己这一段。 */
  delta(kind: 'text' | 'reasoning'): CoreAssistantPartBoundaryResult
  /** 一次调用的参数流开张。 */
  toolInputStart(toolCallId: string, toolName?: string): CoreAssistantPartBoundaryResult
  /** 一条参数 delta 落在哪一段(不开段:没开过就是没有)。 */
  toolInputDelta(toolCallId: string): CoreAssistantPartBoundaryResult
  /** 参数定稿:收掉那一段。 */
  toolInputDone(toolCallId: string): CoreAssistantPartBoundaryResult
  /**
   * 占一个号给**不吐 delta**的一格(`provider-data`)。
   *
   * 与开段不同:它先把正文/推理两段收了(一格夹进去就把前后切成两格),再要
   * 一个号,但**不登记为开着的段** —— 调用方当场就把它写完。
   */
  reserve(): { ended: CoreAssistantPartRef[]; partIndex?: number }
  /** 分界:所有开着的段按开的先后全收。 */
  endAll(): CoreAssistantPartBoundaryResult
  /** 现在开着哪几段(只读,调试/断言用)。 */
  openParts(): readonly CoreAssistantPartRef[]
}

export function createCoreAssistantPartBoundaryMachine(
  options: CoreAssistantPartBoundaryOptions,
): CoreAssistantPartBoundaryMachine {
  /** 开着的段,**插入序 = 开段序**(`endAll` 照这个序收)。 */
  const open = new Map<number, CoreAssistantPartRef>()
  const toolInputPartByCallId = new Map<string, number>()
  let currentTextPart: number | undefined
  let currentReasoningPart: number | undefined

  function closePart(partIndex: number | undefined, into: CoreAssistantPartRef[]): void {
    if (partIndex === undefined) return
    const ref = open.get(partIndex)
    if (!ref) return
    open.delete(partIndex)
    if (ref.kind === 'tool-input' && ref.toolCallId) toolInputPartByCallId.delete(ref.toolCallId)
    if (currentTextPart === partIndex) currentTextPart = undefined
    if (currentReasoningPart === partIndex) currentReasoningPart = undefined
    into.push(ref)
  }

  function openPart(
    kind: CoreAssistantPartBoundaryKind,
    toolCallId?: string,
    toolName?: string,
  ): CoreAssistantPartRef | undefined {
    const partIndex = options.allocate()
    if (partIndex === undefined) return undefined
    const ref: CoreAssistantPartRef = {
      partIndex,
      kind,
      ...(toolCallId ? { toolCallId } : {}),
      ...(toolName ? { toolName } : {}),
    }
    open.set(partIndex, ref)
    return ref
  }

  return {
    delta(kind) {
      const ended: CoreAssistantPartRef[] = []
      // 换 kind 就换段:对面那一段先收。
      closePart(kind === 'text' ? currentReasoningPart : currentTextPart, ended)

      const slot = kind === 'text' ? currentTextPart : currentReasoningPart
      if (slot !== undefined) {
        const ref = open.get(slot)
        return ref ? { ended, current: ref } : { ended }
      }

      const opened = openPart(kind)
      if (!opened) return { ended, dropped: true }
      if (kind === 'text') currentTextPart = opened.partIndex
      else currentReasoningPart = opened.partIndex
      return { ended, current: opened, opened }
    },

    toolInputStart(toolCallId, toolName) {
      const opened = openPart('tool-input', toolCallId, toolName)
      if (!opened) return { ended: [], dropped: true }
      toolInputPartByCallId.set(toolCallId, opened.partIndex)
      return { ended: [], current: opened, opened }
    },

    toolInputDelta(toolCallId) {
      const partIndex = toolInputPartByCallId.get(toolCallId)
      if (partIndex === undefined) return { ended: [] }
      const ref = open.get(partIndex)
      return ref ? { ended: [], current: ref } : { ended: [] }
    },

    toolInputDone(toolCallId) {
      const ended: CoreAssistantPartRef[] = []
      closePart(toolInputPartByCallId.get(toolCallId), ended)
      toolInputPartByCallId.delete(toolCallId)
      return { ended }
    },

    reserve() {
      const ended: CoreAssistantPartRef[] = []
      // 顺序与从前逐字相同:先正文,后推理。
      closePart(currentTextPart, ended)
      closePart(currentReasoningPart, ended)
      const partIndex = options.allocate()
      return partIndex === undefined ? { ended } : { ended, partIndex }
    },

    endAll() {
      const ended: CoreAssistantPartRef[] = []
      for (const partIndex of [...open.keys()]) closePart(partIndex, ended)
      currentTextPart = undefined
      currentReasoningPart = undefined
      toolInputPartByCallId.clear()
      return { ended }
    },

    openParts() {
      return [...open.values()]
    },
  }
}

// ---------------------------------------------------------------------------
// 编码半边:逻辑 delta → 打包行
// ---------------------------------------------------------------------------

/** 攒批的两道闸(另两条是 part 边界与请求结束,由调用方触发)。 */
export const SESSION_CHUNK_BATCH_INTERVAL_MS = 2000
export const SESSION_CHUNK_BATCH_SIZE = 64

/**
 * 一段身上挂着的东西 —— 由调用方保管,编码器只在刷行那一刻问它要。
 *
 * 为什么不由编码器保管:`messageId` 会随 `response-boundary` 换锚点、
 * `turnIndex` 是引擎回合号的镜像、`runId` 是"开这一段时那次执行" —— 三件事
 * 都住在调用方的账上,编码器抄一份就是第二个真相。
 */
export interface SessionChunkPartMeta {
  runId: string
  requestIndex: number
  messageId: string
  kind: SessionAssistantDeltaPartKind
  toolCallId?: string
  toolName?: string
  turnIndex: number
}

/** 一条**已盖章**的逻辑 delta —— 解码器吐的、编码器收的,同一种东西。 */
export interface SessionLogicalDelta {
  runId: string
  requestIndex: number
  messageId: string
  partIndex: number
  kind: SessionAssistantDeltaPartKind
  toolCallId?: string
  toolName?: string
  /** 老文件没有这一格(§13.9 之前写下的行)。 */
  turnIndex?: number
  /** 这条 delta 的到达时刻(打包行里 `time0 + dt[i]`)。 */
  time: number
  text: string
}

export interface SessionChunkEncoderOptions extends CoreAssistantPartBoundaryOptions {
  /** 这一段身上挂着什么(= 调用方的 openParts 查表)。答不上来 = 这条 delta 不落账。 */
  resolvePart: (partIndex: number) => SessionChunkPartMeta | undefined
  /** 刷出一行打包行。**这就是落账那一刻**(调用方把它写进素门)。 */
  emitChunks: (data: SessionAssistantChunksEventData) => void
  /** 状态机新开了一段 —— 调用方在这里登记这一段身上挂的东西。 */
  onPartOpened?: (ref: CoreAssistantPartRef) => void
  /** 一段收了(**这一段的批已经刷完**)—— 调用方在这里写 part-end。 */
  onPartEnded?: (ref: CoreAssistantPartRef) => void
  /** 该开一段却分不到号 —— 这一段整格消失,调用方记一笔掉账。 */
  onPartDropped?: () => void
  /**
   * 一条盖过章的逻辑 delta(落进批的同一条)。
   *
   * 调用方在这里做"落在这一段上的账":正文累计(part-end 的 len/hash 从它来)、
   * UI 流小批。位置与从前逐字相同 —— 批里推完、64 条闸判定之前。
   *
   * `at` = 这条 delta 的**盖章时刻**,与打包行里 `time0 + dt[i]` 逐字相同
   * (F4-c c3-a 加的一格)。调用方把 delta 提前折进活投影时必须用它,否则
   * 提前折那一份与打包行重折那一份的时刻会差几微秒 —— 折出来的
   * `reasoningFirstAt/LastAt` 就成了两个值。
   */
  onDelta?: (partIndex: number, text: string, meta: SessionChunkPartMeta, at: number) => void
  now?: () => number
  batchSize?: number
  batchIntervalMs?: number
  /** 2 秒闸的定时器。返回取消函数。缺省 `setTimeout`(能 unref 就 unref)。 */
  schedule?: (fn: () => void, ms: number) => () => void
}

export interface SessionChunkEncoder {
  /** 一条正文 / 推理 delta。 */
  delta(kind: 'text' | 'reasoning', text: string): void
  /** 一次调用的参数流开张。 */
  toolInputStart(toolCallId: string, toolName?: string): void
  /** 一条参数 delta。 */
  toolInputDelta(toolCallId: string, text: string): void
  /** 参数定稿:收掉那一段(批先刷,再 `onPartEnded`)。 */
  toolInputDone(toolCallId: string): void
  /** 占一个号给不吐 delta 的一格(`provider-data`);先把正文/推理两段收了。 */
  reservePart(): number | undefined
  /** 分界:所有开着的段全收。 */
  endAll(): void
  /** 把还在攒的批全部刷出去(收尾用;不动段)。 */
  flushAll(): void
  /** 现在开着哪几段(只读,断言用)。 */
  openParts(): readonly CoreAssistantPartRef[]
}

/** 一段还在攒的 delta 批次。 */
interface ChunkBatch {
  /**
   * F13:**开这一批时的 run**。
   *
   * 从前落盘时现取"当前那次执行"—— 而 2 秒定时器完全可能晚于 `endSessionRun`
   * 清账才响,那时取回 undefined,整批 delta 静默消失。一批 delta 属于开它的
   * 那次执行,这是事实,不是"当前值"。
   */
  runId: string
  partIndex: number
  kind: SessionAssistantDeltaPartKind
  requestIndex: number
  messageId: string
  toolCallId?: string
  toolName?: string
  /** §13.9:开这一段时引擎的回合号。 */
  turnIndex: number
  time0: number
  dt: number[]
  text: string[]
  cancel: (() => void) | null
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms)
  const unref = (timer as unknown as { unref?: () => void }).unref
  if (typeof unref === 'function') unref.call(timer)
  return () => clearTimeout(timer)
}

export function createSessionChunkEncoder(
  options: SessionChunkEncoderOptions,
): SessionChunkEncoder {
  const parts = createCoreAssistantPartBoundaryMachine({ allocate: options.allocate })
  const batches = new Map<number, ChunkBatch>()
  const now = options.now ?? (() => Date.now())
  const schedule = options.schedule ?? defaultSchedule
  const batchSize = options.batchSize ?? SESSION_CHUNK_BATCH_SIZE
  const batchIntervalMs = options.batchIntervalMs ?? SESSION_CHUNK_BATCH_INTERVAL_MS

  function flushBatch(partIndex: number): void {
    const batch = batches.get(partIndex)
    if (!batch) return
    batches.delete(partIndex)
    if (batch.cancel) batch.cancel()
    if (batch.text.length === 0) return
    // F13:落的是**开这一批时**的那次执行,不是"此刻是哪次执行"。
    options.emitChunks({
      runId: batch.runId,
      requestIndex: batch.requestIndex,
      messageId: batch.messageId,
      partIndex: batch.partIndex,
      kind: batch.kind,
      ...(batch.toolCallId ? { toolCallId: batch.toolCallId } : {}),
      ...(batch.toolName ? { toolName: batch.toolName } : {}),
      turnIndex: batch.turnIndex,
      time0: batch.time0,
      dt: batch.dt,
      text: batch.text,
    })
  }

  /** 一条逻辑 delta 进编码器。 */
  function push(partIndex: number, text: string): void {
    const meta = options.resolvePart(partIndex)
    if (!meta || !text) return

    const at = now()
    let batch = batches.get(partIndex)
    if (!batch) {
      batch = {
        runId: meta.runId,
        partIndex,
        kind: meta.kind,
        requestIndex: meta.requestIndex,
        messageId: meta.messageId,
        ...(meta.toolCallId ? { toolCallId: meta.toolCallId } : {}),
        ...(meta.toolName ? { toolName: meta.toolName } : {}),
        turnIndex: meta.turnIndex,
        time0: at,
        dt: [],
        text: [],
        cancel: null,
      }
      batches.set(partIndex, batch)
      // 2 秒闸:一段慢吞吞吐字的响应也要按时落账(崩溃最多丢这 2 秒)。
      batch.cancel = schedule(() => flushBatch(partIndex), batchIntervalMs)
    }
    batch.dt.push(at - batch.time0)
    batch.text.push(text)
    // 同一条 delta,**同一份段身份**,交回调用方一份(UI 流 / 正文累计)。
    options.onDelta?.(partIndex, text, meta, at)
    // 64 条闸。
    if (batch.text.length >= batchSize) flushBatch(partIndex)
  }

  /** 收段:**先把这一段的批刷了**,再交回调用方写 part-end。 */
  function endPart(ref: CoreAssistantPartRef): void {
    flushBatch(ref.partIndex)
    options.onPartEnded?.(ref)
  }

  function apply(result: CoreAssistantPartBoundaryResult): CoreAssistantPartBoundaryResult {
    for (const ref of result.ended) endPart(ref)
    if (result.opened) options.onPartOpened?.(result.opened)
    if (result.dropped) options.onPartDropped?.()
    return result
  }

  return {
    delta(kind, text) {
      const result = apply(parts.delta(kind))
      if (!result.current) return
      push(result.current.partIndex, text)
    },

    toolInputStart(toolCallId, toolName) {
      apply(parts.toolInputStart(toolCallId, toolName))
    },

    toolInputDelta(toolCallId, text) {
      const current = parts.toolInputDelta(toolCallId).current
      if (current) push(current.partIndex, text)
    },

    toolInputDone(toolCallId) {
      apply(parts.toolInputDone(toolCallId))
    },

    reservePart() {
      const reserved = parts.reserve()
      for (const ref of reserved.ended) endPart(ref)
      return reserved.partIndex
    },

    endAll() {
      apply(parts.endAll())
    },

    flushAll() {
      for (const partIndex of [...batches.keys()]) flushBatch(partIndex)
    },

    openParts() {
      return parts.openParts()
    },
  }
}

// ---------------------------------------------------------------------------
// 解码半边:打包行 → 逻辑 delta 流(纯函数)
// ---------------------------------------------------------------------------

/**
 * 一行打包行展开回它装着的那几条逻辑 delta。
 *
 * **`text` 数组是驱动**:`dt` 与它一样长是编码器的不变式,但盘上的老行/半行不
 * 归我们管 —— `dt` 短了就用最后一个已知偏移(读侧永远只跳过、绝不"修文件")。
 */
export function forEachSessionChunkLogicalDelta(
  data: SessionAssistantChunksEventData,
  visit: (delta: SessionLogicalDelta) => void,
): void {
  const texts = Array.isArray(data.text) ? data.text : []
  const dt = Array.isArray(data.dt) ? data.dt : []
  /**
   * **借出去的一格**:整行共用这一个对象,每一步只改 `text` / `time`。
   *
   * 折叠一份真机账本要展开百万级 delta(全库 212 万),一条一个对象是**读侧
   * 全库多花一倍时间**的那一半(实测)。段身份逐行恒定,所以借一格出去既省
   * 分配又保住形状 —— 代价是**调用方不许留存它**(要留存就用数组形态)。
   */
  const borrowed: SessionLogicalDelta = {
    runId: data.runId,
    requestIndex: data.requestIndex,
    messageId: data.messageId,
    partIndex: data.partIndex,
    kind: data.kind,
    toolCallId: data.toolCallId,
    toolName: data.toolName,
    turnIndex: data.turnIndex,
    time: data.time0,
    text: '',
  }
  let lastOffset = 0
  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index]
    if (typeof text !== 'string' || !text) continue
    const offset = typeof dt[index] === 'number' && Number.isFinite(dt[index]) ? dt[index] : lastOffset
    lastOffset = offset
    borrowed.time = data.time0 + offset
    borrowed.text = text
    visit(borrowed)
  }
}

/**
 * 同一件事的数组形态:一条 delta 一个独立对象,拿走了随便留。
 *
 * 合同测试 / 工具 / 任何要把 delta 存起来的地方用它;折叠热路径走
 * `forEachSessionChunkLogicalDelta`(不建数组、不逐条分配)。
 */
export function decodeSessionChunksEventData(
  data: SessionAssistantChunksEventData,
): SessionLogicalDelta[] {
  const deltas: SessionLogicalDelta[] = []
  forEachSessionChunkLogicalDelta(data, delta => deltas.push({ ...delta }))
  return deltas
}
