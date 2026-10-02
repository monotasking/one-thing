import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFakeRunner, createProbe } from '../../../notes/__tests__/fixtures.js'
import { MemorySnapshotStore, ObsidianCli, ObsidianVault } from '../../../notes/index.js'
import { NoteVaultsProvider, type NoteVaultSummary } from '../note-vaults.js'

describe('note_vaults:值的形状', () => {
  it('每条库给 name / root / system / primary;主库多一格 today', async () => {
    const vaults: NoteVaultSummary[] = [
      { name: 'workbook', root: '/Users/me/note/workbook', system: 'obsidian', primary: true, today: '/Users/me/note/workbook/daily/2026-09-18.md' },
      { name: 'ideas', root: '/Users/me/ideas', system: 'folder', primary: false },
    ]
    const provider = new NoteVaultsProvider({ list: () => vaults })
    const [variable] = await provider.list()
    expect(variable.name).toBe('note_vaults')
    expect(variable.readonly).toBe(true)
    expect(variable.state).toBe(true)
    expect(JSON.parse(variable.value as string)).toEqual(vaults)
  })

  it('一个库都没有 = 这个变量不出现(空表进提示词只是噪音)', async () => {
    const provider = new NoteVaultsProvider({ list: () => [] })
    await expect(provider.list()).resolves.toEqual([])
  })

  it('只认自己那个名字', () => {
    const provider = new NoteVaultsProvider({ list: () => [] })
    expect(provider.claims('note_vaults')).toBe(true)
    // 老的两个可写变量是别人的(`providers/notes.ts`,P3 才删)。
    expect(provider.claims('user_note_dir')).toBe(false)
    expect(provider.claims('notes')).toBe(false)
  })

  it('没有写面 —— 改笔记库走设置页', () => {
    const provider = new NoteVaultsProvider({ list: () => [] }) as unknown as Record<string, unknown>
    // `VariableProvider` 的四个写方法都是可选的;这个 provider 一个都不实现,
    // 所以 `variable` 工具对它的任何写调用都会走注册表的 READONLY 那一条。
    for (const method of ['set', 'append', 'remove', 'delete']) {
      expect(provider[method]).toBeUndefined()
    }
  })
})

describe('note_vaults:一条 CLI 命令都不发', () => {
  /**
   * **反证**:把 `dailyNote(…, { offline: true })` 里的 `offline` 去掉(或者把
   * `ObsidianVault.config` 里那句 `options.offline === true ? false : …` 挖掉),
   * 这条立刻红 —— `runner.calls` 会变成 2(`captureSnapshot` 并发的两条 eval)。
   * 那两次 `spawn` 就是「每一轮对话多两次进程启动」。
   */
  it('主库的 today 走 offline 读:Obsidian 活着也不 spawn', async () => {
    const runner = createFakeRunner({ outputs: ['=> {}'] })
    const snapshots = new MemorySnapshotStore()
    await snapshots.write('v1', {
      dailyFolder: 'daily',
      dailyFormat: 'YYYY-MM-DD',
      attachmentFolderPath: '',
      useMarkdownLinks: false,
      newLinkFormat: 'shortest',
      capturedAt: 1,
    })
    const vault = new ObsidianVault({
      record: { id: 'v1', path: '/Users/me/note/workbook', open: true },
      // 探针说**活着** —— 就算活着,这条路也不许发命令。
      cli: new ObsidianCli({ runner, probe: createProbe(true), executable: 'obsidian' }),
      snapshots,
    })

    const provider = new NoteVaultsProvider({
      list: async () => {
        const ref = await vault.dailyNote(undefined, { offline: true })
        return [{ name: vault.name, root: vault.root, system: vault.system, primary: true, today: ref.path }]
      },
    })
    const [variable] = await provider.list()
    const parsed = JSON.parse(variable.value as string) as NoteVaultSummary[]
    expect(parsed[0].today).toBe(path.join('/Users/me/note/workbook', 'daily', todayFile()))
    expect(runner.calls).toHaveLength(0)
  })
})

function todayFile(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.md`
}
