import { beforeEach, describe, expect, it } from 'vitest'
import { act } from '@testing-library/react'
import { openDirectoryPanel } from '../dir-open'
import { DIR_KIND, normalizeDirPath } from '../kinds/dir-ref'
import { useWorkbenchStore } from '../../workbench/store'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import { registerContentKind, resetContentKinds, refId } from '../../workbench/kinds'
import { leavesOf } from '../../workbench/tree'

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
