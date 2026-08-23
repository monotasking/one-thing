import type { AgentProviderData } from '@onething/core/agent-loop'
import {
  appendOrderedPart,
  type ApplyAgentLoopProviderDataRuntimeOptions,
  type CoreHistoryContentPart,
  type CoreOrderedPartLike,
} from '@onething/core/engine'

type MaybePromise<T> = T | Promise<T>

export interface OnethingGeneratedImageMediaItem {
  id: string
  filePath: string
  prompt: string
  revisedPrompt?: string
  model: string
  createdAt: number
}

export interface OnethingGeneratedImageNotification extends OnethingGeneratedImageMediaItem {
  mediaId: string
  sessionId: string
  messageId: string
}

export interface ApplyOnethingAgentLoopProviderDataOptions<TContentPart extends CoreOrderedPartLike>
  extends ApplyAgentLoopProviderDataRuntimeOptions<TContentPart> {
  saveMediaImage(input: {
    base64: string
    prompt: string
    revisedPrompt?: string
    model: string
    sessionId: string
    messageId: string
  }): MaybePromise<OnethingGeneratedImageMediaItem>
  notifyImageGenerated?(notification: OnethingGeneratedImageNotification): MaybePromise<void>
  /**
   * A14(§13.1):这一段正文是**引擎自己合成的**,不经 provider 流。
   *
   * codex 内联生图把一段 markdown 塞进 `handleTextChunk` —— 消息上它与任何
   * 一段模型正文没有区别,但 `onEvent` 上一条 `text-delta` 都没有,所以会话
   * 事件的采集点看不见它。宿主把落定的那一段回传给记录器,`assistant/chunks`
   * 才对得上(不接这个口 = 那段正文在账本上不存在)。
   */
  onSynthesizedText?(text: string): void
}

/**
 * 一条 `provider-data` 在**消息上留下哪一格**(A1+A14,§13.1)。
 *
 * 抽成纯函数是为了让采集点与引擎共用**同一张表**(§10.10):记录器挂在
 * `onEvent` 上,看到的是同一批 provider-data 事件,但它不能自己再判一遍
 * "这一条会不会变成一格 part" —— 那就是第二个判定点,而两个判定点迟早分叉。
 *
 *  - `'provider-data'` —— 落一格 `{type:'provider-data', providerData, turnIndex}`;
 *    非 codex 的 provider 全部走 core 的缺省计划(`planAgentLoopProviderData`),
 *    结论与这里相同。
 *  - `'text'` —— 落一段正文(内联生图的 markdown)。
 *  - `'none'` —— 消息上什么都不留(生图开始只是一张瞬态卡;其余 codex 类型忽略)。
 *
 * **图像输出按 `type` 判,不按 provider 名判**(P3-2):codex 的原生
 * `image_generation` 工具与 OpenRouter 的 `message.images[]` 是同一件事的两条
 * 线协议,provider 侧已经把两者归一成同一对事件
 * (`image-generation-start` / `image-generation-result`),这里只认那两个 type。
 * codex 独有的那几条(`encrypted-reasoning` 等)才继续按 provider 名判。
 */
export type OnethingProviderDataPartPlan = 'provider-data' | 'text' | 'none'

/**
 * 这条生图结果**带得动一张图**吗 —— base64(`result`)或远端 URL(`url`),
 * 两者都空就是一条空事件,消息上不留格。
 */
function generatedImagePayload(
  providerData: AgentProviderData,
): { base64: string } | { url: string } | undefined {
  if (typeof providerData.result === 'string' && providerData.result.length > 0) {
    return { base64: providerData.result }
  }
  if (typeof providerData.url === 'string' && providerData.url.length > 0) {
    return { url: providerData.url }
  }
  return undefined
}

export function planOnethingProviderDataPart(providerData: AgentProviderData): OnethingProviderDataPartPlan {
  // 生图开始只是一张瞬态卡(任何 provider)。
  if (providerData.type === 'image-generation-start') return 'none'
  // 生图结果落成一段正文(任何 provider)。
  if (providerData.type === 'image-generation-result') {
    return generatedImagePayload(providerData) ? 'text' : 'none'
  }
  if (providerData.provider !== 'codex') return 'provider-data'
  if (
    providerData.type === 'encrypted-reasoning'
    && typeof providerData.encryptedContent === 'string'
    && providerData.encryptedContent.length > 0
  ) {
    return 'provider-data'
  }
  return 'none'
}

export function providerDataFromOnethingContentPart(part: CoreHistoryContentPart): AgentProviderData | undefined {
  if (part.providerData) return part.providerData

  if (
    part.provider === 'codex' &&
    typeof part.encryptedReasoning === 'string' &&
    part.encryptedReasoning.length > 0
  ) {
    return {
      provider: 'codex',
      type: 'encrypted-reasoning',
      encryptedContent: part.encryptedReasoning,
    }
  }

  return undefined
}

export function buildOnethingGeneratedImageMarkdown(mediaId: string, revisedPrompt?: string): string {
  const imageUrl = `media://${mediaId}.png`
  const promptText = revisedPrompt?.trim()
  return `${promptText ? `**Revised prompt:** ${promptText}\n\n` : ''}![Generated Image|mediaId:${mediaId}](${imageUrl})`
}

/**
 * 远端 URL 的生图结果(P3-2)。
 *
 * **本期不落媒体库**:只写一条 markdown 图片链接。OpenRouter 默认回 data URL
 * (那一支照旧走 `saveMediaImage`),http URL 只是兜底 —— 要落库就得在主进程
 * 下载一个我们没验证过来源的远端资源,那是另一批的事,不在这里顺手做。
 * 因此这条正文**没有 `mediaId:` 标记**:消息里没有对应的媒体条目。
 */
export function buildOnethingRemoteImageMarkdown(url: string, revisedPrompt?: string): string {
  const promptText = revisedPrompt?.trim()
  return `${promptText ? `**Revised prompt:** ${promptText}\n\n` : ''}![Generated Image](${url})`
}

/** 把一段图片 markdown 接到当前正文后面(空行分隔)。 */
export function buildOnethingImageTextDelta(currentContent: string, markdown: string): string {
  const prefix = currentContent && !currentContent.endsWith('\n') ? '\n\n' : ''
  return `${prefix}${markdown}`
}

export function buildOnethingGeneratedImageTextDelta(
  currentContent: string,
  mediaId: string,
  revisedPrompt?: string,
): string {
  return buildOnethingImageTextDelta(
    currentContent,
    buildOnethingGeneratedImageMarkdown(mediaId, revisedPrompt),
  )
}

export async function applyOnethingAgentLoopProviderData<TContentPart extends CoreOrderedPartLike>(
  options: ApplyOnethingAgentLoopProviderDataOptions<TContentPart>,
): Promise<boolean | undefined> {
  const providerData = options.providerData

  // ---- 图像输出:按 type 判,任何 provider 同一处理(P3-2)----------------
  if (providerData.type === 'image-generation-start') {
    options.emitter.sendContentPart({
      type: 'image-loading',
      turnIndex: options.turnIndex,
      label: 'Generating image',
    } as unknown as TContentPart)
    return true
  }

  if (providerData.type === 'image-generation-result') {
    const payload = generatedImagePayload(providerData)
    // 空事件:瞬态卡已经收了,消息上不留格。
    if (!payload) return false
    await appendGeneratedImageText(options, payload)
    return true
  }

  // ---- 其余类型:非 codex 交回 core 的缺省计划(它落的正是那一格)--------
  if (providerData.provider !== 'codex') return undefined

  if (planOnethingProviderDataPart(providerData) === 'provider-data') {
    appendOrderedPart(options.orderedParts, {
      type: 'provider-data',
      providerData,
      turnIndex: options.turnIndex,
    } as unknown as TContentPart)
    return true
  }

  return false
}

/**
 * 一张图 → 一段正文。
 *
 * base64 走媒体库(`saveMediaImage` + `media://` 链接 + 生成通知);远端 URL
 * 只写链接 —— 本期不下载(见 `buildOnethingRemoteImageMarkdown`),因此也没有
 * 媒体条目可通知。
 */
async function appendGeneratedImageText<TContentPart extends CoreOrderedPartLike>(
  options: ApplyOnethingAgentLoopProviderDataOptions<TContentPart>,
  payload: { base64: string } | { url: string },
): Promise<void> {
  const providerData = options.providerData
  const revisedPrompt =
    typeof providerData.revisedPrompt === 'string' ? providerData.revisedPrompt : undefined

  let markdown: string
  let mediaItem: OnethingGeneratedImageMediaItem | undefined
  if ('base64' in payload) {
    mediaItem = await options.saveMediaImage({
      base64: payload.base64,
      prompt: options.latestUserPrompt?.trim() || 'Image generation',
      revisedPrompt,
      model: options.model,
      sessionId: options.sessionId,
      messageId: options.messageId,
    })
    markdown = buildOnethingGeneratedImageMarkdown(mediaItem.id, mediaItem.revisedPrompt)
  } else {
    markdown = buildOnethingRemoteImageMarkdown(payload.url, revisedPrompt)
  }

  const displayContent = options.handleTextChunk(
    buildOnethingImageTextDelta(options.content.value, markdown),
    options.content,
    options.turnIndex,
  )
  if (displayContent) {
    appendOrderedPart(options.orderedParts, {
      type: 'text',
      content: displayContent,
      turnIndex: options.turnIndex,
    } as TContentPart)
    // A14:落定的那一段回传给会话事件的采集点。落点与回放同一个值 ——
    // 记 `displayContent`(真正进 orderedParts 的那一份),不是合成前的原文。
    options.onSynthesizedText?.(displayContent)
  }

  if (!mediaItem) return
  await options.notifyImageGenerated?.({
    id: mediaItem.id,
    mediaId: mediaItem.id,
    filePath: mediaItem.filePath,
    prompt: mediaItem.prompt,
    revisedPrompt: mediaItem.revisedPrompt,
    model: mediaItem.model,
    sessionId: options.sessionId,
    messageId: options.messageId,
    createdAt: mediaItem.createdAt,
  })
}
