import { Buffer } from 'node:buffer'
import type { FetchLike } from '@onething/core/http'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

/**
 * Normalize model ID for image generation API calls.
 */
export function normalizeImageModelId(modelId: string): string {
  const normalized = modelId.toLowerCase().replace(/[\s-]+/g, '')
  if (normalized.includes('dalle3')) return 'dall-e-3'
  if (normalized.includes('dalle2')) return 'dall-e-2'
  if (normalized.includes('chatgptimage')) return 'gpt-image-1'
  return modelId
}

export interface CoreImageGenerationRequestPlan {
  providerKind: 'gemini' | 'openai-compatible'
  modelForDisplay: string
  modelForRequest: string
  baseUrl?: string
}

export interface CoreOpenAIImageGenerationOptions {
  size?: string
  quality?: string
  style?: string
}

export interface CoreOpenAIImageGenerationRequest {
  model: string
  prompt: string
  size: string
  style?: string
  quality?: string
  response_format?: 'b64_json'
}

export interface CoreOpenAIImageGenerationPayload {
  data?: Array<{
    b64_json?: string
    revised_prompt?: string
    url?: string
  }>
  b64_json?: string
  revised_prompt?: string
  url?: string
  error?: {
    message?: string
  }
}

export interface CoreGeminiGenerateContentPayload {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string
        inlineData?: {
          data?: string
          mimeType?: string
        }
        inline_data?: {
          data?: string
          mime_type?: string
        }
      }>
    }
  }>
  error?: {
    message?: string
  }
}

export interface CoreImageGenerationResult {
  success: boolean
  imageUrl?: string
  imageBase64?: string
  revisedPrompt?: string
  error?: string
}

export interface GenerateCoreOpenAIImageOptions {
  apiKey: string
  baseUrl: string
  model: string
  prompt: string
  imageOptions?: CoreOpenAIImageGenerationOptions
  fetch: FetchLike
  logger?: {
    error?: (...args: unknown[]) => void
  }
}

export interface GenerateCoreGeminiImageOptions {
  apiKey: string
  model: string
  prompt: string
  fetch: FetchLike
  logger?: {
    log?: (...args: unknown[]) => void
    error?: (...args: unknown[]) => void
  }
}

export function planImageGenerationRequest(options: {
  providerId: string
  model: string
  baseUrl?: string
}): CoreImageGenerationRequestPlan {
  if (options.providerId === 'gemini') {
    return {
      providerKind: 'gemini',
      modelForDisplay: options.model,
      modelForRequest: options.model,
    }
  }

  const normalizedModel = normalizeImageModelId(options.model)
  return {
    providerKind: 'openai-compatible',
    modelForDisplay: normalizedModel,
    modelForRequest: normalizedModel,
    baseUrl: options.baseUrl || 'https://api.openai.com/v1',
  }
}

export function normalizeOpenAIImageBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
}

export function buildOpenAIImageGenerationRequest(
  model: string,
  prompt: string,
  options: CoreOpenAIImageGenerationOptions = {},
): CoreOpenAIImageGenerationRequest {
  const body: CoreOpenAIImageGenerationRequest = {
    model,
    prompt,
    size: options.size || '1024x1024',
  }

  if (model === 'dall-e-3') {
    body.style = options.style || 'vivid'
    body.quality = options.quality || 'standard'
    body.response_format = 'b64_json'
  } else if (model.includes('gpt-image')) {
    body.quality = options.quality || 'auto'
  } else {
    body.response_format = 'b64_json'
  }

  return body
}

export function extractOpenAIImageGenerationPayload(
  payload: CoreOpenAIImageGenerationPayload,
): CoreImageGenerationResult {
  if (payload.error?.message) {
    return { success: false, error: payload.error.message }
  }

  const first = payload.data?.[0] ?? payload
  const imageBase64 = first.b64_json
  const imageUrl = first.url
  if (!imageBase64 && !imageUrl) {
    return { success: false, error: 'No image generated' }
  }

  return {
    success: true,
    imageBase64,
    imageUrl,
    revisedPrompt: first.revised_prompt,
  }
}

export function buildGeminiImageGenerationRequest(prompt: string) {
  return {
    contents: [{
      role: 'user',
      parts: [{ text: prompt }],
    }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  }
}

export function extractGeminiImageGenerationPayload(
  payload: CoreGeminiGenerateContentPayload,
): CoreImageGenerationResult {
  if (payload.error?.message) {
    return { success: false, error: payload.error.message }
  }

  const parts = payload.candidates?.flatMap(candidate => candidate.content?.parts ?? []) ?? []
  for (const part of parts) {
    const inlineData = part.inlineData ?? (part.inline_data
      ? {
          data: part.inline_data.data,
          mimeType: part.inline_data.mime_type,
        }
      : undefined)
    if (inlineData?.data && inlineData.mimeType?.startsWith('image/')) {
      return {
        success: true,
        imageBase64: inlineData.data,
      }
    }
  }

  const text = parts
    .map(part => part.text)
    .filter(Boolean)
    .join('\n')

  if (text) {
    return {
      success: false,
      error: `Model returned text instead of image: ${text.substring(0, 200)}`,
    }
  }

  return {
    success: false,
    error: 'No image generated',
  }
}

export function extractImageGenerationResponseError(text: string, fallback: string): string {
  if (!text) return fallback
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } }
    return parsed.error?.message || text
  } catch {
    return text
  }
}

async function imageGenerationResponseError(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => '')
  return extractImageGenerationResponseError(text, fallback)
}

async function fetchImageUrlAsBase64(url: string, fetchImpl: FetchLike): Promise<string> {
  const response = await fetchImpl(url)
  if (!response.ok) {
    throw new Error(await imageGenerationResponseError(
      response,
      `Failed to fetch generated image: ${response.status}`,
    ))
  }
  return Buffer.from(await response.arrayBuffer()).toString('base64')
}

/**
 * Generate an image through an OpenAI-compatible image REST API.
 * The host supplies fetch so Electron can bind proxy/network settings while
 * headless callers can pass globalThis.fetch directly.
 */
export async function generateCoreOpenAIImage(
  options: GenerateCoreOpenAIImageOptions,
): Promise<CoreImageGenerationResult> {
  try {
    const body = buildOpenAIImageGenerationRequest(options.model, options.prompt, options.imageOptions)
    const response = await options.fetch(`${normalizeOpenAIImageBaseUrl(options.baseUrl)}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new Error(await imageGenerationResponseError(
        response,
        `OpenAI image API error: ${response.status}`,
      ))
    }

    const payload = await response.json() as CoreOpenAIImageGenerationPayload
    const extracted = extractOpenAIImageGenerationPayload(payload)
    if (!extracted.success && extracted.error) throw new Error(extracted.error)

    const imageBase64 = extracted.imageBase64 || (extracted.imageUrl
      ? await fetchImageUrlAsBase64(extracted.imageUrl, options.fetch)
      : undefined)

    if (!imageBase64) {
      return {
        success: false,
        error: 'No image generated',
      }
    }

    return {
      success: true,
      imageBase64,
      revisedPrompt: extracted.revisedPrompt,
    }
  } catch (error) {
    const imageError = error instanceof Error ? error : new Error(String(error))
    options.logger?.error?.('[Image Generation] Error:', imageError)
    return {
      success: false,
      error: imageError.message || 'Failed to generate image',
    }
  }
}

/**
 * Generate an image through Gemini's native generateContent REST API.
 */
export async function generateCoreGeminiImage(
  options: GenerateCoreGeminiImageOptions,
): Promise<CoreImageGenerationResult> {
  try {
    options.logger?.log?.(`[Gemini Image] Generating image with model: ${options.model}`)
    const encodedModel = encodeURIComponent(options.model)
    const response = await options.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodedModel}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': options.apiKey,
        },
        body: JSON.stringify(buildGeminiImageGenerationRequest(options.prompt)),
      },
    )
    if (!response.ok) {
      throw new Error(await imageGenerationResponseError(
        response,
        `Gemini image API error: ${response.status}`,
      ))
    }

    const result = await response.json() as CoreGeminiGenerateContentPayload
    const parts = result.candidates?.flatMap(candidate => candidate.content?.parts ?? []) ?? []
    options.logger?.log?.(`[Gemini Image] Response received, parts: ${parts.length}`)

    const extracted = extractGeminiImageGenerationPayload(result)
    if (extracted.success) {
      options.logger?.log?.('[Gemini Image] Found image')
    } else if (extracted.error?.startsWith('Model returned text instead of image:')) {
      const text = extracted.error.replace(/^Model returned text instead of image:\s*/, '')
      options.logger?.log?.(`[Gemini Image] No image generated, got text: ${text.substring(0, 100)}...`)
    }

    return extracted
  } catch (error) {
    const imageError = error instanceof Error ? error : new Error(String(error))
    options.logger?.error?.('[Gemini Image] Error:', imageError)
    return {
      success: false,
      error: imageError.message || 'Failed to generate image',
    }
  }
}

export function buildImageStreamResponseContent(options: {
  prompt: string
  revisedPrompt?: string
  imageBase64: string
  mediaId: string
}): string {
  let responseContent = ''
  if (options.revisedPrompt && options.revisedPrompt !== options.prompt) {
    responseContent += `**优化后的提示词:** ${options.revisedPrompt}\n\n`
  }
  const imageDataUrl = `data:image/png;base64,${options.imageBase64}`
  responseContent += `![Generated Image|mediaId:${options.mediaId}](${imageDataUrl})`
  return responseContent
}

export function buildImageGenerationErrorContent(error?: string): string {
  return `图片生成失败: ${error || '未知错误'}`
}

export interface CoreImageStreamStartEventPlan {
  startEvent: {
    type: typeof SESSION_EVENT_TYPES.STREAM_START
    messageId: string
    assistantMessageId: string
    model: string
  }
  loadingEvent: {
    type: typeof SESSION_EVENT_TYPES.CONTENT_PART
    part: { type: 'image-loading'; label: string }
  }
}

export interface CoreImageStreamSuccessEventPlan {
  streamChunk: {
    type: 'text-delta'
    text: string
  }
  contentEvent: {
    type: typeof SESSION_EVENT_TYPES.CONTENT_PART
    part: { type: 'text'; content: string }
  }
  completeEvent: {
    type: typeof SESSION_EVENT_TYPES.STREAM_COMPLETE
    data: { sessionName?: string }
  }
}

export interface CoreImageStreamErrorEventPlan {
  errorContent: string
  errorEvent: {
    type: typeof SESSION_EVENT_TYPES.STREAM_ERROR
    data: { error: string }
  }
}

export function buildImageStreamStartEventPlan(options: {
  assistantMessageId: string
  model: string
  loadingLabel?: string
}): CoreImageStreamStartEventPlan {
  return {
    startEvent: {
      type: SESSION_EVENT_TYPES.STREAM_START,
      messageId: options.assistantMessageId,
      assistantMessageId: options.assistantMessageId,
      model: options.model,
    },
    loadingEvent: {
      type: SESSION_EVENT_TYPES.CONTENT_PART,
      part: {
        type: 'image-loading',
        label: options.loadingLabel || 'Generating image',
      },
    },
  }
}

export function buildImageStreamSuccessEventPlan(options: {
  responseContent: string
  sessionName?: string
}): CoreImageStreamSuccessEventPlan {
  return {
    streamChunk: {
      type: 'text-delta',
      text: options.responseContent,
    },
    contentEvent: {
      type: SESSION_EVENT_TYPES.CONTENT_PART,
      part: { type: 'text', content: options.responseContent },
    },
    completeEvent: {
      type: SESSION_EVENT_TYPES.STREAM_COMPLETE,
      data: { sessionName: options.sessionName },
    },
  }
}

export function buildImageStreamErrorEventPlan(error?: string): CoreImageStreamErrorEventPlan {
  const errorMessage = error || 'Image generation failed'
  return {
    errorContent: buildImageGenerationErrorContent(error),
    errorEvent: {
      type: SESSION_EVENT_TYPES.STREAM_ERROR,
      data: { error: errorMessage },
    },
  }
}

export interface CoreImageGeneratedNotificationInput {
  mediaId: string
  filePath: string
  prompt: string
  revisedPrompt?: string
  model: string
  sessionId: string
  messageId: string
  createdAt: number
}

export function buildImageGeneratedNotification(input: CoreImageGeneratedNotificationInput) {
  return {
    id: input.mediaId,
    mediaId: input.mediaId,
    filePath: input.filePath,
    prompt: input.prompt,
    revisedPrompt: input.revisedPrompt,
    model: input.model,
    sessionId: input.sessionId,
    messageId: input.messageId,
    createdAt: input.createdAt,
  }
}

type CoreMaybePromise<T> = T | Promise<T>

export interface CoreImageStreamMediaItem {
  id: string
  filePath: string
  createdAt: number
}

export interface CoreImageStreamStoreAdapter {
  updateMessageContent(sessionId: string, messageId: string, content: string): CoreMaybePromise<unknown>
  addMessageContentPart(
    sessionId: string,
    messageId: string,
    part: { type: 'text'; content: string },
  ): CoreMaybePromise<unknown>
  updateMessageStreaming(sessionId: string, messageId: string, streaming: boolean): CoreMaybePromise<unknown>
  flushSessionSave(sessionId: string): CoreMaybePromise<unknown>
}

export type CoreImageStreamEvent =
  | CoreImageStreamStartEventPlan['startEvent']
  | CoreImageStreamStartEventPlan['loadingEvent']
  | CoreImageStreamSuccessEventPlan['contentEvent']
  | CoreImageStreamSuccessEventPlan['completeEvent']
  | CoreImageStreamErrorEventPlan['errorEvent']

export interface ExecuteCoreImageGenerationStreamOptions {
  sessionId: string
  assistantMessageId: string
  prompt: string
  providerId: string
  apiKey: string
  model: string
  baseUrl?: string
  sessionName?: string
  emitEvent?: (sessionId: string, event: CoreImageStreamEvent) => CoreMaybePromise<void>
  pushStreamChunk?: (sessionId: string, chunk: CoreImageStreamSuccessEventPlan['streamChunk']) => CoreMaybePromise<void>
  generateOpenAIImage: (input: {
    apiKey: string
    baseUrl: string
    model: string
    prompt: string
  }) => CoreMaybePromise<CoreImageGenerationResult>
  generateGeminiImage: (input: {
    apiKey: string
    model: string
    prompt: string
  }) => CoreMaybePromise<CoreImageGenerationResult>
  saveMediaImage: (input: {
    base64: string
    prompt: string
    revisedPrompt?: string
    model: string
    sessionId: string
    messageId: string
  }) => CoreMaybePromise<CoreImageStreamMediaItem>
  store: CoreImageStreamStoreAdapter
  notifyImageGenerated?: (notification: ReturnType<typeof buildImageGeneratedNotification>) => CoreMaybePromise<void>
  logger?: {
    log?: (...args: unknown[]) => void
  }
}

export type ExecuteOnethingImageGenerationStreamOptions = ExecuteCoreImageGenerationStreamOptions

/**
 * Run the provider-neutral image stream lifecycle. Host adapters own network,
 * persistence, and IPC; core owns the ordering and event/message plans.
 */
export async function executeCoreImageGenerationStream(
  options: ExecuteCoreImageGenerationStreamOptions,
): Promise<boolean> {
  const {
    sessionId,
    assistantMessageId,
    prompt,
    providerId,
    apiKey,
    model,
    baseUrl,
    sessionName,
    emitEvent,
    pushStreamChunk,
    generateGeminiImage,
    generateOpenAIImage,
    saveMediaImage,
    store,
    notifyImageGenerated,
    logger,
  } = options

  logger?.log?.(`[ImageStream] Processing image generation for model: ${model}`)

  const startPlan = buildImageStreamStartEventPlan({ assistantMessageId, model })
  await emitEvent?.(sessionId, startPlan.startEvent)
  await emitEvent?.(sessionId, startPlan.loadingEvent)

  const requestPlan = planImageGenerationRequest({ providerId, model, baseUrl })
  const result = requestPlan.providerKind === 'gemini'
    ? await generateGeminiImage({
        apiKey,
        model: requestPlan.modelForRequest,
        prompt,
      })
    : await generateOpenAIImage({
        apiKey,
        baseUrl: requestPlan.baseUrl || 'https://api.openai.com/v1',
        model: requestPlan.modelForRequest,
        prompt,
      })

  if (result.success && result.imageBase64) {
    const mediaItem = await saveMediaImage({
      base64: result.imageBase64,
      prompt,
      revisedPrompt: result.revisedPrompt,
      model: requestPlan.modelForDisplay,
      sessionId,
      messageId: assistantMessageId,
    })
    logger?.log?.('[ImageStream] Image saved to media:', mediaItem.id)

    const responseContent = buildImageStreamResponseContent({
      prompt,
      revisedPrompt: result.revisedPrompt,
      imageBase64: result.imageBase64,
      mediaId: mediaItem.id,
    })

    await store.updateMessageContent(sessionId, assistantMessageId, responseContent)
    await store.addMessageContentPart(sessionId, assistantMessageId, { type: 'text', content: responseContent })
    await store.updateMessageStreaming(sessionId, assistantMessageId, false)
    await store.flushSessionSave(sessionId)

    const successPlan = buildImageStreamSuccessEventPlan({ responseContent, sessionName })
    await pushStreamChunk?.(sessionId, successPlan.streamChunk)
    await emitEvent?.(sessionId, successPlan.contentEvent)

    await notifyImageGenerated?.(buildImageGeneratedNotification({
      mediaId: mediaItem.id,
      filePath: mediaItem.filePath,
      prompt,
      revisedPrompt: result.revisedPrompt,
      model: requestPlan.modelForDisplay,
      sessionId,
      messageId: assistantMessageId,
      createdAt: mediaItem.createdAt,
    }))

    await emitEvent?.(sessionId, successPlan.completeEvent)
    logger?.log?.('[ImageStream] Image generation complete')
    return true
  }

  const errorPlan = buildImageStreamErrorEventPlan(result.error)
  await store.updateMessageContent(sessionId, assistantMessageId, errorPlan.errorContent)
  await store.updateMessageStreaming(sessionId, assistantMessageId, false)
  await store.flushSessionSave(sessionId)
  await emitEvent?.(sessionId, errorPlan.errorEvent)

  return true
}

/**
 * Onething runtime entry point for image stream orchestration.
 *
 * Electron and Gateway hosts should depend on this app-runtime facade instead
 * of reaching for the lower-level core lifecycle helper directly.
 */
export async function executeOnethingImageGenerationStream(
  options: ExecuteOnethingImageGenerationStreamOptions,
): Promise<boolean> {
  return executeCoreImageGenerationStream(options)
}
