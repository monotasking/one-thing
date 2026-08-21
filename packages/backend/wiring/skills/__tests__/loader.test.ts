import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getExternalSkillsPaths, getUserSkillsPath, loadAllSkills } from '../loader.js'
import { registerPluginSkillRootProvider } from '@onething/runtime/skills/plugin-roots.wiring'
import { configureAppSkillsLoader } from '../loader.js'

// Adapter wiring is an explicit assembly step now (no import-time config).
configureAppSkillsLoader()


vi.mock('electron', () => ({
  app: { isPackaged: false },
}))

const originalEnv = { ...process.env }
let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-hermes-skills-'))
  process.env.HOME = tmpDir
  delete process.env.HERMES_HOME
  delete process.env.HERMES_SKILLS_DIR
  delete process.env.CLAUDE_SKILLS_DIR
  delete process.env.EXTERNAL_SKILL_ROOT
})

afterEach(() => {
  process.env = { ...originalEnv }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeSkill(skillDir: string, frontmatter: string, body = 'Follow this skill.'): void {
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf-8')
}

describe('Hermes skills loader', () => {
  it('loads recursive app-owned project skills with Hermes metadata', () => {
    const projectDir = path.join(tmpDir, 'project')
    const skillDir = path.join(projectDir, '.onething', 'skills', 'writing', 'docs')
    writeSkill(
      skillDir,
      [
        'name: docs-polish',
        'description: Improve documentation writing',
        'platforms: [all]',
        'metadata:',
        '  hermes:',
        '    tags: [docs, writing]',
        '    related_skills: [style-guide]',
        '    fallback_for_tools: [docgen]',
      ].join('\n'),
    )
    const referenceDir = path.join(skillDir, 'references')
    fs.mkdirSync(referenceDir, { recursive: true })
    fs.writeFileSync(path.join(referenceDir, 'style.md'), 'Style notes', 'utf-8')

    const skills = loadAllSkills(projectDir)
    const skill = skills.find(item => item.name === 'docs-polish')

    expect(skill).toMatchObject({
      id: 'project:writing/docs',
      category: 'writing',
      rootPath: path.join(projectDir, '.onething', 'skills'),
      relativePath: 'writing/docs/SKILL.md',
      tags: ['docs', 'writing'],
      relatedSkills: ['style-guide'],
      conditions: { fallbackForTools: ['docgen'] },
    })
    expect(skill?.files?.map(file => file.name)).toContain('references/style.md')
  })

  it('uses only app-owned roots and skips unsupported platforms', () => {
    const externalRoot = path.join(tmpDir, 'external-skills')
    process.env.HERMES_HOME = path.join(tmpDir, '.hermes')
    process.env.HERMES_SKILLS_DIR = externalRoot
    process.env.CLAUDE_SKILLS_DIR = externalRoot
    process.env.EXTERNAL_SKILL_ROOT = externalRoot

    fs.mkdirSync(path.join(tmpDir, '.onething'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, '.onething', 'skills.yaml'),
      'skills:\n  external_dirs:\n    - $EXTERNAL_SKILL_ROOT\n',
      'utf-8',
    )

    writeSkill(
      path.join(externalRoot, 'coding', 'review'),
      'name: code-review\ndescription: Review code carefully\nplatforms: [all]',
    )
    const unsupportedPlatform = process.platform === 'win32' ? 'linux' : 'windows'
    writeSkill(
      path.join(getUserSkillsPath(), 'windows-only'),
      `name: windows-only\ndescription: Unsupported platform skill\nplatforms: [${unsupportedPlatform}]`,
    )

    expect(getExternalSkillsPaths()).toEqual([])

    const skills = loadAllSkills()
    const externalSkill = skills.find(item => item.name === 'code-review')

    expect(externalSkill).toBeUndefined()
    expect(skills.some(item => item.name === 'windows-only')).toBe(false)
  })

  it('loads disable-model-invocation from skill frontmatter', () => {
    const skillDir = path.join(getUserSkillsPath(), 'manual-only')
    writeSkill(
      skillDir,
      'name: manual-only\ndescription: Use only when explicitly selected\nplatforms: [all]\ndisable-model-invocation: true',
    )

    const skill = loadAllSkills().find(item => item.name === 'manual-only')

    expect(skill?.disableModelInvocation).toBe(true)
  })

  it('appends plugin instruction context to loaded skill instructions', () => {
    const noteRoot = path.join(tmpDir, 'notes')
    const skillDir = path.join(noteRoot, 'daily-note')
    writeSkill(
      skillDir,
      'name: daily-note\ndescription: Use daily note context\nplatforms: [all]',
      'Follow the note workflow.',
    )

    const unregister = registerPluginSkillRootProvider('note-skills', () => [{
      pluginId: 'note-skills',
      path: noteRoot,
      source: 'plugin',
      recursive: true,
      instructionContext: ({ skillDir: loadedSkillDir, rootDir }) =>
        `<note_skill_context>${path.basename(rootDir)}:${path.basename(loadedSkillDir)}</note_skill_context>`,
    }])

    try {
      const skill = loadAllSkills().find(item => item.name === 'daily-note')

      expect(skill?.instructions).toContain('Follow the note workflow.')
      expect(skill?.instructions).toContain('<note_skill_context>notes:daily-note</note_skill_context>')
      expect(skill?.runtimeContext).toBe('<note_skill_context>notes:daily-note</note_skill_context>')
    } finally {
      unregister()
    }
  })
})
