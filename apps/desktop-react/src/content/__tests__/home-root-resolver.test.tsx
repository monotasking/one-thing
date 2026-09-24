import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMemo } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FilesDirectoryEntry } from '@shared/ipc/files'
import { configureFilesPort } from '../../data/files-port'
import type { FilesPort } from '../../data/files-port'
import { useFilesSource } from '../../data/files-source'
import { useStageStore } from '../../stage/store'
import { focusTree } from '../../focus/registry'
import { FocusDispatchHarness } from '../../test/focus-harness'
import { useWorkbenchStore } from '../../workbench/store'
import { contentKindOf } from '../../workbench/kinds'
import { CENTER_REGION } from '../../workbench/regions'
import { leavesOf, makeLeaf } from '../../workbench/tree'
import type { PaneNode } from '../../workbench/tree'
import { dirRef, DIR_KIND } from '../kinds/dir-ref'
import { DEFAULT_PANEL_VISIBILITY } from '../visibility'
import '../kinds'

/**
 * **存量那一格 `dir:~/…` 在渲染那一拍被改写成绝对 key**(09-24)。
 *
 * 真机上用户桌面已经落了盘一格 `dir:~/Documents/data/work/lenovo/1015`(引用打开的
 * 目录),它的子层一层都展不开(病历在 `content/files/HomeRootResolver.tsx`)。
 * 这一组照真机的形摆:同一个 `~` key 在**两片叶**里各开一格,渲染种类自己的
 * `render` —— 断言三件:①展开中不画任何猜测(没有 `/~/…` 面包屑);②落定之后
 * 树里没有一格 `dir` 的 key 以 `~` 起笔,两片叶各换各的;③换上来的 `FilesPanel`
 * 能展开子层(子层真的进了订阅表 —— 这正是报障那一句)。
 */

const HOME = '/home/me'
const TILDE = '~/proj'
const ABS = `${HOME}/proj`

function entry(name: string, type: 'file' | 'directory', at: string): FilesDirectoryEntry {
  return { name, path: `${at}/${name}`, type }
}

const TREE: Record<string, FilesDirectoryEntry[]> = {
  // 后端对 `~/…` 与绝对路径都列得出来,回来的子项**永远是绝对路径** —— 那正是病根。
  [TILDE]: [entry('src', 'directory', ABS)],
  [ABS]: [entry('src', 'directory', ABS)],
  [`${ABS}/src`]: [entry('main.ts', 'file', `${ABS}/src`)],
}

function installPort(stat: FilesPort['stat']): FilesPort {
  const port: FilesPort = {
    ready: async () => undefined,
    listDirectory: vi.fn(async (path: string) =>
      TREE[path] ? { success: true, entries: TREE[path] } : { success: false, error: 'nope' },
    ),
    stat,
    readContent: vi.fn(async () => ({ success: true, content: '', size: 0 })),
    saveContent: vi.fn(async () => ({ success: true })),
    reveal: vi.fn(async () => ({ success: true })),
    list: vi.fn(async () => ({ success: true, files: [], entries: [] })),
  }
  configureFilesPort(port)
  return port
}

const expandingStat = vi.fn(async (at: string) => ({
  success: true,
  type: 'directory' as const,
  path: at.replace(/^~/, HOME),
}))

/** 照真机那样**从树上读** —— 第一片叶那一格 `dir` 交给它那一种自己的 `render`。 */
function DirHarness() {
  const regions = useWorkbenchStore((st) => st.regions)
  const ref = useMemo(() => {
    for (const tree of Object.values(regions)) {
      for (const leaf of leavesOf(tree)) {
        const tab = leaf.tabs.find((t) => t.kind === DIR_KIND)
        if (tab) return tab
      }
    }
    return null
  }, [regions])
  if (!ref) return null
  // key 跟着 ref 走:与内容挂载表同一条(key 变了 = 另一份内容,换一只组件)。
  return <div key={ref.key}>{contentKindOf(DIR_KIND)?.render(ref, DEFAULT_PANEL_VISIBILITY)}</div>
}

function dirKeys(): string[] {
  const out: string[] = []
  for (const tree of Object.values(useWorkbenchStore.getState().regions)) {
    for (const leaf of leavesOf(tree)) for (const tab of leaf.tabs) if (tab.kind === DIR_KIND) out.push(tab.key)
  }
  return out
}

function seedTwoLeaves(): void {
  const tree: PaneNode = {
    kind: 'split',
    id: 'S',
    dir: 'row',
    ratio: 50,
    a: makeLeaf('A', [dirRef(TILDE)]),
    b: makeLeaf('B', [dirRef(TILDE)]),
  }
  useWorkbenchStore.setState({ regions: { [CENTER_REGION]: tree } })
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  useFilesSource.getState().reset()
  useWorkbenchStore.getState().reset()
  expandingStat.mockClear()
})

afterEach(() => {
  focusTree.reset()
  configureFilesPort(undefined)
})

describe('存量 `dir:~/…`:渲染那一拍展开并改写', () => {
  it('展开中只画骨架,不画 `/~/…` 面包屑;落定后两片叶都换成绝对 key', async () => {
    const pendingStats: (() => void)[] = []
    installPort(
      vi.fn(
        (at: string) =>
          new Promise<{ success: true; type: 'directory'; path: string }>((resolve) => {
            pendingStats.push(() => resolve({ success: true, type: 'directory', path: at.replace(/^~/, HOME) }))
          }),
      ),
    )
    seedTwoLeaves()
    render(
      <>
        <FocusDispatchHarness />
        <DirHarness />
      </>,
    )
    // ① 展开中:骨架那一句在,面包屑一段 `~` 都没有(头上是「正在确定根目录…」)。
    const pending = screen.getByTestId('files-home-root')
    expect(pending.getAttribute('data-state')).toBe('resolving')
    expect(screen.getByRole('status', { name: '正在读取…' })).toBeTruthy()
    expect(pending.textContent).not.toContain('~')
    expect(screen.queryByTestId('files-root')).toBeNull()

    // 发出去的每一发都答(真机上一格一发;双挂时两发,第二次改写是恒等)。
    await waitFor(() => expect(pendingStats.length).toBeGreaterThan(0))
    await act(async () => {
      for (const answer of pendingStats) answer()
    })
    // ② 落定:树里没有一格 `dir` 的 key 以 `~` 起笔,两片叶各换各的。
    await waitFor(() => expect(dirKeys()).toEqual([ABS, ABS]))
    const leaves = leavesOf(useWorkbenchStore.getState().regions[CENTER_REGION])
    expect(leaves.map((leaf) => leaf.id)).toEqual(['A', 'B'])
    // 换上来的是真面板,根是绝对路径。
    await waitFor(() => expect(screen.getByTestId('files-root').getAttribute('data-root')).toBe(ABS))
  })

  it('换上来的面板能展开子层 —— 子层真的进了订阅表(报障那一句)', async () => {
    installPort(expandingStat)
    seedTwoLeaves()
    render(
      <>
        <FocusDispatchHarness />
        <DirHarness />
      </>,
    )
    await waitFor(() => expect(screen.getByText('src')).toBeTruthy())
    fireEvent.click(screen.getByText('src'))
    await waitFor(() => expect(screen.getByText('main.ts')).toBeTruthy())
    expect(dirKeys().some((key) => key.startsWith('~'))).toBe(false)
  })

  it('展不开:沿用「这个目录不在了」+ 后端原话;重试再问一次,答回来就改写', async () => {
    let ok = false
    const stat = vi.fn(async (at: string) =>
      ok
        ? { success: true, type: 'directory' as const, path: at.replace(/^~/, HOME) }
        : { success: false, error: 'EACCES: home unreadable' },
    )
    installPort(stat)
    seedTwoLeaves()
    render(
      <>
        <FocusDispatchHarness />
        <DirHarness />
      </>,
    )
    await waitFor(() => expect(screen.getByText('这个目录不在了')).toBeTruthy())
    expect(screen.getByText('EACCES: home unreadable')).toBeTruthy()
    expect(screen.getByTestId('files-home-root').getAttribute('data-state')).toBe('failed')
    // 没展开就不改写:一格猜出来的 key 比 `~` 更糟。
    expect(dirKeys()).toEqual([TILDE, TILDE])

    ok = true
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(dirKeys()).toEqual([ABS, ABS]))
    expect(stat.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('`referenceRoot` / `presents` 在展开之前答「不算」(那串字不是后端认得的地址)', () => {
    const kind = contentKindOf(DIR_KIND)
    expect(kind?.referenceRoot?.(dirRef(TILDE))).toBeNull()
    expect(kind?.presents?.(dirRef(TILDE))).toBeNull()
    expect(kind?.referenceRoot?.(dirRef(ABS))).toBe(ABS)
    expect(kind?.presents?.(dirRef(ABS))).toBe(`dir:${ABS}`)
  })
})
