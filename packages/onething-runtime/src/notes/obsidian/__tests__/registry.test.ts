import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ObsidianRegistry, obsidianConfigPathCandidates, vaultNameFromPath } from '../registry.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-notes-registry-'))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeConfig(content: string): string {
  const file = path.join(tmpDir, 'obsidian.json')
  fs.writeFileSync(file, content, 'utf-8')
  return file
}

describe('obsidian.json 的三平台落点', () => {
  it('mac / win / linux 各有自己的路径;linux 额外给 flatpak 一条', () => {
    expect(obsidianConfigPathCandidates('darwin', '/Users/me')).toEqual([
      '/Users/me/Library/Application Support/obsidian/obsidian.json',
    ])
    const win = obsidianConfigPathCandidates('win32', 'C:\\Users\\me')
    expect(win).toHaveLength(1)
    expect(win[0].toLowerCase()).toContain('obsidian')
    const linux = obsidianConfigPathCandidates('linux', '/home/me')
    expect(linux[0]).toBe('/home/me/.config/obsidian/obsidian.json')
    expect(linux[1]).toBe('/home/me/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json')
  })
})

describe('ObsidianRegistry.read', () => {
  it('解析名册,`open` 缺席当 false', async () => {
    const file = writeConfig(JSON.stringify({
      vaults: {
        aaa: { path: '/Users/me/workbook', ts: 1, open: true },
        bbb: { path: '/Users/me/reading', ts: 2 },
        ccc: { path: '/Users/me/closed', ts: 3, open: false },
      },
      cli: true,
    }))
    const snapshot = await new ObsidianRegistry({ configPaths: [file] }).read()
    expect(snapshot.cliRegistered).toBe(true)
    expect(snapshot.sourcePath).toBe(file)
    expect(snapshot.vaults).toEqual([
      { id: 'aaa', path: '/Users/me/workbook', open: true },
      { id: 'bbb', path: '/Users/me/reading', open: false },
      { id: 'ccc', path: '/Users/me/closed', open: false },
    ])
  })

  it('文件缺席 = 空表,不抛', async () => {
    const snapshot = await new ObsidianRegistry({ configPaths: [path.join(tmpDir, 'nope.json')] }).read()
    expect(snapshot).toEqual({ vaults: [], cliRegistered: false, sourcePath: null })
  })

  it('坏 JSON = 空表 + warn,不抛', async () => {
    const file = writeConfig('{ this is not json')
    const warnings: string[] = []
    const snapshot = await new ObsidianRegistry({
      configPaths: [file],
      logger: { warn: message => { warnings.push(message) } },
    }).read()
    expect(snapshot.vaults).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  it('没有 path 的条目直接丢掉(名册是外部文件,不许它决定我们读哪儿)', async () => {
    const file = writeConfig(JSON.stringify({ vaults: { a: { ts: 1 }, b: { path: '   ' }, c: { path: '/x' } } }))
    const snapshot = await new ObsidianRegistry({ configPaths: [file] }).read()
    expect(snapshot.vaults.map(v => v.id)).toEqual(['c'])
  })

  it('第一条候选读不到就试下一条(flatpak)', async () => {
    const file = writeConfig(JSON.stringify({ vaults: { a: { path: '/x', open: true } } }))
    const snapshot = await new ObsidianRegistry({
      configPaths: [path.join(tmpDir, 'missing.json'), file],
    }).read()
    expect(snapshot.vaults.map(v => v.id)).toEqual(['a'])
  })
})

describe('vaultNameFromPath', () => {
  it('库根的最后一段就是界面上的库名', () => {
    expect(vaultNameFromPath('/Users/me/data/note/workbook')).toBe('workbook')
    expect(vaultNameFromPath('/Users/me/data/note/workbook/')).toBe('workbook')
  })
})
