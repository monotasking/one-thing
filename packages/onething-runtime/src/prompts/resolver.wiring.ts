import type {
  ChatMessage,
  ContentPart,
  SkillDefinition,
} from '@shared/ipc.js'
import {
  displayOnethingContentForMessage,
  resolveOnethingPromptReferences,
} from './index.js'
import { getPrompt } from './store-bound.js'

export interface ResolvePromptReferencesOptions {
  skills?: SkillDefinition[]
}

export interface ResolvedPromptReferences {
  modelContent: string
  displayContent: string
  contentParts?: ContentPart[]
  missingPromptIds: string[]
  missingSkillIds: string[]
  hasPromptReferences: boolean
  hasSkillReferences: boolean
}

export function resolvePromptReferences(
  rawContent: string,
  options: ResolvePromptReferencesOptions = {},
): ResolvedPromptReferences {
  return resolveOnethingPromptReferences<SkillDefinition, ContentPart>(rawContent, {
    getPrompt,
    skills: options.skills,
  })
}

export function displayContentForMessage(message: Pick<ChatMessage, 'content' | 'contentParts'>): string {
  return displayOnethingContentForMessage(message)
}
