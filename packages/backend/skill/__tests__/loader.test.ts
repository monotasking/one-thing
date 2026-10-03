import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  configureOnethingSkillsLoaderRuntime,
  findProjectSkillPaths,
  getUserSkillsPath,
  loadAllSkills,
} from '../loader.js'
import type { PluginSkillRoot, SkillDirectoryConfig } from '../types.js'

let root = ''
let storePath = ''
let projectDir = ''
let pluginRoot = ''
let customRoot = ''
let customRoots: SkillDirectoryConfig[] = []

function writeSkill(skillsRoot: string, dirname: string, name = dirname): void {
  const dir = path.join(skillsRoot, dirname)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), [
    '---',
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(`${name} description`)}`,
    '---',
    '',
    `${name} instructions`,
    '',
  ].join('\n'), 'utf-8')
}

describe('onething skills loader runtime', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-runtime-loader-'))
    storePath = path.join(root, 'store')
    projectDir = path.join(root, 'workspace', 'app')
    pluginRoot = path.join(root, 'plugin-skills')
    customRoot = path.join(root, 'custom-skills')
    customRoots = []

    const builtinRoot = path.join(root, 'resources', 'skills')
    const userRoot = path.join(storePath, 'skills')
    const projectRoot = path.join(projectDir, '.onething', 'skills')

    writeSkill(builtinRoot, 'shared')
    writeSkill(builtinRoot, 'builtin-only')
    writeSkill(pluginRoot, 'shared')
    writeSkill(pluginRoot, 'plugin-only')
    writeSkill(userRoot, 'shared')
    writeSkill(userRoot, 'user-only')
    writeSkill(projectRoot, 'shared')
    writeSkill(projectRoot, 'project-only')

    configureOnethingSkillsLoaderRuntime({
      getStorePath: () => storePath,
      getCwd: () => root,
      isPackaged: () => false,
      listPluginSkillRoots: (): PluginSkillRoot[] => [{
        pluginId: 'plugin-a',
        path: pluginRoot,
      }],
      listCustomSkillRoots: () => customRoots,
    })
  })

  afterEach(() => {
    configureOnethingSkillsLoaderRuntime(undefined)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('loads app, project, plugin, and builtin skills through host adapters', () => {
    expect(getUserSkillsPath()).toBe(path.join(storePath, 'skills'))
    expect(findProjectSkillPaths(projectDir)).toEqual([
      path.join(projectDir, '.onething', 'skills'),
    ])

    const skills = loadAllSkills(projectDir)
    const byName = new Map(skills.map(skill => [skill.name, skill]))

    expect(byName.get('shared')?.source).toBe('project')
    expect(byName.get('project-only')?.source).toBe('project')
    expect(byName.get('user-only')?.source).toBe('user')
    expect(byName.get('plugin-only')?.source).toBe('plugin')
    expect(byName.get('builtin-only')?.source).toBe('builtin')
  })

  it('loads custom roots with stable ids and agent bindings, skipping disabled or missing roots', () => {
    writeSkill(customRoot, 'shared')
    writeSkill(customRoot, 'custom-only')
    customRoots = [
      { id: 'dir-1', path: customRoot, agentId: 'writer', enabled: true },
      { id: 'dir-off', path: customRoot, enabled: false },
      { id: 'dir-missing', path: path.join(root, 'nope'), enabled: true },
    ]

    const skills = loadAllSkills()
    const byName = new Map(skills.map(skill => [skill.name, skill]))

    const customOnly = byName.get('custom-only')
    expect(customOnly?.source).toBe('custom')
    expect(customOnly?.id).toBe('custom:dir-1:custom-only')
    expect(customOnly?.agentId).toBe('writer')
    // Name collision: user root outranks custom roots.
    expect(byName.get('shared')?.source).toBe('user')
    // Disabled and missing roots contribute nothing extra.
    expect(skills.filter(skill => skill.source === 'custom')).toHaveLength(1)
  })

  /**
   * 接入目录(五件套之四:技能发现根)复用的就是上面这条自定义根链路 ——
   * `app/stores/connected-directories.ts` 把每个接入目录投影成一个
   * `SkillDirectoryConfig`,id 形如 `connected:<绝对路径>`。
   *
   * 这里用**投影后的确切形状**跑一遍,证明复用是真的通的:递归发现、
   * id 与路径解耦、不存在的目录静默跳过。
   */
  describe('connected directories reuse the custom-root path', () => {
    it('递归发现嵌套 SKILL.md,id 走 custom:<connected:...> 前缀', () => {
      const connectedRoot = path.join(root, 'vault')
      writeSkill(connectedRoot, 'top-level')
      writeSkill(path.join(connectedRoot, 'nested', 'deep'), 'buried')

      // listConnectedSkillRoots() 的输出形状,逐字段照抄。
      customRoots = [{
        id: `connected:${connectedRoot}`,
        path: connectedRoot,
        label: connectedRoot,
        agentId: null,
        enabled: true,
      }]

      const byName = new Map(loadAllSkills().map(skill => [skill.name, skill]))

      expect(byName.get('top-level')?.source).toBe('custom')
      expect(byName.get('top-level')?.id).toBe(`custom:connected:${connectedRoot}:top-level`)
      // 递归:嵌在两层子目录里的技能同样被发现。
      expect(byName.get('buried')?.source).toBe('custom')
      expect(byName.get('buried')?.id).toBe(`custom:connected:${connectedRoot}:nested/deep/buried`)
    })

    it('配置了但不存在的接入目录被静默跳过,不影响其它目录', () => {
      const connectedRoot = path.join(root, 'vault')
      writeSkill(connectedRoot, 'alive')

      customRoots = [
        { id: `connected:${connectedRoot}`, path: connectedRoot, agentId: null, enabled: true },
        { id: 'connected:/nope/gone', path: '/nope/gone', agentId: null, enabled: true },
      ]

      const skills = loadAllSkills()

      expect(skills.filter(skill => skill.source === 'custom').map(skill => skill.name)).toEqual(['alive'])
    })

    it('空接入目录列表不引入任何 custom 技能(与没有这个功能时一致)', () => {
      customRoots = []
      expect(loadAllSkills().filter(skill => skill.source === 'custom')).toEqual([])
    })
  })
})
