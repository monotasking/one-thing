/**
 * **笔记根的唯一定义**(P3 §1)。
 *
 * 全仓六个消费面 —— 无会话读根 / 扫盘根 / 授权全集 / `@` 文件引用 / markdown 附件 /
 * 技能根 —— 读的都是 `noteRootsNow()` 这一句话。消费面各自的单测吃的是假件,所以
 * **这句话的产地必须在这里被直接钉住**:挖掉它(比如让它恒答空表),那些用例一条
 * 都不会红。
 *
 * 这份用例假的是**当前 backend 那一格**(`current.ts` 的进程单槽),因为
 * `noteRootsNow` / `skillVaultRootsNow` 的全部内容就是「从那一格拿子系统,再问它」。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteVault } from '@onething/runtime/notes'

const backend = vi.hoisted(() => ({ handle: null as unknown }))
vi.mock('../../../current.js', () => ({
  getCurrentBackendSafe: () => backend.handle,
  getCurrentBackend: () => {
    if (backend.handle === null) throw new Error('not assembled')
    return backend.handle
  },
}))

const { noteRootsNow, skillVaultRootsNow } = await import('../index.js')

function vault(root: string, id: string): NoteVault {
  return { id, name: id, root, system: 'fake' } as unknown as NoteVault
}

beforeEach(() => {
  backend.handle = null
})

describe('noteRootsNow', () => {
  it('没有 backend / 没有笔记子系统 = 空表(不是抛)', () => {
    expect(noteRootsNow()).toEqual([])
    backend.handle = { get notes(): never { throw new Error('no notes part') } }
    expect(noteRootsNow()).toEqual([])
  })

  it('有子系统 = 在册库的根,逐字、按序', () => {
    const vaults = [vault('/notes/workbook', 'v1'), vault('/notes/notebook', 'v2')]
    backend.handle = { notes: { registry: { vaults: () => vaults } } }

    expect(noteRootsNow()).toEqual(['/notes/workbook', '/notes/notebook'])
  })

  it('现取:库表变了,下一次调用就跟着变', () => {
    let vaults = [vault('/notes/workbook', 'v1')]
    backend.handle = { notes: { registry: { vaults: () => vaults } } }

    expect(noteRootsNow()).toEqual(['/notes/workbook'])
    vaults = []
    expect(noteRootsNow()).toEqual([])
  })
})

describe('skillVaultRootsNow', () => {
  it('没有子系统 = 空表;有就是子系统答的那一份', () => {
    expect(skillVaultRootsNow()).toEqual([])

    const roots = [{ id: 'note-vault:v1', path: '/notes/workbook', enabled: true, instructionContext: () => '' }]
    backend.handle = { notes: { skillVaultRoots: () => roots } }
    expect(skillVaultRootsNow()).toBe(roots)
  })
})
