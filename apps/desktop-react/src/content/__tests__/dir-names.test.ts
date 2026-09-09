import { beforeEach, describe, expect, it } from 'vitest'
import { disambiguate, disambiguatedDirName, openDirRoots, parentNameOf } from '../files/dir-names'
import { dirRef } from '../kinds/dir-ref'
import { pairRefOf } from '../kinds/pair-ref'
import { pairContentKind } from '../kinds/pair'
import { CENTER_REGION } from '../../workbench/regions'
import { registerContentKind, resetContentKinds } from '../../workbench/kinds'
import { useWorkbenchStore } from '../../workbench/store'
import {
  RECENT_ROOTS_MAX,
  normalizeRecentRoots,
} from '../../workbench/store'
import { makeLeaf } from '../../workbench/tree'
import { FACTORY_FILE_OPEN_MODE, useFileOpenMode } from '../../data/file-open-mode'

/**
 * **目录面板的名字、最近目录表、出厂档**(W6-a,设计
 * `apps/desktop-react/docs/workbench-tabs-2026-09.md` §3 / §9)。
 */

beforeEach(() => {
  resetContentKinds()
  registerContentKind({
    id: 'dir',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'FolderTree',
    render: () => null,
  })
  registerContentKind(pairContentKind)
  useWorkbenchStore.getState().reset()
})

describe('名字 = 目录名;同名带父目录', () => {
  it('只有它自己叫这个名 → `basename`', () => {
    expect(disambiguate('/a/docs', ['/a/docs'])).toBe('docs')
  })

  it('两个同名 → 各自带上父目录(`docs · a` / `docs · b`)', () => {
    const all = ['/a/docs', '/b/docs']
    expect(disambiguate('/a/docs', all)).toBe('docs · a')
    expect(disambiguate('/b/docs', all)).toBe('docs · b')
  })

  it('父目录名也说不出(两个都在根下)→ 退回**全路径**,不编一个更短的谎', () => {
    const all = ['/docs', '/x/docs']
    expect(disambiguate('/docs', all)).toBe('/docs')
    expect(disambiguate('/x/docs', all)).toBe('docs · x')
  })

  it('`parentNameOf`:顶到根时是空串,尾斜杠不算一层', () => {
    expect(parentNameOf('/a/b/c')).toBe('b')
    expect(parentNameOf('/a/b/c/')).toBe('b')
    expect(parentNameOf('/a')).toBe('')
  })
})

describe('「此刻开着哪些目录」问的是树,而且**看进两格标签里**', () => {
  it('普通标签与两格标签里的那一格都算在场', () => {
    const pair = pairRefOf(dirRef('/b/docs'), { kind: 'dir', key: '/c/notes' })
    useWorkbenchStore.setState({
      regions: { [CENTER_REGION]: makeLeaf('L1', [dirRef('/a/docs'), pair]) },
    })
    expect(openDirRoots().sort()).toEqual(['/a/docs', '/b/docs', '/c/notes'])
    // 于是同名那两个各自带上父目录 —— 两格标签里的那一格也画在屏幕上。
    expect(disambiguatedDirName('/a/docs')).toBe('docs · a')
    expect(disambiguatedDirName('/b/docs')).toBe('docs · b')
  })
})

describe('最近目录表:最近的在前、去重、封顶 20', () => {
  it('`rememberRoot` 把它提到最前,重复的不留两份', () => {
    const st = () => useWorkbenchStore.getState()
    st().rememberRoot('/a')
    useWorkbenchStore.getState().rememberRoot('/b')
    useWorkbenchStore.getState().rememberRoot('/a')
    expect(st().recentRoots).toEqual(['/a', '/b'])
  })

  it('已经在最前的那一个 = 空动作(引用恒等,不惊动订阅者)', () => {
    useWorkbenchStore.getState().rememberRoot('/a')
    const before = useWorkbenchStore.getState().recentRoots
    useWorkbenchStore.getState().rememberRoot('/a')
    expect(useWorkbenchStore.getState().recentRoots).toBe(before)
  })

  it(`最多 ${RECENT_ROOTS_MAX} 条 —— 第 21 个把最老的挤出去`, () => {
    for (let i = 0; i < RECENT_ROOTS_MAX + 5; i += 1) {
      useWorkbenchStore.getState().rememberRoot(`/dir-${i}`)
    }
    const rows = useWorkbenchStore.getState().recentRoots
    expect(rows).toHaveLength(RECENT_ROOTS_MAX)
    expect(rows[0]).toBe(`/dir-${RECENT_ROOTS_MAX + 4}`)
    expect(rows).not.toContain('/dir-0')
  })

  it('洗存量档案:非字符串 / 空串剔掉、去重、封顶', () => {
    const dirty = ['/a', '', '/a', 42, null, '/b'] as unknown[]
    expect(normalizeRecentRoots(dirty)).toEqual(['/a', '/b'])
    expect(normalizeRecentRoots('nope')).toEqual([])
  })
})

describe('出厂档 = 主区域新标签(W6-a §9)', () => {
  it('新装的那一台读出来就是 `stage`', () => {
    expect(FACTORY_FILE_OPEN_MODE).toBe('stage')
    expect(useFileOpenMode.getState().mode).toBe('stage')
  })
})
