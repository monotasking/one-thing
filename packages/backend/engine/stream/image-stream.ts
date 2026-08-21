/**
 * Image Stream Module
 * Handles image generation streaming flow (IPC messages, media saving, etc.)
 *
 * Uses EventBus/StreamChannel for streaming lifecycle events.
 * IMAGE_GENERATED is a one-off notification sent directly via sender.
 */

import { IPC_CHANNELS } from '@shared/ipc.js'
import * as store from '../../store.js'
import { saveMediaImage } from '@onething/runtime/media/save-image'
import { getEventBus, getStreamChannel } from '../../events/index.js'
import {
  generateImage,
  generateGeminiImage,
} from './image-generation.js'
import type { StreamSender } from './stream-processor.js'
import {
  executeOnethingImageGenerationStream,
} from '@onething/runtime/media'
import { recordSynthesizedAssistantText } from '../../session/assistant-parts.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'

const log = getLogger('engine.stream.image')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


export interface ImageStreamParams {
  sender: StreamSender
  sessionId: string
  assistantMessageId: string
  prompt: string
  providerId: string
  apiKey: string
  model: string
  baseUrl?: string
  sessionName?: string
}

/**
 * Process image generation stream
 * Handles the full flow: send progress, generate, save, send result
 *
 * @returns true if image generation was handled, false to continue with text stream
 */
export async function processImageGenerationStream(
  params: ImageStreamParams
): Promise<boolean> {
  const {
    sender,
    sessionId,
    assistantMessageId,
    prompt,
    providerId,
    apiKey,
    model,
    baseUrl,
    sessionName,
  } = params

  // Lazy-get event system singletons
  let eventBus: ReturnType<typeof getEventBus> | null = null
  let streamChannel: ReturnType<typeof getStreamChannel> | null = null
  try { eventBus = getEventBus() } catch { /* not initialized */ }
  try { streamChannel = getStreamChannel() } catch { /* not initialized */ }

  return executeOnethingImageGenerationStream({
    sessionId,
    assistantMessageId,
    prompt,
    providerId,
    apiKey,
    model,
    baseUrl,
    sessionName,
    emitEvent: async (targetSessionId, event) => {
      try {
        await eventBus?.emit(targetSessionId, event)
      } catch (err) {
        log.error('image stream event emit failed', { sessionId: targetSessionId, eventType: event.type }, err)
      }
    },
    pushStreamChunk: (targetSessionId, chunk) => {
      // Send the real image markdown; the renderer reducer pops the skeleton first.
      streamChannel?.push(targetSessionId, chunk)
    },
    generateGeminiImage: input => generateGeminiImage(input.apiKey, input.model, input.prompt),
    generateOpenAIImage: input => generateImage(input.apiKey, input.baseUrl, input.model, input.prompt),
    saveMediaImage,
    store: {
      updateMessageContent: store.updateMessageContent,
      // R-b(§13.6):**正文落到消息上的那一刻**,同一段正文也进事件账本
      // (data URL 换成 blob 占位符)。挂在这一格而不是 `saveMediaImage` 上:
      // 这里才是"消息上多了一格 contentPart"的那一刻,两侧因此逐字节对得上
      // (错误分支不写 contentPart,账本上也就没有那一格)。
      addMessageContentPart: async (targetSessionId, messageId, part) => {
        const applied = await store.addMessageContentPart(targetSessionId, messageId, part)
        if (part.type === 'text' && typeof part.content === 'string') {
          recordSynthesizedAssistantText(targetSessionId, messageId, part.content)
        }
        return applied
      },
      // §13.8 第二类:失败分支的正文只落在 `content` 上(没有 contentPart),
      // 所以它有自己的落点 —— 挂在 `updateMessageContent` 上会把成功分支的
      // 那段正文记两遍(那边先写 content、再写 part)。
      updateMessageErrorContent: async (targetSessionId, messageId, content) => {
        const applied = await store.updateMessageContent(targetSessionId, messageId, content)
        recordSynthesizedAssistantText(targetSessionId, messageId, content, { contentOnly: true })
        return applied
      },
      updateMessageStreaming: store.updateMessageStreaming,
      flushSessionSave: store.flushSessionSave,
    },
    notifyImageGenerated: notification => {
      // IMAGE_GENERATED is a one-off renderer notification outside EventBus.
      if (!sender.isDestroyed()) {
        sender.send(IPC_CHANNELS.IMAGE_GENERATED, notification)
      }
    },
    logger: consoleLog,
  })
}
