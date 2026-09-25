import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NotesSettings, isKnownVault } from '../NotesSettings'
import { configureNotesPort, type NotesPort } from '../../../data/notes-port'
import { resetNotesSourceForTest } from '../../../data/notes-source'
import { useOpenDirDialog } from '../../files/open-dir-hub'
import { configureDialogPort } from '../../../data/dialog-port'
import type { AppSettings } from '@shared/ipc/settings'
import type { NotesListResponse, NoteVaultDto } from '@shared/ipc/notes'
import { t } from '../../../i18n'

/**
 * 设置页「笔记」那一页(P4)。钉六件:
 *  ① 四态各说一句话,`not-installed` 那一档**库表整块不画**;
 *  ② 写路**只碰 `notes`** —— 写回去那份与读进来那份除了 `notes` 逐键相同;
 *  ③ 总开关关掉之后**行内三件全禁**(而「启用」那一颗也禁 —— 系统关了,单个库
 *     的开关没有意义;开回来走的是总开关);
 *  ④ `open: false` 的行多一行小字,而且**那一行仍然在表里**;
 *  ⑤ 「添加目录…」认一条不存在的路径 → 就地一行错话,零通知、零写盘;
 *  ⑥ 挑到一个已经是库的目录 → 另一句错话。
 */

const BASE_SETTINGS: AppSettings = {
  ai: {} as AppSettings['ai'],
  theme: 'dark',
  general: { locale: 'zh' } as unknown as AppSettings['general'],
  tools: {} as AppSettings['tools'],
  notes: { systems: {}, vaults: {}, folders: [], dailyFormat: 'YYYY-MM-DD' },
}

function vault(over: Partial<NoteVaultDto> & { id: string }): NoteVaultDto {
  return {
    id: over.id,
    name: over.name ?? over.id,
    root: over.root ?? `/vaults/${over.id}`,
    system: over.system ?? 'obsidian',
    open: over.open ?? true,
    enabled: over.enabled ?? true,
    skills: over.skills ?? false,
    primary: over.primary ?? false,
  }
}

interface Fake extends NotesPort {
  settings: AppSettings
  list_: NotesListResponse
  saves: AppSettings[]
  /** `files.stat` 认得出的目录。不在表里 = 不存在。 */
  dirs: Set<string>
  /** 「打开」按下去的实参(P5)。**「一条都没发」全靠数它。** */
  opened: Array<{ vaultId: string; path?: string }>
  openResult: { ok: boolean; reason?: string }
}

function fakePort(list: NotesListResponse, settings: AppSettings = BASE_SETTINGS): Fake {
  const fake: Fake = {
    settings,
    list_: list,
    saves: [],
    dirs: new Set(),
    opened: [],
    openResult: { ok: true },
    ready: async () => undefined,
    list: async () => fake.list_,
    refresh: async () => fake.list_,
    openInApp: async (vaultId, path) => {
      fake.opened.push({ vaultId, ...(path === undefined ? {} : { path }) })
      return fake.openResult
    },
    readSettings: async () => ({ success: true, settings: fake.settings }),
    saveSettings: async (next) => {
      fake.saves.push(next)
      fake.settings = next
      return { success: true, settings: next }
    },
    stat: async (path) =>
      fake.dirs.has(path)
        ? { success: true, type: 'directory', path }
        : { success: false, error: 'ENOENT' },
    onSettingsChanged: () => () => {},
  }
  return fake
}

function emptyList(over: Partial<NotesListResponse> = {}): NotesListResponse {
  return { systems: {}, vaults: [], folders: [], dailyFormat: '', ...over }
}

afterEach(() => {
  configureNotesPort(undefined)
  resetNotesSourceForTest()
  useOpenDirDialog.getState().setOpen(false)
  configureDialogPort(undefined)
})

beforeEach(() => {
  resetNotesSourceForTest()
  // 「添加目录…」先问系统对话框;这里钉的是没有对话框时退到的那扇路径输入窗。
  configureDialogPort({ showOpen: async () => ({ canceled: true, filePaths: [], unavailable: true }) })
})

/** 画出来,并等第一发取数落定。 */
async function mount(port: NotesPort): Promise<void> {
  configureNotesPort(port)
  // 第一发取数在挂载的 effect 里,落定时会推一次屏 —— 包进 act 才不会在别的
  // 用例里冒出「update was not wrapped in act」。
  await act(async () => {
    render(<NotesSettings />)
  })
  await waitFor(() => expect(screen.queryByTestId('notes-obsidian-state')).not.toBeNull())
}

// ── ① 四态 ────────────────────────────────────────────────

describe('状态句', () => {
  const cases = [
    ['running', 'notes.stateRunning'],
    ['not-running', 'notes.stateNotRunning'],
    ['cli-not-registered', 'notes.stateCliNotRegistered'],
    ['not-installed', 'notes.stateNotInstalled'],
  ] as const

  for (const [state, key] of cases) {
    it(`${state} 说的是那一句`, async () => {
      await mount(fakePort(emptyList({
        systems: { obsidian: { state, enabled: true } },
        vaults: [vault({ id: 'a' })],
      })))
      expect(screen.getByTestId('notes-obsidian-state').textContent).toBe(t(key))
    })
  }

  it('systems 里没有这一行(夹紧的宿主答的空表)也落到「没有找到」', async () => {
    await mount(fakePort(emptyList()))
    expect(screen.getByTestId('notes-obsidian-state').textContent).toBe(t('notes.stateNotInstalled'))
  })

  it('没装那一档库表整块不画 —— 哪怕回执里莫名其妙带着库', async () => {
    await mount(fakePort(emptyList({
      systems: { obsidian: { state: 'not-installed', enabled: true } },
      vaults: [vault({ id: 'a' })],
    })))
    expect(screen.queryByTestId('notes-vaults')).toBeNull()
    // 总开关仍然在场:那是「这台机器上不用它」这句话的落点。
    expect(screen.getByLabelText(t('notes.useObsidianVaults'))).not.toBeNull()
  })

  it('装了但零库 = 那一句空态', async () => {
    await mount(fakePort(emptyList({ systems: { obsidian: { state: 'running', enabled: true } } })))
    expect(screen.queryByTestId('notes-vaults')).toBeNull()
    expect(screen.getByText(t('notes.vaultsEmpty'))).not.toBeNull()
  })
})

// ── ② 写路只碰 notes ──────────────────────────────────────

describe('写路', () => {
  it('整份写回,但**除了 notes 逐键相同**', async () => {
    const port = fakePort(
      emptyList({
        systems: { obsidian: { state: 'running', enabled: true } },
        vaults: [vault({ id: 'a' })],
      }),
      // 底本里带着两格别人的东西 —— 它们一个字都不许被这条写路碰。
      { ...BASE_SETTINGS, theme: 'light', general: { locale: 'en' } as unknown as AppSettings['general'] },
    )
    await mount(port)

    await act(async () => {
      fireEvent.click(screen.getByLabelText(`${t('notes.vaultSkills')} · a`))
    })
    await waitFor(() => expect(port.saves).toHaveLength(1))

    const written = port.saves[0]!
    expect(written.notes?.vaults).toEqual({ a: { skills: true } })
    // 逐键对照:除了 `notes`,写回去那份与读进来那份完全一样。
    const strip = (settings: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'notes'))
    expect(strip(written as unknown as Record<string, unknown>)).toEqual(
      strip({ ...BASE_SETTINGS, theme: 'light', general: { locale: 'en' } } as unknown as Record<string, unknown>),
    )
  })

  it('总开关写的是 systems 那张表的一行,不是一格 obsidian', async () => {
    const port = fakePort(emptyList({ systems: { obsidian: { state: 'running', enabled: true } } }))
    await mount(port)

    await act(async () => {
      fireEvent.click(screen.getByLabelText(t('notes.useObsidianVaults')))
    })
    await waitFor(() => expect(port.saves).toHaveLength(1))
    expect(port.saves[0]!.notes?.systems).toEqual({ obsidian: { enabled: false } })
  })
})

// ── ③ 关掉之后行内禁用 ────────────────────────────────────

describe('禁用的传递', () => {
  it('总开关关着 → 行内三件全禁', async () => {
    await mount(fakePort(emptyList({
      systems: { obsidian: { state: 'running', enabled: false } },
      vaults: [vault({ id: 'a' })],
    })))
    for (const label of [
      `${t('notes.vaultEnabled')} · a`,
      `${t('notes.vaultSkills')} · a`,
      `${t('notes.vaultPrimary')} · a`,
    ]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).disabled).toBe(true)
    }
  })

  it('总开关开着、这一行关着 → 「启用」自己还能点(否则开不回来),另两件禁', async () => {
    await mount(fakePort(emptyList({
      systems: { obsidian: { state: 'running', enabled: true } },
      vaults: [vault({ id: 'a', enabled: false })],
    })))
    expect((screen.getByLabelText(`${t('notes.vaultEnabled')} · a`) as HTMLInputElement).disabled)
      .toBe(false)
    expect((screen.getByLabelText(`${t('notes.vaultSkills')} · a`) as HTMLInputElement).disabled)
      .toBe(true)
    expect((screen.getByLabelText(`${t('notes.vaultPrimary')} · a`) as HTMLInputElement).disabled)
      .toBe(true)
  })
})

// ── ④ open: false ────────────────────────────────────────

describe('没在 Obsidian 里打开的库', () => {
  it('多一行小字,而且那一行仍然在表里', async () => {
    await mount(fakePort(emptyList({
      systems: { obsidian: { state: 'running', enabled: true } },
      vaults: [vault({ id: 'shut', open: false }), vault({ id: 'live' })],
    })))
    expect(screen.getByTestId('notes-vault-shut')).not.toBeNull()
    expect(screen.getByTestId('notes-vault-shut').textContent).toContain(t('notes.vaultNotOpen'))
    expect(screen.getByTestId('notes-vault-live').textContent).not.toContain(t('notes.vaultNotOpen'))
  })
})

// ── ⑤⑥ 添加目录 ──────────────────────────────────────────

describe('添加目录', () => {
  /** 按下「添加目录…」并把那扇窗挑出来的路径交回去(全壳唯一那一面的替身)。 */
  async function pick(path: string): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByTestId('notes-folder-add'))
    })
    const onPick = useOpenDirDialog.getState().onPick
    expect(onPick).toBeTypeOf('function')
    await act(async () => {
      onPick!(path)
    })
  }

  it('不存在 → 就地一行错话,零写盘', async () => {
    const port = fakePort(emptyList({ systems: { obsidian: { state: 'running', enabled: true } } }))
    await mount(port)
    await pick('/nope')
    await waitFor(() =>
      expect(screen.getByTestId('notes-folder-error').textContent).toBe(t('notes.folderMissing')))
    expect(port.saves).toHaveLength(0)
  })

  it('挑到一个已经在册的库 → 另一句错话,零写盘', async () => {
    const port = fakePort(emptyList({
      systems: { obsidian: { state: 'running', enabled: true } },
      vaults: [vault({ id: 'a', root: '/vaults/a' })],
    }))
    port.dirs.add('/vaults/a')
    await mount(port)
    await pick('/vaults/a')
    await waitFor(() =>
      expect(screen.getByTestId('notes-folder-error').textContent).toBe(t('notes.folderIsVault')))
    expect(port.saves).toHaveLength(0)
  })

  it('认得出的普通目录 → 追加进 folders(整张新表写回)', async () => {
    const port = fakePort(emptyList({ systems: { obsidian: { state: 'running', enabled: true } } }))
    port.dirs.add('/plain')
    await mount(port)
    expect(screen.getByTestId('notes-folders-empty')).not.toBeNull()
    await pick('/plain')
    await waitFor(() => expect(port.saves).toHaveLength(1))
    expect(port.saves[0]!.notes?.folders).toEqual(['/plain'])
  })

  it('一个目录都没有时「日记文件名格式」那一行不画', async () => {
    await mount(fakePort(emptyList({ systems: { obsidian: { state: 'running', enabled: true } } })))
    expect(screen.queryByTestId('notes-daily-format')).toBeNull()
  })

  it('有目录时它才画,而且拿的是后端投影的那一份', async () => {
    await mount(fakePort(emptyList({
      systems: { obsidian: { state: 'running', enabled: true } },
      folders: ['/plain'],
      dailyFormat: 'YYYY/MM/DD',
    })))
    expect((screen.getByTestId('notes-daily-format') as HTMLInputElement).value).toBe('YYYY/MM/DD')
  })
})

// ── 纯函数 ───────────────────────────────────────────────

describe('isKnownVault', () => {
  it('归一到无尾斜杠再比', () => {
    const vaults = [vault({ id: 'a', root: '/v/a' })]
    expect(isKnownVault(vaults, '/v/a/')).toBe(true)
    expect(isKnownVault(vaults, '/v/a')).toBe(true)
    expect(isKnownVault(vaults, '/v/ab')).toBe(false)
  })
})


// ── ⑦ 「打开」那颗钮(P5:量出来它做不到,所以它不存在)──────

/**
 * P4 留账 2 的结清:Obsidian CLI 整张动词表里**没有**「只把某个库调到前台」这件事
 * (`open path=` 真机答 `Missing required parameter: file or path`),所以这一页上
 * 没有那颗钮 —— 一颗按下去只会失败的钮比没有更坏。
 */
describe('行内没有「打开」钮', () => {
  it('库表画得出来,但一行上没有那颗钮', async () => {
    const port = fakePort(emptyList({
      systems: { obsidian: { state: 'running', enabled: true } },
      vaults: [vault({ id: 'v1', name: 'workbook' })],
    }))
    await mount(port)
    expect(screen.getByTestId('notes-vault-v1')).toBeTruthy()
    expect(screen.queryByText('打开')).toBeNull()
    // 这一页一次 `openInApp` 都不发。
    expect(port.opened).toEqual([])
  })
})
