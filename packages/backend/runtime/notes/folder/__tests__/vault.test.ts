import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FolderVault } from '../vault.js'
import { FolderDriver } from '../driver.js'
import { createEmptyNotesConfig } from '../../types.js'
import { BasenameIndex } from '../../basename-index.js'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-notes-folder-'))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function write(relative: string, content = ''): string {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf-8')
  return target
}

describe('FolderVault:日记', () => {
  it('日记路径 = <root>/<format(date)>.md,缺省格式 YYYY-MM-DD', async () => {
    const vault = new FolderVault({ root })
    const ref = await vault.dailyNote(new Date(2026, 8, 8))
    expect(ref.path).toBe(path.join(root, '2026-09-08.md'))
    expect(ref.exists).toBe(false)
  })

  it('自定义格式串照排', async () => {
    const vault = new FolderVault({ root, dailyFormat: 'YYYY/MM/DD-dddd' })
    const ref = await vault.dailyNote(new Date(2026, 8, 8))
    expect(ref.path).toBe(path.join(root, '2026/09/08-Tuesday.md'))
  })

  it('createDailyNote 幂等:已存在就原样返回,不清空', async () => {
    const vault = new FolderVault({ root })
    const target = write('2026-09-08.md', 'already here')
    await expect(vault.createDailyNote(new Date(2026, 8, 8))).resolves.toBe(target)
    expect(fs.readFileSync(target, 'utf-8')).toBe('already here')
  })

  it('appendToDaily 在没有日记时先建一本', async () => {
    const vault = new FolderVault({ root })
    await vault.appendToDaily('line one')
    const today = (await vault.dailyNote()).path
    expect(fs.readFileSync(today, 'utf-8')).toBe('line one\n')
    await vault.appendToDaily('line two')
    expect(fs.readFileSync(today, 'utf-8')).toBe('line one\nline two\n')
  })

  it('degraded 永远 undefined —— 本地目录不依赖任何在跑的 app', () => {
    expect(new FolderVault({ root }).degraded).toBeUndefined()
  })
})

describe('FolderVault:附件与链接', () => {
  it('attachmentDirectory 缺席 = 文档同目录', async () => {
    const vault = new FolderVault({ root })
    await expect(vault.attachmentPathFor('shot.png', 'notes/a.md'))
      .resolves.toBe(path.join(root, 'notes', 'shot.png'))
  })

  it('attachmentDirectory 给了就是库下那个固定目录', async () => {
    const vault = new FolderVault({ root, attachmentDirectory: 'assets' })
    await expect(vault.attachmentPathFor('shot.png', 'notes/a.md'))
      .resolves.toBe(path.join(root, 'assets', 'shot.png'))
  })

  it('链接是标准 md、相对文档目录', async () => {
    const vault = new FolderVault({ root })
    await expect(vault.linkTextFor('notes/sub/Target.md', 'notes/a.md', 'link'))
      .resolves.toBe('[Target](sub/Target.md)')
    await expect(vault.linkTextFor('notes/sub/Target.md', 'notes/a.md', 'embed'))
      .resolves.toBe('![Target](sub/Target.md)')
  })
})

describe('FolderVault:basename 索引', () => {
  it('按名字解析,带不带扩展名都行', async () => {
    write('notes/Target.md')
    const vault = new FolderVault({ root })
    await expect(vault.resolveByName('Target', 'a.md')).resolves.toBe(path.join(root, 'notes/Target.md'))
    await expect(vault.resolveByName('Target.md', 'a.md')).resolves.toBe(path.join(root, 'notes/Target.md'))
    await expect(vault.resolveByName('notes/Target', 'a.md')).resolves.toBe(path.join(root, 'notes/Target.md'))
    await expect(vault.resolveByName('nope', 'a.md')).resolves.toBeNull()
  })

  it('同名多份时,离 sourceDoc 最近的那个赢', async () => {
    write('near/Target.md')
    write('far/deeper/Target.md')
    const vault = new FolderVault({ root })
    await expect(vault.resolveByName('Target', 'near/a.md'))
      .resolves.toBe(path.join(root, 'near/Target.md'))
  })

  it('listNotes 只收 md,并且能按文件夹过滤', async () => {
    write('a.md'); write('sub/b.md'); write('sub/c.txt')
    const vault = new FolderVault({ root })
    const all = (await vault.listNotes()).sort()
    expect(all).toEqual(['a.md', path.join('sub', 'b.md')].sort())
    expect(await vault.listNotes('sub')).toEqual([path.join('sub', 'b.md')])
  })

  it('跳过 .git / .obsidian / node_modules', async () => {
    write('.git/x.md'); write('.obsidian/y.md'); write('node_modules/z.md'); write('real.md')
    const vault = new FolderVault({ root })
    expect(await vault.listNotes()).toEqual(['real.md'])
  })
})

describe('BasenameIndex:收什么、按名怎么挑', () => {
  /**
   * 索引收**库里的所有文件**(P3):wikilink 指得最多的恰恰是附件
   * (`![[shot.png]]`),只收 `.md` 的话按名兜底那一路恒答 null。
   */
  it('附件也在索引里,按名找得到', async () => {
    write('attachments/shot.png')
    const index = new BasenameIndex(root)
    await expect(index.resolve('shot.png')).resolves.toBe(path.join(root, 'attachments', 'shot.png'))
  })

  /**
   * 但**不带扩展名的名字先找笔记** —— `[[Note]]` 在同时有 `Note.md` 与
   * `Note.png` 时指的是那篇笔记。反证:把那道筛挖掉,这一条会指到 png 上
   * (两者同深度,`localeCompare` 说了算)。
   */
  it('`[[Note]]` 在同名附件旁边仍然指笔记;写了扩展名就按写的来', async () => {
    write('Note.md')
    // 扩展名故意选 `.jpg`:同一层目录时兜底规则是 `localeCompare`,
    // `j` < `m` —— 挖掉「先找笔记」那一筛,这一条当场指到图上。
    write('Note.jpg')
    const index = new BasenameIndex(root)
    await expect(index.resolve('Note')).resolves.toBe(path.join(root, 'Note.md'))
    await expect(index.resolve('Note.jpg')).resolves.toBe(path.join(root, 'Note.jpg'))
  })

  it('`listNotes` 只交笔记 —— 「只要 md」是读者的事,不是索引的', async () => {
    write('real.md')
    write('attachments/shot.png')
    expect(await new FolderVault({ root }).listNotes()).toEqual(['real.md'])
  })
})

describe('BasenameIndex:TTL 与上限', () => {
  it('TTL 之内不重扫,过期后重扫', async () => {
    write('a.md')
    const index = new BasenameIndex(root, { ttlMs: 10_000 })
    await expect(index.resolve('a')).resolves.toBe(path.join(root, 'a.md'))
    write('b.md')
    // 还在 TTL 内:新文件看不见。
    await expect(index.resolve('b')).resolves.toBeNull()
    index.invalidate()
    await expect(index.resolve('b')).resolves.toBe(path.join(root, 'b.md'))
  })

  it('TTL 为 0 时每次都重扫', async () => {
    write('a.md')
    const index = new BasenameIndex(root, { ttlMs: 0 })
    await index.resolve('a')
    write('b.md')
    await expect(index.resolve('b')).resolves.toBe(path.join(root, 'b.md'))
  })

  it('条目上限把遍历截住', async () => {
    for (let i = 0; i < 6; i += 1) write(`n${i}.md`)
    const index = new BasenameIndex(root, { maxEntries: 2, ttlMs: 10_000 })
    expect((await index.all()).length).toBeLessThanOrEqual(2)
  })
})

describe('FolderDriver', () => {
  it('config.folders 里每个目录一个库,带上 dailyFormat 与附件目录', async () => {
    const vaults = await new FolderDriver().discover({
      ...createEmptyNotesConfig(),
      folders: [root, '/Users/me/other'],
      dailyFormat: 'YYYY_MM_DD',
      attachmentDirectory: 'assets',
    })
    expect(vaults).toHaveLength(2)
    expect(vaults[0].system).toBe('folder')
    expect((await vaults[0].dailyNote(new Date(2026, 8, 8))).path).toBe(path.join(root, '2026_09_08.md'))
  })

  it('folders 空 = 零个库', async () => {
    await expect(new FolderDriver().discover(createEmptyNotesConfig())).resolves.toEqual([])
  })

  /**
   * 系统级开关是**一张按 id 的表**,不是一格 `obsidian`(2026-09-18 陌生能力
   * 演练打回的那一处)。两个驱动读的是同一句 `isNoteSystemEnabled(config, this.id)`
   * —— 所以第三个驱动不用改契约、不用改 core。
   */
  it('自己那一行关了就整个退场;缺席 = 开着;别人那一行不影响自己', async () => {
    const base = { ...createEmptyNotesConfig(), folders: [root] }
    await expect(new FolderDriver().discover(base)).resolves.toHaveLength(1)
    await expect(new FolderDriver().discover({ ...base, systems: { folder: { enabled: false } } }))
      .resolves.toEqual([])
    await expect(new FolderDriver().discover({ ...base, systems: { folder: {} } }))
      .resolves.toHaveLength(1)
    await expect(new FolderDriver().discover({ ...base, systems: { obsidian: { enabled: false } } }))
      .resolves.toHaveLength(1)
  })
})
