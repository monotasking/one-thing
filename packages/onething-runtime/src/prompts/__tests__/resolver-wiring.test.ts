import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPrompt, setPromptsPathForTests } from '../store-bound.js'
import { displayContentForMessage, resolvePromptReferences } from '../resolver.wiring.js'
import {
  createPromptToken,
  createSkillToken,
  formatPromptForModel,
  formatSkillForModel,
} from '@shared/prompt-references.js'
import type { SkillDefinition } from '@shared/ipc.js'

let tmpDir: string

function formatExpectedSkill(skill: SkillDefinition): string {
  return formatSkillForModel(skill.name, skill.source, skill.description, skill.instructions, {
    path: skill.path,
    directoryPath: skill.directoryPath,
  })
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-resolver-'))
  setPromptsPathForTests(path.join(tmpDir, 'prompts.json'))
})

afterEach(async () => {
  setPromptsPathForTests(null)
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('prompt reference resolver', () => {
  it('leaves plain text unchanged', () => {
    const resolved = resolvePromptReferences('plain message')

    expect(resolved.modelContent).toBe('plain message')
    expect(resolved.displayContent).toBe('plain message')
    expect(resolved.contentParts).toBeUndefined()
    expect(resolved.missingPromptIds).toEqual([])
  })

  it('expands prompt tokens for the model and snapshots prompt parts for display', () => {
    const prompt = createPrompt({
      title: 'Review "Now"',
      body: 'Check correctness.',
      description: 'Review helper',
    })

    const resolved = resolvePromptReferences(`Before ${createPromptToken(prompt.id)} after`)

    expect(resolved.modelContent).toBe(`Before ${formatPromptForModel(prompt.title, prompt.body)} after`)
    expect(resolved.displayContent).toBe('Before [Prompt: Review "Now"] after')
    expect(resolved.contentParts).toEqual([
      { type: 'text', content: 'Before ' },
      {
        type: 'prompt-ref',
        promptId: prompt.id,
        title: prompt.title,
        content: prompt.body,
        description: prompt.description,
        bodyHash: expect.any(String),
      },
      { type: 'text', content: ' after' },
    ])
    expect(displayContentForMessage({
      content: resolved.modelContent,
      contentParts: resolved.contentParts,
    })).toBe(resolved.displayContent)
  })

  it('handles multiple and repeated prompt references', () => {
    const first = createPrompt({ title: 'First', body: 'One' })
    const second = createPrompt({ title: 'Second', body: 'Two' })

    const resolved = resolvePromptReferences([
      createPromptToken(first.id),
      ' + ',
      createPromptToken(second.id),
      ' + ',
      createPromptToken(first.id),
    ].join(''))

    expect(resolved.modelContent).toBe([
      formatPromptForModel('First', 'One'),
      ' + ',
      formatPromptForModel('Second', 'Two'),
      ' + ',
      formatPromptForModel('First', 'One'),
    ].join(''))
    expect(resolved.contentParts?.filter(part => part.type === 'prompt-ref')).toHaveLength(3)
  })

  it('keeps missing prompt tokens literal and reports the missing ids', () => {
    const resolved = resolvePromptReferences('Use {{prompt:missing-id}} now')

    expect(resolved.modelContent).toBe('Use {{prompt:missing-id}} now')
    expect(resolved.displayContent).toBe('Use {{prompt:missing-id}} now')
    expect(resolved.contentParts).toBeUndefined()
    expect(resolved.missingPromptIds).toEqual(['missing-id'])
  })

  it('expands selected skill tokens as skill invocation blocks for the model and snapshots skill parts for display', () => {
    const skill: SkillDefinition = {
      id: 'user:skill-development',
      name: 'Skill Development',
      description: 'Create or update skills',
      source: 'user',
      path: '/skills/skill-development/SKILL.md',
      directoryPath: '/skills/skill-development',
      enabled: true,
      instructions: 'Build skills carefully.',
    }

    const resolved = resolvePromptReferences(`Use ${createSkillToken(skill.id)} now`, { skills: [skill] })

    expect(resolved.modelContent).toBe(`Use ${formatExpectedSkill(skill)} now`)
    expect(resolved.modelContent).toContain('<skill name="Skill Development" location="/skills/skill-development/SKILL.md">')
    expect(resolved.modelContent).toContain('References are relative to /skills/skill-development.')
    expect(resolved.displayContent).toBe('Use [Skill: Skill Development] now')
    expect(resolved.contentParts).toEqual([
      { type: 'text', content: 'Use ' },
      {
        type: 'skill-ref',
        skillId: skill.id,
        name: skill.name,
        description: skill.description,
        source: skill.source,
        content: skill.instructions,
        bodyHash: expect.any(String),
      },
      { type: 'text', content: ' now' },
    ])
    expect(displayContentForMessage({
      content: resolved.modelContent,
      contentParts: resolved.contentParts,
    })).toBe(resolved.displayContent)
  })

  it('expands slash skill references as skill invocation blocks', () => {
    const skill: SkillDefinition = {
      id: 'user:skill-development',
      name: 'Skill Development',
      description: 'Create or update skills',
      source: 'user',
      path: '/skills/skill-development/SKILL.md',
      directoryPath: '/skills/skill-development',
      enabled: true,
      instructions: 'Build skills carefully.',
    }

    const resolved = resolvePromptReferences('/skill:Skill Development', { skills: [skill] })

    expect(resolved.modelContent).toBe(formatExpectedSkill(skill))
    expect(resolved.modelContent).toContain('<skill name="Skill Development" location="/skills/skill-development/SKILL.md">')
    expect(resolved.displayContent).toBe('[Skill: Skill Development]')
    expect(resolved.contentParts?.[0]).toMatchObject({
      type: 'skill-ref',
      skillId: skill.id,
      name: skill.name,
    })
  })

  it('expands bare slash skill references for the model', () => {
    const skill: SkillDefinition = {
      id: 'user:iva',
      name: 'iva',
      description: 'Use the IVA workflow',
      source: 'user',
      path: '/skills/iva/SKILL.md',
      directoryPath: '/skills/iva',
      enabled: true,
      instructions: 'Always use IVA steps.',
    }

    const resolved = resolvePromptReferences('/iva summarize this', { skills: [skill] })

    expect(resolved.modelContent).toBe(`${formatExpectedSkill(skill)} summarize this`)
    expect(resolved.displayContent).toBe('[Skill: iva] summarize this')
    expect(resolved.hasSkillReferences).toBe(true)
    expect(resolved.contentParts?.[0]).toMatchObject({
      type: 'skill-ref',
      skillId: skill.id,
      name: skill.name,
    })
  })

  it('matches slash skill references case-insensitively', () => {
    const skill: SkillDefinition = {
      id: 'user:iva',
      name: 'iva',
      description: 'Use the IVA workflow',
      source: 'user',
      path: '/skills/iva/SKILL.md',
      directoryPath: '/skills/iva',
      enabled: true,
      instructions: 'Always use IVA steps.',
    }

    const resolved = resolvePromptReferences('/IVA summarize this', { skills: [skill] })

    expect(resolved.modelContent).toBe(`${formatExpectedSkill(skill)} summarize this`)
    expect(resolved.displayContent).toBe('[Skill: iva] summarize this')
    expect(resolved.hasSkillReferences).toBe(true)
  })

  it('does not treat longer slash tokens as bare skill references', () => {
    const skill: SkillDefinition = {
      id: 'user:iva',
      name: 'iva',
      description: 'Use the IVA workflow',
      source: 'user',
      path: '/skills/iva/SKILL.md',
      directoryPath: '/skills/iva',
      enabled: true,
      instructions: 'Always use IVA steps.',
    }

    const resolved = resolvePromptReferences('/iva-extra summarize this', { skills: [skill] })

    expect(resolved.modelContent).toBe('/iva-extra summarize this')
    expect(resolved.displayContent).toBe('/iva-extra summarize this')
    expect(resolved.hasSkillReferences).toBe(false)
    expect(resolved.contentParts).toBeUndefined()
  })
})
