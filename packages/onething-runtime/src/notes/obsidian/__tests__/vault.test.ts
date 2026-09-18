import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLI_FIXTURES, createFakeRunner, createProbe } from '../../__tests__/fixtures.js'
import { ObsidianCli } from '../cli.js'
import { MemorySnapshotStore, type ObsidianVaultSnapshot } from '../snapshot.js'
import { ObsidianVault } from '../vault.js'
import { NoteVaultUnavailable } from '../../types.js'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-notes-vault-'))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function snapshot(overrides: Partial<ObsidianVaultSnapshot> = {}): ObsidianVaultSnapshot {
  return {
    dailyFolder: 'daily',
    dailyFormat: 'YYYY-MM-DD',
    attachmentFolderPath: 'attatch',
    useMarkdownLinks: false,
    newLinkFormat: 'shortest',
    capturedAt: 1,
    ...overrides,
  }
}

function makeVault(options: {
  alive?: boolean | null
  open?: boolean
  outputs?: string[]
  snapshot?: ObsidianVaultSnapshot | null
} = {}) {
  const runner = createFakeRunner({ outputs: options.outputs })
  const snapshots = new MemorySnapshotStore()
  if (options.snapshot !== null && options.snapshot !== undefined) {
    void snapshots.write('v1', options.snapshot)
  }
  const vault = new ObsidianVault({
    record: { id: 'v1', path: root, open: options.open ?? true },
    cli: new ObsidianCli({
      runner,
      // `?? true` 会把显式的 `null` 吃掉 —— 那正是「平台没有探活手段」那一档。
      probe: createProbe('alive' in options ? (options.alive as boolean | null) : true),
      executable: 'obsidian',
    }),
    snapshots,
    now: () => 42,
  })
  return { vault, runner, snapshots }
}

describe('活着:走 CLI 并写快照', () => {
  it('dailyNote 问 Obsidian 的配置,并把它落成快照', async () => {
    const { vault, snapshots, runner } = makeVault({
      snapshot: null,
      // captureSnapshot 并发发两条 eval —— 两条夹具都给同一份就够。
      outputs: [CLI_FIXTURES.vaultConfig, CLI_FIXTURES.dailyOptions],
    })
    const ref = await vault.dailyNote(new Date(2026, 8, 8))
    expect(ref.path).toBe(path.join(root, 'daily', '2026-09-08-Tuesday.md'))
    expect(ref.exists).toBe(false)
    expect(vault.degraded).toBeUndefined()
    // 快照落了盘(内存库),而且是 Obsidian 说的那份配置。
    await expect(snapshots.read('v1')).resolves.toMatchObject({
      dailyFolder: 'daily',
      dailyFormat: 'YYYY-MM-DD-dddd',
      attachmentFolderPath: 'attatch',
      useMarkdownLinks: false,
      newLinkFormat: 'shortest',
      capturedAt: 42,
    })
    expect(runner.calls).toHaveLength(2)
  })

  it('attachmentPathFor 问 getAvailablePathForAttachment,答案按库根拼绝对路径', async () => {
    const { vault } = makeVault({ outputs: [CLI_FIXTURES.attachmentPath] })
    await expect(vault.attachmentPathFor('shot.png', 'notes/a.md'))
      .resolves.toBe(path.join(root, 'attatch/shot.png'))
  })

  it('linkTextFor 问 generateMarkdownLink;embed 在前面补一个 !', async () => {
    const link = makeVault({ outputs: [CLI_FIXTURES.markdownLink] })
    await expect(link.vault.linkTextFor('00.00 JDex.md', 'a.md', 'link')).resolves.toBe('[[00.00 JDex]]')
    const embed = makeVault({ outputs: [CLI_FIXTURES.markdownLink] })
    await expect(embed.vault.linkTextFor('00.00 JDex.md', 'a.md', 'embed')).resolves.toBe('![[00.00 JDex]]')
  })

  it('liveSearch 解析 search:context format=json', async () => {
    const { vault, runner } = makeVault({ outputs: [CLI_FIXTURES.searchContext] })
    const hits = await vault.liveSearch('hello', { limit: 5 })
    expect(hits).toEqual([{ path: path.join(root, 'notes/a.md'), matches: [{ line: 3, text: 'hello there' }] }])
    expect(runner.calls[0].args).toEqual(['vault=v1', 'search:context', 'query=hello', 'format=json', 'limit=5'])
  })

  it('零命中:CLI 答一句 `No matches found.`,不是 `[]` —— 认掉它,答空表', async () => {
    const { vault } = makeVault({ outputs: [CLI_FIXTURES.searchNoMatches] })
    await expect(vault.liveSearch('__no_such_note__')).resolves.toEqual([])
  })

  it('liveSearch 把 signal 递下去(换词即 kill 的那条线)', async () => {
    const { vault, runner } = makeVault({ outputs: [CLI_FIXTURES.searchContext] })
    const controller = new AbortController()
    await vault.liveSearch('hello', { signal: controller.signal })
    expect(runner.calls[0].signal).toBe(controller.signal)
  })
})

describe('liveSearch:两道闸(P5)', () => {
  it('库没在 app 里打开 → 抛 vault-not-open,**一次 spawn 都不发生**', async () => {
    const { vault, runner } = makeVault({ open: false, snapshot: snapshot() })
    await expect(vault.liveSearch('hello')).rejects.toThrowError(NoteVaultUnavailable)
    await expect(vault.liveSearch('hello')).rejects.toMatchObject({ reason: 'vault-not-open' })
    expect(runner.calls).toHaveLength(0)
  })

  it('app 没在跑 → 抛 system-not-running,同样一次都不发', async () => {
    const { vault, runner } = makeVault({ alive: false, snapshot: snapshot() })
    await expect(vault.liveSearch('hello')).rejects.toMatchObject({ reason: 'system-not-running' })
    expect(runner.calls).toHaveLength(0)
  })

  it('这个平台探不出活 → 抛 cli-not-registered(不确定时后台不发)', async () => {
    const { vault, runner } = makeVault({ alive: null, snapshot: snapshot() })
    await expect(vault.liveSearch('hello')).rejects.toMatchObject({ reason: 'cli-not-registered' })
    expect(runner.calls).toHaveLength(0)
  })
})

describe('不活:走快照复现三条语义', () => {
  it('日记路径 = <root>/<dailyFolder>/<format(date)>.md', async () => {
    const { vault, runner } = makeVault({
      alive: false,
      snapshot: snapshot({ dailyFolder: 'journal', dailyFormat: 'YYYY/MM/DD' }),
    })
    const ref = await vault.dailyNote(new Date(2026, 8, 8))
    expect(ref.path).toBe(path.join(root, 'journal', '2026/09/08.md'))
    expect(vault.degraded).toBe('system-not-running')
    expect(runner.calls).toHaveLength(0)
  })

  it('附件:四种 attachmentFolderPath 语义各一例', async () => {
    const cases: Array<[string, string]> = [
      ['', 'shot.png'],                          // 库根
      ['/', 'shot.png'],                         // 库根
      ['./', path.join('notes', 'shot.png')],    // 文档同目录
      ['./assets', path.join('notes', 'assets', 'shot.png')], // 文档同级子目录
      ['attatch', path.join('attatch', 'shot.png')],          // 库下固定目录
    ]
    for (const [setting, expected] of cases) {
      const { vault } = makeVault({ alive: false, snapshot: snapshot({ attachmentFolderPath: setting }) })
      await expect(vault.attachmentPathFor('shot.png', 'notes/a.md'))
        .resolves.toBe(path.join(root, expected))
    }
  })

  it('附件让名:同名已在就加序号(与 Obsidian 排出同一串名字)', async () => {
    fs.mkdirSync(path.join(root, 'attatch'), { recursive: true })
    fs.writeFileSync(path.join(root, 'attatch', 'shot.png'), '')
    const { vault } = makeVault({ alive: false, snapshot: snapshot() })
    await expect(vault.attachmentPathFor('shot.png', 'notes/a.md'))
      .resolves.toBe(path.join(root, 'attatch', 'shot 1.png'))
  })

  it('链接:wikilink 与 markdown 两种格式', async () => {
    const wiki = makeVault({ alive: false, snapshot: snapshot({ useMarkdownLinks: false }) })
    await expect(wiki.vault.linkTextFor('folder/Target.md', 'notes/a.md', 'link'))
      .resolves.toBe('[[Target]]')

    const md = makeVault({
      alive: false,
      snapshot: snapshot({ useMarkdownLinks: true, newLinkFormat: 'relative' }),
    })
    await expect(md.vault.linkTextFor('notes/sub/Target.md', 'notes/a.md', 'embed'))
      .resolves.toBe('![Target](sub/Target.md)')

    const absolute = makeVault({
      alive: false,
      snapshot: snapshot({ useMarkdownLinks: false, newLinkFormat: 'absolute' }),
    })
    // wikilink 对 `.md` 省扩展名,**三档都省**(档位只决定取路径的哪一段)。
    await expect(absolute.vault.linkTextFor('folder/Target.md', 'notes/a.md', 'link'))
      .resolves.toBe('[[folder/Target]]')
  })

  it('连快照都没有 → NoteVaultUnavailable(no-snapshot)', async () => {
    const { vault } = makeVault({ alive: false, snapshot: null })
    await expect(vault.dailyNote()).rejects.toThrowError(NoteVaultUnavailable)
    await expect(vault.dailyNote()).rejects.toMatchObject({ reason: 'no-snapshot' })
  })

  it('探针答 null 时降级理由是 cli-not-registered', async () => {
    const { vault } = makeVault({ alive: null, snapshot: snapshot() })
    await vault.dailyNote()
    expect(vault.degraded).toBe('cli-not-registered')
  })
})

describe('offline 读:变量板那条路一条命令都不发', () => {
  it('offline 时连探活都不做,直接读快照,而且不改 degraded', async () => {
    const { vault, runner } = makeVault({ alive: true, snapshot: snapshot() })
    const ref = await vault.dailyNote(new Date(2026, 8, 8), { offline: true })
    expect(ref.path).toBe(path.join(root, 'daily', '2026-09-08.md'))
    expect(runner.calls).toHaveLength(0)
    expect(vault.degraded).toBeUndefined()
  })

  it('offline 且没有快照 → 抛,而不是编一个路径', async () => {
    const { vault } = makeVault({ alive: true, snapshot: null })
    await expect(vault.dailyNote(undefined, { offline: true }))
      .rejects.toMatchObject({ reason: 'no-snapshot' })
  })
})

describe('后台读:`open:false` 的库一条命令都不发(review ②)', () => {
  /**
   * **反证**:把 `canQueryLive` 里的 `if (!this.isOpen) return false` 挖掉,
   * 这一组全红 —— `runner.calls` 会变成非 0。现场的后果是 Obsidian 在跑时,
   * 一次变量板渲染 / 一次附件解析就把一个用户没打开的库的窗口弹出来。
   */
  it('库没开着 + app 活着:dailyNote 走快照,零 spawn,理由是 vault-not-open', async () => {
    const { vault, runner } = makeVault({ open: false, alive: true, snapshot: snapshot() })
    const ref = await vault.dailyNote(new Date(2026, 8, 8))
    expect(ref.path).toBe(path.join(root, 'daily', '2026-09-08.md'))
    expect(runner.calls).toHaveLength(0)
    expect(vault.degraded).toBe('vault-not-open')
  })

  it('库没开着 + app 活着:attachmentPathFor 走快照语义,零 spawn', async () => {
    const { vault, runner } = makeVault({ open: false, alive: true, snapshot: snapshot() })
    await expect(vault.attachmentPathFor('shot.png', 'notes/a.md'))
      .resolves.toBe(path.join(root, 'attatch', 'shot.png'))
    expect(runner.calls).toHaveLength(0)
  })

  it('库没开着 + app 活着:resolveByName 走本地索引,零 spawn', async () => {
    fs.mkdirSync(path.join(root, 'notes'), { recursive: true })
    fs.writeFileSync(path.join(root, 'notes', 'Target.md'), '')
    const { vault, runner } = makeVault({ open: false, alive: true, snapshot: snapshot() })
    await expect(vault.resolveByName('Target', 'a.md'))
      .resolves.toBe(path.join(root, 'notes', 'Target.md'))
    expect(runner.calls).toHaveLength(0)
  })

  it('库没开着 + app 活着:linkTextFor / listNotes 也不发', async () => {
    fs.writeFileSync(path.join(root, 'only.md'), '')
    const { vault, runner } = makeVault({ open: false, alive: true, snapshot: snapshot() })
    await expect(vault.linkTextFor('folder/Target.md', 'notes/a.md', 'link')).resolves.toBe('[[Target]]')
    await expect(vault.listNotes()).resolves.toEqual(['only.md'])
    expect(runner.calls).toHaveLength(0)
  })

  it('库开着 + app 活着才问 CLI —— 对照组', async () => {
    const { vault, runner } = makeVault({
      open: true, alive: true, snapshot: null,
      outputs: [CLI_FIXTURES.vaultConfig, CLI_FIXTURES.dailyOptions],
    })
    await vault.dailyNote(new Date(2026, 8, 8))
    expect(runner.calls).toHaveLength(2)
  })
})

describe('前台动作的两道闸', () => {
  it('库 open:false + mayLaunch 缺省 → vault-not-open,一次 spawn 都没发生', async () => {
    const { vault, runner } = makeVault({ open: false, alive: true, outputs: [CLI_FIXTURES.dailyPath] })
    await expect(vault.createDailyNote()).rejects.toMatchObject({ reason: 'vault-not-open' })
    await expect(vault.appendToDaily('x')).rejects.toMatchObject({ reason: 'vault-not-open' })
    await expect(vault.createNote('a.md', {})).rejects.toMatchObject({ reason: 'vault-not-open' })
    await expect(vault.openInApp('a.md')).rejects.toMatchObject({ reason: 'vault-not-open' })
    expect(runner.calls).toHaveLength(0)
  })

  it('open:false + mayLaunch:true 就放行(用户主动动作)', async () => {
    const { vault, runner } = makeVault({ open: false, alive: false, outputs: [CLI_FIXTURES.dailyPath] })
    await expect(vault.createDailyNote(new Date(), { mayLaunch: true }))
      .resolves.toBe(path.join(root, '2026-09-08.md'))
    expect(runner.calls[0].args).toEqual(['vault=v1', 'eval', expect.stringContaining('getDailyNote()')])
  })

  /**
   * **反证**:把 `ObsidianVault.launch()` 改回写死 `{ mayLaunch: true }`,
   * 这一条红 —— `runner.calls` 变成 1,而那一次 spawn 就是「后台把 Obsidian
   * 拉起来」。`obsidian.json` 里的 `open` 标是**上次运行留下的**,所以
   * 「open:true 但 app 已经退了」是一个真实的、很常见的组合。
   */
  it('open:true 但 app 已经退了 + 缺省调用 → 抛 system-not-running,零 spawn', async () => {
    const { vault, runner } = makeVault({ open: true, alive: false, outputs: [CLI_FIXTURES.dailyPath] })
    await expect(vault.createDailyNote()).rejects.toMatchObject({ reason: 'system-not-running' })
    await expect(vault.appendToDaily('x')).rejects.toMatchObject({ reason: 'system-not-running' })
    await expect(vault.createNote('a.md', {})).rejects.toMatchObject({ reason: 'system-not-running' })
    await expect(vault.openInApp('a.md')).rejects.toMatchObject({ reason: 'system-not-running' })
    expect(runner.calls).toHaveLength(0)
  })

  it('同一档 + mayLaunch:true → 放行(这是用户主动动作)', async () => {
    const { vault, runner } = makeVault({ open: true, alive: false, outputs: [CLI_FIXTURES.dailyPath] })
    await expect(vault.createDailyNote(new Date(), { mayLaunch: true }))
      .resolves.toBe(path.join(root, '2026-09-08.md'))
    expect(runner.calls).toHaveLength(1)
  })

  it('appendToDaily 把换行转义成 \\n(CLI 的 content= 语义)', async () => {
    const { vault, runner } = makeVault({ alive: true, outputs: [''] })
    await vault.appendToDaily('a\nb', { mayLaunch: true })
    expect(runner.calls[0].args).toEqual(['vault=v1', 'daily:append', 'content=a\\nb'])
  })
})
