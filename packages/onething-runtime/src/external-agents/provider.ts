import { statSync } from 'node:fs'
import { agentContentToText } from '@onething/core/agent-loop'
import type {
  AgentMessageContent,
  AgentModelCapabilities,
  AgentProvider,
  AgentTurnRequest,
  AgentTurnStreamEvent,
} from '@onething/core/agent-loop'
import { BaseAgentProvider } from '../agent-loop/providers/base/base-agent-provider.js'
import { getLogger } from '../logging/index.js'
import type {
  ExternalAgentConnector,
  ExternalAgentImageInput,
  ExternalAgentSessionLink,
} from './types.js'

export interface CreateExternalAgentProviderOptions {
  providerId: string
  connector: ExternalAgentConnector
  localSessionId?: string
  executionContext?: unknown
  workingDirectory?: string
  messageId?: string
  /** Previously persisted link for this session, to resume the external session. */
  resolveSessionLink?: (localSessionId: string) => ExternalAgentSessionLink | undefined
  /** Persist the (new or refreshed) link as soon as the turn establishes it. */
  onSessionLink?: (link: ExternalAgentSessionLink) => void
}

/** 未绑工作目录时回给用户的那句人话。导出是为了让测试与宿主复用同一份措辞。 */
export const UNBOUND_WORKING_DIRECTORY_NOTICE =
  '⚠️ 此会话未绑定工作目录,外部 agent 没有启动。\n\n'
  + '请先用 `/cd <路径>` 指定一个目录,或在会话设置里绑定工作目录,然后重发这条消息。'

/**
 * 绑了、但那个目录已经没了(2026-08-12 真机)。
 *
 * 这一支在此之前是**误导**而不是缺失:目录不存在 → spawn 当场失败 → SDK 把任何一种
 * 启动失败都翻成同一句「Claude Code binary failed to launch」,并附上一段关于
 * musl / glibc 的排查建议。于是用户拆掉一个 worktree 之后,拿到的是一条让他去查
 * C 运行时的提示,而真正的原因是「你绑的那个目录被你自己删了」。
 *
 * 拒绝的形状与 `UNBOUND_WORKING_DIRECTORY_NOTICE` 逐字同款:一条可见正文 +
 * `finish(error)`,不 spawn、不 throw。理由也同一条 —— 用户要的是「我该做什么」。
 */
export function missingWorkingDirectoryNotice(cwd: string): string {
  return `⚠️ 此会话绑定的工作目录已不存在(${cwd}),可能已被移动或删除。\n\n`
    + '请用 `/cd <路径>` 重新绑定后重发这条消息。'
}

/**
 * 这个路径现在能不能当工作目录用。
 *
 * `statSync` 抛(不存在 / 无权限)与「存在但不是目录」都算不能用 —— 两种都会让
 * spawn 失败,而失败之后的文案是同一句误导。探测失败**不当成不可用**只在一种情况下
 * 危险:权限问题下这里会拒绝一个理论上可用的目录,但那一轮本来也跑不起来。
 */
function isUsableDirectory(cwd: string): boolean {
  try {
    return statSync(cwd).isDirectory()
  } catch {
    return false
  }
}

/** 连接器接不住图片时回给用户的那句人话。导出是为了让测试与宿主复用同一份措辞。 */
export function externalAgentImagesUnsupportedNotice(count: number): string {
  return `⚠️ 本轮的 ${count} 张图片未送达(此执行引擎暂不支持图片输入),仅文本生效。\n\n`
}

/**
 * 最后一条用户消息里的图片(2026-08-12,审计「图片静默丢弃」)。
 *
 * 与原生 claude provider 的 `userContentBlocks` 同款口径:`image` 部件直接取,
 * `file` 部件里 mediaType 是 `image/*` 的也算 —— 上游把附件按 mediaType 分流,
 * 两条路都可能落到这里,只认一条就是一次静默丢弃。
 */
function imagesFromContent(content: AgentMessageContent): ExternalAgentImageInput[] {
  if (!Array.isArray(content)) return []
  const images: ExternalAgentImageInput[] = []
  for (const part of content) {
    if (part.type === 'image' && part.image) {
      images.push({
        image: part.image,
        ...(part.mediaType ? { mediaType: part.mediaType } : {}),
      })
      continue
    }
    if (part.type === 'file' && part.mediaType?.startsWith('image/') && part.data) {
      images.push({ image: part.data, mediaType: part.mediaType })
    }
  }
  return images
}

/**
 * 这一轮真正要发出去的东西:最后一条用户消息的文本 **与它的图片**。
 *
 * 在此之前这里只取文本(`agentContentToText`),图片部件被静默丢在原地 —— 用户发了
 * 图,外部 agent 一个像素都没收到,而界面上没有任何迹象。文本与图片必须从**同一条
 * 消息**上取:图片属于它旁边那句话,拆开取就会把上一轮的图配到这一轮的问题上。
 *
 * 收敛条件也随之放宽:一条只有图、没有文字的消息(用户直接拖一张图进来)从前会被
 * 当成「空 prompt」抛错,现在是一条合法的回合。
 */
function latestUserTurn(request: AgentTurnRequest): { text: string; images: ExternalAgentImageInput[] } {
  for (let index = request.messages.length - 1; index >= 0; index--) {
    const message = request.messages[index]
    if (message.role !== 'user') continue
    const text = agentContentToText(message.content).trim()
    const images = imagesFromContent(message.content)
    if (text || images.length > 0) return { text, images }
  }
  return { text: '', images: [] }
}

/**
 * 整份 system prompt(E4/G9)。
 *
 * 在此之前这里只取最后一条 user 文本,system 位**整个被丢掉** —— 于是群里的 Iris
 * 不是 Iris:她的 persona(agents.json 里那段「a designer with sharp taste and a
 * sharper tongue」)在房间回合里就是 system prompt 的全部内容
 * (`app/engine/prompt/system-prompt.ts:151` 注释:persona already IS the system
 * prompt),丢了它就只剩一台通用的 Claude Code。
 *
 * 引擎把 system prompt 放在 `messages` 的 system 位(`core/agent-loop/prompts.ts`),
 * 与 claude/gemini provider 的取法逐字一致;多条按顺序拼(压缩摘要也走这一位)。
 */
function systemPrompt(request: AgentTurnRequest): string {
  return request.messages
    .filter(message => message.role === 'system')
    .map(message => agentContentToText(message.content).trim())
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Adapts an ExternalAgentConnector to the engine's AgentProvider seam:
 * connector-level events (session-established, agent-status) are consumed
 * here; everything else is the AgentTurnStreamEvent vocabulary already.
 *
 * P1-d1:从对象字面量改成 `BaseAgentProvider` 的子类。继承来的是身份、能力投影、
 * logger 与 `runTurn = collect(streamTurn)`。**不**继承 `HttpAgentProvider` ——
 * 外部 agent 的传输是一条 SDK 会话/子进程,不是一次 fetch(设计稿 §2.9)。
 *
 * 实例无可写字段:`options` 是构造时闭起来的只读依赖,回合级的量全在
 * `streamTurn` 的局部里。
 */
class ExternalAgentProvider extends BaseAgentProvider {
  constructor(private readonly options: CreateExternalAgentProviderOptions) {
    super({
      providerId: options.providerId,
      logger: getLogger(`providers.${options.providerId}`),
    })
  }

  /** 能力来自连接的 agent,不是账本 —— 宿主的账本覆盖层看这一位跳过自己。 */
  get capabilitiesAreSelfDeclared(): boolean {
    return true
  }

  /**
   * 传输声明。自述能力的 provider 没有账本解析器,所以 `BaseAgentProvider` 会把
   * 这份表原样交出去 —— 与从前那个字面量逐字段相同。
   */
  protected get transportCapabilities(): AgentModelCapabilities {
    const { connector } = this.options
    return {
      /**
       * 图像那一位**从连接器的能力表读**(2026-08-12),不在这里硬编码 —— 与
       * `executorAcceptsHostTools` 同一条纪律(原则 5):翻 `imagesIn` 会真的改变
       * 声明,而不是改一行没人看的文档。
       */
      capabilities: connector.capabilities.imagesIn
        ? ['text-input', 'text-output', 'streaming', 'reasoning', 'vision-input']
        : ['text-input', 'text-output', 'streaming', 'reasoning'],
      inputModalities: connector.capabilities.imagesIn ? ['text', 'image'] : ['text'],
      outputModalities: ['text'],
      supportsStreaming: true,
      supportsReasoning: connector.capabilities.thinking,
      /**
       * 仍是 false —— 而 E3 之后这句话的含义变了,值得写清楚。
       *
       * 它答的是「**引擎的工具循环**要不要为这个 provider 装载工具」,答案是不要:
       * 外部 agent 的工具在它自己的循环里执行,引擎再装一份只会把同一批工具发两遍,
       * 然后等一个永远不会回到我们这条循环里的结果。
       *
       * 协作工具**不走这条路**:它们经进程内 MCP 直接注入 SDK(E3,§2
       * `host-mcp/`),由 connector 的 `hostToolSurface` 在每一轮解析、由**我们的**
       * 执行器执行。所以「没有工具面」这个 §0 诊断已经不成立了 —— 工具面回来了,
       * 只是它接在 connector 上,不接在这里。
       *
       * 这一位翻真要等 E2:那时 AgentExecutor 抽象接管「工具装载看 `hostTools`」,
       * 引擎不再从 provider 的这一位推断任何东西。
       */
      supportsTools: false,
    }
  }

  async *streamTurn(request: AgentTurnRequest): AsyncGenerator<AgentTurnStreamEvent, void, void> {
    const { options } = this
    const { text: prompt, images } = latestUserTurn(request)
    if (!prompt && images.length === 0) throw new Error(`${options.providerId} prompt is empty`)

    /**
     * **接不住图也要说话**(2026-08-12)。`imagesIn` 为假的连接器(今天是 ACP)
     * 从前拿到的是一份被悄悄剥掉图片的文本 —— 用户发的图去哪了,界面上一个字都没有。
     * 现在它拿到的仍然是文本,但用户先看到一句「图片没送到、为什么」。
     *
     * 这一位就是 `imagesIn` 的第二个读者:翻它会改行为,不只是改声明。
     */
    const deliverableImages = options.connector.capabilities.imagesIn ? images : []
    const undeliverableImageNotice =
      !options.connector.capabilities.imagesIn && images.length > 0
        ? externalAgentImagesUnsupportedNotice(images.length)
        : undefined

    /**
     * **未绑工作目录 = 不开跑**(2026-08-11 止血,审计「四堵墙」之二)。
     *
     * 这里以前兜底 `process.cwd()`:开发时那恰好是仓库根,于是看着像能用;
     * 打包之后主进程的 cwd 是 `/`,外部 agent 于是在一个空目录里困惑地摸索,
     * 而界面上一个字的提示都没有。兜底给的不是韧性,是一次静默的错误现场。
     *
     * 拒绝的形状与失败 result 同一套(`claude-code-connector.ts` 的
     * `claudeCodeFailureNotice`):一条可见正文 + `finish(error)`。不 throw ——
     * 抛出去只会在别处变成一条堆栈,用户要的是「我该做什么」。
     */
    const cwd = options.workingDirectory?.trim()
    if (!cwd) {
      yield { type: 'text-delta', turn: request.turn, delta: UNBOUND_WORKING_DIRECTORY_NOTICE }
      yield { type: 'finish', turn: request.turn, finishReason: 'error' }
      return
    }

    /**
     * **绑了但没了**(2026-08-12 真机)。见 `missingWorkingDirectoryNotice`:
     * 不拦的话这一支会以一条关于 musl / glibc 的排查建议收场。
     *
     * 判据是「是不是一个目录」而不是「存不存在」:绑到一个**文件**上 spawn 同样
     * 失败,而 `existsSync` 对它是真 —— 只查存在会漏掉一半。
     */
    if (!isUsableDirectory(cwd)) {
      yield { type: 'text-delta', turn: request.turn, delta: missingWorkingDirectoryNotice(cwd) }
      yield { type: 'finish', turn: request.turn, finishReason: 'error' }
      return
    }

    // 图片送不出去的那句话排在工作目录之后:没绑目录时这一轮压根不会跑,
    // 用户该看到的是「去绑个目录」,而不是先被告知一件不相干的事。
    if (undeliverableImageNotice) {
      yield { type: 'text-delta', turn: request.turn, delta: undeliverableImageNotice }
      // 只有图、没有文字,而这个引擎又接不住图 —— 这一轮没有任何可送的东西。
      // 与未绑工作目录同一套收场:一条可见正文 + finish(error),不 throw。
      if (!prompt) {
        yield { type: 'finish', turn: request.turn, finishReason: 'error' }
        return
      }
    }

    const system = systemPrompt(request)
    const localSessionId = options.localSessionId ?? `${options.providerId}-${request.model}`
    const resume = options.connector.capabilities.resume
      ? options.resolveSessionLink?.(localSessionId)
      : undefined

    for await (const event of options.connector.streamTurn({
      localSessionId,
      executionContext: options.executionContext,
      messageId: options.messageId,
      prompt,
      ...(deliverableImages.length > 0 ? { images: deliverableImages } : {}),
      ...(system ? { systemPrompt: system } : {}),
      // `||`: unbound sessions arrive with an empty-string working dir.
      cwd,
      // The provider id doubles as the picker's pseudo-model; only a real
      // model override is forwarded to the connector.
      model: request.model === options.providerId ? undefined : request.model,
      thinking: request.thinking,
      reasoningEffort: request.reasoningEffort,
      turn: request.turn,
      abortSignal: request.abortSignal,
      resume,
    })) {
      if (event.type === 'session-established') {
        options.onSessionLink?.(event.link)
        continue
      }
      if (event.type === 'agent-status') continue
      yield event
    }
  }
}

/** 工厂函数签名与导出名一字不变 —— 调用方看不出里面换成了一个类。 */
export function createExternalAgentProvider(
  options: CreateExternalAgentProviderOptions,
): AgentProvider {
  return new ExternalAgentProvider(options)
}
