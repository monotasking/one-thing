/**
 * 采集点:把 agent-loop 的事件流翻译成会话事件日志。
 *
 * 挂在 `AgentLoopOptions.onEvent` 上,而不是挂在 executor 消费的 chunk 流上。
 * 理由是**记账必须在执行前**:core agent-loop 的 runner 在 `collectEvent` 里先
 * 同步调 `request.onEvent?.(event)`,再把工具执行 enqueue 进调度器。所以
 * onEvent 看到 `tool-call-done` 的那一刻,工具一定还没跑。而 chunk 流要过一层
 * 异步队列(agent-loop bridge 的 AgentEventQueue),等它到达 executor 时工具
 * 可能早跑完了 —— 挂在那里的 `tool/call` 就成了事后补记,失去了"崩溃时留下
 * 开了头没收尾"的全部价值。
 *
 * ## S1a 补齐的那半份账(§10.2 第三行)
 *
 * E0 只记**信封与时刻**(七类)。S1a 把"这次请求发了什么、模型答了什么"补上,
 * 但严格守住"正文只有一个来源"这条:
 *
 * | 事件 | 记什么 | 不记什么 |
 * |---|---|---|
 * | `request/recipe` | 系统提示词 / 工具目录指纹 + 这次发出去的每条消息的 `{messageId, contentHash}` | 消息正文(它在 `user/message` 那一份账里) |
 * | `assistant/chunks` | **每一条 delta 的原文与到达时刻**,攒批成一行 | —— 这就是响应正文的唯一来源 |
 * | `assistant/part-end` | part 的 len + hash | 正文(fold delta 得到) |
 * | `request/response` | finish / usage / providerResponseId / responseModel + 各 part 的指纹 | 第二份文本 |
 * | `request/error` | 错误 + `willRetry` / `attempt` | —— |
 * | `skill/activated` | 这一轮激活了哪个技能 | —— |
 *
 * ### 攒批的四个触发点(§3 助手行)
 *
 * 2 秒 / 64 条 / part 边界 / 请求结束,先到者触发。一条 delta 一行会把 events.jsonl
 * 撑爆(一次响应几千条),而完全不记 delta 是量级退化(崩溃丢整个未收齐的
 * part)。攒批之后崩溃最多丢最后一批(≤2s),而 token 级回放与 TTFT/tps 全都
 * 还在。
 *
 * 本模块的所有异常自吞:记账坏了绝不能影响聊天。
 */

import type {
  AgentLoopOptions,
  AgentStreamEvent,
  AgentTool,
} from '@onething/core/agent-loop'
import type {
  BlobRef,
  CoreAssistantPartBoundaryResult,
  CoreAssistantPartRef,
  SessionAssistantDeltaPartKind,
  SessionAssistantPartKind,
  SessionResponseUsage,
} from '@onething/core/session'
// U0(`docs/design/ui-event-stream-2026-08.md` §1 规则 1):part 边界**只判一次**。
// 从前这台状态机是本文件里的四个字段 + `deltaInto`;现在它是 core 的一件纯件,
// 落盘打包器(这里)与 UI 小批发器(coalescer)共用同一份判定。
import { createCoreAssistantPartBoundaryMachine } from '@onething/core/session/part-boundary'
import type { UiAssistantDeltaChunk, UiAssistantPartEndChunk } from '@onething/core/events'
import { safeParseAgentToolArguments } from '@onething/core/agent-loop'
// §13.9:回合号的判定规则只有一份,住在引擎那边。引那**一个叶子文件**而不是
// `@onething/core/engine` barrel —— barrel 会把整棵执行器模块图拖进记录器
// (与上面 provider-data 那条 import 同一条理由)。
import { nextAgentLoopTurnIndexAfterFinish } from '@onething/core/engine/agent-loop-turn'
// §13.17:changes 的判定点与引擎写消息时同源(`changesFromToolMetadata`)。引
// 那一个叶子文件而不是 `@onething/core/engine` barrel —— 同上"避免拖进整棵执行器
// 模块图"的理由。
import { changesFromToolMetadata } from '@onething/core/engine/tool-orchestration'
// 直接引那一个纯文件而不是 providers 的 barrel:barrel 会把六个 provider 实现
// 一并拖进记录器的模块图,而这里要的只是一张判定表(见文件头"本模块只依赖
// 会话事件那一层"的同一条理由)。
import { planOnethingProviderDataPart } from '@onething/runtime/agent-loop/providers/provider-data'
import {
  hashSessionEventContent,
  hashSessionEventSystemPrompt,
  hashSessionEventTools,
  isSameRequestHeaderEnvelope,
  truncateSessionEventPreview,
  type SessionEventToolSchema,
  type SessionRequestHeaderEventData,
} from '@onething/runtime/sessions/session-events'
import {
  appendSessionLogEvent,
  findLastSessionEventSync,
  flushSessionEventLog,
  nextSessionRequestIndex,
} from '../../../session/event-log.js'
import { textOrBlobForEvent } from '../../../session/blob-store.js'
import { countSessionEventDroppedPart } from '../../../session/event-stats.js'
import {
  currentSessionRunId,
  nextSessionRunPartIndex,
  setSessionRunRequestIndex,
} from '../../../session/runs.js'
import { getLogger } from '../../logging/index.js'

const log = getLogger('sessions.events')


/** 攒批的三条闸(第四条是"请求结束",由 turn-end 触发)。 */
export const SESSION_CHUNK_BATCH_INTERVAL_MS = 2000
export const SESSION_CHUNK_BATCH_SIZE = 64

/** 这次请求发出去的历史里的一条(G10:身份 + 指纹,不是正文)。 */
export interface SessionRecipeMessage {
  messageId: string
  contentHash: string
}

export interface SessionEventRecorderContext {
  sessionId: string
  providerId: string
  model: string
  /** 当次请求的 system prompt 全文;只用来算指纹,不落盘。 */
  systemPrompt?: string
  /** 当次请求模型看到的工具目录。 */
  tools?: readonly AgentTool[]
  /** 助手消息 id 现取现用 —— 一个 run 里它会随 response-boundary 换锚点。 */
  getMessageId: () => string
  /**
   * G10:这次请求发出去的**历史输入**。
   *
   * 采集点必须是 history builder 的**输入**(带 id 的那一份 `ChatMessage[]`),
   * 而不是 provider 收到的 `AgentMessage[]` —— 后者没有消息 id,配对只能靠数
   * 下标,而工具消息会把下标错开。缺省不给就不写 recipe 的 messages 那一格
   * (少一格账,好过一格猜出来的账)。
   *
   * `eventSeq` 要到 S2 才填得上(id→seq 索引在那一期建),所以这里只有
   * `{messageId, contentHash}`,与 §10.1 G10 的裁定一致。
   */
  getHistoryInput?: () => readonly { id: string; role: string; content?: string }[]
  /** 请求参数快照(温度 / maxTokens / thinking …),原样进 recipe。 */
  getRequestParams?: () => Record<string, unknown> | undefined
  /**
   * 配方写下去的那一刻(= 这次请求真正发出之前)的旁听口。
   *
   * S1b 的历史影子断言挂在这里(`history-shadow.ts`)。留一个回调而不是就地
   * import:那条断言要用 `buildHistoryMessages` 与读门面,而它们身后是整棵
   * store 树 —— recorder 只该依赖会话事件那一层。
   */
  onRequestRecipe?: (runId: string, requestIndex: number) => void
  /**
   * A6+A7(§13.1):工具身份归一 —— **引擎那一个函数**,由宿主注入。
   *
   * 消息上那两格是 `toolCall.toolId = resolved.toolId` /
   * `toolCall.toolName = resolved.displayName`,而账本上从前只有 provider 给的
   * 原始名。记录器不自己再实现一遍别名表与 MCP 折叠(那就是第二个判定点):
   * 宿主把 `app/engine/stream/stream-processor.ts` 的 `resolveToolIdentity`
   * 传进来。用端口而不是 import 的理由与 `onRequestRecipe` 同一条 —— 那个函数
   * 身后挂着 MCP 管理器与整棵 store 树,记录器的模块图不该被它撑开。
   *
   * 不注入时不写这两格,投影退回原始名(= 修复前的行为)。
   */
  resolveToolIdentity?: (
    toolName: string,
    args: Record<string, unknown>,
  ) => { toolId: string; displayName: string }
  /**
   * A11(§13.1):这次调用**在消息上吗**?
   *
   * 可见性的判定点只有一个,在引擎(`stream-processor.ts` 的 `visible`:
   * 占位卡、`toolCalls.push`、step 三样一起做或一起不做)。记录器挂在 agent-loop
   * 的事件流上,看不见那个决定,所以由宿主经这个端口回传 —— 与
   * `resolveToolIdentity` 同一条路数(记录器不实现第二遍规则)。
   *
   * 不注入 / 答不上来 = 可见(= 修复前的行为,老文件也是这么读的)。
   *
   * **已知边界**:记录器跑在 provider 流上,比消费 chunk 的执行器**早**一步 ——
   * 对"参数流从没开过头"的补位调用(fallback),藏与不藏的决定与
   * `tool/call` 落账几乎同刻,答不上来时按可见记。今天生产里
   * `publish:false` 没有产地(agent-loop 那条路一次都不传),所以这一格是
   * 给将来的守卫,不是在描述现状。
   */
  isToolCallHidden?: (toolCallId: string) => boolean
  /**
   * U0:UI 事件流的**旁路口**(`docs/design/ui-event-stream-2026-08.md` §3)。
   *
   * 采集点是 part 边界的唯一判定处,所以"这条 delta 属于哪一段"也只该在这里
   * 说一次 —— UI 小批吃的就是这里盖过章的东西,不再自己判第二遍。
   *
   * 不注入(默认 `ONETHING_UI_STREAM=legacy`)= 一条都不发,renderer 零感知。
   */
  emitUiEvent?: (event: UiAssistantDeltaChunk | UiAssistantPartEndChunk) => void
  /**
   * U0(§10.15):`response-boundary` 的**同步**换锚点口。
   *
   * 采集点在这一刻已经把上一条响应的 part 全收了,接下来的每一条事件都属于
   * 新的那条助手消息 —— 宿主在这里换 run 与消息 id,采集点随后取到的
   * `getMessageId()` / `currentSessionRunId()` 就是新的那一对。
   *
   * 不注入 = 保持 U0 之前的行为(换锚点仍由执行器在异步侧做)。
   */
  onResponseBoundary?: () => void
}

/**
 * 工具结局的结构化那一份 → 事件行。
 *
 * `AgentToolResult.data` 就是引擎写进 `ToolCall.result` 的那个对象
 * (`tool-orchestration.ts` 的 `toJsonValue(result.data)`),所以这里存的与那边
 * 存的是同一份。序列化失败不写 —— 少一格账,好过一格坏掉的账。
 *
 * **字符串结局分两种**(§10.14):成功时它与 `result.text` 是同一个东西,不必
 * 存两遍;**失败**时 `result.text` 装的是那句错误话,而 `ToolCall.result` 装的
 * 仍是 data —— 两者不是同一个东西,不写就等于把它丢了(矩阵在
 * `tool-args-truncated` 那一格抓到:参数 JSON 断在半路,data 是空串)。
 */
function structuredResultForEvent(
  sessionId: string,
  data: unknown,
  isError = false,
): { resultData: { text: string } | { blob: BlobRef } } | Record<string, never> {
  if (data === undefined || data === null) return {}
  if (typeof data !== 'object' && !isError) return {}
  let text: string
  try {
    text = JSON.stringify(data)
  } catch {
    return {}
  }
  if (!text) return {}
  return { resultData: textOrBlobForEvent(sessionId, text) }
}

/**
 * edit/write 的结构化 diff → 事件行(§13.17)。序列化 ≤64KB 进事件行,超了走
 * blob(与 `resultData` 同一条 `textOrBlobForEvent` 线;真机上去掉 originalContent
 * 后 2207 份里只有 3 份超线)。`changes` 天然不含 `originalContent`
 * (`changesFromToolMetadata` 从不折它)。缺席 / 序列化失败 = 不写这一格。
 */
function changesForEvent(
  sessionId: string,
  changes: ReturnType<typeof changesFromToolMetadata>,
): { changes: { text: string } | { blob: BlobRef } } | Record<string, never> {
  if (!changes) return {}
  let text: string
  try {
    text = JSON.stringify(changes)
  } catch {
    return {}
  }
  if (!text) return {}
  return { changes: textOrBlobForEvent(sessionId, text) }
}

function toToolSchemas(tools: readonly AgentTool[] | undefined): SessionEventToolSchema[] {
  if (!tools?.length) return []
  return tools.map(tool => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.parameters ? { parameters: tool.parameters } : {}),
  }))
}

/** 一段还在攒的 delta 批次。 */
interface ChunkBatch {
  /**
   * F13:**开这一批时的 run**。
   *
   * 从前落盘时现取 `currentSessionRunId()` —— 而 2 秒定时器完全可能晚于
   * `endSessionRun` 清账才响,那时取回 undefined,整批 delta 静默消失。
   * 一批 delta 属于开它的那次执行,这是事实,不是"当前值"。
   */
  runId: string
  partIndex: number
  kind: SessionAssistantDeltaPartKind
  requestIndex: number
  messageId: string
  toolCallId?: string
  toolName?: string
  /** §13.9:开这一段时引擎的回合号(与 `PartState.turnIndex` 同一个值)。 */
  turnIndex: number
  time0: number
  dt: number[]
  text: string[]
  timer: ReturnType<typeof setTimeout> | null
}

/** 一个 part 的累计状态(part-end 的 len/hash 从这里来)。 */
interface PartState {
  /** F13:开这一段时的 run(理由同 `ChunkBatch.runId`)。 */
  runId: string
  partIndex: number
  kind: SessionAssistantDeltaPartKind
  requestIndex: number
  messageId: string
  toolCallId?: string
  /**
   * `tool-input` 段的工具名(`tool-call-start` 那一格)。孤儿参数流永远等不到
   * `tool/call`,没有这一格就说不出"被打断的那次调用是谁"(§10.14 第 7 类)。
   */
  toolName?: string
  /**
   * §13.9:**开这一段时**引擎的回合号。
   *
   * 引擎给 contentPart 盖章是在消费每一条 chunk 的那一刻(`state.turnIndex`),
   * 而一段 part 里的每条 delta 必然同回合 —— 回合一换,分界那条 finish 就把这
   * 一段收了(见 `handle` 的 `finish` 分支)。
   */
  turnIndex: number
  text: string
}

interface RecorderState {
  requestIndex?: number
  /**
   * §13.9:引擎的回合号(`CoreAgentLoopExecutorState.turnIndex`)的镜像。
   *
   * 为什么不是 `requestIndex`:`requestIndex` 在 `turn-start` 上发号(一次请求
   * 一个),而引擎的回合号还会在**每一条 tool-calls finish** 上 +1 ——
   * 外部执行器(Claude Code SDK)把多轮装进一次请求,靠的正是那条中途 finish。
   *
   * 镜像是可靠的:记录器与执行器消费的是**同一条**有序事件流(记录器挂在
   * `onEvent` 上、执行器消费由它派生的 chunk 队列),而推进规则调的是引擎那
   * 一个函数(§10.10),不在这里手抄。
   */
  turnIndex: number
  /**
   * §13.9:最近一条 finish 的**推进之前**那个回合号 —— 引擎把这次请求的 usage
   * 记到 step 上时用的就是它(`updateStepsUsageByTurn` 排在推进之前)。
   * 一条 finish 都没见过时退回当前值。
   */
  usageTurnIndex?: number
  firstTokenWritten: boolean
  /** 上一条已写入的 header 信封;首次从文件恢复(跨重启也不重复写)。 */
  lastHeader?: SessionRequestHeaderEventData
  lastHeaderLoaded: boolean
  /**
   * 上一条已写入的工具目录指纹;首次从文件恢复 —— 跨重启也不会把那 40KB
   * 再写一遍。恢复读的是 `request/tools.toolsHash` 字段,不重算大数组。
   */
  lastToolsHash?: string
  lastToolsHashLoaded: boolean
  callSeqByCallId: Map<string, number>
  /**
   * callId → 工具自报的**最后一个**标题(`tool-metadata` 里带 title 的那几条)。
   *
   * 与引擎同一条规则:`applyAgentLoopToolMetadata` 只在 `update.title` 是非空
   * 字符串时覆盖 step 标题,收尾时只带 metadata 的那条 annotate 不清空标题。
   */
  reportedTitleByCallId: Map<string, string>
  /**
   * callId → edit/write 的结构化 diff(§13.17)。工具在 `tool-metadata` 里带
   * diff/hunks/path 时,过**引擎同款** `changesFromToolMetadata` 折出,`tool/result`
   * 落账时附上。时序天然成立:metadata 在 apply 中途到,result 在 settle 后写。
   */
  changesByCallId: Map<string, ReturnType<typeof changesFromToolMetadata>>
  /** 正在攒的批(每个 part 至多一个)。 */
  batches: Map<number, ChunkBatch>
  /**
   * 还没收齐的 part 的**元信息**(runId / messageId / turnIndex / 正文累计)。
   *
   * U0:哪一段开着、该收哪一段,由 core 的边界状态机说了算(`state.parts`);
   * 这张表只存"那一段身上挂着什么"——两件事分开之后,UI 小批与落盘打包才可能
   * 共用同一份边界判定。
   */
  openParts: Map<number, PartState>
  /**
   * U0:part 边界的**唯一判定处**(core `part-boundary.ts`)。从前是本文件里
   * `currentTextPart` / `currentReasoningPart` / `toolInputPartByCallId` 三个
   * 字段加 `deltaInto` 的那段 if。
   */
  parts: ReturnType<typeof createCoreAssistantPartBoundaryMachine>
  /** 这次请求收齐的 part(request/response 的 parts 指纹表)。 */
  finishedParts: Array<{ partIndex: number; kind: SessionAssistantPartKind; len: number; hash: string }>
  /** 这次请求产出的工具调用 id。 */
  toolCallIds: string[]
  /** provider 自报的响应 id / 模型(有些 provider 在 provider-data 里带)。 */
  providerResponseId?: string
  responseModel?: string
  /** 这次请求的自动重试次数(`auto-retry` 累加)。 */
  attempt: number
}

export interface SessionEventRecorder {
  handle(event: AgentStreamEvent): void
  /**
   * 请求**最终**失败(重试用光 / 不可重试)。`auto-retry` 记的是
   * `willRetry:true` 的那几次,这一条记的是收场 —— 由执行器的 catch 调。
   */
  recordRequestError(error: unknown): void
  /**
   * A14(§13.1):引擎**自己合成**的一段正文,不经 provider 流。
   *
   * codex 内联生图把一段 markdown 交给 `handleTextChunk`,消息上它与模型吐的
   * 正文没有区别 —— 但 `onEvent` 上一条 `text-delta` 都没有,所以采集点看不见。
   * 宿主在那一格落定之后回传给这里,`assistant/chunks` 才对得上事实。
   *
   * 走的是与 `text-delta` **同一条** `deltaInto('text')`:引擎那边也是同一个
   * `appendOrderedPart('text')`,合并规则因此天然一致。
   *
   * 不写 `assistant/first-token` —— 那一条记的是"模型第一次吐字",这段不是。
   */
  recordSynthesizedText(text: string): void
  /**
   * §13.8 第一类:一次执行**收场**时,把引擎写在消息上的取消结局记成
   * `tool/result`。
   *
   * 中止(或请求最终出错)时,已经派工出去的工具永远等不到那条 `tool-result`
   * 流事件 —— 账本上只剩一条 `tool/call`,而**消息上**引擎是有话说的:
   * `finalizeLingeringAgentLoopToolWork` 把调用与 step 判成 `cancelled` + 一句
   * 收场话,而 step 上还留着执行途中已经写下的结局(工具的
   * `annotate{metadata}` 或最后一次 partial)与它自报的标题。真机上那两条不等
   * (`web-7abaca68` 的 `sleep 20`、`fd899977` 的 `提问已取消`)差的正是这两格。
   *
   * 调用方交的是**引擎真的写下的那一份**(从收场之后的消息上读),不是这里
   * 第二次派生出来的东西(§10.10)。哪几次调用还没有结局由记录器自己说了算
   * (`callSeqByCallId` 就是那张表)—— 已经报过结局的调用一个字都不会被重写。
   *
   * @returns 实际落账的条数。
   */
  recordCancelledToolResults(calls: readonly SessionCancelledToolResult[]): number
  /** 把还在攒的批全部落盘(执行器收尾时调,防止最后一批被丢)。 */
  flush(): void
}

/** 收场那一刻,引擎写在一次未结调用上的东西(§13.8 第一类)。 */
export interface SessionCancelledToolResult {
  callId: string
  /**
   * 引擎写在 `step.result` 上的那一格 —— 执行途中已经落下的结局正文。
   * 没有就是没有:这里不造一段话(那会在投影里凭空多出一格 `result`)。
   */
  result?: string
}

export function createSessionEventRecorder(
  ctx: SessionEventRecorderContext,
): SessionEventRecorder {
  // U0:边界状态机的号由**这次执行**发(`nextSessionRunPartIndex`)。开不出段
  // 的条件与从前逐字相同:没有请求号 / 没有活跃 run 就一个号都不分。
  const parts = createCoreAssistantPartBoundaryMachine({
    allocate: () => allocatePartIndex(),
  })

  const state: RecorderState = {
    // 引擎那边同一格的初值也是 1(`agent-loop-executor.ts` 的 `turnIndex: 1`)。
    turnIndex: 1,
    parts,
    firstTokenWritten: false,
    lastHeaderLoaded: false,
    lastToolsHashLoaded: false,
    callSeqByCallId: new Map(),
    reportedTitleByCallId: new Map(),
    changesByCallId: new Map(),
    batches: new Map(),
    openParts: new Map(),
    finishedParts: [],
    toolCallIds: [],
    attempt: 0,
  }

  const runId = (): string | undefined => currentSessionRunId(ctx.sessionId)

  /**
   * 工具目录在这个记录器的整个生命周期内是恒定的(`ctx.tools` 在 attach 时就
   * 定好了),所以 schema 数组与指纹各算一次就够 —— 每回合重算 40KB 的
   * JSON.stringify 是纯浪费。
   */
  let catalog: { tools: SessionEventToolSchema[]; hash: string } | undefined
  function toolCatalog(): { tools: SessionEventToolSchema[]; hash: string } {
    if (!catalog) {
      const tools = toToolSchemas(ctx.tools)
      catalog = { tools, hash: hashSessionEventTools(tools) }
    }
    return catalog
  }

  /**
   * 目录变了才写那 40KB。返回本次生效的指纹,交给 header 引用。
   *
   * 与 header 的去重**互相独立**:system prompt 会话内会变(变量/上下文注入),
   * 目录不会;合在一条里的话每次 system 一变就陪葬一份没变的目录。
   */
  function maybeWriteTools(requestIndex: number): string {
    const { tools, hash } = toolCatalog()
    if (!state.lastToolsHashLoaded) {
      // F13:`findLastSessionEventSync` 现在**先问这个进程刚写过什么**
      // (`event-log.ts` 的 `lastByType`),文件读退回冷启动兜底 —— 写是排队异步
      // 落盘的,读文件会读到上一次的指纹,于是那 40KB 的目录被再写一遍。
      state.lastToolsHash = findLastSessionEventSync(ctx.sessionId, 'request/tools')?.data.toolsHash
      state.lastToolsHashLoaded = true
    }
    if (state.lastToolsHash === hash) return hash
    appendSessionLogEvent(ctx.sessionId, 'request/tools', {
      requestIndex,
      toolsHash: hash,
      tools,
      ...withRunId(),
    })
    state.lastToolsHash = hash
    return hash
  }

  function withRunId(): { runId?: string } {
    const id = runId()
    return id ? { runId: id } : {}
  }

  function envelope(requestIndex: number, toolsHash: string): SessionRequestHeaderEventData {
    return {
      requestIndex,
      provider: ctx.providerId,
      model: ctx.model,
      systemPromptHash: hashSessionEventSystemPrompt(ctx.systemPrompt ?? ''),
      toolsHash,
      reason: 'initial',
    }
  }

  function maybeWriteHeader(requestIndex: number, toolsHash: string): void {
    if (!state.lastHeaderLoaded) {
      // F13:同上 —— 内存里那一份是权威,文件读是冷启动兜底。
      state.lastHeader = findLastSessionEventSync(ctx.sessionId, 'request/header')?.data
      state.lastHeaderLoaded = true
    }
    const next = envelope(requestIndex, toolsHash)
    if (isSameRequestHeaderEnvelope(state.lastHeader, next)) return
    next.reason = state.lastHeader ? 'change' : 'initial'
    appendSessionLogEvent(ctx.sessionId, 'request/header', { ...next, ...withRunId() })
    state.lastHeader = next
  }

  /** G10:这次请求究竟发了哪些消息 —— 身份 + 指纹的自证账。 */
  function writeRecipe(requestIndex: number, toolsHash: string): void {
    const id = runId()
    if (!id) return
    const input = ctx.getHistoryInput?.()
    const messages: SessionRecipeMessage[] = (input ?? []).map(message => ({
      messageId: message.id,
      contentHash: hashSessionEventContent(`${message.role}\n${message.content ?? ''}`),
    }))
    const params = ctx.getRequestParams?.()
    appendSessionLogEvent(ctx.sessionId, 'request/recipe', {
      runId: id,
      requestIndex,
      systemPromptHash: hashSessionEventSystemPrompt(ctx.systemPrompt ?? ''),
      toolsHash,
      // `eventSeq` 在 S2 由 id→seq 索引解析(§10.1 G10);S1 只有身份与指纹。
      messages: messages as unknown as { eventSeq: number; contentHash: string }[],
      ...(params ? { params } : {}),
    })
    // S1b:配方写下去的同一刻比一次历史 —— 比的就是这次要发出去的那一份。
    try {
      ctx.onRequestRecipe?.(id, requestIndex)
    } catch (error) {
      log.warn('request recipe hook failed', { sessionId: ctx.sessionId }, error)
    }
  }

  // ---- delta 攒批 ----

  /** 号从**这次执行**上取;取不到就是取不到(见 `applyPartBoundary` 的掉账)。 */
  function allocatePartIndex(): number | undefined {
    const requestIndex = state.requestIndex
    const id = runId()
    if (requestIndex === undefined || !id) return undefined
    return nextSessionRunPartIndex(ctx.sessionId)
  }

  /** 状态机开了一段 → 把这一段身上挂的东西记下来。 */
  function registerPart(ref: CoreAssistantPartRef): void {
    const requestIndex = state.requestIndex
    const id = runId()
    // allocate 刚刚同步答应过这两格都在,这里只是把类型收窄。
    if (requestIndex === undefined || !id) return
    state.openParts.set(ref.partIndex, {
      runId: id,
      partIndex: ref.partIndex,
      kind: ref.kind,
      requestIndex,
      messageId: ctx.getMessageId(),
      ...(ref.toolCallId ? { toolCallId: ref.toolCallId } : {}),
      ...(ref.toolName ? { toolName: ref.toolName } : {}),
      turnIndex: state.turnIndex,
      text: '',
    })
  }

  /**
   * 状态机的一步判定 → 落到账上:先按收的先后收段,再登记新开的那一段。
   *
   * F13(§13.2):开不出段 = 这一段正文在账本上**整格消失**。从前这是三个纯静默
   * 的 `return undefined`;现在它至少是账单上的一个数
   * (`sessions:shadow-report` 打印它)。仍然不抛:记账不打断聊天。
   */
  function applyPartBoundary(
    result: CoreAssistantPartBoundaryResult,
  ): CoreAssistantPartBoundaryResult {
    for (const ref of result.ended) endPart(ref.partIndex)
    if (result.opened) registerPart(result.opened)
    if (result.dropped) countSessionEventDroppedPart(ctx.sessionId)
    return result
  }

  function flushBatch(partIndex: number): void {
    const batch = state.batches.get(partIndex)
    if (!batch) return
    state.batches.delete(partIndex)
    if (batch.timer) clearTimeout(batch.timer)
    if (batch.text.length === 0) return
    // F13:落的是**开这一批时**的那次执行,不是"此刻是哪次执行"——
    // 2 秒定时器完全可能晚于 `endSessionRun` 才响。
    appendSessionLogEvent(ctx.sessionId, 'assistant/chunks', {
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

  function flushAllBatches(): void {
    for (const partIndex of [...state.batches.keys()]) flushBatch(partIndex)
  }

  function pushDelta(partIndex: number, delta: string): void {
    const part = state.openParts.get(partIndex)
    if (!part || !delta) return
    part.text += delta

    const now = Date.now()
    let batch = state.batches.get(partIndex)
    if (!batch) {
      batch = {
        runId: part.runId,
        partIndex,
        kind: part.kind,
        requestIndex: part.requestIndex,
        messageId: part.messageId,
        ...(part.toolCallId ? { toolCallId: part.toolCallId } : {}),
        ...(part.toolName ? { toolName: part.toolName } : {}),
        turnIndex: part.turnIndex,
        time0: now,
        dt: [],
        text: [],
        timer: null,
      }
      state.batches.set(partIndex, batch)
      // 2 秒闸:一段慢吞吞吐字的响应也要按时落账(崩溃最多丢这 2 秒)。
      const timer = setTimeout(() => flushBatch(partIndex), SESSION_CHUNK_BATCH_INTERVAL_MS)
      const unref = (timer as unknown as { unref?: () => void }).unref
      if (typeof unref === 'function') unref.call(timer)
      batch.timer = timer
    }
    batch.dt.push(now - batch.time0)
    batch.text.push(delta)
    // U0:同一条 delta,**同一份段身份**,发一份给 UI 流(16ms 小批由 coalescer
    // 合)。落盘那份继续按 2s/64 攒 —— 词汇同名同形,只是节奏不同。
    ctx.emitUiEvent?.({
      type: 'assistant/delta',
      runId: part.runId,
      requestIndex: part.requestIndex,
      messageId: part.messageId,
      partIndex,
      kind: part.kind,
      ...(part.toolCallId ? { toolCallId: part.toolCallId } : {}),
      ...(part.toolName ? { toolName: part.toolName } : {}),
      turnIndex: part.turnIndex,
      text: delta,
    })
    // 64 条闸。
    if (batch.text.length >= SESSION_CHUNK_BATCH_SIZE) flushBatch(partIndex)
  }

  /** part 边界闸:先把批落了,再记这一段的 len/hash。 */
  function endPart(partIndex: number | undefined): void {
    if (partIndex === undefined) return
    flushBatch(partIndex)
    const part = state.openParts.get(partIndex)
    if (!part) return
    state.openParts.delete(partIndex)
    // F13:**账不能先记后丢**。从前 `finishedParts.push` 排在 `if (!id) return`
    // 之前,于是写不出去的那一段仍然进了 `request/response.parts` 的指纹表 ——
    // 一份说"有这一段"的账,配一条根本不存在的 part。
    const id = part.runId || runId()
    if (!id) {
      countSessionEventDroppedPart(ctx.sessionId)
      return
    }
    const hash = hashSessionEventContent(part.text)
    state.finishedParts.push({ partIndex, kind: part.kind, len: part.text.length, hash })
    appendSessionLogEvent(ctx.sessionId, 'assistant/part-end', {
      runId: id,
      requestIndex: part.requestIndex,
      messageId: part.messageId,
      partIndex,
      kind: part.kind,
      len: part.text.length,
      hash,
      ...(part.toolCallId ? { toolCallId: part.toolCallId } : {}),
      ...(part.toolName ? { toolName: part.toolName } : {}),
      turnIndex: part.turnIndex,
    })
    // U0:边界只判一次 —— UI 流收到的"这一段收齐了"与落盘那条是同一次判定。
    ctx.emitUiEvent?.({
      type: 'assistant/part-end',
      runId: id,
      requestIndex: part.requestIndex,
      messageId: part.messageId,
      partIndex,
      kind: part.kind,
      ...(part.toolCallId ? { toolCallId: part.toolCallId } : {}),
      ...(part.toolName ? { toolName: part.toolName } : {}),
      turnIndex: part.turnIndex,
      len: part.text.length,
      hash,
    })
  }

  function endAllOpenParts(): void {
    applyPartBoundary(state.parts.endAll())
  }

  /**
   * A1(§13.1):`provider-data` 落成**一格 part**,一次到齐。
   *
   * 两件事必须同时做,少一件投影就与事实错位:
   *
   *  1. **先把正在攒的正文/推理段收了**。引擎那边 `appendOrderedPart` 只合并
   *     **相邻**同类,一格 provider-data 夹进去就把前后两段正文切成两格;记录器
   *     若继续往同一个 partIndex 里塞 delta,投影出来就是合并成一段的那一格。
   *  2. **占一个 partIndex**。partIndex 是"这次执行的第几段输出",投影按它排
   *     contentParts —— 不占号,provider-data 与它后面那段正文的先后就没了。
   *
   * 载荷与工具结局同一条 64KB 线(`textOrBlobForEvent`)。
   */
  function recordProviderDataPart(providerData: unknown): void {
    const requestIndex = state.requestIndex
    if (requestIndex === undefined) return
    const id = runId()
    if (!id) return
    let text: string
    try {
      text = JSON.stringify(providerData)
    } catch {
      // 序列化不了的载荷:少一格账,好过一格坏掉的账(与结构化工具结局同款)。
      return
    }
    if (!text) return

    // U0:占号也走同一台状态机 —— 它先把正文/推理两段收了(顺序与从前逐字
    // 相同:先正文后推理),再要一个号。
    const reserved = state.parts.reserve()
    for (const ref of reserved.ended) endPart(ref.partIndex)
    const partIndex = reserved.partIndex
    if (partIndex === undefined) return
    const hash = hashSessionEventContent(text)
    state.finishedParts.push({ partIndex, kind: 'provider-data', len: text.length, hash })
    appendSessionLogEvent(ctx.sessionId, 'assistant/part-end', {
      runId: id,
      requestIndex,
      messageId: ctx.getMessageId(),
      partIndex,
      kind: 'provider-data',
      len: text.length,
      hash,
      turnIndex: state.turnIndex,
      providerData: textOrBlobForEvent(ctx.sessionId, text),
    })
  }

  /** 换 kind 就换段:一段 text 与一段 reasoning 不能共用一个 partIndex。 */
  function deltaInto(kind: 'text' | 'reasoning', delta: string): void {
    const result = applyPartBoundary(state.parts.delta(kind))
    if (!result.current) return
    pushDelta(result.current.partIndex, delta)
  }

  /**
   * 批 P-a(§15.3):这张白名单**就是**事件面的采集口径 —— 新上线的 usage 字段
   * 不加进来,store 有、事件没有,投影当场对不上(providerCostUSD 就是这么漏的)。
   */
  function normalizeUsage(usage: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
    providerCostUSD?: number
  } | undefined): SessionResponseUsage | undefined {
    if (!usage) return undefined
    return {
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      ...(usage.providerCostUSD !== undefined ? { providerCostUSD: usage.providerCostUSD } : {}),
    }
  }

  function handle(event: AgentStreamEvent): void {
    switch (event.type) {
      case 'turn-start': {
        const requestIndex = nextSessionRequestIndex(ctx.sessionId)
        if (requestIndex === undefined) return
        state.requestIndex = requestIndex
        setSessionRunRequestIndex(ctx.sessionId, requestIndex)
        // §13.9:引擎那一行是 `state.turnIndex = options.turn`
        // (`applyAgentLoopTurnStartWithAdapters`)—— 照抄,不按请求数自己数。
        state.turnIndex = event.turn
        state.usageTurnIndex = undefined
        state.firstTokenWritten = false
        state.finishedParts = []
        state.toolCallIds = []
        state.attempt = 0
        state.providerResponseId = undefined
        state.responseModel = undefined
        // 先目录后信封:header 引用的 toolsHash 在日志里一定已经有了对应的
        // request/tools。读侧不依赖这个顺序,但顺序对的日志人也能顺着读。
        const toolsHash = maybeWriteTools(requestIndex)
        maybeWriteHeader(requestIndex, toolsHash)
        writeRecipe(requestIndex, toolsHash)
        appendSessionLogEvent(ctx.sessionId, 'request/start', {
          requestIndex,
          messageId: ctx.getMessageId(),
          ...withRunId(),
        })
        // 语义检查点:调模型之前,这次请求的配方必须已经在盘上(§10.3 ③)。
        void flushSessionEventLog(ctx.sessionId)
        return
      }
      case 'finish': {
        // §13.9:**引擎的回合号在这里动**,而不是在 `turn-start`。
        //
        // 普通 provider 一次请求一条 finish,推进之后紧接着就是 turn-end + 下一条
        // turn-start —— 账本一个字节都不变。外部执行器(Claude Code SDK 连接器)
        // 则在一次请求里发好几条 `finish(tool_calls)` 当轮分界(runner 当场转发),
        // 那才是这一格的产地。
        //
        // 用量归属取**推进之前**那个值:引擎的 `updateStepsUsageByTurn` 排在
        // `state.turnIndex = plan.nextTurnIndex` 之前。
        state.usageTurnIndex = state.turnIndex
        const next = nextAgentLoopTurnIndexAfterFinish(state.turnIndex, event.finishReason)
        if (next !== state.turnIndex) {
          // 引擎在这一刻把这一轮的 part 落到消息上、换一份 turn state
          // (`persistTurnContentParts` + `resetTurn`)—— 于是分界之后的正文是
          // **新的一格** contentPart。记录器照做:不收段的话,分界前后的正文
          // 会折进同一个 partIndex,投影出来就少一格。
          endAllOpenParts()
          state.turnIndex = next
        }
        return
      }
      case 'response-boundary': {
        // steering 打断:当前响应到此为止。part 全部收齐。
        endAllOpenParts()
        // U0(§10.15 的根治):**身份就在这一刻换**。
        //
        // 从前换 run 是执行器那边的事(`createNextAssistantWriter`),而执行器
        // 隔着 agent-loop 的异步事件队列 —— 采集点挂在 `onEvent` 上是同步的,
        // 它看到 boundary 之后的 `turn-start` / 第一批 delta 时,登记簿里往往
        // 还是**上一条** run 与上一条助手消息,于是新响应的开头被记在旧消息上
        // (电池 1/5 复现的那条竞态)。
        //
        // 修法不是时序 hack:事实(boundary)生在这里,身份就该在这里定。宿主
        // 在这个同步点换锚点(新助手消息 + `rotateSessionRun`),执行器退成
        // "消费已经盖过章的事件"。
        ctx.onResponseBoundary?.()
        return
      }
      case 'text-delta':
      case 'reasoning-delta': {
        if (!event.delta) return
        if (state.requestIndex === undefined) return
        if (!state.firstTokenWritten) {
          state.firstTokenWritten = true
          appendSessionLogEvent(ctx.sessionId, 'assistant/first-token', {
            requestIndex: state.requestIndex,
            messageId: ctx.getMessageId(),
            ...withRunId(),
          })
        }
        deltaInto(event.type === 'text-delta' ? 'text' : 'reasoning', event.delta)
        return
      }
      case 'tool-call-start': {
        applyPartBoundary(state.parts.toolInputStart(event.toolCallId, event.toolName))
        return
      }
      case 'tool-call-delta': {
        const current = state.parts.toolInputDelta(event.toolCallId).current
        if (current) pushDelta(current.partIndex, event.argumentsDelta)
        return
      }
      case 'tool-call-done': {
        // 参数流**先**收齐(part-end),`tool/call` 才落账 —— 铁律 2 的顺序:
        // 记的是"参数定稿了,还没执行"。
        applyPartBoundary(state.parts.toolInputDone(event.toolCall.id))
        // S3.1(§10.11):`skill/activated` **不在这里认**。记录器认一遍、引擎再认
        // 一遍 = 两个判定点,真机上就出现过"账本有 skill/activated 而消息上没有
        // skillUsed"。现在唯一的判定点在引擎(`startAgentLoopToolExecution` /
        // `executeCoreToolAndUpdate`),这条事件由那一次宣告经 emitter 落账
        // (`app/events/event-only-emitter.ts`)—— 记录器只记引擎宣告过的事。
        // A6+A7:归一后的身份与原始名并列记账。参数解析用的是 agent-loop 自己
        // 那一个函数(`safeParseAgentToolArguments`)—— 引擎解析出来的 args 正是
        // 它的产物,而 `findMCPToolIdByShortName` 会看参数。
        const resolved = ctx.resolveToolIdentity?.(
          event.toolCall.name,
          safeParseAgentToolArguments(event.toolCall.arguments),
        )
        // A11:引擎藏起来的调用在账本上带一格 `hidden` —— 投影据此不产出
        // toolCalls/steps(轨迹与审计照旧看得见)。答不上来 = 可见。
        const hidden = ctx.isToolCallHidden?.(event.toolCall.id) === true
        const seq = appendSessionLogEvent(ctx.sessionId, 'tool/call', {
          callId: event.toolCall.id,
          name: event.toolCall.name,
          ...(hidden ? { hidden: true } : {}),
          ...(resolved ? { resolvedToolId: resolved.toolId, displayName: resolved.displayName } : {}),
          argumentsRaw: event.toolCall.arguments,
          messageId: ctx.getMessageId(),
          // §13.9:引擎给 step 盖的回合号就是这一格(`tool-execution.ts` 的
          // `turnIndex: state.turnIndex`)。投影从前按"这条 run 跑过几次请求"推。
          turnIndex: state.turnIndex,
          ...withRunId(),
        })
        if (seq !== undefined) state.callSeqByCallId.set(event.toolCall.id, seq)
        state.toolCallIds.push(event.toolCall.id)
        // 语义检查点:调工具之前(§10.3 ③)。
        void flushSessionEventLog(ctx.sessionId)
        return
      }
      case 'tool-metadata': {
        // 工具自报的标题(`annotate{title}`)。引擎拿它**当场**盖掉 step 标题
        // (`applyAgentLoopToolMetadata`),而结局对象里只有成功时才抄了一份 ——
        // 失败的调用没有结局对象,标题就只剩这一条路能记下来(§10.12 第 6 类)。
        const title = event.update.title
        if (typeof title === 'string' && title) {
          state.reportedTitleByCallId.set(event.toolCall.id, title)
        }
        // §13.17:edit/write 的结构化 diff 就藏在这条 metadata 里(diff/diffHunks/
        // path/…),结局正文不带。抄引擎写消息的**同一把**判定点折出,记进表,
        // `tool/result` 落账时附上。最后一条带 diff 的 metadata 覆盖前一条。
        const changes = changesFromToolMetadata(event.update.metadata)
        if (changes) state.changesByCallId.set(event.toolCall.id, changes)
        return
      }
      case 'provider-data': {
        // provider 自报的响应身份。名字各家不同,认得的就记,认不得的不猜。
        const data = event.providerData as Record<string, unknown>
        const responseId = data.responseId ?? data.id
        if (typeof responseId === 'string') state.providerResponseId = responseId
        if (typeof data.model === 'string') state.responseModel = data.model
        // A1:这一条在**消息上**留下哪一格,由引擎与采集点共用的那张表说了算
        // (`planOnethingProviderDataPart`)—— 记录器不自己判第二遍。
        // `'text'`(codex 内联生图)那一支的正文是引擎合成的,由宿主经
        // `recordSynthesizedText` 回传,不在这里凭空造。
        if (planOnethingProviderDataPart(event.providerData) === 'provider-data') {
          recordProviderDataPart(event.providerData)
        }
        return
      }
      case 'auto-retry': {
        state.attempt = event.attempt
        const id = runId()
        if (!id || state.requestIndex === undefined) return
        appendSessionLogEvent(ctx.sessionId, 'request/error', {
          runId: id,
          requestIndex: state.requestIndex,
          error: { message: event.error },
          willRetry: true,
          attempt: event.attempt,
        })
        return
      }
      case 'tool-result': {
        const isError = Boolean(event.result.error)
        const preview = event.result.error ?? event.result.content ?? ''
        const sourceSeq = state.callSeqByCallId.get(event.toolCall.id)
        state.callSeqByCallId.delete(event.toolCall.id)
        const reportedTitle = state.reportedTitleByCallId.get(event.toolCall.id)
        state.reportedTitleByCallId.delete(event.toolCall.id)
        const changes = state.changesByCallId.get(event.toolCall.id)
        state.changesByCallId.delete(event.toolCall.id)
        appendSessionLogEvent(ctx.sessionId, 'tool/result', {
          callId: event.toolCall.id,
          isError,
          // 预览**保留**:老文件只有它,轨迹面板也只读它。
          resultPreview: truncateSessionEventPreview(preview),
          // 正文补上:64KB 以内进事件行,超过走 blob(§9.1)。
          result: textOrBlobForEvent(ctx.sessionId, preview),
          // S1b:**结构化**结局(`ToolCall.result` 的正身)。工具卡渲染的是它,
          // 只记正文的话 S2 切读之后每张卡都退化成一段纯文本(diff hunks、
          // 退出码、文件路径全在 metadata 里)。**成功**时字符串结局不写 ——
          // 那时它与上面那一格是同一个东西;失败时两者不是同一个东西(见函数注释)。
          // 取的是引擎那一行的**同一个表达式**:`toJsonValue(result.data ?? result.content)`
          // (`settleAgentLoopToolResult`)。只记 `data` 的话,一次 `data` 缺席、
          // `content` 是空串的失败(参数 JSON 断在半路)在账上就少一格 `result`。
          ...structuredResultForEvent(ctx.sessionId, event.result.data ?? event.result.content, isError),
          // §13.17:edit/write 的结构化 diff。resultData 里派生不出 hunks —— 它们
          // 只活在 tool-metadata,这里是独立采集的一格。
          ...changesForEvent(ctx.sessionId, changes),
          // 工具自报的标题:引擎的 step 标题就是它。成功时它同时在
          // `resultData.title` 里,失败时那里没有 —— 所以这一格是独立的一份账。
          ...(reportedTitle ? { reportedTitle } : {}),
          ...(sourceSeq !== undefined ? { sourceSeq } : {}),
          ...withRunId(),
        })
        return
      }
      case 'turn-end': {
        if (state.requestIndex === undefined) return
        // 请求结束闸:所有还开着的 part 收齐,所有攒着的批落盘。
        endAllOpenParts()
        const usage = normalizeUsage(event.usage)
        const id = runId()
        if (id) {
          appendSessionLogEvent(ctx.sessionId, 'request/response', {
            runId: id,
            requestIndex: state.requestIndex,
            messageId: ctx.getMessageId(),
            ...(state.providerResponseId ? { providerResponseId: state.providerResponseId } : {}),
            ...(state.responseModel ? { responseModel: state.responseModel } : {}),
            ...(event.finishReason ? { finishReason: event.finishReason } : {}),
            ...(usage ? { usage } : {}),
            // §13.9:这份 usage 被引擎记到哪个回合的 step 上 —— 带 usage 的那条
            // finish **推进之前**的回合号。没有 usage 就没有归属可言,不写。
            ...(usage ? { usageTurnIndex: state.usageTurnIndex ?? state.turnIndex } : {}),
            ...(state.finishedParts.length > 0 ? { parts: [...state.finishedParts] } : {}),
            ...(state.toolCallIds.length > 0 ? { toolCallIds: [...state.toolCallIds] } : {}),
          })
        }
        appendSessionLogEvent(ctx.sessionId, 'request/end', {
          requestIndex: state.requestIndex,
          ...(event.finishReason ? { stopReason: event.finishReason } : {}),
          ...(event.usage
            ? {
                usage: {
                  ...(event.usage.inputTokens !== undefined ? { inputTokens: event.usage.inputTokens } : {}),
                  ...(event.usage.outputTokens !== undefined ? { outputTokens: event.usage.outputTokens } : {}),
                  ...(event.usage.cacheReadTokens !== undefined
                    ? { cacheReadTokens: event.usage.cacheReadTokens }
                    : {}),
                  ...(event.usage.cacheWriteTokens !== undefined
                    ? { cacheWriteTokens: event.usage.cacheWriteTokens }
                    : {}),
                },
              }
            : {}),
          ...withRunId(),
        })
        // 语义检查点:响应收齐(§10.3 ③)。
        void flushSessionEventLog(ctx.sessionId)
        return
      }
      default:
        return
    }
  }

  return {
    handle(event) {
      try {
        handle(event)
      } catch (error) {
        // 记账绝不打断聊天。
        log.warn('event recorder failed', { sessionId: ctx.sessionId }, error)
      }
    },
    recordRequestError(error) {
      try {
        endAllOpenParts()
        const id = runId()
        if (!id || state.requestIndex === undefined) return
        const normalized = error instanceof Error
          ? {
              ...(error.name ? { name: error.name } : {}),
              message: error.message,
              ...(typeof (error as unknown as { status?: unknown }).status === 'number'
                ? { status: (error as unknown as { status: number }).status }
                : {}),
            }
          : { message: String(error) }
        appendSessionLogEvent(ctx.sessionId, 'request/error', {
          runId: id,
          requestIndex: state.requestIndex,
          error: normalized,
          willRetry: false,
          attempt: state.attempt,
        })
      } catch (cause) {
        log.warn('event recorder error record failed', { sessionId: ctx.sessionId }, cause)
      }
    },
    recordSynthesizedText(text) {
      try {
        if (!text) return
        if (state.requestIndex === undefined) return
        deltaInto('text', text)
      } catch (error) {
        log.warn('event recorder synthesized text failed', { sessionId: ctx.sessionId }, error)
      }
    },
    recordCancelledToolResults(calls) {
      let written = 0
      try {
        for (const call of calls) {
          // 已经报过结局的调用不在这张表里 —— 一次都不会被重写。
          const sourceSeq = state.callSeqByCallId.get(call.callId)
          if (sourceSeq === undefined) continue
          state.callSeqByCallId.delete(call.callId)
          // 标题与正常那条路同源(工具自报的最后一条 `annotate{title}`)。
          const reportedTitle = state.reportedTitleByCallId.get(call.callId)
          state.reportedTitleByCallId.delete(call.callId)
          // §13.17:收场前若 edit 已产出 diff metadata,引擎在 step 上仍留着
          // changes —— 与它同源地记下这一格,清表防泄漏。
          const changes = state.changesByCallId.get(call.callId)
          state.changesByCallId.delete(call.callId)
          const text = call.result ?? ''
          appendSessionLogEvent(ctx.sessionId, 'tool/result', {
            callId: call.callId,
            // 收场判死不是"工具失败":引擎写的是 `cancelled`,那句收场话由 run
            // 的收场方式派生(投影的 `lingeringToolError`),不是工具报的错。
            isError: false,
            cancelled: true,
            resultPreview: truncateSessionEventPreview(text),
            ...(text ? { result: textOrBlobForEvent(ctx.sessionId, text) } : {}),
            ...changesForEvent(ctx.sessionId, changes),
            ...(reportedTitle ? { reportedTitle } : {}),
            sourceSeq,
            ...withRunId(),
          })
          written += 1
        }
      } catch (error) {
        log.warn('event recorder cancelled tool result record failed', { sessionId: ctx.sessionId }, error)
      }
      return written
    },
    flush() {
      try {
        endAllOpenParts()
        flushAllBatches()
      } catch (error) {
        log.warn('event recorder flush failed', { sessionId: ctx.sessionId }, error)
      }
    },
  }
}

/**
 * 把记录器接到一份 agent-loop runtime 上。
 *
 * 返回 `{ runtime, recorder }`:执行器需要 recorder 本体才能在**错误与收尾**
 * 两条路上记账(那两条路不经过 `onEvent`)。已有的 onEvent 原样保留并在记账
 * 之后调用。
 */
export function attachSessionEventRecorder(
  runtime: AgentLoopOptions,
  ctx: Omit<SessionEventRecorderContext, 'tools'> & { tools?: readonly AgentTool[] },
): { runtime: AgentLoopOptions; recorder: SessionEventRecorder } {
  // runner 会先按 toolPolicy 过滤工具目录;policy 关掉时模型看到的是空目录,
  // header 就该照实记空 —— 记录"当时模型看到的世界",不记装配时的意图。
  const tools = runtime.toolPolicy?.enabled === false
    ? []
    : (ctx.tools ?? runtime.tools)
  const recorder = createSessionEventRecorder({ ...ctx, tools })
  const existing = runtime.onEvent
  return {
    recorder,
    runtime: {
      ...runtime,
      onEvent(event) {
        recorder.handle(event)
        existing?.(event)
      },
    },
  }
}
