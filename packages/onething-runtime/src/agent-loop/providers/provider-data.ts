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
 *  - `'text'` —— 落一段正文(codex 内联生图的 markdown)。
 *  - `'none'` —— 消息上什么都不留(生图开始只是一张瞬态卡;其余 codex 类型忽略)。
 */
export type OnethingProviderDataPartPlan = 'provider-data' | 'text' | 'none'

export function planOnethingProviderDataPart(providerData: AgentProviderData): OnethingProviderDataPartPlan {
  if (providerData.provider !== 'codex') return 'provider-data'
  if (
    providerData.type === 'encrypted-reasoning'
    && typeof providerData.encryptedContent === 'string'
    && providerData.encryptedContent.length > 0
  ) {
    return 'provider-data'
  }
  if (
    providerData.type === 'image-generation-result'
    && typeof providerData.result === 'string'
    && providerData.result.length > 0
  ) {
    return 'text'
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

export function buildOnethingGeneratedImageTextDelta(
  currentContent: string,
  mediaId: string,
  revisedPrompt?: string,
): string {
  const markdown = buildOnethingGeneratedImageMarkdown(mediaId, revisedPrompt)
  const prefix = currentContent && !currentContent.endsWith('\n') ? '\n\n' : ''
  return `${prefix}${markdown}`
}

export async function applyOnethingAgentLoopProviderData<TContentPart extends CoreOrderedPartLike>(
  options: ApplyOnethingAgentLoopProviderDataOptions<TContentPart>,
): Promise<boolean | undefined> {
  const providerData = options.providerData
  // 非 codex 交回 core 的缺省计划(它落的正是 `'provider-data'` 那一格)。
  if (providerData.provider !== 'codex') return undefined

  const plan = planOnethingProviderDataPart(providerData)

  if (plan === 'provider-data') {
    appendOrderedPart(options.orderedParts, {
      type: 'provider-data',
      providerData,
      turnIndex: options.turnIndex,
    } as unknown as TContentPart)
    return true
  }

  if (providerData.type === 'image-generation-start') {
    options.emitter.sendContentPart({
      type: 'image-loading',
      turnIndex: options.turnIndex,
      label: 'Generating image',
    } as unknown as TContentPart)
    return true
  }

  if (plan === 'text') {
    const mediaItem = await options.saveMediaImage({
      // `plan === 'text'` 已经查过它是非空字符串(见 `planOnethingProviderDataPart`)。
      base64: providerData.result as string,
      prompt: options.latestUserPrompt?.trim() || 'Image generation',
      revisedPrompt: typeof providerData.revisedPrompt === 'string' ? providerData.revisedPrompt : undefined,
      model: options.model,
      sessionId: options.sessionId,
      messageId: options.messageId,
    })

    const displayContent = options.handleTextChunk(
      buildOnethingGeneratedImageTextDelta(
        options.content.value,
        mediaItem.id,
        mediaItem.revisedPrompt,
      ),
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

    return true
  }

  return false
}
