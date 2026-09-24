import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { openDirectoryPanel } from '../dir-open'
import { DIR_KIND, normalizeDirPath } from '../kinds/dir-ref'
import { useWorkbenchStore } from '../../workbench/store'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import { registerContentKind, resetContentKinds, refId } from '../../workbench/kinds'
import { leavesOf } from '../../workbench/tree'
import { configureFilesPort } from '../../data/files-port'
import type { FilesPort } from '../../data/files-port'

/**
 * **同一个目录只有一个身份**(09-23)。
 *
 * 聊天里那枚目录 chip 的路径带尾斜杠(句子里「这是个目录」的判据),它原样走进
 * 打开目录那条路,于是 `dir:/a/Java/` 与 `dir:/a/Java` 成了两格。这里钉两件:
 * 归一的判据本身(纯函数),以及「chip 开一次 + 别处再开一次 = 仍然一格」。
 */

beforeEach(() => {
  resetContentKinds()
  registerContentKind({
    id: DIR_KIND,
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'FolderTree',
    render: () => null,
  })
  useWorkbenchStore.getState().reset()
  useStageStore.setState({ ...initialStageState })
})

function dirTabs(): string[] {
  const out: string[] = []
  for (const tree of Object.values(useWorkbenchStore.getState().regions)) {
    for (const leaf of leavesOf(tree)) {
      for (const tab of leaf.tabs) if (tab.kind === DIR_KIND) out.push(refId(tab))
    }
  }
  return out
}

describe('normalizeDirPath', () => {
  it('去尾斜杠,根目录除外,幂等', () => {
    expect(normalizeDirPath('/a/Java/')).toBe('/a/Java')
    expect(normalizeDirPath('/a/Java//')).toBe('/a/Java')
    expect(normalizeDirPath('/a/Java')).toBe('/a/Java')
    expect(normalizeDirPath('/')).toBe('/')
    expect(normalizeDirPath('///')).toBe('/')
    expect(normalizeDirPath(normalizeDirPath('/a/b/'))).toBe('/a/b')
  })
})

describe('打开目录:尾斜杠不造第二个身份', () => {
  it('chip(带 /)开一次、文件树(不带 /)再开一次 —— 仍然只有 dir:/a/Java 一格', () => {
    act(() => openDirectoryPanel('/a/Java/'))
    expect(dirTabs()).toEqual(['dir:/a/Java'])
    act(() => openDirectoryPanel('/a/Java'))
    expect(dirTabs()).toEqual(['dir:/a/Java'])
  })

  it('根目录照旧是 dir:/', () => {
    act(() => openDirectoryPanel('/'))
    expect(dirTabs()).toEqual(['dir:/'])
  })
})

/**
 * **入口保证根绝对**(09-24)。病历:模型写的 `<ref type="dir" path="~/…/"/>` 原样
 * 进了拼贴台,key 是 `~/…`;后端回来的子项是绝对路径,`FilesPanel` 用 `isUnder(子, 根)`
 * 滤订阅表 —— 子层一层都进不去,点开只见骨架条。裁定是根永远绝对、`~` 只在入口展开
 * 一次(`data/files-source.resolveHomePath`)。所以这一组问的不是「`~` 根底下子层
 * 被不被滤掉」(修过之后根不可能是 `~`),而是**入口那一步有没有把它展开**。
 */
describe('入口保证根绝对:`~` 在打开那一刻展开', () => {
  function installStat(stat: FilesPort['stat']) {
    configureFilesPort({
      ready: async () => undefined,
      listDirectory: vi.fn(async () => ({ success: true, entries: [] })),
      stat,
      readContent: vi.fn(async () => ({ success: true, content: '', size: 0 })),
      saveContent: async () => ({ success: true }),
      reveal: vi.fn(async () => ({ success: true })),
      list: vi.fn(async () => ({ success: true, files: [], entries: [] })),
    })
  }

  afterEach(() => configureFilesPort(undefined))

  it('`~/…` 落下的 key 是绝对路径,最近目录收到的也是绝对路径', async () => {
    installStat(vi.fn(async (at: string) => ({
      success: true,
      type: 'directory' as const,
      path: at.replace(/^~/, '/home/me'),
    })))
    let opened: boolean | undefined
    await act(async () => {
      opened = await openDirectoryPanel('~/data/code/apps/')
    })
    expect(opened).toBe(true)
    expect(dirTabs()).toEqual(['dir:/home/me/data/code/apps'])
    expect(useWorkbenchStore.getState().recentRoots[0]).toBe('/home/me/data/code/apps')
    // 裁定本身:树里没有任何一格 `dir` 的 key 以 `~` 起笔。
    expect(dirTabs().some((id) => id.startsWith('dir:~'))).toBe(false)
  })

  it('展不开 = 答 false,**什么都不摆**(拿一格 `~` 去占位就是把病历重演一遍)', async () => {
    installStat(vi.fn(async () => ({ success: false, error: 'no home' })))
    let opened: boolean | undefined
    await act(async () => {
      opened = await openDirectoryPanel('~/x')
    })
    expect(opened).toBe(false)
    expect(dirTabs()).toEqual([])
    expect(useWorkbenchStore.getState().recentRoots).toEqual([])
  })

  it('绝对路径**当拍**就摆好,不绕后端那一跳(交互预算①:点击当帧可见)', () => {
    const stat = vi.fn(async () => ({ success: true, type: 'directory' as const, path: '/x' }))
    installStat(stat)
    act(() => {
      void openDirectoryPanel('/a/b')
    })
    expect(dirTabs()).toEqual(['dir:/a/b'])
    expect(stat).not.toHaveBeenCalled()
  })
})
