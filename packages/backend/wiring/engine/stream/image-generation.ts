/**
 * Image Generation Module
 * Handles OpenAI-compatible (DALL-E / gpt-image) image generation.
 *
 * P4-8:gemini 那一支已退役 —— Google 官方端点的图像模型同时是聊天模型,图在
 * agent loop 里以 `inlineData` part 回来(GeminiWire 解析),不再有专用生图流。
 */

import { createAppFetch } from '../../../provider-binding/bound-fetch.js'
import {
  generateCoreOpenAIImage,
  normalizeImageModelId,
  type CoreImageGenerationResult,
} from '@onething/runtime/media'
import { consolePort, getLogger } from '../../logging/index.js'

const log = getLogger('engine.stream.image')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


export { normalizeImageModelId }

/**
 * Image generation result interface
 */
export interface ImageGenerationResult extends CoreImageGenerationResult {}

/**
 * Generate image using the OpenAI-compatible image generation REST API.
 */
export async function generateImage(
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string,
  options: { size?: string; quality?: string; style?: string } = {}
): Promise<ImageGenerationResult> {
  return generateCoreOpenAIImage({
    apiKey,
    baseUrl,
    model,
    prompt,
    imageOptions: options,
    fetch: createAppFetch({ policy: 'default' }),
    logger: consoleLog,
  })
}
