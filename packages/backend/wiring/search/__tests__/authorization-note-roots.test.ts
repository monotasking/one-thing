/**
 * 检索授权面里的**笔记根**(P3,正本 §4.5)。
 *
 * 两句话各一条:
 *  ① `files` 那一类的授权全集(`fileRoots`)里的笔记根 = **在册的笔记库的根**,
 *    从前是 `user_note_dir` / `work_note_dir` 两个变量;
 *  ② 关掉一个库 = 把它从 AI 准看的范围里拿掉 —— 端口答什么就是什么,**现取**。
 *
 * 反证:把 `authorization.ts` 里 `roots.push(...noteRoots())` 换回读变量仓,
 * 第一条当场红;把 `getNoteVaults` 从适配器上摘掉,两条都红。
 */

import { describe, expect, it } from 'vitest'
import type { SearchContext } from '@onething/core/search'
import type { OnethingSearchProvidersAdapters } from '@onething/runtime/search'
import { FolderVault, type NoteVault } from '@onething/runtime/notes'
import { createAppSearchAuthorization } from '../authorization.js'

/** 本机操作者(`DEFAULT_SESSION_OWNER`)—— 笔记根只对它开。 */
function operatorContext(): SearchContext {
  return {
    principal: { kind: 'user', id: 'local-user' },
    executionContext: undefined,
  } as unknown as SearchContext
}

function adaptersWith(vaults: NoteVault[]): OnethingSearchProvidersAdapters {
  return {
    getSessionsList: () => [],
    iterateSessionMessages: () => [],
    getSession: () => undefined,
    getCurrentSessionId: () => undefined,
    getNoteVaults: () => vaults,
    getPrimaryNoteVault: () => vaults[0] ?? null,
    getConnectedDirectories: () => [],
    listFiles: () => ({ async *[Symbol.asyncIterator]() {} }),
    listPrompts: () => [],
  }
}

describe('检索授权面的笔记根', () => {
  it('fileRoots 里的笔记根来自在册的笔记库', () => {
    const vaults = [
      new FolderVault({ root: '/notes/workbook', id: 'v1' }),
      new FolderVault({ root: '/notes/notebook', id: 'v2' }),
    ]
    const { fileRoots } = createAppSearchAuthorization(adaptersWith(vaults))

    expect(fileRoots(operatorContext())).toEqual(
      expect.arrayContaining([vaults[0].root, vaults[1].root]),
    )
  })

  it('库表现取:关掉一个库,它的根当场退出授权全集', () => {
    let vaults = [new FolderVault({ root: '/notes/workbook', id: 'v1' })]
    const adapters: OnethingSearchProvidersAdapters = {
      ...adaptersWith([]),
      getNoteVaults: () => vaults,
    }
    const { fileRoots } = createAppSearchAuthorization(adapters)

    expect(fileRoots(operatorContext())).toContain(vaults[0].root)
    vaults = []
    expect(fileRoots(operatorContext())).toEqual([])
  })

  it('一个库都没有 = 笔记那一类任何路径都不准打开', async () => {
    const { authorization } = createAppSearchAuthorization(adaptersWith([]))

    await expect(authorization.targets!(
      'notes',
      [{ id: 'n1', capability: 'notes', target: { kind: 'note', payload: { filePath: '/notes/workbook/a.md' } } }],
      operatorContext(),
      undefined,
    ) as Promise<void>).rejects.toThrow()
  })
})
