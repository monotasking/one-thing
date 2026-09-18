/**
 * notes 域(P4)。钉五件:
 *  ① 四态判法(`judgeObsidianState` 逐条);
 *  ② 缺席算什么(`enabled` 缺席开 / `skills` 缺席关 / `isOpen` 缺席 = true);
 *  ③ 不可信宿主答空表,而且**连名册都不读**(子系统一次都没被问到);
 *  ④ `openInApp` **才**带 `mayLaunch: true`,`list` / `refresh` 一条命令都不发;
 *  ⑤ `refresh` 会重问驱动,`list` 不会(看一眼没有副作用)。
 *
 * 三个被替掉的依赖(子系统 / 设置缓存 / 信任谓词)都是模块级单槽,所以这里用
 * `vi.mock` 换整只模块 —— 起一台真 backend 只为了问一句「名册长什么样」是本末倒置。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/ipc.js'
import { judgeObsidianState, NoteVaultUnavailable, type NoteVault } from '@onething/runtime/notes'
import type { NotesInventory } from '../../wiring/notes/index.js'

const state = {
  trusted: true,
  settings: {} as AppSettings,
  inventory: { vaults: [], systems: {} } as NotesInventory,
  /** 子系统被问了几次(③ 的反证靠它)。 */
  inventoryCalls: 0,
  refreshCalls: 0,
  vaultById: new Map<string, NoteVault>(),
}

/** `openInApp` 收到的那份选项 —— ④ 的证物。 */
const opened: Array<{ vaultId: string; path: string; mayLaunch: boolean | undefined }> = []

vi.mock('../../server/host-trust.js', () => ({
  isHostLocallyTrusted: () => state.trusted,
}))

vi.mock('../../stores/settings.js', () => ({
  getSettings: () => state.settings,
}))

vi.mock('../../wiring/notes/index.js', () => ({
  getNotesSubsystem: () => ({
    registry: { vault: (id: string) => state.vaultById.get(id) ?? null },
    inventory: async () => {
      state.inventoryCalls += 1
      return state.inventory
    },
    refresh: async () => {
      state.refreshCalls += 1
    },
  }),
}))

const { notesRpcHandlers, toVaultDto } = await import('../domains/notes.js')

/** 一只最小的库替身。`openInApp` 把收到的选项记下来。 */
function fakeVault(over: Partial<NoteVault> & { id: string }): NoteVault {
  const vault = {
    id: over.id,
    name: over.name ?? over.id,
    root: over.root ?? `/vaults/${over.id}`,
    system: over.system ?? 'obsidian',
    isOpen: over.isOpen,
    openInApp: over.openInApp,
  } as unknown as NoteVault
  return vault
}

function settingsWithNotes(notes: AppSettings['notes']): AppSettings {
  return { notes } as unknown as AppSettings
}

beforeEach(() => {
  state.trusted = true
  state.settings = settingsWithNotes({ systems: {}, vaults: {}, folders: [], dailyFormat: 'YYYY-MM-DD' })
  state.inventory = { vaults: [], systems: {} }
  state.inventoryCalls = 0
  state.refreshCalls = 0
  state.vaultById = new Map()
  opened.length = 0
})

// ── ① 四态判法 ─────────────────────────────────────────────

describe('Obsidian 的四态', () => {
  it('名册读不到 = 没装(后面两个读数在这台机器上都答 false,不许照它们说话)', () => {
    expect(judgeObsidianState({ sourcePath: null, cliRegistered: false }, false)).toBe('not-installed')
    // 名册不在时,哪怕探活莫名其妙答了 true 也还是「没装」。
    expect(judgeObsidianState({ sourcePath: null, cliRegistered: true }, true)).toBe('not-installed')
  })

  it('名册在、命令行通道没开 = cli-not-registered(排在探活前面)', () => {
    expect(judgeObsidianState({ sourcePath: '/o.json', cliRegistered: false }, false))
      .toBe('cli-not-registered')
  })

  it('探不出来(win32)也算 cli-not-registered —— 不确定不许当活着', () => {
    expect(judgeObsidianState({ sourcePath: '/o.json', cliRegistered: true }, null))
      .toBe('cli-not-registered')
  })

  it('通道开着,探活说了算', () => {
    expect(judgeObsidianState({ sourcePath: '/o.json', cliRegistered: true }, false)).toBe('not-running')
    expect(judgeObsidianState({ sourcePath: '/o.json', cliRegistered: true }, true)).toBe('running')
  })
})

// ── ② 缺席算什么 ───────────────────────────────────────────

describe('一行的三格开关', () => {
  it('enabled 缺席 = 开;skills 缺席 = 关;isOpen 缺席 = true', () => {
    const dto = toVaultDto(fakeVault({ id: 'a' }), { systems: {}, vaults: {}, folders: [], dailyFormat: '' })
    expect(dto).toMatchObject({ enabled: true, skills: false, open: true, primary: false })
  })

  it('显式 false 照旧是 false;主库按 primaryVaultId 认', () => {
    const dto = toVaultDto(fakeVault({ id: 'a', isOpen: false }), {
      systems: {},
      vaults: { a: { enabled: false, skills: true } },
      folders: [],
      dailyFormat: '',
      primaryVaultId: 'a',
    })
    expect(dto).toMatchObject({ enabled: false, skills: true, open: false, primary: true })
  })
})

// ── ③ 不可信宿主 ───────────────────────────────────────────

describe('夹紧的宿主', () => {
  it('list 答空表,而且连子系统都没问', async () => {
    state.trusted = false
    state.inventory = { vaults: [fakeVault({ id: 'a' })], systems: { obsidian: 'running' } }
    state.settings = settingsWithNotes({
      systems: {}, vaults: {}, folders: ['/notes'], dailyFormat: '',
    })

    expect(await notesRpcHandlers.list({})).toEqual({ systems: {}, vaults: [], folders: [], dailyFormat: '' })
    expect(state.inventoryCalls).toBe(0)
  })

  it('refresh 不重问驱动,openInApp 一律 not-found', async () => {
    state.trusted = false
    state.vaultById.set('a', fakeVault({ id: 'a', openInApp: async () => undefined }))

    expect(await notesRpcHandlers.refresh({})).toEqual({ systems: {}, vaults: [], folders: [], dailyFormat: '' })
    expect(state.refreshCalls).toBe(0)
    expect(await notesRpcHandlers.openInApp({ vaultId: 'a' })).toEqual({ ok: false, reason: 'not-found' })
    expect(opened).toEqual([])
  })
})

// ── ④ 谁带 mayLaunch ───────────────────────────────────────

describe('前台动作只有一条', () => {
  function openable(id: string): NoteVault {
    return fakeVault({
      id,
      openInApp: async (target: string, options?: { mayLaunch?: boolean }) => {
        opened.push({ vaultId: id, path: target, mayLaunch: options?.mayLaunch })
      },
    })
  }

  it('list 与 refresh 一条命令都不发', async () => {
    state.vaultById.set('a', openable('a'))
    state.inventory = { vaults: [state.vaultById.get('a')!], systems: { obsidian: 'running' } }

    await notesRpcHandlers.list({})
    await notesRpcHandlers.refresh({})
    expect(opened).toEqual([])
  })

  it('openInApp 带 mayLaunch: true —— 用户按的那一下', async () => {
    state.vaultById.set('a', openable('a'))
    expect(await notesRpcHandlers.openInApp({ vaultId: 'a', path: 'x.md' })).toEqual({ ok: true })
    expect(opened).toEqual([{ vaultId: 'a', path: 'x.md', mayLaunch: true }])
  })

  it('path 缺席 = 把库本身唤到前台', async () => {
    state.vaultById.set('a', openable('a'))
    await notesRpcHandlers.openInApp({ vaultId: 'a' })
    expect(opened[0]!.path).toBe('/vaults/a')
  })

  it('不在册的库 / 没有这件事的系统 / 领域拒绝,三种回执各不相同', async () => {
    expect(await notesRpcHandlers.openInApp({ vaultId: 'nope' })).toEqual({ ok: false, reason: 'not-found' })

    state.vaultById.set('folder', fakeVault({ id: 'folder', system: 'folder' }))
    expect(await notesRpcHandlers.openInApp({ vaultId: 'folder' }))
      .toEqual({ ok: false, reason: 'unsupported' })

    state.vaultById.set('shut', fakeVault({
      id: 'shut',
      openInApp: async () => { throw new NoteVaultUnavailable('vault-not-open', 'shut') },
    }))
    expect(await notesRpcHandlers.openInApp({ vaultId: 'shut' }))
      .toEqual({ ok: false, reason: 'vault-not-open' })
  })
})

// ── ⑤ 看一眼没有副作用 ─────────────────────────────────────

describe('list 与 refresh 的分工', () => {
  beforeEach(() => {
    state.inventory = {
      vaults: [fakeVault({ id: 'a', name: 'workbook', root: '/v/workbook' })],
      systems: { obsidian: 'not-running' },
    }
    state.settings = settingsWithNotes({
      systems: {}, vaults: { a: { skills: true } }, folders: ['/plain'], dailyFormat: 'YYYY-MM-DD',
    })
  })

  it('list 只投影,不换在册的那张表', async () => {
    const answer = await notesRpcHandlers.list({})
    expect(state.refreshCalls).toBe(0)
    expect(state.inventoryCalls).toBe(1)
    expect(answer.systems).toEqual({ obsidian: { state: 'not-running', enabled: true } })
    expect(answer.dailyFormat).toBe('YYYY-MM-DD')
    expect(answer.folders).toEqual(['/plain'])
    expect(answer.vaults).toHaveLength(1)
    expect(answer.vaults[0]).toMatchObject({ id: 'a', name: 'workbook', skills: true, enabled: true })
  })

  it('refresh 先重问驱动再答', async () => {
    await notesRpcHandlers.refresh({})
    expect(state.refreshCalls).toBe(1)
    expect(state.inventoryCalls).toBe(1)
  })
})
