import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NoteSystemRegistry } from '../registry.js'
import type { NotesConfig, NoteSystemDriver, NoteVault } from '../types.js'
import { createEmptyNotesConfig } from '../types.js'

/** 一个最小的假库 —— 注册表只看 `id` / `root` / `system`,别的方法不会被调到。 */
function fakeVault(id: string, root: string, system: string): NoteVault {
  return {
    id, root, system, name: path.basename(root),
    dailyNote: async () => ({ path: path.join(root, 'x.md'), exists: false }),
    createDailyNote: async () => path.join(root, 'x.md'),
    appendToDaily: async () => undefined,
    createNote: async rel => path.join(root, rel),
    attachmentPathFor: async name => path.join(root, name),
    linkTextFor: async target => `[[${target}]]`,
    resolveByName: async () => null,
    listNotes: async () => [],
  }
}

function driver(id: string, vaults: NoteVault[], options: { throws?: boolean } = {}): NoteSystemDriver {
  return {
    id,
    discover: async () => {
      if (options.throws) throw new Error('boom')
      return vaults
    },
  }
}

const config: NotesConfig = createEmptyNotesConfig()

describe('NoteSystemRegistry:注册', () => {
  it('重复 id 直接抛(两份同 id 的驱动谁赢说不清)', () => {
    const registry = new NoteSystemRegistry()
    registry.register(driver('a', []))
    expect(() => registry.register(driver('a', []))).toThrowError(/already registered/)
  })

  it('registeredDriverIds 按注册顺序', () => {
    const registry = new NoteSystemRegistry()
    registry.register(driver('obsidian', []))
    registry.register(driver('folder', []))
    expect(registry.registeredDriverIds()).toEqual(['obsidian', 'folder'])
  })
})

describe('NoteSystemRegistry:先认领先得', () => {
  it('同一个根被两个驱动都认下来时,注册在前的赢', async () => {
    const registry = new NoteSystemRegistry()
    registry.register(driver('obsidian', [fakeVault('o1', '/Users/me/vault', 'obsidian')]))
    registry.register(driver('folder', [fakeVault('f1', '/Users/me/vault', 'folder')]))
    const vaults = await registry.refresh(config)
    expect(vaults).toHaveLength(1)
    expect(vaults[0].system).toBe('obsidian')
  })

  it('尾斜杠 / 大小写的不同写法归成同一个根', async () => {
    const registry = new NoteSystemRegistry()
    registry.register(driver('obsidian', [fakeVault('o1', '/Users/me/vault/', 'obsidian')]))
    registry.register(driver('folder', [fakeVault('f1', '/Users/me/vault', 'folder')]))
    expect(await registry.refresh(config)).toHaveLength(1)
  })

  it('一个驱动抛了不拖累别人', async () => {
    const warnings: string[] = []
    const registry = new NoteSystemRegistry({ warn: message => { warnings.push(message) } })
    registry.register(driver('broken', [], { throws: true }))
    registry.register(driver('folder', [fakeVault('f1', '/Users/me/notes', 'folder')]))
    const vaults = await registry.refresh(config)
    expect(vaults.map(v => v.id)).toEqual(['f1'])
    expect(warnings).toHaveLength(1)
  })
})

describe('NoteSystemRegistry:vaultFor', () => {
  async function loaded() {
    const registry = new NoteSystemRegistry()
    registry.register(driver('obsidian', [
      fakeVault('outer', '/Users/me/notes', 'obsidian'),
      fakeVault('inner', '/Users/me/notes/sub/vault', 'obsidian'),
    ]))
    await registry.refresh(config)
    return registry
  }

  it('最长前缀匹配:库里套库时里面那个赢', async () => {
    const registry = await loaded()
    expect(registry.vaultFor('/Users/me/notes/sub/vault/a.md')?.id).toBe('inner')
    expect(registry.vaultFor('/Users/me/notes/a.md')?.id).toBe('outer')
  })

  it('库根本身也算在库里', async () => {
    const registry = await loaded()
    expect(registry.vaultFor('/Users/me/notes')?.id).toBe('outer')
  })

  it('库外的路径回 null(不是「最近的那个」)', async () => {
    const registry = await loaded()
    expect(registry.vaultFor('/Users/me/other/a.md')).toBeNull()
    // 前缀相同但不是子目录 —— `/Users/me/notes-2` 不在 `/Users/me/notes` 里。
    expect(registry.vaultFor('/Users/me/notes-2/a.md')).toBeNull()
  })
})

describe('NoteSystemRegistry:refresh 换表 / 主库', () => {
  it('refresh 之后是新表,不是并集', async () => {
    const registry = new NoteSystemRegistry()
    let vaults = [fakeVault('a', '/x/a', 'obsidian')]
    registry.register({ id: 'obsidian', discover: async () => vaults })
    await registry.refresh(config)
    expect(registry.vaults().map(v => v.id)).toEqual(['a'])
    vaults = [fakeVault('b', '/x/b', 'obsidian')]
    await registry.refresh(config)
    expect(registry.vaults().map(v => v.id)).toEqual(['b'])
    expect(registry.vaultFor('/x/a/n.md')).toBeNull()
  })

  it('primaryVault:配置指着谁就是谁;指着一个不在册的就回落到第一个', async () => {
    const registry = new NoteSystemRegistry()
    registry.register(driver('obsidian', [
      fakeVault('a', '/x/a', 'obsidian'),
      fakeVault('b', '/x/b', 'obsidian'),
    ]))
    await registry.refresh({ ...config, primaryVaultId: 'b' })
    expect(registry.primaryVault()?.id).toBe('b')
    await registry.refresh({ ...config, primaryVaultId: 'gone' })
    expect(registry.primaryVault()?.id).toBe('a')
    await registry.refresh(config)
    expect(registry.primaryVault()?.id).toBe('a')
  })

  it('空表时 primaryVault 是 null', () => {
    expect(new NoteSystemRegistry().primaryVault()).toBeNull()
  })
})
