import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@shared/defaults/settings.js'
import { updateSettingsInMemory } from '../../../stores/settings.js'
import { buildNoteSkillInstructionContext } from '../note-skills.js'

const tempRoots: string[] = []

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-skills-'))
  tempRoots.push(root)
  return root
}

function parseContext(raw: string): Record<string, unknown> {
  const match = raw.match(/^<note_skill_context>\n([\s\S]+)\n<\/note_skill_context>$/)
  if (!match) throw new Error('missing note skill context')
  return JSON.parse(match[1]) as Record<string, unknown>
}

beforeEach(() => {
  const settings = createDefaultSettings()
  settings.general.editor = {
    ...settings.general.editor,
    markdownNoteAttachmentDirectory: 'assets',
  }
  updateSettingsInMemory(settings)
})

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
  updateSettingsInMemory(createDefaultSettings())
})

describe('note skills plugin', () => {
  it('injects the configured non-Obsidian note attachment directory', () => {
    const noteRoot = makeTempRoot()
    const skillDir = path.join(noteRoot, 'daily')
    fs.mkdirSync(skillDir, { recursive: true })

    const context = parseContext(buildNoteSkillInstructionContext({ skillDir, rootDir: noteRoot }))

    expect(context).toMatchObject({
      note_root: noteRoot,
      skill_directory: skillDir,
      note_system: 'note',
      attachment_directory: path.join(noteRoot, 'assets'),
      attachment_directory_available: true,
      attachment_directory_configured: true,
      attachment_source: 'settings.general.editor.markdownNoteAttachmentDirectory',
    })
  })

  it('injects Obsidian attachmentFolderPath for note skills inside a vault', () => {
    const vaultRoot = makeTempRoot()
    const skillDir = path.join(vaultRoot, 'skills', 'daily')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.mkdirSync(path.join(vaultRoot, '.obsidian'), { recursive: true })
    fs.writeFileSync(
      path.join(vaultRoot, '.obsidian', 'app.json'),
      JSON.stringify({ attachmentFolderPath: 'attachments' }),
      'utf-8',
    )

    const context = parseContext(buildNoteSkillInstructionContext({ skillDir, rootDir: vaultRoot }))

    expect(context).toMatchObject({
      note_root: vaultRoot,
      skill_directory: skillDir,
      note_system: 'obsidian',
      attachment_directory: path.join(vaultRoot, 'attachments'),
      attachment_directory_available: true,
      attachment_directory_configured: true,
      attachment_source: '.obsidian/app.json attachmentFolderPath',
    })
  })
})
