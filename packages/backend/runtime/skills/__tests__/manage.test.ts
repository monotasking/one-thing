import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  executeSkillManage,
  previewSkillManage,
  type OnethingSkillManageAdapters,
} from '../manage.js'
import type { SkillDefinition } from '../types.js'

let root = ''

function loadSkills(): SkillDefinition[] {
  const skills: SkillDefinition[] = []
  if (!fs.existsSync(root)) return skills

  const scan = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        scan(fullPath)
        continue
      }
      if (entry.name !== 'SKILL.md') continue
      const directoryPath = path.dirname(fullPath)
      const content = fs.readFileSync(fullPath, 'utf-8')
      const name = path.basename(directoryPath)
      skills.push({
        id: `user:${name}`,
        name,
        description: content.match(/description:\s*"?([^"\n]+)"?/)?.[1]?.trim() ?? name,
        source: 'user',
        path: fullPath,
        directoryPath,
        rootPath: root,
        enabled: true,
        instructions: content,
      })
    }
  }

  scan(root)
  return skills
}

function adapters(): OnethingSkillManageAdapters {
  return {
    getUserSkillsPath: () => root,
    loadAllSkills: loadSkills,
  }
}

describe('onething skill_manage runtime', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-runtime-skills-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('creates, reads, patches, and deletes skills through host adapters', () => {
    const options = { adapters: adapters() }

    const created = executeSkillManage({
      action: 'create',
      name: 'daily-review',
      description: 'Review daily notes',
      instructions: 'Summarize open loops.',
    }, options)

    expect(created.success).toBe(true)
    expect(created.skill?.name).toBe('daily-review')
    expect(fs.existsSync(path.join(root, 'daily-review', 'SKILL.md'))).toBe(true)

    const preview = previewSkillManage({
      action: 'patch',
      name: 'daily-review',
      old_string: 'Summarize open loops.',
      new_string: 'Summarize open loops and decisions.',
    }, options)
    expect(preview.mutated).toBe(true)
    expect(preview.additions).toBeGreaterThan(0)

    const patched = executeSkillManage({
      action: 'patch',
      name: 'daily-review',
      old_string: 'Summarize open loops.',
      new_string: 'Summarize open loops and decisions.',
    }, options)
    expect(patched.success).toBe(true)

    const read = executeSkillManage({ action: 'read', name: 'daily-review' }, options)
    expect(read.output).toContain('decisions')

    const deleted = executeSkillManage({ action: 'delete', name: 'daily-review' }, options)
    expect(deleted.success).toBe(true)
    expect(fs.existsSync(path.join(root, 'daily-review'))).toBe(false)
  })
})
