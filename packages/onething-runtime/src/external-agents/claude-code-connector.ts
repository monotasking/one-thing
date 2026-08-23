import type {
  AgentReasoningEffort,
  AgentToolCall,
  AgentToolResult,
  AgentTurnStreamEvent,
  AgentUsage,
} from '@onething/core/agent-loop'
import { createTwoFilesPatch } from 'diff'
import { findAgentExecutorDescriptor } from '../agents/executor/capabilities.js'
import { anthropicUsageBuckets } from '../agent-loop/providers/wires/anthropic-usage.js'
import { onethingClaudeModelFamily } from '../providers/model-capability.js'
import { countLineChanges } from '../tools/file-snapshot.js'
import { trimDiff, truncateDiffForDisplay } from '../tools/replacers.js'
import {
  isHostMcpToolName,
  stripHostMcpToolPrefix,
  type HostMcpSurfaceResolver,
} from './host-mcp/index.js'
import type {
  ExternalAgentCapabilities,
  ExternalAgentConnector,
  ExternalAgentEvent,
  ExternalAgentImageInput,
  ExternalAgentInteractionHandler,
  ExternalAgentObserver,
  ExternalAgentPermissionHandler,
  ExternalAgentSessionLink,
  ExternalAgentSteerOutcome,
  ExternalAgentTurnRequest,
} from './types.js'
import type { InteractionAnswer, InteractionQuestion } from '@onething/core/interaction'

export const CLAUDE_CODE_AGENT_CONNECTOR_ID = 'claude-code-agent'

/**
 * Structural subsets of the Claude Agent SDK message stream
 * (@anthropic-ai/claude-agent-sdk SDKMessage). Kept structural so tests can
 * replay fixtures and the SDK stays a soft dependency of this module.
 */
interface SdkStreamEventDelta {
  type: string
  text?: string
  thinking?: string
  partial_json?: string
}

interface SdkContentBlock {
  type: string
  id?: string
  name?: string
  input?: unknown
  text?: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

export interface ClaudeCodeSdkMessage {
  type: string
  subtype?: string
  session_id?: string
  parent_tool_use_id?: string | null
  event?: {
    type: string
    index?: number
    content_block?: SdkContentBlock
    delta?: SdkStreamEventDelta
  }
  message?: {
    role?: string
    content?: SdkContentBlock[] | string
  }
  result?: string
  is_error?: boolean
  /**
   * `SDKPermissionDeniedMessage`(`sdk.d.ts:4113-4137`)独有的几位。它是
   * `type:'system'` 的一个 subtype,与上面那些字段住在同一条消息类型上。
   *
   * 注意它的**拒绝原文写在 `message` 字段里,而那是一个 string** —— 与助手/用户
   * 消息上的 `message: { role, content }` 同名不同型。两者不合并:合成一个联合类型
   * 会把所有 `message.content` 的读点都变成带守卫的分支,而它们要读的从来只有对象
   * 那一支。这一位在 `permissionDeniedNotice` 里就地取,只在那一处。
   */
  tool_name?: string
  tool_use_id?: string
  decision_reason?: string
  decision_reason_type?: string
  num_turns?: number
  total_cost_usd?: number
  /**
   * `SDKBackgroundTasksChangedMessage`(`sdk.d.ts:2880`)的载荷:变更之后**全部**
   * 存活的后台任务。d.ts 原话是它「a level signal, unlike the task_started/
   * task_notification edge bookends」,并明写只需要「is background work running」
   * 的消费者应当**整表替换**而不是配对 edge —— 漏掉一只 bookend 不会卡住状态。
   * 我们要的正是这一个判据,所以读的是它,不是 task_started/task_notification。
   */
  tasks?: { task_id?: string; task_type?: string; description?: string }[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

/**
 * 一条流式输入用户消息里的内容块。
 *
 * `SDKUserMessage.message` 的类型是 `@anthropic-ai/sdk` 的 `MessageParam`
 * (`sdk.d.ts:8` 的 import),也就是 **Messages API 原封不动的那套 content block**
 * —— text 与 image 的形状因此与直连 API 逐字相同,`agent-loop/providers/claude.ts`
 * 的 `ClaudeImageBlock` 就是同一个东西。
 *
 * 实测(2026-08-12,真 CLI + 真 `sdk.query()`):流式输入里的 image block 确实进到
 * 模型眼里 —— 一张画着字母 K 的 320×320 PNG,模型答 `LETTER=K`。所以这条路是通的,
 * 不需要退到「诚实地说送不到」那一档。
 */
export type ClaudeCodeSdkUserContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source:
        | { type: 'base64'; media_type: string; data: string }
        | { type: 'url'; url: string }
    }

/**
 * SDK 的 `SDKUserMessage`(`sdk.d.ts:4521`)里我们真正要写的那几位。保持结构化,
 * 与 `ClaudeCodeSdkMessage` 同一条纪律:SDK 仍是这个模块的软依赖。
 */
export interface ClaudeCodeSdkUserMessage {
  type: 'user'
  session_id: string
  parent_tool_use_id: null
  message: { role: 'user'; content: ClaudeCodeSdkUserContentBlock[] }
  /**
   * 中途追话的**投递档位**(`SDKUserMessage.priority`,`sdk.d.ts:4530`)。
   *
   * d.ts 只给了三个字面量、一个字的说明都没有,所以下面这三行是**实测**结论
   * (2026-08-12,真 CLI 2.1.227 + haiku,脚本与逐条时间线见交付报告):
   *
   *  - **缺席 / `'next'`** —— 排队。当前这一轮跑完(60 行数字整段发完、`result`
   *    到达)之后才起新的一轮回答它。这是 CLI 交互 REPL 里「跑着的时候打字」
   *    的同款语义。
   *  - **`'now'`** —— **就地截断**。实测注入后 13ms 当前轮就以
   *    `subtype:'success'` 收场(已生成的正文原样保留、不是错误收场、没有
   *    `[Request interrupted by user]` 那条合成消息),1.2~1.4s 后新的一轮开口
   *    回答追话。这才是「插得进话」。
   *
   * **一个真实的坑**:`'now'` 在当前轮**还没吐出第一个 token 时**注入,追话会被
   * 吞掉 —— 实测那一次当前轮以 `error_during_execution` 收场,随后重跑的是**原来
   * 那条 prompt**,追话一个字都没被回答。所以 `steer()` 要等这一轮真的开口了才用
   * `'now'`,没开口就退回排队档(见 `ActiveClaudeCodeTurn.sawOutput`)。
   */
  priority?: 'now' | 'next' | 'later'
}

/* ── 图片(2026-08-12,审计「图片静默丢弃」) ─────────────────────────────── */

/**
 * 单轮张数上限。
 *
 * 取 20 而不是 API 文档那个更宽的上限:一条聊天消息挂二十张以上图片已经不是「发图」
 * 而是「灌库」,而每一张都要经 stdin 的一行 JSON 进 CLI。超出的部分**如实截并说明**,
 * 不静默丢 —— 这条上限存在的意义就是让「没送到」有一句话可说。
 */
export const CLAUDE_CODE_MAX_IMAGES_PER_TURN = 20

/**
 * 单张原始字节上限(5 MiB)。这是 Anthropic API 自己对单张图片的上限:再大是一个
 * 400,而 400 会把**整轮**打掉,用户拿到的是一次不知所以的失败。宁可少送一张并写清
 * 为什么,也不要用一张超限图换掉整个回合。
 */
export const CLAUDE_CODE_MAX_IMAGE_BYTES = 5 * 1024 * 1024

/**
 * 单轮图片总量上限(20 MiB 原始字节 ≈ 26.7 MB base64)。API 的整请求上限是 32 MB,
 * 而上游草稿允许 32 MB 附件 —— 不设这一道,一次合法的草稿就能把请求撑爆。
 */
export const CLAUDE_CODE_MAX_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024

/**
 * API 认得的四种图片类型。别的类型(heic / bmp / tiff …)送上去是一个 400,
 * 与超限同理:整轮打掉 vs 一句人话,选后者。
 */
const CLAUDE_CODE_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

function parseImageDataUrl(value: string): { mediaType: string; data: string } | undefined {
  const match = value.match(/^data:([^;,]+);base64,(.*)$/)
  return match ? { mediaType: match[1], data: match[2] } : undefined
}

/** base64 长度 → 解码后字节数。不解码 —— 量一张图不值得在内存里再复制一份。 */
function base64DecodedBytes(data: string): number {
  const clean = data.replace(/\s/g, '')
  if (!clean) return 0
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding)
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 没送出去的图片要说的**人话**。它同时走两条路:进用户消息的文本块(模型据此知道
 * 自己没拿到全部图片,不会凭空描述一张不存在的图),和一条 `text-delta`(用户据此
 * 知道自己发的图去哪了)。同一句话,两个收信人 —— 这正是「绝不静默」的具体形状。
 */
export function claudeCodeImageDropNotice(dropped: string[], accepted: number): string {
  return `⚠️ 本轮有 ${dropped.length} 张图片未送达:${dropped.join('、')}。`
    + (accepted > 0
      ? `其余 ${accepted} 张已随这条消息送达。`
      : '本轮仅文本生效。')
}

/**
 * 一轮的用户消息内容:文本块 + 图片块。
 *
 * 纪律三条:
 *
 *  1. **无图的回合形状逐字不变** —— `[{ type:'text', text }]`,连空文本都保持原样,
 *     否则这次改动会顺手动到每一个不发图的普通回合;
 *  2. 文本在前、图片在后(实测这个次序模型读得到,见类型说明);
 *  3. 任何一张没进去的图都进 `notice`,一张都不许悄悄消失。
 */
export function claudeCodePromptContent(
  text: string,
  images: ExternalAgentImageInput[] = [],
): { blocks: ClaudeCodeSdkUserContentBlock[]; notice?: string } {
  const blocks: ClaudeCodeSdkUserContentBlock[] = []
  const dropped: string[] = []
  let totalBytes = 0
  let accepted = 0

  images.forEach((entry, index) => {
    const label = `第 ${index + 1} 张`
    const raw = entry.image?.trim()
    if (!raw) {
      dropped.push(`${label}(数据为空)`)
      return
    }
    if (accepted >= CLAUDE_CODE_MAX_IMAGES_PER_TURN) {
      dropped.push(`${label}(超过单轮 ${CLAUDE_CODE_MAX_IMAGES_PER_TURN} 张上限)`)
      return
    }
    // 远端 URL:交给 API 自己去取,与原生 claude provider 同款口径(它也不下载)。
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      blocks.push({ type: 'image', source: { type: 'url', url: raw } })
      accepted += 1
      return
    }
    const parsed = parseImageDataUrl(raw)
    const mediaType = (parsed?.mediaType ?? entry.mediaType ?? 'image/png')
      .split(';')[0].trim().toLowerCase()
    const data = parsed?.data ?? raw
    if (!CLAUDE_CODE_IMAGE_MEDIA_TYPES.includes(mediaType)) {
      dropped.push(`${label}(格式 ${mediaType} 不受支持)`)
      return
    }
    const bytes = base64DecodedBytes(data)
    if (bytes > CLAUDE_CODE_MAX_IMAGE_BYTES) {
      dropped.push(
        `${label}(${formatMegabytes(bytes)},超过单张 ${formatMegabytes(CLAUDE_CODE_MAX_IMAGE_BYTES)} 上限)`,
      )
      return
    }
    if (totalBytes + bytes > CLAUDE_CODE_MAX_IMAGE_TOTAL_BYTES) {
      dropped.push(
        `${label}(本轮图片总量超过 ${formatMegabytes(CLAUDE_CODE_MAX_IMAGE_TOTAL_BYTES)} 上限)`,
      )
      return
    }
    totalBytes += bytes
    accepted += 1
    blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } })
  })

  const notice = dropped.length > 0 ? claudeCodeImageDropNotice(dropped, accepted) : undefined
  const body = notice ? (text ? `${text}\n\n${notice}` : notice) : text
  // `blocks.length === 0` 那一支就是「无图回合」:文本块照发,空文本也照发。
  if (body || blocks.length === 0) blocks.unshift({ type: 'text', text: body })
  return { blocks, ...(notice ? { notice } : {}) }
}

/**
 * **一轮的输入迭代器**(2026-08-11 后台子代理审批事故)。
 *
 * 把 prompt 交给 `sdk.query()` 有两种形状,而它们决定的不是「怎么传字符串」,是
 * **控制通道的寿命**:
 *
 *  - **字符串** → SDK 记下 `isSingleUserTurn = typeof prompt === 'string'`
 *    (`sdk.mjs`,`Xkt`),于是 `Query.readMessages` 在**第一条 `result` 到达时就
 *    `transport.endInput()`** —— CLI 的 stdin 被关掉。stdin 不只是「输入」,它是
 *    `canUseTool` 的控制通道:CLI 侧 `sendRequest` 在 `inputClosed` 时抛
 *    `Stream closed`,审批请求被就地包成
 *    `Tool permission request failed: AbortError: Stream closed` 并 **deny**。
 *  - **AsyncIterable** → `isSingleUserTurn` 为假,那条 endInput 不发;改由
 *    `Query.streamInput` 在**迭代器耗尽之后**收口(源码:遍历完 → 若有双向需求
 *    则 `waitForFirstResult()` → `endInput()`)。
 *
 * 后台子代理(`Agent` 工具的 `run_in_background`,**SDK 默认就是 true**)恰恰在主
 * `result` **之后**才去碰需要审批的工具。所以单轮形状下它的每一次审批都必然撞上
 * 一条已经关掉的通道 —— 不是偶发,是必然。
 *
 * 于是输入迭代器在这里被**握在手里**:发出唯一一条用户消息后挂起,由连接器按
 * 「未决后台任务归零」的判据决定何时 `close()`。零后台的普通回合在 result 当场
 * 关闭,`waitForFirstResult()` 立即返回(result 已到),时序与字符串形状逐毫秒
 * 相同 —— 这不是「多等一会儿换来的安全」,是**只在真有后台任务时才多等**。
 */
export class ClaudeCodePromptStream {
  private readonly queue: ClaudeCodeSdkUserMessage[] = []
  private wake: (() => void) | undefined
  private closed = false

  /**
   * 收的是**内容块数组**而不是一段文本(2026-08-12):图片与文本是同一条消息里并列
   * 的两种块,由 `claudeCodePromptContent` 一次算好。这里只负责把它发出去再挂起。
   */
  constructor(content: ClaudeCodeSdkUserContentBlock[]) {
    this.queue.push(promptMessage(content))
  }

  /**
   * **中途再塞一条用户消息**(2026-08-12 steering)。
   *
   * 通道一直是开着的 —— 这是 b8472769 为了后台子代理的审批留下的形状,追话只是
   * 第二个用得上它的人,机械上一行新东西都不需要。返回值是**送没送出去**:
   * 迭代器已经收口(回合正在收尾 / 被 abort)之后再塞就是塞进一个没人读的队列,
   * 那种时候必须说"没送到",不能假装送到了。
   */
  push(content: ClaudeCodeSdkUserContentBlock[], priority?: 'now' | 'next' | 'later'): boolean {
    if (this.closed) return false
    this.queue.push(promptMessage(content, priority))
    // `wake` 是"迭代器正挂着等下一条"的凭据;它没挂着说明队列还没被抽干,
    // 下一次抽干时自然会带上这一条。
    const wake = this.wake
    this.wake = undefined
    wake?.()
    return true
  }

  /** 幂等。abort / 超时 / 正常收口三条路都可能调它,谁先到都算数。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  get isClosed(): boolean {
    return this.closed
  }

  /**
   * 先把队列抽干,再挂起等下一条或等收口。
   *
   * 与改动前的「发一条然后 await 一个 gate」在**无追话的回合里逐字等价**:队列里
   * 只有那一条,发完就挂在同一个位置,`close()` 放开。追话只是在那个挂起点上多
   * 醒来一次。
   */
  async *stream(): AsyncGenerator<ClaudeCodeSdkUserMessage, void, void> {
    for (;;) {
      while (this.queue.length > 0) yield this.queue.shift()!
      if (this.closed) return
      await new Promise<void>(resolve => { this.wake = resolve })
    }
  }
}

function promptMessage(
  content: ClaudeCodeSdkUserContentBlock[],
  priority?: 'now' | 'next' | 'later',
): ClaudeCodeSdkUserMessage {
  return {
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    message: { role: 'user', content },
    ...(priority ? { priority } : {}),
  }
}

export interface ClaudeCodeQueryOptions {
  cwd?: string
  model?: string
  resume?: string
  pathToClaudeCodeExecutable?: string
  includePartialMessages?: boolean
  permissionMode?: string
  env?: Record<string, string | undefined>
  /**
   * SDK 的 `ThinkingConfig`(`sdk.d.ts` 的 `ThinkingAdaptive`/`ThinkingEnabled`/
   * `ThinkingDisabled`)。`display` 不是装饰:缺省时 SDK 走 redacted,
   * `thinking_delta` 只有事件没有正文,思考面板因此永远是空的。
   */
  thinking?:
    | { type: 'adaptive'; display?: 'summarized' | 'omitted' }
    | { type: 'enabled'; budgetTokens: number; display?: 'summarized' | 'omitted' }
    | { type: 'disabled' }
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  abortController?: AbortController
  /**
   * 进程内 MCP 服务器(E3 宿主工具面)。键是服务器名,值是
   * `{ type: 'sdk', name, instance }`(SDK 的 `McpSdkServerConfigWithInstance`)。
   * 结构保持宽松,SDK 因此仍是这个模块的软依赖。
   */
  mcpServers?: Record<string, unknown>
  /**
   * SDK 的 `systemPrompt`(`sdk.d.ts:1990`)。三种形状里我们用 preset+append:
   * 换成裸字符串会把 Claude Code 自己那份操作说明(Read/Write/Bash 怎么用)
   * 整个替掉,persona 到位了工具却不会用了。
   */
  systemPrompt?: string | string[] | {
    type: 'preset'
    preset: 'claude_code'
    append?: string
    excludeDynamicSections?: boolean
  }
  /**
   * SDK 的 `settingSources`(`sdk.d.ts:1873-1883`,取值 `SettingSource =
   * 'user' | 'project' | 'local'`,见 `sdk.d.ts:6541`)。三者是**三个并列的源**:
   * `~/.claude/settings.json` / `<cwd>/.claude/settings.json` /
   * `<cwd>/.claude/settings.local.json` —— 'project' 不含 local。
   * 缺席 = 全加载(CLI 默认),`[]` = 一份文件系统设置都不读。
   */
  settingSources?: ('user' | 'project' | 'local')[]
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    /** SDK 的 options 还有 suggestions/title/requestId 等;这里只取用得上的。 */
    options: { signal: AbortSignal; toolUseID?: string },
  ) => Promise<
    | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  >
  /**
   * `request_user_dialog` 的宿主渲染回调(`sdk.d.ts:1287-1289`)。
   * 结果只有两种形状:`{behavior:'completed', result}` 与 `{behavior:'cancelled'}`,
   * 后者是「答不上来」的**规定答法**(CLI 转而执行该 dialog 的默认行为)。
   */
  onUserDialog?: (
    request: { dialogKind: string; payload: Record<string, unknown>; toolUseID?: string },
    options: { signal: AbortSignal },
  ) => Promise<{ behavior: 'completed'; result: unknown } | { behavior: 'cancelled' }>
  /**
   * 我们真能画出来的 dialog kinds(`sdk.d.ts:1551` / `3405`,注意名字是
   * `supportedDialogKinds`,不是方案里写的 `userDialogKinds`)。
   *
   * **缺席 = 不能显示,CLI 就地失败关闭** —— 只给 `onUserDialog` 而不声明这张表,
   * 一个 dialog 都不会发过来。这正是今天那一半静默。
   */
  supportedDialogKinds?: string[]
}

/**
 * `prompt` 是**迭代器**而不是字符串 —— 理由整段写在 `ClaudeCodePromptStream` 上
 * (控制通道的寿命由它决定)。`promptText` 并列带上原文:诊断与 fixture 测试要断言
 * 「这一轮问了什么」,而把迭代器抽干一次就没了,那是把断言变成副作用。
 */
export type ClaudeCodeQueryFn = (params: {
  prompt: AsyncIterable<ClaudeCodeSdkUserMessage>
  promptText: string
  options: ClaudeCodeQueryOptions
}) => AsyncIterable<ClaudeCodeSdkMessage>

export interface ClaudeCodeConnectorOptions {
  /** Absolute path to the locally installed claude executable. */
  executablePath?: string
  permissionHandler?: ExternalAgentPermissionHandler
  /**
   * 提问落点(E4,§4)。**不装 = 没有落点**:`AskUserQuestion` 与 `onUserDialog`
   * 都退回「当场拒绝 / cancelled」,而不是挂着等一个不会来的答案。
   */
  interactionHandler?: ExternalAgentInteractionHandler
  /**
   * 覆盖 `supportedDialogKinds`。给空数组 = 一个 dialog 都不接(退回 E4 之前的
   * 形状:CLI 走每个 dialog 的默认行为)。装配层因此不必改代码就能关掉这条路。
   */
  userDialogKinds?: string[]
  /**
   * The SDK's query(); injectable for fixture-replay tests. Default lazily
   * imports @anthropic-ai/claude-agent-sdk.
   */
  queryFn?: ClaudeCodeQueryFn
  now?: () => number
  logger?: Pick<Console, 'log' | 'warn'>
  /**
   * Environment for the spawned CLI, resolved per turn. Hosts use this to
   * inject the app's proxy settings — a GUI-launched app has no shell proxy
   * env, and a direct connection gets region-blocked by the API (403
   * "Request not allowed").
   */
  resolveSpawnEnv?: () => Record<string, string | undefined> | undefined
  /**
   * 宿主工具面(E3,§2)。装配层实现它 —— 它认识 store、工具注册表、v3 回合登记簿,
   * 而这个模块一个都不该认识。
   *
   * **不装 = 不注入**,与 E3 之前逐字同形:外部 agent 只有 SDK 自带的工具,发言
   * 靠收养兜底。装上之后协作工具经进程内 MCP 进去,发言权回到房间。
   */
  hostToolSurface?: HostMcpSurfaceResolver
  /**
   * 观测口(E6,§6)。**不装 = 不记账**,外部回合在调度时间轴上退回 E6 之前的
   * 那一片空白 —— 不影响这一轮跑不跑得成。
   */
  observer?: ExternalAgentObserver
  /**
   * 主 result 之后**为后台任务多等**的墙钟上限(默认 10 分钟)。
   *
   * 这是一道**防呆**,不是调度策略:判据(`background_tasks_changed` 的整表替换)
   * 万一在某个 CLI 版本上不再发、或发漏了归零的那一条,回合就会永远挂着 —— 挂起
   * 是这套系统里最坏的收场(用户看到的是一个永远转圈的会话,连「失败了」都不知道)。
   * 超时到点时如实发一条可见正文再收口,与失败 result 同一个先例:能上屏的只有正文。
   *
   * abort 不受它管辖 —— 用户按停止永远即时生效。
   */
  backgroundTaskTimeoutMs?: number
}

/** 见 `backgroundTaskTimeoutMs`。 */
export const DEFAULT_BACKGROUND_TASK_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 后台任务等超时后的**人话**。用户看到的必须是「为什么这一轮就这么结束了」,
 * 而不是一段无声的中断。
 */
export function claudeCodeBackgroundTimeoutNotice(taskCount: number, timeoutMs: number): string {
  const minutes = Math.round(timeoutMs / 60000)
  return `\n\n⚠️ 后台子代理已运行超过 ${minutes} 分钟仍未收工(还有 ${taskCount} 个未决任务),`
    + '本回合先行收尾。后台任务已随本轮一并停止 —— 如果它的活还没干完,请重新发起一次。\n'
}

/**
 * 这个执行器接不接宿主工具 —— **从 E0 的能力表读**,不在这里硬编码。
 *
 * 判据写死成 `providerId === 'claude-code-agent'` 的话,能力表就成了一份没人读的
 * 文档:把 `hostTools` 翻成 false 不会改变任何行为,而那正是「声明与真实能力分家」
 * 的开始(原则 5)。表里那一行现在有了读者,翻它就真的会停掉注入。
 */
function executorAcceptsHostTools(): boolean {
  return findAgentExecutorDescriptor(CLAUDE_CODE_AGENT_CONNECTOR_ID)
    ?.capabilities.hostTools === true
}

const CLAUDE_CODE_CAPABILITIES: ExternalAgentCapabilities = {
  streamingText: true,
  thinking: true,
  toolSteps: true,
  permissionBridge: 'callback',
  resume: true,
  fork: true,
  /**
   * **插得进话**(2026-08-12)。实证见 `ClaudeCodeSdkUserMessage.priority`:输入
   * 迭代器整轮开着(b8472769 为后台子代理的审批留下的形状),往里塞一条
   * `priority:'now'` 的用户消息,当前轮 13ms 内就地收场、1.2s 后新的一轮回答追话。
   *
   * 这一位有**两个读者**,翻它真的会改变行为:装配层据它决定要不要把宿主的
   * steering 交给连接器(`takeExternalAgentSteering`),E0 能力表据它对外声明。
   */
  steer: true,
  /**
   * **真的接得住**(2026-08-12)。图片作为 image block 随文本一起进流式输入的
   * `SDKUserMessage`,实测经真 CLI 到达模型(见 `ClaudeCodeSdkUserContentBlock`)。
   * 翻回 false 不是改一行文档:`provider.ts` 会据此改声明**并**改行为,发图的回合
   * 转而收到一句「此引擎暂不支持图片」。
   */
  imagesIn: true,
  mcpInjection: 'in-process',
  concurrentSessions: 'per-process',
}

function claudeCodeEffort(
  effort: AgentReasoningEffort,
): NonNullable<ClaudeCodeQueryOptions['effort']> {
  return effort === 'minimal' ? 'low' : effort
}

/**
 * The CLI's default model when no override is sent. `provider.ts` erases the
 * picker's pseudo-model to `undefined` (the pseudo-model is not a real model
 * id), so "no model" is the **common** case here, not an edge one — and the
 * family semantics below must therefore have an answer for it rather than
 * bailing out. Whatever the CLI ships as default is an adaptive-family,
 * non-alwaysThinking model; that is the assumption encoded here.
 */
const CLAUDE_CODE_DEFAULT_MODEL_FAMILY = { adaptive: true, alwaysThinking: false } as const

/**
 * Thinking/effort knobs for the CLI, mirroring the claude API provider's
 * family semantics (`agent-loop/providers/claude.ts` streamTurn): Fable/Mythos
 * reject the `thinking` param outright and take only the effort knob; the 4.6+
 * adaptive family takes `{type:'adaptive'}` + effort; older families take
 * neither (their fixed-budget dialect is not wired through the CLI).
 *
 * Two deliberate departures from the raw API body:
 *
 * - `display: 'summarized'` is attached to the adaptive config. Without it the
 *   SDK streams **redacted** thinking — `thinking_delta` events arrive with no
 *   text — so the thinking panel stays empty however hard the model thinks.
 *   It is the only switch that puts prose on the wire.
 * - An unknown model is treated as the CLI default (see the constant above)
 *   instead of skipping the override. Otherwise `thinking: 'disabled'` is
 *   never sent on the pseudo-model path, and the Off setting is unswitchable.
 */
function claudeCodeThinkingOptions(
  request: Pick<ExternalAgentTurnRequest, 'model' | 'thinking' | 'reasoningEffort'>,
): Pick<ClaudeCodeQueryOptions, 'thinking' | 'effort'> {
  const family = request.model
    ? onethingClaudeModelFamily(request.model)
    : CLAUDE_CODE_DEFAULT_MODEL_FAMILY

  if (request.thinking === 'disabled') {
    if (family.adaptive && !family.alwaysThinking) {
      return { thinking: { type: 'disabled' } }
    }
    return {}
  }

  if (request.thinking === 'enabled') {
    const effort = request.reasoningEffort
      ? { effort: claudeCodeEffort(request.reasoningEffort) }
      : {}
    // Fable/Mythos think unconditionally and reject the param — sending it
    // would fail the turn outright, so the summarized display is not
    // available there.
    if (family.alwaysThinking || !family.adaptive) return effort
    return { thinking: { type: 'adaptive', display: 'summarized' }, ...effort }
  }

  return {}
}

async function defaultQueryFn(params: {
  prompt: AsyncIterable<ClaudeCodeSdkUserMessage>
  promptText: string
  options: ClaudeCodeQueryOptions
}): Promise<AsyncIterable<ClaudeCodeSdkMessage>> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  // `promptText` 不进 SDK:它只是同一条消息的原文备份(见 ClaudeCodeQueryFn)。
  // 多传一个 SDK 不认识的键会被 `uO` 原样塞进 CLI 参数解析,所以在这里剥掉。
  return sdk.query({ prompt: params.prompt, options: params.options } as never) as AsyncIterable<ClaudeCodeSdkMessage>
}

/**
 * SDK 报的是**一份 Anthropic usage**,所以它走 Anthropic 那张表 —— 不在继承树里,
 * 但同一份直译函数(设计稿 §7 表末「不在继承树,但必须同表修」)。
 *
 * 官方口径:总输入 = `input_tokens` + `cache_creation` + `cache_read`(三者互斥),
 * 于是 `inputTokens = input_tokens + cache_read_input_tokens`,`cacheWrite` 在它
 * 之外单独带出。这是**行为修正**:缓存命中的回合以前少算输入。
 */
function usageFromResult(message: ClaudeCodeSdkMessage): AgentUsage | undefined {
  return anthropicUsageBuckets(message.usage)?.toAgentUsage()
}

/**
 * 一条失败 result 的**人话**。SDK 把「为什么失败」写在 `result` 字段里(限流提示、
 * 额度用尽、登录过期、resume 的会话不存在……),这里原样带出来 —— 我们既不解读也不
 * 改写它,只保证它上得了屏。`subtype` 一并写进去:`error_max_turns` 与
 * `error_during_execution` 在排障时是两个完全不同的结论。
 */
export function claudeCodeFailureNotice(message: ClaudeCodeSdkMessage): string {
  const subtype = (message.subtype || 'error').trim()
  const detail = typeof message.result === 'string' ? message.result.trim() : ''
  const head = `⚠️ Claude Code 回合失败(${subtype})`
  return detail
    ? `${head}:\n\n${detail}`
    : `${head}。SDK 没有给出更多信息 —— 常见原因是限流、额度用尽或登录过期,请到设置里核对 Claude Code 的登录状态。`
}

/**
 * 一次 **auto-deny 的人话**(P1-3,`docs/audit/claude-code-sdk-audit-2026-08-11.md`
 * 「两不管地带」)。
 *
 * `SDKPermissionDeniedMessage` 覆盖的是 CLI 侧**没有走交互审批**就拒掉的那一支
 * (deny 规则、dontAsk、classifier、headless auto-deny)。它不经 `canUseTool`,
 * 所以 onething 的审批面从头到尾没见过这次调用 —— 翻译器又只认四种消息类型,
 * 于是被拒的工具在 UI 上凭空消失:用户只看到模型忽然改口,不知道是谁拦的。
 *
 * `decision_reason` 是拒的那个组件写的人话,`message` 是回给模型的那句;两者都可能
 * 缺席,所以逐级回落,并把 `decision_reason_type`(rule / mode / classifier …)带上
 * —— 「被规则拦了」与「被模型分类器拦了」在排障时是两个完全不同的结论。
 */
export function claudeCodePermissionDeniedNotice(message: ClaudeCodeSdkMessage): string {
  const toolName = normalizeToolName(message.tool_name)
  // 拒绝原文住在 string 形态的 `message` 上(见 ClaudeCodeSdkMessage 的说明)。
  const rejection = (message as { message?: unknown }).message
  const detail = [
    message.decision_reason,
    typeof rejection === 'string' ? rejection : '',
  ].map(text => (text ?? '').trim()).find(Boolean)
  const reasonType = message.decision_reason_type?.trim()
  const head = `⚠️ 工具 ${toolName} 被 Claude Code 侧配置拒绝`
    + (reasonType ? `(${reasonType})` : '')
  return detail
    ? `${head}:${detail}`
    : `${head}。CLI 没有给出理由 —— 常见来源是 settings 里的 deny 规则或权限模式。`
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => (part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * The CLI's Edit/Write results are plain confirmation text, so the diff the
 * app's file-edit UI expects is synthesized from the tool arguments (the
 * edited hunk, same as Claude Code's own UI) and delivered through the
 * tool-metadata channel the builtin edit tool uses.
 */
function fileChangeMetadata(
  toolName: string,
  argumentsJson: string,
): { path: string; diff: string; additions: number; deletions: number } | null {
  let args: Record<string, unknown>
  try {
    const parsed = JSON.parse(argumentsJson) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    args = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const path = typeof args.file_path === 'string' ? args.file_path : null
  if (!path) return null

  const lower = toolName.toLowerCase()
  let before: string | null = null
  let after: string | null = null
  if (lower === 'edit' && typeof args.old_string === 'string' && typeof args.new_string === 'string') {
    before = args.old_string
    after = args.new_string
  } else if (lower === 'write' && typeof args.content === 'string') {
    before = ''
    after = args.content
  } else if (lower === 'multiedit' && Array.isArray(args.edits)) {
    const olds: string[] = []
    const news: string[] = []
    for (const entry of args.edits) {
      const edit = entry as { old_string?: unknown; new_string?: unknown } | null
      if (!edit || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') return null
      olds.push(edit.old_string)
      news.push(edit.new_string)
    }
    if (olds.length === 0) return null
    before = olds.join('\n\n')
    after = news.join('\n\n')
  } else {
    return null
  }

  if (before === after) return null
  const diff = truncateDiffForDisplay(trimDiff(createTwoFilesPatch(path, path, before, after)))
  const { additions, deletions } = countLineChanges(before, after)
  return { path, diff, additions, deletions }
}

/* ── 提问(E4 / G6+G7) ─────────────────────────────────────────────────── */

/** SDK 自带的「问用户」工具(`sdk-tools.d.ts:847-900` 的 `AskUserQuestionInput`)。 */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion'

/**
 * 默认声明的 dialog kinds。
 *
 * d.ts 里唯一被点名的 kind 就是 `refusal_fallback_prompt`(拒答后要不要重试),
 * 而**每个 kind 的 payload / result 形状在类型里是不透明的**
 * (`payload: Record<string, unknown>`、`result: unknown`)。所以这里的纪律是:
 *
 *  - 声明的 kind → 走通用映射去问人;答上来了才回 `completed`,
 *  - 没声明 / 没落点 / 没答上来 → 一律 `cancelled`(SDK 规定的「答不上来」答法,
 *    CLI 转而执行该 dialog 的默认行为 —— 也就是 E4 之前的形状,只会更好不会更坏)。
 *
 * 装配层可用 `userDialogKinds: []` 就地关掉这条路,不必改代码。
 */
export const DEFAULT_USER_DIALOG_KINDS = ['refusal_fallback_prompt']

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * `AskUserQuestionInput` → E1 的 `InteractionQuestion[]`。字段逐一对得上
 * (E1 的形状就是照它设计的),两处刻意的不同:
 *
 * 1. **主键用 `id` 不用 `header`**:header 是给人看的短标签(SDK 自己写「max 12
 *    chars」),两题撞名就静默串答案。这里按下标造稳定 id。
 * 2. `allowFreeText` 恒真:SDK 说「There should be no 'Other' option, that will be
 *    provided automatically」—— 那个自动的「其他」在我们这边要显式声明出来。
 */
export function askUserQuestionToInteraction(input: unknown): InteractionQuestion[] {
  const questions = asRecord(input)?.questions
  if (!Array.isArray(questions)) return []
  const mapped: InteractionQuestion[] = []
  questions.forEach((entry, index) => {
    const question = asRecord(entry)
    const text = question ? readString(question, 'question') : undefined
    if (!question || !text) return
    const options = Array.isArray(question.options) ? question.options : []
    mapped.push({
      id: `q${index}`,
      ...(readString(question, 'header') ? { header: readString(question, 'header')! } : {}),
      question: text,
      multiSelect: question.multiSelect === true,
      options: options.flatMap(raw => {
        const option = asRecord(raw)
        const label = option ? readString(option, 'label') : undefined
        if (!option || !label) return []
        return [{
          label,
          ...(readString(option, 'description') ? { description: readString(option, 'description')! } : {}),
          ...(readString(option, 'preview') ? { preview: readString(option, 'preview')! } : {}),
        }]
      }),
      allowFreeText: true,
    })
  })
  return mapped
}

/**
 * `InteractionAnswer` → SDK 的 `AskUserQuestionOutput` 形状。
 *
 * 键是**问题原文**,不是 questionId —— d.ts 写死了「question text -> answer
 * string; multi-select answers are comma-separated」。所以这里做一次
 * questionId → 问题原文的回译;E1 用 id 当主键换来的是「两题撞名不串答案」,
 * 代价只有这一次回译。
 *
 * `response` 是「用户没选选项、自己写了一句」那一格(d.ts 的 freeform text)。
 */
export function askUserQuestionOutput(
  questions: InteractionQuestion[],
  answer: InteractionAnswer,
): Record<string, unknown> {
  const answers: Record<string, string> = {}
  let freeform: string | undefined
  for (const question of questions) {
    const entry = answer.answers[question.id]
    if (!entry) continue
    const selected = entry.selected.filter(Boolean)
    const text = selected.length > 0 ? selected.join(', ') : (entry.freeText ?? '')
    answers[question.question] = text
    if (!freeform && entry.freeText) freeform = entry.freeText
  }
  return {
    answers,
    ...(freeform ? { response: freeform } : {}),
  }
}

/**
 * `request_user_dialog` 的 payload → 一道提问。
 *
 * payload 的形状按 kind 定义,而 d.ts 把它透明地放过去(`Record<string, unknown>`),
 * 所以这里只认三样**跨 kind 都成立**的东西:一句问题、一组选项、一个标题。
 * 认不出问题就返回空表 —— 上层据此回 `cancelled`,绝不拿一张空卡去占住一个人。
 */
export function userDialogToInteraction(
  dialogKind: string,
  payload: Record<string, unknown>,
): InteractionQuestion[] {
  const question =
    readString(payload, 'question')
    ?? readString(payload, 'message')
    ?? readString(payload, 'prompt')
    ?? readString(payload, 'title')
  if (!question) return []
  const rawOptions = Array.isArray(payload.options) ? payload.options : []
  const options = rawOptions.flatMap(raw => {
    const option = asRecord(raw)
    if (!option) return typeof raw === 'string' && raw ? [{ label: raw }] : []
    const label = readString(option, 'label') ?? readString(option, 'value')
    if (!label) return []
    return [{
      label,
      ...(readString(option, 'description') ? { description: readString(option, 'description')! } : {}),
    }]
  })
  return [{
    id: 'dialog',
    header: dialogKind,
    question,
    options: options.length > 0 ? options : [{ label: '继续' }, { label: '取消' }],
    allowFreeText: true,
  }]
}

/**
 * 事件流出口的**名字归一化**(E3)。
 *
 * SDK 侧宿主工具叫 `mcp__onething__send_message`(MCP 全名的规矩),而它就是本地
 * 回合里那个 `send_message` —— 前缀说的是「这次它是怎么进到 SDK 里的」,不是
 * 「它是什么」。归一化放在这里(翻译器出口)之后,下游一个都不必改:
 *
 *  - 打字灯的 `isCollabSendCall` 认得出它,外部 agent 说话时群里的「正在输入」
 *    终于会亮 —— 此前 W19 那盏灯对外部 agent 是恒灭的;
 *  - 步骤渲染、调度日志、退役名表看到的都是与本地回合逐字相同的名字。
 *
 * `canUseTool` 那一侧**刻意不归一化**:那是 SDK 的审批口,两类工具的分界线就画在
 * 那个前缀上(见下面的 `canUseTool`)。同一个字符串在两个面上承担两件事,所以只
 * 在事件面上抹掉。
 */
function normalizeToolName(name: string | undefined): string {
  return name ? stripHostMcpToolPrefix(name) : 'tool'
}

/**
 * Per-turn translator: Claude Agent SDK message stream → normalized agent
 * events. Tool calls stream as content blocks (start → input_json_delta →
 * stop) and are marked externallyExecuted; their results arrive as
 * tool_result blocks in user messages. Everything nested under a subagent
 * (parent_tool_use_id set) is skipped — the parent Task tool call already
 * represents it.
 */
class ClaudeCodeTurnTranslator {
  private toolCallsByIndex = new Map<number, { id: string; name: string; args: string }>()
  private toolCallsById = new Map<string, AgentToolCall>()
  private settled = new Set<string>()
  /** 已经报过 `tool-call-start` 的调用 id(流式与回填两条出口共用一张表)。 */
  private started = new Set<string>()
  /** 本轮(一次模型应答)已经报出去的工具调用数。 */
  private roundToolCalls = 0
  /** 本轮的工具结果已经到齐,下一段助手内容属于**新的一轮**。 */
  private roundClosePending = false

  constructor(private turn: number) {}

  /**
   * `backgroundPending` = 这一刻还有活着的后台任务(连接器按
   * `background_tasks_changed` 的整表替换算出来的)。它只改变 **result 的读法**:
   * 带着未决后台任务的 result 不是这一轮的终点,只是一段的终点。
   */
  translate(message: ClaudeCodeSdkMessage, backgroundPending = false): AgentTurnStreamEvent[] {
    if (message.parent_tool_use_id) return []

    switch (message.type) {
      case 'stream_event':
        return this.withRoundBoundary(this.translateStreamEvent(message))
      case 'assistant':
        return this.withRoundBoundary(this.translateAssistant(message))
      case 'user':
        return this.translateUser(message)
      case 'result':
        return this.translateResult(message, backgroundPending)
      case 'system':
        return this.translateSystem(message)
      default:
        return []
    }
  }

  /**
   * `type:'system'` 下唯一需要上屏的一支:**auto-deny**(P1-3)。init / 其它
   * subtype 照旧沉默。
   *
   * 优先翻成**那张工具卡自己的失败结局**:这次调用的 `tool_use_id` 在流上已经有
   * 一张卡时,补一条 error 的 `tool-result` —— 卡就地结算成失败,理由写在卡上,
   * 与本地工具被拒时长得一样。CLI 随后可能还会回一条 is_error 的 tool_result,
   * `settled` 会把它挡掉,不会出现两次结算。
   *
   * 卡还没建(拒得比 `content_block_start` 还早)或已结算时才回落到一句正文 ——
   * 与失败 result 那条(`claudeCodeFailureNotice`)同一个先例:`AgentTurnStreamEvent`
   * 词表里没有 error 事件,能上屏的只有正文。
   */
  private translateSystem(message: ClaudeCodeSdkMessage): AgentTurnStreamEvent[] {
    if (message.subtype !== 'permission_denied') return []
    const notice = claudeCodePermissionDeniedNotice(message)
    const toolUseId = message.tool_use_id
    const toolCall = toolUseId ? this.toolCallsById.get(toolUseId) : undefined
    if (toolCall && toolUseId && !this.settled.has(toolUseId)) {
      this.settled.add(toolUseId)
      // 与 translateUser 同款的收尾:本轮工具结果到齐,下一段正文属于新的一轮。
      if (this.roundToolCalls > 0) this.roundClosePending = true
      return [{
        type: 'tool-result',
        turn: this.turn,
        toolCall,
        result: { content: notice, error: notice },
      }]
    }
    return this.withRoundBoundary([{ type: 'text-delta', turn: this.turn, delta: `\n\n${notice}\n` }])
  }

  /**
   * **回合分界**(F4)。
   *
   * 本地 provider 的一次 provider 请求 = 一个 turn,turn 与 turn 之间由一条
   * `finish(tool_calls)` 分开;执行器正是在这条边界上把上一 turn 的 contentParts
   * 落库、重开 turn 状态、并允许下一 turn 再种一个 `data-steps` 锚点(工具卡在正文
   * 里的落点)。一个 turn 只种一次锚点是对的 —— 本地一轮里正文永远在工具调用之前。
   *
   * Claude Code 把「应答 → 工具 → 再应答 → 再工具 → 收尾」整段跑在**一次**
   * `streamTurn` 里。不发分界的话,这一整段共用一个 turn:所有工具卡都塌到第一个
   * 锚点上,而夹在两次调用之间的正文全被甩到卡片之后 —— 这就是真机上看到的乱序。
   *
   * 所以每当上一轮的工具结果到齐、又有新的助手内容开始时,这里补一条与本地通路
   * **逐字相同**的 `finish(tool_calls)`。次序保证因此只有一套,而不是在 renderer
   * 侧另写一套排序把问题藏起来。
   */
  private withRoundBoundary(events: AgentTurnStreamEvent[]): AgentTurnStreamEvent[] {
    if (!this.roundClosePending || events.length === 0) return events
    // 只有「新的助手内容」才算新的一轮开始:tool-call-delta / done / metadata 都是
    // 上一条 start 的续集,拿它们开新轮会把一次调用劈成两轮。
    const opensRound = events.some(event =>
      event.type === 'text-delta'
      || event.type === 'reasoning-delta'
      || event.type === 'tool-call-start')
    if (!opensRound) return events
    this.roundClosePending = false
    this.roundToolCalls = 0
    return [
      { type: 'finish', turn: this.turn, finishReason: 'tool_calls' },
      ...events,
    ]
  }

  private translateStreamEvent(message: ClaudeCodeSdkMessage): AgentTurnStreamEvent[] {
    const event = message.event
    if (!event) return []

    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      const index = event.index ?? 0
      const id = event.content_block.id ?? `tool-${index}`
      const name = normalizeToolName(event.content_block.name)
      this.toolCallsByIndex.set(index, { id, name, args: '' })
      this.started.add(id)
      return [{ type: 'tool-call-start', turn: this.turn, toolCallId: id, toolName: name }]
    }

    if (event.type === 'content_block_delta' && event.delta) {
      const delta = event.delta
      if (delta.type === 'text_delta' && delta.text) {
        return [{ type: 'text-delta', turn: this.turn, delta: delta.text }]
      }
      if (delta.type === 'thinking_delta' && delta.thinking) {
        return [{ type: 'reasoning-delta', turn: this.turn, delta: delta.thinking }]
      }
      if (delta.type === 'input_json_delta' && delta.partial_json) {
        const pending = this.toolCallsByIndex.get(event.index ?? 0)
        if (!pending) return []
        pending.args += delta.partial_json
        return [{
          type: 'tool-call-delta',
          turn: this.turn,
          toolCallId: pending.id,
          toolName: pending.name,
          argumentsDelta: delta.partial_json,
        }]
      }
      return []
    }

    if (event.type === 'content_block_stop') {
      const pending = this.toolCallsByIndex.get(event.index ?? 0)
      if (!pending || this.toolCallsById.has(pending.id)) return []
      this.toolCallsByIndex.delete(event.index ?? 0)
      return this.completeToolCall(pending.id, pending.name, pending.args || '{}')
    }

    return []
  }

  private translateAssistant(message: ClaudeCodeSdkMessage): AgentTurnStreamEvent[] {
    // Text/thinking already streamed via stream_events; the full assistant
    // message only backfills tool calls the partial stream did not complete.
    const content = message.message?.content
    if (!Array.isArray(content)) return []
    const events: AgentTurnStreamEvent[] = []
    for (const block of content) {
      if (block.type !== 'tool_use' || !block.id) continue
      if (this.toolCallsById.has(block.id)) continue
      const name = normalizeToolName(block.name)
      /**
       * **报过的 start 不再报第二遍**(F4)。
       *
       * 判据此前只看 `toolCallsById`(它在 `content_block_stop` 才落),于是「start
       * 流过了、stop 没到」这一支会在回填时再发一条 `tool-call-start`:下游据它
       * 再建一个占位 toolCall 与一个 step,同一次调用在步骤面上变成两张卡,
       * 而第二张永远停在 input-streaming。
       */
      if (!this.started.has(block.id)) {
        this.started.add(block.id)
        events.push({ type: 'tool-call-start', turn: this.turn, toolCallId: block.id, toolName: name })
      }
      // 还挂在 index 表上的同一次调用(stop 没到)清掉,否则迟到的 stop 会把它
      // 再完成一遍。
      for (const [index, pending] of this.toolCallsByIndex) {
        if (pending.id === block.id) this.toolCallsByIndex.delete(index)
      }
      events.push(...this.completeToolCall(block.id, name, JSON.stringify(block.input ?? {})))
    }
    return events
  }

  private translateUser(message: ClaudeCodeSdkMessage): AgentTurnStreamEvent[] {
    const content = message.message?.content
    if (!Array.isArray(content)) return []
    const events: AgentTurnStreamEvent[] = []
    for (const block of content) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue
      const toolCall = this.toolCallsById.get(block.tool_use_id)
      if (!toolCall || this.settled.has(block.tool_use_id)) continue
      this.settled.add(block.tool_use_id)
      const text = toolResultText(block.content)
      const result: AgentToolResult = {
        content: text,
        ...(block.is_error ? { error: text || 'Tool call failed' } : {}),
      }
      events.push({ type: 'tool-result', turn: this.turn, toolCall, result })
    }
    // 结果到齐 = 本轮结束。分界不在这里发,而是等下一段助手内容真的开始时再发
    // (`withRoundBoundary`):并行调用的结果可能分几条 user 消息回来,提前发会
    // 凭空多出几个空 turn。
    if (events.length > 0 && this.roundToolCalls > 0) this.roundClosePending = true
    return events
  }

  private translateResult(
    message: ClaudeCodeSdkMessage,
    backgroundPending: boolean,
  ): AgentTurnStreamEvent[] {
    /**
     * **未决后台任务当前的 result 不是终点**(2026-08-11 后台子代理审批事故)。
     *
     * 后台子代理跑在主 result 之后:CLI 还活着、还会发工具调用、还会走审批,最后
     * 再收一条真正的 result。所以这一条只翻成**一次轮分界**:
     *
     *  - 不发 `finish` —— 它是回合的终点信号,提前发等于对下游说谎;
     *  - 不发成本 —— `total_cost_usd` 是会话累计值,每条 result 都记一次就是重复计费;
     *  - 失败正文照发 —— 主段真的失败了,用户现在就该看见,不能等到后台收工;
     *  - 置 `roundClosePending`,于是后台归零之后那段收尾正文会开在**新的一轮**,
     *    而不是黏在「DISPATCHED」后面成为一句没头没尾的续写。
     *
     * `settleRemaining()` 同样留给终点:这里补空结果会把还在飞的调用提前结算成
     * 一张空卡。
     */
    if (backgroundPending) {
      const pending: AgentTurnStreamEvent[] = []
      if (message.subtype !== 'success') {
        pending.push(...this.withRoundBoundary([
          { type: 'text-delta', turn: this.turn, delta: claudeCodeFailureNotice(message) },
        ]))
      }
      this.roundClosePending = true
      return pending
    }

    const events: AgentTurnStreamEvent[] = [...this.settleRemaining()]
    /**
     * **失败要说人话**(2026-08-11 止血,`docs/audit/claude-code-sdk-audit-2026-08-11.md`
     * 「四堵墙」之一)。
     *
     * 在此之前一条 `subtype !== 'success'` 的 result 只翻成 `finish(error)`,而
     * `finish` 不带任何文本 —— 限流、额度用尽、登录过期、resume 失效在 UI 上
     * 全长成同一副样子:「回合突然结束,什么都没说」。错误原文只进 console.warn,
     * 用户看不到,自举开发时连「为什么停了」都判不出来。
     *
     * 所以在 finish 之前补一条**可见的正文**。走 `text-delta` 而不是别的形状,
     * 因为 `AgentTurnStreamEvent` 词表里没有 error 事件:能上屏的只有正文。
     * 经 `withRoundBoundary` 是为了让它落在工具卡之后而不是塌回上一轮里。
     */
    if (message.subtype !== 'success') {
      events.push(...this.withRoundBoundary([
        { type: 'text-delta', turn: this.turn, delta: claudeCodeFailureNotice(message) },
      ]))
    }
    if (typeof message.total_cost_usd === 'number') {
      events.push({
        type: 'provider-data',
        turn: this.turn,
        providerData: {
          provider: CLAUDE_CODE_AGENT_CONNECTOR_ID,
          type: 'cost',
          costUSD: message.total_cost_usd,
        },
      })
    }
    events.push({
      type: 'finish',
      turn: this.turn,
      finishReason: message.subtype === 'success' ? 'stop' : 'error',
      usage: usageFromResult(message),
    })
    return events
  }

  private completeToolCall(id: string, name: string, args: string): AgentTurnStreamEvent[] {
    const toolCall: AgentToolCall = {
      id,
      name,
      arguments: args,
      externallyExecuted: true,
    }
    this.toolCallsById.set(id, toolCall)
    this.roundToolCalls += 1
    const events: AgentTurnStreamEvent[] = [
      { type: 'tool-call-done', turn: this.turn, toolCall },
    ]
    const change = fileChangeMetadata(name, args)
    if (change) {
      events.push({
        type: 'tool-metadata',
        turn: this.turn,
        toolCall,
        update: { metadata: change },
      })
    }
    return events
  }

  /**
   * 一句连接器自己要说的正文,走与模型正文**同一条**轮分界(`withRoundBoundary`)。
   * 直接 yield 一条 text-delta 会让它黏在上一轮尾巴上 —— 而它恰恰是在解释
   * 「上一轮为什么没有下文」。
   */
  emitNotice(text: string): AgentTurnStreamEvent[] {
    return this.withRoundBoundary([{ type: 'text-delta', turn: this.turn, delta: text }])
  }

  /** Stream ended without results for some calls — settle them so steps never hang. */
  settleRemaining(): AgentTurnStreamEvent[] {
    const events: AgentTurnStreamEvent[] = []
    for (const [id, toolCall] of this.toolCallsById) {
      if (this.settled.has(id)) continue
      this.settled.add(id)
      events.push({
        type: 'tool-result',
        turn: this.turn,
        toolCall,
        result: { content: '' },
      })
    }
    return events
  }
}

/**
 * 一条会话上**正在跑**的那一轮,只留追话用得着的两样东西。
 *
 * `sawOutput` 不是装饰:它是 `priority:'now'` 那个坑的闸(见
 * `ClaudeCodeSdkUserMessage.priority` —— 当前轮还没吐第一个 token 时用 `'now'`,
 * 追话会被整条吞掉、重跑的是原来那条 prompt)。没开口就退回排队档,于是最坏情况
 * 是「晚一轮」,而不是「说了等于没说」。
 */
interface ActiveClaudeCodeTurn {
  promptStream: ClaudeCodePromptStream
  /** 这一轮是否已经产出过内容(assistant 消息或任何一条 stream_event)。 */
  sawOutput: boolean
  /** 已经塞进去、但它那一轮的 `result` 还没回来的追话条数。 */
  awaitingResult: number
  /**
   * 这一轮的完整拆解(abort + 停表 + 收口)。登记在这里而不是只留一个
   * `AbortController`:半套拆解会留下一个关了输入却还活着的 CLI —— 那正是
   * 「审批打不出去」的另一种病根。
   */
  abort: () => void
}

export function createClaudeCodeConnector(
  options: ClaudeCodeConnectorOptions = {},
): ExternalAgentConnector {
  const abortControllers = new Map<string, AbortController>()
  const activeTurns = new Map<string, ActiveClaudeCodeTurn>()
  const now = options.now ?? (() => Date.now())
  const dialogKinds = options.userDialogKinds ?? DEFAULT_USER_DIALOG_KINDS

  /**
   * `AskUserQuestion` 的四种收场,逐一翻成 SDK 看得懂的答复(原则 3:每一种收场
   * 都要有翻译,不能有一种是「继续等」)。
   *
   *  - `answered` → allow,答案按 `AskUserQuestionOutput` 的形状回填进 input;
   *  - 其余三种 → deny,理由用 E1 的 `answer.reason` 原文(它本来就是写给模型看的
   *    一句人话:「无人应答……请按你自己的判断选一条最稳妥的路继续」)。
   *
   * 没有落点(装配层没装 handler)也是**当场拒绝**,不是挂着 —— 挂着就是 F3。
   */
  async function askUserQuestion(
    request: ExternalAgentTurnRequest,
    input: Record<string, unknown>,
    toolUseID: string | undefined,
  ): Promise<
    | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  > {
    if (!options.interactionHandler) {
      return {
        behavior: 'deny',
        message: '此处没有可以回答问题的人。请不要提问,按你自己的判断继续,并在回答里说明你替用户做了哪个假设。',
      }
    }
    const questions = askUserQuestionToInteraction(input)
    if (questions.length === 0) {
      return { behavior: 'deny', message: 'AskUserQuestion input carried no answerable question.' }
    }
    try {
      const answer = await options.interactionHandler({
        connectorId: CLAUDE_CODE_AGENT_CONNECTOR_ID,
        localSessionId: request.localSessionId,
        ...(request.messageId ? { messageId: request.messageId } : {}),
        ...(toolUseID ? { toolCallId: toolUseID } : {}),
        questions,
      })
      if (answer.outcome === 'answered') {
        return {
          behavior: 'allow',
          updatedInput: { ...input, ...askUserQuestionOutput(questions, answer) },
        }
      }
      return {
        behavior: 'deny',
        message: answer.reason || `Question settled as ${answer.outcome}.`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { behavior: 'deny', message: `Interaction bridge failed: ${message}` }
    }
  }

  return {
    id: CLAUDE_CODE_AGENT_CONNECTOR_ID,
    capabilities: CLAUDE_CODE_CAPABILITIES,

    async *streamTurn(request: ExternalAgentTurnRequest): AsyncIterable<ExternalAgentEvent> {
      const abortController = new AbortController()
      abortControllers.set(request.localSessionId, abortController)

      /**
       * 输入迭代器与 abort 绑在一起(见 `ClaudeCodePromptStream`)。
       *
       * abort 时**必须**同时放开它:SDK 的 `Query.streamInput` 正挂在这个迭代器上,
       * 不放开就留下一个永不结算的 promise。放开之后 SDK 走 endInput、CLI 退出,
       * 与今天 abort 的收场逐字相同(实测:abort 后 CLI 干净退出,后台任务一并终止)。
       */
      /**
       * 图片与文本在这里合成一条用户消息(2026-08-12)。`promptContent.notice` 非空
       * 就说明有图没进去 —— 它已经写进了给模型的文本块,下面还要再发一条给用户看的
       * 正文。两个收信人都必须收到,这是这次修复的全部要点。
       */
      const promptContent = claudeCodePromptContent(request.prompt, request.images)
      const promptStream = new ClaudeCodePromptStream(promptContent.blocks)

      /**
       * **收口只有这一个出口**(2026-08-12 提问事故)。
       *
       * 关 stdin 不是一件小事:CLI 那一侧的判据只有一条(2.1.228 原文)——
       *
       * ```js
       * async sendRequest(e, t, r, n = randomUUID(), o) {
       *   let i = { type: 'control_request', request_id: n, request: e }
       *   if (jEo(n), this.inputClosed) throw new dT('Stream closed')
       * ```
       *
       * 也就是说 `Tool permission request failed: AbortError: Stream closed` 这句话
       * **只**说明一件事:CLI 要发这条 `can_use_tool` 的时候,它的 stdin 已经 EOF 了。
       * 而 stdin 只由我们关(SDK 的 `Query.streamInput` 在输入迭代器结束后调
       * `transport.endInput()`)。所以「谁在何时关的」必须当场记在账上,否则下一次
       * 事故还是只能靠翻会话文件反推。
       */
      function closeInput(reason: string): void {
        if (promptStream.isClosed) return
        options.logger?.log?.(
          `[ClaudeCodeConnector] closing input for ${request.localSessionId.slice(0, 8)} — ${reason}`,
        )
        promptStream.close()
      }

      /**
       * **还欠 CLI 几条控制答复**(2026-08-12 提问事故)。
       *
       * 这是继「后台子代理」(b8472769)与「追话」(e610b0dc)之后,输入通道的
       * **第三个**持有者,也是漏掉的那一个:`canUseTool` / `onUserDialog` 是 CLI
       * 发过来、等我们回话的控制请求,它的答复走的正是 stdin。`AskUserQuestion`
       * 尤其如此 —— 卡片挂在人眼前,可以是几分钟。这段时间里任何一次收口都等于
       * 把答案扔进一根断掉的管子,而且 CLI 之后每一次审批都会当场 `Stream closed`。
       *
       * 判据是「欠不欠答复」,不是「问的是哪个工具」:审批与提问同一条通道,
       * 只认工具名就会漏掉另一半。
       */
      let pendingControlRequests = 0
      /** result 已经到了,但还欠答复 —— 等最后一条答复落地再收口。 */
      let resultAwaitingControlRequests = false
      let settleCloseTimer: ReturnType<typeof setTimeout> | undefined

      function disarmSettleCloseTimer(): void {
        if (settleCloseTimer === undefined) return
        clearTimeout(settleCloseTimer)
        settleCloseTimer = undefined
      }

      const backgroundTimeoutMs = options.backgroundTaskTimeoutMs ?? DEFAULT_BACKGROUND_TASK_TIMEOUT_MS
      let backgroundTimer: ReturnType<typeof setTimeout> | undefined
      let backgroundTimedOutCount = 0

      function disarmBackgroundTimer(): void {
        if (backgroundTimer === undefined) return
        clearTimeout(backgroundTimer)
        backgroundTimer = undefined
      }

      const forwardAbort = () => {
        abortController.abort()
        disarmBackgroundTimer()
        disarmSettleCloseTimer()
        closeInput('abort')
      }
      request.abortSignal?.addEventListener('abort', forwardAbort, { once: true })

      /**
       * 追话的落点(2026-08-12)。登记在**发第一条消息之前**:回合已经开跑而登记表
       * 还是空的那一瞬间,追话会被判成 `unavailable` 并退回宿主队列 —— 不是错误,
       * 但白白晚了一轮。
       *
       * `abort` 一并登记:`abort()` / 新一轮抢占都必须走**同一套**拆解
       * (abort + 停表 + 收口),不能各拆一半。
       */
      const activeTurn: ActiveClaudeCodeTurn = {
        promptStream,
        sawOutput: false,
        awaitingResult: 0,
        abort: forwardAbort,
      }
      /**
       * **一条会话上只许有一轮**(2026-08-12 真机)。
       *
       * 事故日志里同一个本地会话上两条 `[ClaudeCodeConnector] init` 只隔 5ms ——
       * 两个 CLI 进程同时 `--resume` 同一条外部会话。这不只是浪费:连接器的
       * `activeTurns` / `abortControllers` 都以 localSessionId 为键,两轮共存时
       * 登记表只剩一份,于是 `steer()` / `abort()` 打在谁身上全凭先后,而先结束
       * 的那一轮的清理还会把后一轮的句柄一起抹掉。抢占是唯一诚实的形状。
       */
      const superseded = activeTurns.get(request.localSessionId)
      if (superseded) {
        options.logger?.warn?.(
          `[ClaudeCodeConnector] a turn is already live on ${request.localSessionId.slice(0, 8)}`
            + ' — aborting it before starting the new one',
        )
        superseded.abort()
      }
      activeTurns.set(request.localSessionId, activeTurn)

      /**
       * 一次控制往返(`canUseTool` / `onUserDialog`)。**只**做两件事:
       * 把「欠答复」的电平抬起来 / 落下去,以及在电平落到零、而 result 早就到了
       * 的时候把收口补上。
       *
       * 补收口刻意走一个宏任务:SDK 是在我们这个 promise **决议之后**才把控制
       * 答复写进 stdin 的(`await this.canUseTool(...)` 之后才 `transport.write`),
       * 而那段续跑是微任务。宏任务排在所有微任务之后,于是「先把答案写出去,
       * 再关管子」是有序的,不是碰运气。
       */
      async function withControlRequest<T>(label: string, run: () => Promise<T>): Promise<T> {
        if (promptStream.isClosed) {
          // 走到这里就说明收口早了一步:CLI 已经拿不到我们的答复了(它那一侧会
          // 当场抛 `Stream closed`)。这一行是下一次排障的起点,不能省。
          options.logger?.warn?.(
            `[ClaudeCodeConnector] ${label} arrived after the input was closed`
              + ` on ${request.localSessionId.slice(0, 8)} — the answer cannot reach the CLI`,
          )
        }
        pendingControlRequests += 1
        disarmSettleCloseTimer()
        try {
          return await run()
        } finally {
          pendingControlRequests -= 1
          if (
            pendingControlRequests === 0
            && resultAwaitingControlRequests
            && liveBackgroundTasks.size === 0
            && activeTurn.awaitingResult === 0
          ) {
            resultAwaitingControlRequests = false
            settleCloseTimer = setTimeout(() => {
              settleCloseTimer = undefined
              disarmBackgroundTimer()
              closeInput('last pending control request settled after result')
            }, 0)
            settleCloseTimer.unref?.()
          }
        }
      }

      if (request.abortSignal?.aborted) forwardAbort()

      const translator = new ClaudeCodeTurnTranslator(request.turn)
      let linkEmitted = false
      /**
       * 活着的后台任务(`background_tasks_changed` 的**整表替换**语义,见
       * `ClaudeCodeSdkMessage.tasks`)。每轮起于空集 —— d.ts 明写这个电平是
       * per-process 的、启动时不发,而一次 `streamTurn` 恰好就是一个 CLI 进程。
       */
      const liveBackgroundTasks = new Set<string>()

      /**
       * 后台电平的**观测**(2026-08-11)。
       *
       * `liveBackgroundTasks` 早就把电平算准了,它只被用来决定要不要留着输入迭代器
       * —— 也就是说这个信息一直存在,只是从没往界面走过。用户因此只能靠"终止按钮
       * 还亮着"反推有东西在跑。这三个变量就是把同一个电平**再报一次**给观测口。
       *
       * `undefined` = 此刻没有在跑的后台任务;有值 = 电平第一次抬起的墙钟。
       * 一次 streamTurn 里电平可能起落多次,每次重新抬起都是一段新的计时。
       */
      let backgroundStartedAt: number | undefined
      let backgroundReportedCount = 0

      /**
       * 观测调用的唯一出口。**绝不抛** —— 与 `observeTurn` / `toolDecision` 同一条
       * 纪律:观测失败让这一轮炸掉,是把「看不见」升级成「跑不动」。
       */
      function observeBackground(phase: 'running' | 'settled', count: number): void {
        if (!options.observer?.backgroundTasks) return
        if (backgroundStartedAt === undefined) return
        try {
          options.observer.backgroundTasks({
            connectorId: CLAUDE_CODE_AGENT_CONNECTOR_ID,
            localSessionId: request.localSessionId,
            phase,
            count,
            startedAt: backgroundStartedAt,
            ...(phase === 'settled'
              ? { elapsedMs: Math.max(0, now() - backgroundStartedAt) }
              : {}),
          })
        } catch {
          // 观测绝不能变成第二个故障源。
        }
      }

      /**
       * 电平变化后调一次。**零后台的普通回合在这里一条都不发**:没抬起过就没有
       * `backgroundStartedAt`,`settled` 那一支也进不去。
       */
      function noteBackgroundLevel(): void {
        const count = liveBackgroundTasks.size
        if (count > 0) {
          if (backgroundStartedAt === undefined) backgroundStartedAt = now()
          // 任务数没变就不重复投递 —— 同 R6 压 label 抖动那条理由。
          if (count === backgroundReportedCount) return
          backgroundReportedCount = count
          observeBackground('running', count)
          return
        }
        if (backgroundStartedAt === undefined) return
        observeBackground('settled', 0)
        backgroundStartedAt = undefined
        backgroundReportedCount = 0
      }

      /**
       * 收场兜底。防呆表超时或 abort 时电平可能仍然非零 —— 那就**如实报残留数**,
       * 不谎称干净收尾:一条说"还有 2 个在跑"的定格,比一条假装归零的干净结论有用。
       */
      function settleBackgroundOnExit(): void {
        if (backgroundStartedAt === undefined) return
        observeBackground('settled', liveBackgroundTasks.size)
        backgroundStartedAt = undefined
        backgroundReportedCount = 0
      }

      /**
       * 宿主工具面的注入(E3 §2)。
       *
       * 两道门缺一不可:能力表说这个执行器接得住(`hostTools`),装配层装上了
       * 解析器。任何一道不过就退回 E3 之前的形状 —— 只有 SDK 自带工具。
       *
       * 解析失败**不炸回合**:注入不上的代价是这一轮没有发言权(收养兜底还在),
       * 抛出去的代价是这一轮什么都没有。
       */
      let hostTools: Awaited<ReturnType<HostMcpSurfaceResolver>> | undefined
      if (options.hostToolSurface && executorAcceptsHostTools()) {
        try {
          hostTools = await options.hostToolSurface({
            localSessionId: request.localSessionId,
            ...(request.messageId ? { messageId: request.messageId } : {}),
            cwd: request.cwd,
          })
        } catch (error) {
          options.logger?.warn?.(
            `[ClaudeCodeConnector] host tool surface failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
      }

      /**
       * 一轮的起 / 落(E6,§6)。
       *
       * 起点画在这里而不是 `streamTurn` 的第一行:宿主工具面解析失败要退回「只有 SDK
       * 自带工具」,那不是一轮的开始出了问题。落点在 `finally` —— 它是这个生成器
       * **唯一**的收场出口,正常跑完、抛错、被 abort 掐断走的都是它,所以「起了却
       * 没落」在账上只可能意味着进程没了,不可能意味着漏记。
       */
      const turnStartedAt = now()
      let turnOutcome: 'complete' | 'error' | 'aborted' = 'complete'
      /** SDK 的消息流是不是自己跑到了尽头(见 `finally` 里那一刀 abort 的判据)。 */
      let streamCompleted = false
      observeTurn('start')

      function observeTurn(phase: 'start' | 'end'): void {
        if (!options.observer) return
        try {
          options.observer.turn({
            connectorId: CLAUDE_CODE_AGENT_CONNECTOR_ID,
            localSessionId: request.localSessionId,
            phase,
            ...(phase === 'end'
              ? { outcome: turnOutcome, elapsedMs: Math.max(0, now() - turnStartedAt) }
              : {}),
          })
        } catch {
          // 观测绝不能变成第二个故障源(与落盘层同一条纪律)。
        }
      }

      try {
        const spawnEnv = options.resolveSpawnEnv?.()
        const queryOptions: ClaudeCodeQueryOptions = {
          cwd: request.cwd,
          model: request.model,
          resume: request.resume?.externalSessionId,
          pathToClaudeCodeExecutable: options.executablePath,
          includePartialMessages: true,
          permissionMode: 'default',
          /**
           * **显式只收项目层**(P1-2,`docs/audit/claude-code-sdk-audit-2026-08-11.md`
           * 「两不管地带」)。
           *
           * 不传这个字段时 SDK 加载**全部**文件系统设置,于是用户全局
           * `~/.claude/settings.json` 里的 allow 规则在 **CLI 侧先行放行**:
           * `canUseTool` 根本不被调用,onething 的审批面一个字都看不到。开发者
           * 机器上那份白名单几乎人人都有,自举场景下这是致命的。所以:
           *
           *  1. **不含 `'user'`** —— 全局 allow 规则会绕过 onething 的审批,信任面
           *     必须收在 `canUseTool` 这一处;不含 `'local'` 同理:
           *     `.claude/settings.local.json` 不进版本库,是另一份看不见的白名单。
           *     留下的 `'project'`(`<cwd>/.claude/settings.json`)在仓库里看得见、
           *     评审得到,那才是可以谈信任的一层。
           *  2. **必须含 `'project'`** —— 仓库 CLAUDE.md 的读取依赖它
           *     (d.ts 原话:「Must include 'project' to load CLAUDE.md files」)。
           *     此前 CLAUDE.md 是靠「默认全加载」白捡来的:SDK 默认值一变即静默
           *     丢失。写成显式取值之后,自举刚需从白捡变成明拿。
           */
          settingSources: ['project'],
          ...(spawnEnv ? { env: spawnEnv } : {}),
          ...(hostTools ? { mcpServers: hostTools.mcpServers } : {}),
          /**
           * **persona 进 system 位**(E4/G9)。E0 能力表里 claude-code 的
           * `persona: 'system'` 说的就是这里。
           *
           * 用 `preset + append` 而不是裸字符串:裸字符串会把 Claude Code 自己那份
           * 操作说明整个替掉 —— persona 到位了,Read/Write/Bash 却不会用了。追加的
           * 位置在预设之后,于是「这一轮的你是谁」是模型读到的最后一段。
           */
          ...(request.systemPrompt?.trim()
            ? {
                systemPrompt: {
                  type: 'preset' as const,
                  preset: 'claude_code' as const,
                  append: request.systemPrompt.trim(),
                },
              }
            : {}),
          ...claudeCodeThinkingOptions(request),
          abortController,
          /**
           * `request_user_dialog` 的落点(E4/G7)。声明表必须与回调同时给 ——
           * d.ts 明写「Requires `onUserDialog`;passing a non-empty list without
           * the callback throws at option intake」。
           */
          ...(dialogKinds.length > 0
            ? {
                supportedDialogKinds: dialogKinds,
                // `withControlRequest`:这条问答也走 stdin,寿命跟审批同一条规矩。
                onUserDialog: async (dialogRequest, { signal }) => withControlRequest(
                  `onUserDialog(${dialogRequest.dialogKind})`,
                  async () => {
                    if (signal.aborted) return { behavior: 'cancelled' as const }
                    if (!options.interactionHandler) return { behavior: 'cancelled' as const }
                    const questions = userDialogToInteraction(
                      dialogRequest.dialogKind,
                      dialogRequest.payload ?? {},
                    )
                    // 认不出这个 payload。`cancelled` 是 SDK 规定的「答不上来」答法,
                    // CLI 转而执行该 dialog 的默认行为(= E4 之前的形状)。
                    if (questions.length === 0) return { behavior: 'cancelled' as const }
                    try {
                      const answer = await options.interactionHandler({
                        connectorId: CLAUDE_CODE_AGENT_CONNECTOR_ID,
                        localSessionId: request.localSessionId,
                        ...(request.messageId ? { messageId: request.messageId } : {}),
                        ...(dialogRequest.toolUseID ? { toolCallId: dialogRequest.toolUseID } : {}),
                        questions,
                      })
                      if (answer.outcome !== 'answered') return { behavior: 'cancelled' as const }
                      return {
                        behavior: 'completed' as const,
                        result: askUserQuestionOutput(questions, answer),
                      }
                    } catch (error) {
                      options.logger?.warn?.(
                        `[ClaudeCodeConnector] user dialog bridge failed: ${
                          error instanceof Error ? error.message : String(error)
                        }`,
                      )
                      return { behavior: 'cancelled' as const }
                    }
                  },
                ),
              }
            : {}),
          /**
           * **两类工具在这里分家**(§2)。
           *
           * 判据是 MCP 全名的前缀 `mcp__onething__`:
           *
           *  - **宿主工具**(带前缀):跑在我们自己的执行器里,而那条路上已经有
           *    完整的一套 —— 场子门、`permissionGuard`、`enforcePermissionPolicy`、
           *    v3 持牌校验。再过一遍 `canUseTool` 就是同一个动作被审两次:用户
           *    要点两下,而第二下问的是一件他刚刚已经答过的事。所以直接放行,
           *    真正的门在下游。
           *  - **SDK 自带工具**(不带前缀):Read/Write/Bash 跑在 CLI 进程里,
           *    我们对它们只剩这一座桥,照旧走宿主的审批。
           */
          /**
           * 决定 + 记账。**记账只在这一处**(E6):`decideToolUse` 有六个 return,
           * 逐个去记必然漏掉其中一两个,而漏掉的多半是 deny 那几支 —— 恰恰是回查时
           * 最想看见的。所以决定与记账在这里分层:内层只管答,外层只管记。
           */
          canUseTool: async (toolName, input, context) => {
            const decision = await withControlRequest(
              `canUseTool(${normalizeToolName(toolName)})`,
              () => decideToolUse(toolName, input, context),
            )
            if (options.observer) {
              try {
                options.observer.toolDecision({
                  connectorId: CLAUDE_CODE_AGENT_CONNECTOR_ID,
                  localSessionId: request.localSessionId,
                  // 账上与事件流上是同一个名字(E3 的归一化),否则同一次调用在
                  // 时间轴与步骤面上看起来像两件事。
                  toolName: normalizeToolName(toolName),
                  decision: decision.behavior,
                  hostTool: isHostMcpToolName(toolName),
                  ...(context.toolUseID ? { toolCallId: context.toolUseID } : {}),
                })
              } catch { /* 观测绝不能变成第二个故障源 */ }
            }
            return decision
          },
        }

        async function decideToolUse(
          toolName: string,
          input: Record<string, unknown>,
          { signal, toolUseID }: { signal: AbortSignal; toolUseID?: string },
        ): Promise<
          | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
          | { behavior: 'deny'; message: string }
        > {
          if (isHostMcpToolName(toolName)) {
            return { behavior: 'allow', updatedInput: input }
          }
          if (signal.aborted) return { behavior: 'deny', message: 'Aborted.' }

          /**
           * **提问不是审批**(E4/G6)。`AskUserQuestion` 问的是「A 还是 B」,
           * 答案是结构化的;拿审批那套四选一去接它,只能翻成一个「允许 / 拒绝」,
           * 而模型要的那个选择就丢了。所以它在这里拐进 InteractionRegistry。
           */
          if (toolName === ASK_USER_QUESTION_TOOL) {
            return askUserQuestion(request, input, toolUseID)
          }

          if (!options.permissionHandler) {
            return { behavior: 'deny', message: 'No permission handler registered in host.' }
          }
          try {
            const decision = await options.permissionHandler({
              connectorId: CLAUDE_CODE_AGENT_CONNECTOR_ID,
              localSessionId: request.localSessionId,
              messageId: request.messageId,
              cwd: request.cwd,
              toolName,
              input,
              // G1:丢了它,卡就画不出来(见 `ExternalAgentPermissionAsk.toolCallId`)。
              toolCallId: toolUseID,
            })
            return decision.behavior === 'allow'
              ? { behavior: 'allow', updatedInput: input }
              : { behavior: 'deny', message: decision.message }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return { behavior: 'deny', message: `Permission bridge failed: ${message}` }
          }
        }

        const queryParams = {
          prompt: promptStream.stream(),
          promptText: request.prompt,
          options: queryOptions,
        }
        const stream = options.queryFn
          ? options.queryFn(queryParams)
          : await defaultQueryFn(queryParams)

        // 截图的那句话在**模型开口之前**上屏:用户先知道「你那张图没进去」,再看到
        // 一段没有提到那张图的回答,而不是反过来自己猜。
        if (promptContent.notice) {
          yield* translator.emitNotice(`${promptContent.notice}\n\n`)
        }

        for await (const message of stream) {
          /**
           * 这一轮**吐出内容了没有** —— `priority:'now'` 那道闸的唯一数据源(见
           * `ActiveClaudeCodeTurn.sawOutput`)。
           *
           * 判据是**真的内容块**,不是「有没有 stream_event」。第一版就写成了后者,
           * 于是 `message_start` 一到就算开口了 —— 而 `message_start` 恰恰在第一个
           * token **之前**,正好落在那个会把追话整条吞掉的窗口里。真机连着三次
           * 只截断不转向,根因就是这一行:`steeredAt=0`(一个字都还没来)却报了
           * `steered`。
           *
           * 现在只认两样:带 delta 的 `content_block_delta`(正文 / 思考 / 工具入参
           * 真的在流),或一条完整的 `assistant` 消息(非流式回填)。
           */
          if (message.type === 'assistant') {
            activeTurn.sawOutput = true
          } else if (
            message.type === 'stream_event'
            && message.event?.type === 'content_block_delta'
            && message.event.delta !== undefined
          ) {
            activeTurn.sawOutput = true
          }

          /**
           * **追话在飞时,这条 result 不是终点**(2026-08-12)。
           *
           * 与后台子代理那一条(下面)是同一个判据、同一个理由:CLI 还会为这条追话
           * 再跑一轮、再发一条 result。提前收口的代价是双份的 —— 输入迭代器关掉,
           * 追话那一轮永远不会跑;`finish` 提前发出去,下游把回合结算掉。
           *
           * 计数的语义是「**还欠几条 result**」:一条追话 = CLI 还会多发一条
           * result(被截断那一轮的 + 追话那一轮的,一共两条)。所以判据是
           * `steerHoldsThisResult` 这个**减之前**的快照,不是减之后的计数 ——
           * 读减之后的计数会在第一条 result 上就看到 0 并当场收口,追话那一轮
           * 于是永远跑不成(这一条是被 `claude-code-steering.test.ts` 抓出来的)。
           */
          let steerHoldsThisResult = false
          if (message.type === 'result' && activeTurn.awaitingResult > 0) {
            steerHoldsThisResult = true
            activeTurn.awaitingResult -= 1
          }

          /**
           * **回合生命周期**(2026-08-11 后台子代理审批事故)。整段判据只有两条:
           *
           *  1. 后台任务的电平从 `background_tasks_changed` 整表替换而来;
           *  2. 一条 `result` 到达时电平为零 → 结束输入迭代器(SDK 随即 endInput,
           *     CLI 退出,流自然收尾);电平非零 → 保持打开,继续消费后台轮的消息。
           *
           * 零后台的普通回合因此在 result 当场收口:`waitForFirstResult()` 立即返回
           * (result 已到),时序与改动前逐毫秒相同。
           */
          if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
            liveBackgroundTasks.clear()
            for (const task of message.tasks ?? []) {
              if (task.task_id) liveBackgroundTasks.add(task.task_id)
            }
            // 后台清空了但 result 还没来(实测的正常次序):把防呆表停掉,
            // 收口交给随后的那条 result。
            if (liveBackgroundTasks.size === 0) disarmBackgroundTimer()
            // 同一处电平变化,同时报给观测口(可见性,2026-08-11)。放在这里而不是
            // result 那一支:后台任务在正文流完**之前**就可能起来,用户应当从它起来
            // 的那一刻就看得见,而不是等到主回合收尾。
            noteBackgroundLevel()
          }

          if (message.type === 'result') {
            if (liveBackgroundTasks.size === 0 && !steerHoldsThisResult) {
              if (pendingControlRequests > 0) {
                /**
                 * **还欠 CLI 一条答复,这条 result 就不是终点**(2026-08-12)。
                 *
                 * 与后台子代理、追话是同一个形状的第三条:`AskUserQuestion` 的卡片
                 * 可能在人眼前挂几分钟,而答复走的就是这条 stdin。在这里收口,
                 * 答案会被扔进一根断掉的管子,CLI 之后每一次审批都当场
                 * `Stream closed` —— 事故原文。
                 */
                resultAwaitingControlRequests = true
                options.logger?.log?.(
                  `[ClaudeCodeConnector] holding input open for ${pendingControlRequests}`
                    + ' pending control request(s) (the CLI is still owed an answer)',
                )
              } else {
                disarmBackgroundTimer()
                closeInput('result with no background task, no steering, nothing owed')
              }
            } else if (steerHoldsThisResult) {
              // 追话还在飞:输入通道原样留着,等它那一轮的 result。这里**不**武装
              // 后台防呆表 —— 那张表的措辞讲的是「后台子代理没收工」,拿它给追话
              // 兜底会在界面上说一句不相干的话。追话必然有一条 result 跟着回来
              // (CLI 每一轮都发),流真断了 for-await 自己会结束。
              options.logger?.log?.(
                '[ClaudeCodeConnector] holding input open for a steered message'
                  + ` (${activeTurn.awaitingResult} more after this one)`,
              )
            } else if (backgroundTimer === undefined && !promptStream.isClosed) {
              options.logger?.log?.(
                `[ClaudeCodeConnector] holding input open for ${liveBackgroundTasks.size}`
                  + ` background task(s): ${[...liveBackgroundTasks].join(', ')}`,
              )
              backgroundTimer = setTimeout(() => {
                backgroundTimedOutCount = liveBackgroundTasks.size
                options.logger?.warn?.(
                  `[ClaudeCodeConnector] background tasks still pending after ${backgroundTimeoutMs}ms`
                    + ` — closing input (tasks: ${[...liveBackgroundTasks].join(', ')})`,
                )
                closeInput('background fail-safe timed out')
              }, backgroundTimeoutMs)
              // 一个挂了十分钟的定时器不该把宿主进程钉在事件循环上。
              backgroundTimer.unref?.()
            }
          }

          if (message.type === 'system' && message.subtype === 'init') {
            const init = message as ClaudeCodeSdkMessage & { apiKeySource?: string; model?: string; cwd?: string }
            options.logger?.log?.(
              `[ClaudeCodeConnector] init session=${message.session_id} model=${init.model}`
                + ` apiKeySource=${init.apiKeySource} cwd=${init.cwd}`
                // 这一轮到底给了它哪几个宿主工具。注入静静地失败是最坏的结局
                // (发言权没了却看不出来),所以每一轮都把答案写进日志。
                + ` hostTools=[${hostTools?.toolNames.join(', ') ?? ''}]`,
            )
          }
          if (message.type === 'result' && message.subtype !== 'success') {
            options.logger?.warn?.(
              `[ClaudeCodeConnector] error result: ${JSON.stringify(message).slice(0, 800)}`,
            )
          }
          if (!linkEmitted && message.session_id) {
            linkEmitted = true
            const link: ExternalAgentSessionLink = {
              localSessionId: request.localSessionId,
              connectorId: CLAUDE_CODE_AGENT_CONNECTOR_ID,
              externalSessionId: message.session_id,
              cwd: request.cwd,
              createdAt: request.resume?.createdAt ?? now(),
              lastUsedAt: now(),
            }
            yield { type: 'session-established', link }
          }
          yield* translator.translate(
            message,
            liveBackgroundTasks.size > 0 || steerHoldsThisResult,
          )
        }
        // 流自己跑完了 —— 与「下游把生成器丢了」是两回事,`finally` 据此决定要不要
        // 补一刀 abort。
        streamCompleted = true

        /**
         * 防呆到点之后的收尾。走到这里说明我们**主动**掐了输入,那条真正的
         * `result` 永远不会来了 —— 于是这一轮的终点由我们自己补:一句可见的正文
         * (为什么结束的),把还挂着的工具卡结算掉,再发终点信号。少了任何一样,
         * 用户拿到的都是一个静默停住的回合。
         */
        if (backgroundTimedOutCount > 0) {
          yield* translator.emitNotice(
            claudeCodeBackgroundTimeoutNotice(backgroundTimedOutCount, backgroundTimeoutMs),
          )
          yield* translator.settleRemaining()
          yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
        }
      } catch (error) {
        // abort 先判:SDK 把一次中断也抛成异常,而「被人停掉」与「炸了」在回查时
        // 是两个完全不同的结论(E5 的三级停止正是要在账上看得见)。
        turnOutcome = abortController.signal.aborted ? 'aborted' : 'error'
        throw error
      } finally {
        // 生成器被下游提前丢弃(`return()`)时既不进 catch 也不抛,但流确实没跑完 ——
        // 靠信号补判,否则那一支会被记成 `complete`。
        if (turnOutcome === 'complete' && abortController.signal.aborted) turnOutcome = 'aborted'
        /**
         * 输入迭代器**一定**要放开。生成器被下游提前丢弃(`return()`)、抛错、被
         * abort 掐断走的都是这里,而任何一条没放开的路都留下一个挂着的 promise 和
         * 一个不肯退出的 CLI 进程 —— 那是「审批通道活着」的代价里最不该付的一种。
         */
        disarmBackgroundTimer()
        disarmSettleCloseTimer()
        /**
         * **拆解要拆全**(2026-08-12)。此前这里只关输入,不 abort ——
         * 于是「下游把生成器丢了」(`return()`)那一支会留下一个 **stdin 已经
         * EOF、进程却还活着**的 CLI:它照样往下跑,而它每一次 `canUseTool` 都会
         * 当场 `Stream closed`。关管子和掐进程必须是同一个动作。
         *
         * 只在流**没跑完**时掐:正常收场的那一轮流已经自己结束了,再 abort 一次
         * 只会在账上留下一个假的「被中断」。
         */
        if (!streamCompleted) abortController.abort()
        closeInput('turn teardown')
        // 后台状态**必须**在这里收场。它和输入迭代器同一个道理:这是生成器唯一的
        // 收场出口,少了它,一次超时或 abort 会在气泡里留下一根永远走秒的状态条,
        // 而用户没有任何办法让它停 —— 正是 R6 第 3 条列出的那种坏结局。
        settleBackgroundOnExit()
        observeTurn('end')
        request.abortSignal?.removeEventListener('abort', forwardAbort)
        /**
         * 两张登记表同生共死,而且**都要认人**(2026-08-12)。
         *
         * `abortControllers.delete` 此前是无条件的:两轮短暂共存时(真机日志里
         * 那两条只隔 5ms 的 `init`),先结束的那一轮会把**后一轮**的 abort 句柄
         * 一起抹掉 —— 之后 `abort()` 变成一次静默的空操作,回合停不下来。
         * 漏删同样有代价:下一次追话会打在一个已经收口的输入迭代器上并被判成
         * `steered`,一句谎话(界面说插进去了,模型从没听见)。所以是「认人删」。
         */
        if (abortControllers.get(request.localSessionId) === abortController) {
          abortControllers.delete(request.localSessionId)
        }
        if (activeTurns.get(request.localSessionId) === activeTurn) {
          activeTurns.delete(request.localSessionId)
        }
        // 语境解绑。漏解的条目会让下一轮之后的迟到调用打在一份过期语境上,而那
        // 是最难查的一类串房 —— 所以它在 `finally` 里,与 abort 清理并列。
        hostTools?.release?.()
      }
    },

    /**
     * **中途追话**(2026-08-12)。
     *
     * 整段只有三条判据,每一条都对应一个实测结论(逐条时间线见
     * `ClaudeCodeSdkUserMessage.priority`):
     *
     *  1. 这条会话上没有正在跑的外部回合 → `'unavailable'`,宿主退回自己的
     *     steering 队列(= 改动前的行为,一字不差)。
     *  2. 有,而且这一轮**已经开口**了 → `priority:'now'`,就地插进去 →
     *     `'steered'`。
     *  3. 有,但还没开口 → **不用** `'now'`(会被吞掉),按排队档送 →
     *     `'queued'`。送到了,只是要等这一轮跑完。
     *
     * 同步返回,不 await 任何东西 —— 理由写在 `ExternalAgentConnector.steer` 上。
     */
    steer(localSessionId: string, text: string): ExternalAgentSteerOutcome {
      const active = activeTurns.get(localSessionId)
      if (!active || active.promptStream.isClosed) return 'unavailable'
      const trimmed = text.trim()
      if (!trimmed) return 'unavailable'
      const priority = active.sawOutput ? 'now' : undefined
      // 追话只有文本。图片走的是回合起点那条路(`claudeCodePromptContent`),
      // 而中途追话在宿主那一侧本来就只带一段文字。
      const sent = active.promptStream.push([{ type: 'text', text: trimmed }], priority)
      if (!sent) return 'unavailable'
      active.awaitingResult += 1
      options.logger?.log?.(
        `[ClaudeCodeConnector] steered ${localSessionId.slice(0, 8)}`
          + ` priority=${priority ?? 'queued'} awaiting=${active.awaitingResult}`,
      )
      return priority === 'now' ? 'steered' : 'queued'
    },

    /**
     * 走**整套**拆解(abort + 停表 + 收口),而不是只 abort 那个 controller。
     *
     * 只 abort 的形状是有代价的:SDK 的 `Query.streamInput` 会因为
     * `signal.aborted` 跳出 for-await,随后无条件 `transport.endInput()` ——
     * stdin 于是被**别人**关掉,连接器自己的账上一个字都没有。收口的理由必须
     * 永远出自 `closeInput`,否则下一次 `Stream closed` 又只能靠猜。
     */
    async interrupt(localSessionId: string): Promise<void> {
      const active = activeTurns.get(localSessionId)
      if (active) {
        active.abort()
        return
      }
      abortControllers.get(localSessionId)?.abort()
    },

    async dispose(): Promise<void> {
      for (const active of activeTurns.values()) active.abort()
      for (const controller of abortControllers.values()) controller.abort()
      abortControllers.clear()
      activeTurns.clear()
    },
  }
}
