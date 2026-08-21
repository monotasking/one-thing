/**
 * Built-in Note Skills plugin.
 *
 * Exposes SKILL.md files stored under the configured note directories:
 * user_note_dir and work_note_dir. Roots are recursive so users can
 * organize skills inside nested folders.
 */

import { getVariablesStore } from '../../variables/index.js'
import { invalidateSessionSkillsCache } from '../../skills/session-skills.js'
import { getSettings } from '../../../stores/settings.js'
import type { PluginAPI } from '../types.js'
import { isDirectory } from '@onething/core/storage'
import {
  buildNoteSkillInstructionContext as buildOnethingNoteSkillInstructionContext,
  ONETHING_NOTE_SKILLS_MANIFEST,
  registerOnethingNoteSkillsPlugin,
} from '@onething/runtime/plugins'

export const noteSkillsManifest = ONETHING_NOTE_SKILLS_MANIFEST

export function buildNoteSkillInstructionContext(input: { skillDir: string; rootDir: string }): string {
  return buildOnethingNoteSkillInstructionContext({
    ...input,
    markdownNoteAttachmentDirectory: getSettings().general.editor?.markdownNoteAttachmentDirectory,
  })
}

export default function noteSkillsPlugin(api: PluginAPI): void {
  registerOnethingNoteSkillsPlugin(api, {
    getDirs: () => {
      const store = getVariablesStore()
      return [store.getUserNoteDir(), store.getWorkNoteDir()]
    },
    getMarkdownNoteAttachmentDirectory: () => getSettings().general.editor?.markdownNoteAttachmentDirectory,
    onVariableChange: handler => getVariablesStore().subscribe(handler),
    invalidateSkillsCache: invalidateSessionSkillsCache,
    isDirectory,
  })
}
