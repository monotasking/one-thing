/**
 * Image Stream Module
 * Handles image generation streaming flow (IPC messages, media saving, etc.)
 *
 * Uses EventBus/StreamChannel for streaming lifecycle events.
 * IMAGE_GENERATED is a one-off notification sent directly via sender.
 */

import { IPC_CHANNELS } from '@shared/ipc.js'
import * as store from '../../store.js'
import { saveMediaImage } from '../../media/save-image.js'
import { getEventBus, getStreamChannel } from '../../events/index.js'
import {
  generateImage,
  generateGeminiImage,
} from './image-generation.js'
import type { StreamSender } from './stream-processor.js'
import {
  executeOnethingImageGenerationStream,
} from '@onething/runtime/media'
import { recordGeneratedImagePart } from '../../session/assistant-parts.js'
import { consolePort, getLogger } from '../../logging/index.js'

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
    // S1b 缺口 3:图片本体在这一刻同时进 blob store,事件行留一条
    // `assistant/part-end{kind:'image'}`。挂在 saveMediaImage 上而不是别处 ——
    // 这是整条特化流里唯一同时握着 sessionId / messageId / base64 的地方。
    saveMediaImage: async input => {
      const item = await saveMediaImage(input)
      recordGeneratedImagePart(sessionId, assistantMessageId, input.base64)
      return item
    },
    store: {
      updateMessageContent: store.updateMessageContent,
      addMessageContentPart: store.addMessageContentPart,
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
