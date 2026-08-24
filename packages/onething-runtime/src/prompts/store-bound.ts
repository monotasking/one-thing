import {
  OnethingPromptStore,
  type PromptCreateRequest,
  type PromptUpdateRequest,
  type UserPrompt,
} from './index.js'
import {
  getOnethingPromptsPath,
  readJsonFile,
  writeJsonFile,
} from '../storage/index.js'
import { getLogger } from '../logging/index.js'
import type { OnethingPromptStoreAdapters } from './store.js'

const log = getLogger('prompts')


const promptStoreAdapters: OnethingPromptStoreAdapters = {
  getPath: () => getOnethingPromptsPath(),
  readJson: readJsonFile,
  writeJson: writeJsonFile,
  warn: (message, details) => {
    log.warn('prompt store', details === undefined ? { detail: message } : { detail: message, details })
  },
};
export const promptStore = new OnethingPromptStore(promptStoreAdapters)

export function listPrompts(): UserPrompt[] {
  return promptStore.list()
}

export function getPrompt(id: string): UserPrompt | undefined {
  return promptStore.get(id)
}

export function createPrompt(request: PromptCreateRequest): UserPrompt {
  return promptStore.create(request)
}

export function updatePrompt(request: PromptUpdateRequest): UserPrompt | undefined {
  return promptStore.update(request)
}

export function deletePrompt(id: string): boolean {
  return promptStore.delete(id)
}

export function invalidatePromptsCache(): void {
  promptStore.invalidate()
}

export function setPromptsPathForTests(filePath: string | null): void {
  promptStore.setPathForTests(filePath)
}
