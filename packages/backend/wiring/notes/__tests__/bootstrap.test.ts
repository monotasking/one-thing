/**
 * 笔记子系统的接线单测:设置一保存就重问一遍驱动、disposer 退订、夹紧宿主为空表。
 *
 * 没有真的 Obsidian、没有子进程:`createNotesSubsystem` 在不可信宿主下**一个
 * 驱动都不注册**,而可信那一路这里只断言驱动注册进去了 + 订阅接上了
 * (驱动本身的行为由 `runtime/src/notes` 那几份单测钉住)。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppSettings } from '@shared/ipc.js'
import { createDefaultSettings } from '@shared/defaults/settings.js'
import {
  broadcastSettingsChanged,
  configureSettingsEventBroadcaster,
  getSettingsEventBroadcaster,
} from '../../settings/events.js'
import type { NoteSystemDriver, NoteSystemState } from '@onething/runtime/notes'
import { createNotesSubsystem, obsidianSocketPath, toNotesConfig } from '../index.js'
import { updateSettingsInMemory } from '../../../stores/settings.js'

let tmpDir: string
let previousStorePath: string | undefined

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-notes-bootstrap-'))
  previousStorePath = process.env.ONETHING_STORE_PATH
  process.env.ONETHING_STORE_PATH = tmpDir
  configureSettingsEventBroadcaster(null)
})

afterEach(() => {
  configureSettingsEventBroadcaster(null)
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function settingsWith(folders: string[]): AppSettings {
  const settings = createDefaultSettings()
  return { ...settings, notes: { ...settings.notes!, folders } }
}

describe('可信宿主', () => {
  it('两个驱动都注册,Obsidian 在前(同一个根它赢);注册不发任何命令', () => {
    const subsystem = createNotesSubsystem({ storePath: tmpDir, isLocallyTrusted: () => true })
    expect(subsystem.registry.registeredDriverIds()).toEqual(['obsidian', 'folder'])
    subsystem.dispose()
  })

  it('refresh 之后目录驱动的库在表里', async () => {
    const subsystem = createNotesSubsystem({ storePath: tmpDir, isLocallyTrusted: () => true })
    await subsystem.refresh(settingsWith([tmpDir]))
    // 根按 `path.resolve` 归一,**不解符号链接** —— 用户写什么就是什么。
    expect(subsystem.registry.vaults().map(v => v.root)).toEqual([path.resolve(tmpDir)])
    subsystem.dispose()
  })

  /**
   * 技能根(P3 §4.4):**勾了「技能来源」的库才进**。
   *
   * 反证:把 `skillVaultRoots` 里那道 `preferences[vault.id]?.skills === true`
   * 挖掉,第一段就会多出没勾的那个库 —— 也就是把一个用户没同意当技能来源的
   * 目录递给了技能加载器。
   */
  it('skillVaultRoots 只收勾了 skills 的库', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-notes-skills-'))
    try {
      const subsystem = createNotesSubsystem({ storePath: tmpDir, isLocallyTrusted: () => true })
      const settings = settingsWith([tmpDir, other])
      const folderId = (root: string): string => `folder:${path.resolve(root)}`
      settings.notes = {
        ...settings.notes!,
        vaults: { [folderId(tmpDir)]: { skills: true }, [folderId(other)]: { skills: false } },
      }
      updateSettingsInMemory(settings)
      await subsystem.refresh(settings)

      expect(subsystem.skillVaultRoots().map(root => root.path)).toEqual([path.resolve(tmpDir)])
      subsystem.dispose()
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('夹紧宿主', () => {
  /**
   * 判据是 `isHostLocallyTrusted()`(与 `rpc/sandbox.ts` 的 `confined` 同一个
   * 谓词),而且**每次 refresh 都问一遍**。驱动照样注册(注册不发命令),不可信
   * 那一档由空表表达。
   */
  it('不可信:驱动在册,但 refresh 之后是空表', async () => {
    const subsystem = createNotesSubsystem({ storePath: tmpDir, isLocallyTrusted: () => false })
    expect(subsystem.registry.registeredDriverIds()).toEqual(['obsidian', 'folder'])
    await subsystem.refresh(settingsWith([tmpDir]))
    expect(subsystem.registry.vaults()).toEqual([])
    expect(subsystem.registry.vaultFor(path.join(tmpDir, 'a.md'))).toBeNull()
    subsystem.dispose()
  })

  /**
   * **review ③ 的病:信任在装配时算一次,server 上就永远是空表。**
   *
   * `server:start` 装配时 host 表的 `localTrust` 是 null,它要到
   * `apps/server/src/main.ts` 决定绑回环之后才 `configureHostLocalTrust(...)`。
   *
   * **反证**:把 `refresh` 里的 `if (!trusted())` 那一段挖掉 → 第一次就不空,
   * 这条红;把它改回构造期算一次 → 第二次仍然空,这条也红。
   */
  it('信任会变:先 false 后 true,两次 refresh 的答案跟着变', async () => {
    let trusted = false
    const subsystem = createNotesSubsystem({ storePath: tmpDir, isLocallyTrusted: () => trusted })

    await subsystem.refresh(settingsWith([tmpDir]))
    expect(subsystem.registry.vaults()).toEqual([])

    // 这就是 server listen 时那一刻。
    trusted = true
    await subsystem.refresh(settingsWith([tmpDir]))
    expect(subsystem.registry.vaults().map(v => v.root)).toEqual([path.resolve(tmpDir)])

    // 反向也成立(可逆,不是一次性的)。
    trusted = false
    await subsystem.refresh(settingsWith([tmpDir]))
    expect(subsystem.registry.vaults()).toEqual([])
    subsystem.dispose()
  })

  it('refresh 不给 settings 就读当前设置缓存(宿主那一侧只喊一声)', async () => {
    const subsystem = createNotesSubsystem({ storePath: tmpDir, isLocallyTrusted: () => true })
    await expect(subsystem.refresh()).resolves.toBeUndefined()
    subsystem.dispose()
  })
})

describe('settings:changed 串联', () => {
  it('设置一保存就重问一遍驱动', async () => {
    const subsystem = createNotesSubsystem({ storePath: tmpDir, isLocallyTrusted: () => true })
    expect(subsystem.registry.vaults()).toEqual([])

    const folder = path.join(tmpDir, 'notes')
    fs.mkdirSync(folder, { recursive: true })
    broadcastSettingsChanged(settingsWith([folder]))
    // refresh 是异步的:等一拍。
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(subsystem.registry.vaults().map(v => v.root)).toEqual([folder])
    subsystem.dispose()
  })

  it('串联不占槽:宿主原来那条推送照跑', () => {
    const seen: string[] = []
    configureSettingsEventBroadcaster(() => seen.push('host'))
    const subsystem = createNotesSubsystem({ storePath: tmpDir, isLocallyTrusted: () => true })
    broadcastSettingsChanged(createDefaultSettings())
    expect(seen).toEqual(['host'])
    subsystem.dispose()
  })

  it('disposer 退订,并把槽还给上一位', async () => {
    const previous = (): void => undefined
    configureSettingsEventBroadcaster(previous)
    const subsystem = createNotesSubsystem({ storePath: tmpDir, isLocallyTrusted: () => true })
    expect(getSettingsEventBroadcaster()).not.toBe(previous)
    subsystem.dispose()
    expect(getSettingsEventBroadcaster()).toBe(previous)

    // 退订之后设置再变也不动库表。
    const folder = path.join(tmpDir, 'after')
    fs.mkdirSync(folder, { recursive: true })
    broadcastSettingsChanged(settingsWith([folder]))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(subsystem.registry.vaults()).toEqual([])
  })

  it('身份守卫:后来又有人串了一层时,还原不抹掉那一层', () => {
    const subsystem = createNotesSubsystem({ storePath: tmpDir, isLocallyTrusted: () => true })
    const later = (): void => undefined
    configureSettingsEventBroadcaster(later)
    subsystem.dispose()
    expect(getSettingsEventBroadcaster()).toBe(later)
  })
})

/**
 * **「有没有状态可说」由驱动自述**(P4 review 打回的那一条)。
 *
 * 装配层从前拿一张 `Map<驱动 id, 取状态的闭包>` 枚举,于是加一种笔记系统除了
 * 「一行 register」还得往那张表上补一行,而且两个 Obsidian 的名字因此进了
 * wiring 文件。改成驱动自述之后,判据变成「这个驱动实不实现 `state()`」——
 * 下面两只假驱动就是这条判据的两端。
 */
describe('系统状态由驱动自述', () => {
  /** 一只最小的假驱动。`state` 给了就答得出,不给就是「这个问题对我不成立」。 */
  function fakeDriver(id: string, state?: () => Promise<NoteSystemState>): NoteSystemDriver {
    return state === undefined
      ? { id, discover: async () => [] }
      : { id, discover: async () => [], state }
  }

  it('inventory().systems 只收答得出的那些 —— 不答的那只一格都没有', async () => {
    const subsystem = createNotesSubsystem({ storePath: tmpDir, isLocallyTrusted: () => true })
    subsystem.registry.register(fakeDriver('has-app', async () => 'not-running'))
    subsystem.registry.register(fakeDriver('no-app'))
    try {
      const { systems } = await subsystem.inventory(createDefaultSettings())
      expect(systems['has-app']).toBe('not-running')
      expect('no-app' in systems).toBe(false)
    } finally {
      subsystem.dispose()
    }
  })

  it('systemState(id) 走的是同一条:不在册 / 不答 都是 undefined', async () => {
    const subsystem = createNotesSubsystem({ storePath: tmpDir, isLocallyTrusted: () => true })
    subsystem.registry.register(fakeDriver('has-app', async () => 'running'))
    subsystem.registry.register(fakeDriver('no-app'))
    try {
      expect(await subsystem.systemState('has-app')).toBe('running')
      expect(await subsystem.systemState('no-app')).toBeUndefined()
      expect(await subsystem.systemState('never-registered')).toBeUndefined()
    } finally {
      subsystem.dispose()
    }
  })

  it('驱动的 state() 抛了不拖累别人:那一格退成「没装」,别的驱动照答', async () => {
    const subsystem = createNotesSubsystem({ storePath: tmpDir, isLocallyTrusted: () => true })
    subsystem.registry.register(fakeDriver('angry', async () => { throw new Error('boom') }))
    subsystem.registry.register(fakeDriver('calm', async () => 'running'))
    try {
      const { systems } = await subsystem.inventory(createDefaultSettings())
      expect(systems['angry']).toBe('not-installed')
      expect(systems['calm']).toBe('running')
    } finally {
      subsystem.dispose()
    }
  })

  it('夹紧的宿主上一个驱动都不问', async () => {
    const subsystem = createNotesSubsystem({ storePath: tmpDir, isLocallyTrusted: () => false })
    let asked = 0
    subsystem.registry.register(fakeDriver('has-app', async () => { asked += 1; return 'running' }))
    try {
      expect(await subsystem.inventory(createDefaultSettings())).toEqual({ vaults: [], systems: {} })
      expect(await subsystem.systemState('has-app')).toBeUndefined()
      expect(asked).toBe(0)
    } finally {
      subsystem.dispose()
    }
  })
})

describe('配置投影与 socket 路径', () => {
  it('toNotesConfig 只做形状转换;附件目录只认 notes 自己那一格(P3 起唯一一格)', () => {
    const settings = createDefaultSettings()
    // 老的 `general.editor.markdownNoteAttachmentDirectory` 已删,它的值由
    // `mergeWithDefaults` 一次性搬进 `notes.attachmentDirectory`(见 settings.test)。
    expect(toNotesConfig(settings).attachmentDirectory).toBeUndefined()

    settings.notes = { ...settings.notes!, attachmentDirectory: 'own' }
    expect(toNotesConfig(settings).attachmentDirectory).toBe('own')
  })

  it('notes 整格缺席时也答得出一份配置(老 settings.json)', () => {
    const settings = createDefaultSettings()
    delete settings.notes
    expect(toNotesConfig(settings)).toMatchObject({
      // 空表 = 全开;这里不出现任何一个笔记系统的名字。
      systems: {},
      vaults: {},
      folders: [],
      dailyFormat: 'YYYY-MM-DD',
    })
  })

  it('mac/linux 有 socket,win32 是 null(探活待补,不猜一个 named pipe)', () => {
    expect(obsidianSocketPath('darwin', '/Users/me')).toBe('/Users/me/.obsidian-cli.sock')
    expect(obsidianSocketPath('linux', '/home/me')).toBe('/home/me/.obsidian-cli.sock')
    expect(obsidianSocketPath('win32', 'C:\\Users\\me')).toBeNull()
  })
})
