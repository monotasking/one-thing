/**
 * Image Generation Module
 * Handles OpenAI DALL-E and Gemini image generation
 */

import { createAppFetch } from '../../providers/bound-fetch.js'
import {
  generateCoreGeminiImage,
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

/**
 * Generate image using Gemini's native image generation REST API.
 */
export async function generateGeminiImage(
  apiKey: string,
  model: string,
  prompt: string
): Promise<ImageGenerationResult> {
  return generateCoreGeminiImage({
    apiKey,
    model,
    prompt,
    fetch: createAppFetch({ policy: 'default' }),
    logger: consoleLog,
  })
}
