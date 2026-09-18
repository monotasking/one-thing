import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getExternalSkillsPaths, getUserSkillsPath, loadAllSkills } from '../loader.js'
import { registerPluginSkillRootProvider } from '@onething/runtime/skills/plugin-roots.wiring'
import { configureAppSkillsLoader } from '../loader.js'

/**
 * 勾了「技能来源」的笔记库(P3)。这里假的是 `skillVaultRootsNow()` —— 也就是
 * 笔记域交给技能加载器的那张根表。
 *
 * 反证:把 `wiring/skills/loader.ts` 的 `listCustomSkillRoots` 里那一行
 * `...skillVaultRootsNow()` 去掉,下面那条用例当场红(笔记库里的技能不再加载)。
 */
const noteVaults = vi.hoisted(() => ({ roots: [] as unknown[] }))
vi.mock('../../notes/index.js', () => ({ skillVaultRootsNow: () => noteVaults.roots }))

// Adapter wiring is an explicit assembly step now (no import-time config).
configureAppSkillsLoader()


vi.mock('electron', () => ({
  app: { isPackaged: false },
}))

const originalEnv = { ...process.env }
let tmpDir: string

beforeEach(() => {
  noteVaults.roots = []
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

  /**
   * 笔记库的技能走的是**自定义根那条 `custom:` 链路**(P3,正本 §4.4),不是
   * note-skills 插件那条 `plugin:<id>:<sha1>:<rel>`:后者的 id 里嵌绝对路径的
   * 哈希,挪一次库,settings 里针对这些技能的覆盖全成孤儿。
   */
  it('loads skills from a note vault marked as a skill source, on the custom lane', () => {
    const vaultRoot = path.join(tmpDir, 'workbook')
    writeSkill(
      path.join(vaultRoot, 'skills', 'note-taking'),
      'name: note-taking\ndescription: Take notes\nplatforms: [all]',
      'Write it down.',
    )
    noteVaults.roots = [{
      id: 'note-vault:v-work',
      path: vaultRoot,
      label: 'workbook',
      agentId: null,
      enabled: true,
      instructionContext: () => '<note_skill_context>{"note_system":"folder"}</note_skill_context>',
    }]

    const skill = loadAllSkills().find(item => item.name === 'note-taking')

    expect(skill?.source).toBe('custom')
    // id 按**库 id**,与路径无关 —— 挪库不改 id。
    expect(skill?.id).toBe('custom:note-vault:v-work:skills/note-taking')
    expect(skill?.runtimeContext).toBe('<note_skill_context>{"note_system":"folder"}</note_skill_context>')
  })
})
