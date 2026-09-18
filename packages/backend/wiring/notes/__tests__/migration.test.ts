/**
 * 迁移播种的单测。
 *
 * **每一条都把 `ONETHING_STORE_PATH` 钉在临时目录里**(08-18 C1 事故的判例:
 * 一条迁移单测清空了用户真实的 `oauth-tokens.json`)。备份与 `variables.json`
 * 的读取都走 `getOnethingStorePath()`,所以钉住环境变量就够 —— 这也是为什么
 * 迁移代码不许有模块级根。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/ipc.js'
import { createDefaultSettings } from '@shared/defaults/settings.js'

const mocks = vi.hoisted(() => ({
  settings: {} as AppSettings,
  saved: [] as AppSettings[],
}))

vi.mock('../../../stores/settings.js', () => ({
  getPersistedSettings: () => mocks.settings,
  savePersistedSettings: (next: AppSettings) => {
    mocks.saved.push(next)
    mocks.settings = next
  },
}))

const { migrateNotesSettings } = await import('../migration.js')

let tmpDir: string
let previousStorePath: string | undefined

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-notes-migration-'))
  previousStorePath = process.env.ONETHING_STORE_PATH
  process.env.ONETHING_STORE_PATH = tmpDir
  mocks.saved = []
  mocks.settings = createDefaultSettings()
  fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify(mocks.settings), 'utf-8')
})

afterEach(() => {
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const VAULTS = [
  { id: 'aaa', path: '/Users/me/note/workbook', open: true },
  { id: 'bbb', path: '/Users/me/note/notebook', open: true },
]

function ports(legacy: { userNoteDir?: string; workNoteDir?: string } = {}) {
  return {
    readObsidianVaults: async () => VAULTS,
    readLegacyNoteDirs: () => legacy,
    now: () => 1_700_000_000_000,
  }
}

function backups(): string[] {
  const dir = path.join(tmpDir, 'backups')
  return fs.existsSync(dir) ? fs.readdirSync(dir) : []
}

describe('四种播种情形', () => {
  it('纯 Obsidian(两个老变量都空):名册全部种成 enabled/skills:false', async () => {
    await expect(migrateNotesSettings(ports())).resolves.toBe('seeded')
    const notes = mocks.settings.notes!
    expect(notes.vaults).toEqual({
      aaa: { enabled: true, skills: false },
      bbb: { enabled: true, skills: false },
    })
    expect(notes.folders).toEqual([])
    expect(notes.primaryVaultId).toBeUndefined()
    expect(notes.migratedAt).toBe(1_700_000_000_000)
  })

  it('user 是某个库、work 不是:那个库 skills:true 且当主库,work 进 folders', async () => {
    await expect(migrateNotesSettings(ports({
      userNoteDir: '/Users/me/note/workbook/inbox',
      workNoteDir: '/Users/me/work-notes',
    }))).resolves.toBe('seeded')
    const notes = mocks.settings.notes!
    expect(notes.vaults.aaa).toEqual({ enabled: true, skills: true })
    expect(notes.vaults.bbb).toEqual({ enabled: true, skills: false })
    expect(notes.primaryVaultId).toBe('aaa')
    expect(notes.folders).toEqual(['/Users/me/work-notes'])
  })

  it('两个都不是库:都进 folders,没有主库', async () => {
    await expect(migrateNotesSettings(ports({
      userNoteDir: '/Users/me/personal',
      workNoteDir: '/Users/me/work',
    }))).resolves.toBe('seeded')
    const notes = mocks.settings.notes!
    expect(notes.folders).toEqual(['/Users/me/personal', '/Users/me/work'])
    expect(notes.primaryVaultId).toBeUndefined()
    expect(Object.values(notes.vaults).every(entry => entry.skills === false)).toBe(true)
  })

  it('settings.notes 已经配过:一个字不动,只盖标记', async () => {
    mocks.settings = {
      ...mocks.settings,
      notes: {
        systems: { obsidian: { enabled: false } },
        vaults: { zzz: { enabled: false, skills: true } },
        folders: ['/Users/me/mine'],
        primaryVaultId: 'zzz',
        dailyFormat: 'YYYY',
      },
    }
    await expect(migrateNotesSettings(ports({ userNoteDir: '/Users/me/note/workbook' })))
      .resolves.toBe('kept-existing-config')
    const notes = mocks.settings.notes!
    expect(notes.vaults).toEqual({ zzz: { enabled: false, skills: true } })
    expect(notes.folders).toEqual(['/Users/me/mine'])
    expect(notes.systems).toEqual({ obsidian: { enabled: false } })
    expect(notes.migratedAt).toBe(1_700_000_000_000)
  })
})

describe('幂等、备份、失败不写标记', () => {
  it('第二次是一次同步返回:不写盘、不再备份', async () => {
    await migrateNotesSettings(ports())
    const after = backups().length
    mocks.saved = []
    await expect(migrateNotesSettings(ports())).resolves.toBe('already-migrated')
    expect(mocks.saved).toHaveLength(0)
    expect(backups()).toHaveLength(after)
  })

  it('写之前把 settings.json 备份到 <store>/backups/', async () => {
    await migrateNotesSettings(ports())
    const files = backups()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^settings-before-notes-.*\.json$/)
    // 备份里是**迁移前**的那一份(没有 migratedAt)。
    const backed = JSON.parse(fs.readFileSync(path.join(tmpDir, 'backups', files[0]), 'utf-8')) as AppSettings
    expect(backed.notes?.migratedAt).toBeUndefined()
  })

  /**
   * **反证**:把 `migrateNotesSettings` 开头那句
   * `if (typeof settings.notes?.migratedAt === 'number') return 'already-migrated'`
   * 挖掉,上面那条幂等例立刻红(`mocks.saved` 会变成 1),而且这一条也红 ——
   * 用户删掉的库会被第二次启动种回来。
   */
  it('标记在就是幂等的唯一判据:用户后来删掉的库不会被种回来', async () => {
    await migrateNotesSettings(ports())
    mocks.settings = {
      ...mocks.settings,
      notes: { ...mocks.settings.notes!, vaults: { aaa: { enabled: false, skills: false } } },
    }
    await migrateNotesSettings(ports())
    expect(Object.keys(mocks.settings.notes!.vaults)).toEqual(['aaa'])
  })

  it('名册读取抛了 → failed,且不写标记(下次启动重跑)', async () => {
    await expect(migrateNotesSettings({
      readObsidianVaults: async () => { throw new Error('boom') },
      readLegacyNoteDirs: () => ({}),
      now: () => 1,
    })).resolves.toBe('failed')
    expect(mocks.settings.notes?.migratedAt).toBeUndefined()
    expect(mocks.saved).toHaveLength(0)
  })

  it('general.dailyNotes.format 有值就搬进 dailyFormat', async () => {
    mocks.settings = {
      ...mocks.settings,
      general: {
        ...mocks.settings.general,
        dailyNotes: { ...mocks.settings.general.dailyNotes!, format: 'YYYY/MM/DD' },
      },
    }
    await migrateNotesSettings(ports())
    expect(mocks.settings.notes!.dailyFormat).toBe('YYYY/MM/DD')
    // **不删** general.dailyNotes(P2 才删)。
    expect(mocks.settings.general.dailyNotes?.format).toBe('YYYY/MM/DD')
  })

  it('相对路径的老变量不进 folders(与 folders 的归一同口径)', async () => {
    await migrateNotesSettings(ports({ userNoteDir: 'notes/relative' }))
    expect(mocks.settings.notes!.folders).toEqual([])
  })
})
