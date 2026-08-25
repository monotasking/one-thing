/**
 * 助手输出的 **part 边界判定** —— 一台状态机,两处落点(U 线 U0,
 * `docs/design/ui-event-stream-2026-08.md` §1 规则 1 / §3 U0 行)。
 *
 * 从前这套判定只活在采集点里(`session-event-recorder.ts` 的
 * `currentTextPart` / `currentReasoningPart` / `toolInputPartByCallId` +
 * `deltaInto` / `endAllOpenParts`)。U0 要给 UI 流发同一套词汇的小批
 * (`assistant/chunks`),而**边界只判一次**是这条线的第一条规矩:两处各算一遍
 * 就是第二个判定点,而"位置推断出来的 part 身份"正是 U 线要根治的病根。
 *
 * 所以判定被提到这里,成为一件**零依赖的纯件**:
 *  - 落盘打包器(recorder)拿它决定"这条 delta 落在哪一段、哪一段该收了";
 *  - UI 小批(coalescer)吃的就是它盖过章的 delta —— 不再自己判第二遍。
 *
 * ## 它只回答两个问题
 *
 * 1. **这条 delta 属于哪一段**(`partIndex` + `kind`);
 * 2. **这一步收掉了哪几段**(按收的先后)。
 *
 * 段上挂什么(runId / messageId / turnIndex / 正文累计 / 攒批)是调用方的账,
 * 不在这里 —— 那些东西每个落点各不相同,而边界规则只有一条。
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
