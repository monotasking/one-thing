import type {
  PromptCreateRequest,
  PromptUpdateRequest,
  UserPrompt,
} from './store.js'

export interface PromptGetRequest {
  id: string
}

export interface PromptDeleteRequest {
  id: string
}

export interface OnethingPromptIpcLogger {
  error?: (...args: unknown[]) => void
}

export type OnethingPromptIpcResult<TPayload extends object = {}> =
  | ({ success: true } & TPayload)
  | { success: false; error: string }

export function listOnethingPromptsForIpc<TPrompt = UserPrompt>(
  options: {
    listPrompts(): TPrompt[]
    logger?: OnethingPromptIpcLogger
  },
): OnethingPromptIpcResult<{ prompts: TPrompt[] }> {
  try {
    return { success: true, prompts: options.listPrompts() }
  } catch (error) {
    return promptIpcError(options.logger, 'list prompts', error, 'Failed to list prompts')
  }
}

export function getOnethingPromptForIpc<TPrompt = UserPrompt>(
  options: {
    request: PromptGetRequest
    getPrompt(id: string): TPrompt | undefined
    logger?: OnethingPromptIpcLogger
  },
): OnethingPromptIpcResult<{ prompt: TPrompt }> {
  try {
    const prompt = options.getPrompt(options.request.id)
    return prompt
      ? { success: true, prompt }
      : { success: false, error: 'Prompt not found' }
  } catch (error) {
    return promptIpcError(options.logger, 'read prompt', error, 'Failed to read prompt')
  }
}

export function createOnethingPromptForIpc<TPrompt = UserPrompt>(
  options: {
    request: PromptCreateRequest
    createPrompt(request: PromptCreateRequest): TPrompt
    logger?: OnethingPromptIpcLogger
  },
): OnethingPromptIpcResult<{ prompt: TPrompt }> {
  try {
    if (!options.request.title?.trim()) return { success: false, error: 'Title is required' }
    return { success: true, prompt: options.createPrompt(options.request) }
  } catch (error) {
    return promptIpcError(options.logger, 'create prompt', error, 'Failed to create prompt')
  }
}

export function updateOnethingPromptForIpc<TPrompt = UserPrompt>(
  options: {
    request: PromptUpdateRequest
    updatePrompt(request: PromptUpdateRequest): TPrompt | undefined
    logger?: OnethingPromptIpcLogger
  },
): OnethingPromptIpcResult<{ prompt: TPrompt }> {
  try {
    const prompt = options.updatePrompt(options.request)
    return prompt
      ? { success: true, prompt }
      : { success: false, error: 'Prompt not found' }
  } catch (error) {
    return promptIpcError(options.logger, 'update prompt', error, 'Failed to update prompt')
  }
}

export function deleteOnethingPromptForIpc(
  options: {
    request: PromptDeleteRequest
    deletePrompt(id: string): boolean
    logger?: OnethingPromptIpcLogger
  },
): { success: boolean; error?: string } {
  try {
    return { success: options.deletePrompt(options.request.id) }
  } catch (error) {
    return promptIpcError(options.logger, 'delete prompt', error, 'Failed to delete prompt')
  }
}

function promptIpcError(
  logger: OnethingPromptIpcLogger | undefined,
  label: string,
  error: unknown,
  fallback: string,
): { success: false; error: string } {
  logger?.error?.(`[Prompts IPC] Failed to ${label}:`, error)
  return {
    success: false,
    error: error instanceof Error && error.message ? error.message : fallback,
  }
}
