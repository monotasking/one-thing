import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpaceRecord } from '@shared/ipc/spaces'
import { configureSpacesPort } from '../../data/spaces-port'
import { useWorkspaceStore } from '../store'
import { DEFAULT_SPACE_ID } from '../types'
import { startPerSpaceLayout, stopPerSpaceLayout } from '../layout-scope'
import { STAGE_PER_SPACE, useStageStore } from '../../stage/store'
import { SPLIT_PER_SPACE, useSplitPrefs } from '../../data/split-prefs'
import { OPEN_MODE_PER_SPACE, useFileOpenMode } from '../../data/file-open-mode'
import { EXPOSE_PER_SPACE, useExposeStore } from '../../expose/store'
import { useFilesSource } from '../../data/files-source'

/**
 * 五个面**一起**换装(T-W1)。上一组(per-space.test)守的是原语本身,
 * 这一组守的是「真的接上了」—— 每一面各摆一样东西,切过去全变、切回来全复原。
 *
 * 为什么值得单独一组:接线出错的样子是**沉默的**(某一面忘了接,它就跨空间共享),
 * 而那正是用户报的那种「切了空间架子还在」。一面一条断言,漏接哪一面当场点名。
 */

const DEFAULT: SpaceRecord = { id: DEFAULT_SPACE_ID, name: '默认', createdAt: 0 }
const WORK: SpaceRecord = { id: 'ws-work', name: '工作', createdAt: 100 }

async function loadSpaces(): Promise<void> {
  configureSpacesPort({
    ready: async () => undefined,
    list: vi.fn(async () => ({ success: true, spaces: [DEFAULT, WORK] })),
    create: vi.fn(async () => ({ success: false, error: 'not stubbed' })),
    update: vi.fn(async () => ({ success: true })),
    remove: vi.fn(async () => ({ success: true, removed: true })),
  })
  await useWorkspaceStore.getState().load()
}

/**
 * 五个面各摆一样东西,好认。
 *
 * stage 那一份**五格全摆到**(架子 / 落点 / 浮窗 + 次序 / 记忆)——
 * 反证跑出来的教训:只摆架子的话,`pickStageFurniture` 漏摘 `memory` 这类错
 * 一条都抓不住(把 memory 改成 `{}` 全绿)。家具有几格,这里就得摆几格。
 */
function furnish(mark: string): void {
  useStageStore.getState().openAs('files', { kind: 'edge', side: 'right' })
  useStageStore.getState().openAs('diff', { kind: 'float' })
  useSplitPrefs.getState().setRatio('files', mark === 'A' ? 30 : 70)
  useFileOpenMode.getState().setMode(mark === 'A' ? 'panel' : 'float')
  // 09-04:折叠组退役,总览这一面的家具换成范围与展开的房间(见 expose/store.ts)。
  useExposeStore.setState({ expandedRooms: [`room-${mark}`] })
  useFilesSource.setState({ expanded: { [`/p/${mark}`]: true } })
}

/** 屏幕上此刻这五面各是什么样。**stage 的五格逐格读**(见 furnish 的注)。 */
function readFurniture() {
  const stage = useStageStore.getState()
  return {
    shelfTabs: [...(stage.shelves.right.tabs ?? [])],
    placements: { ...stage.placements },
    floatIds: Object.keys(stage.floats).sort(),
    floatOrder: [...stage.floatOrder],
    memoryIds: Object.keys(stage.memory).sort(),
    ratio: useSplitPrefs.getState().ratios.files,
    openMode: useFileOpenMode.getState().mode,
    expandedRooms: [...useExposeStore.getState().expandedRooms],
    expanded: Object.keys(useFilesSource.getState().expanded),
  }
}

beforeEach(async () => {
  useWorkspaceStore.getState().reset()
  localStorage.clear()
  // 五个面各归零到**出厂**,免得用例之间互相污染。出厂那一份一律取各自的
  // `factory()`(就是换装时首进某空间摊开的那一份)—— 手抄一份空状态迟早与
  // 真出厂分叉,而那会让这组用例在「切过去应该是什么样」上说谎。
  useFilesSource.getState().reset()
  useExposeStore.setState({ ...EXPOSE_PER_SPACE.factory(), byWorkspace: {} })
  useSplitPrefs.setState({ ...SPLIT_PER_SPACE.factory(), byWorkspace: {} })
  useFileOpenMode.setState({ ...OPEN_MODE_PER_SPACE.factory(), byWorkspace: {} })
  useStageStore.setState({ ...STAGE_PER_SPACE.factory(), byWorkspace: {} })
  await loadSpaces()
  startPerSpaceLayout()
})

afterEach(() => {
  stopPerSpaceLayout()
  useWorkspaceStore.getState().reset()
  useFilesSource.getState().reset()
})

describe('五个面一起换装', () => {
  it('A 空间摆好 → 切到 B = 全套出厂;**一面都不许漏**', () => {
    furnish('A')
    const inA = readFurniture()
    expect(inA.shelfTabs).toContain('files')
    expect(inA.memoryIds.length).toBeGreaterThan(0)

    useWorkspaceStore.getState().switchTo('ws-work')
    const inB = readFurniture()
    expect(inB.shelfTabs).toEqual([])
    expect(inB.placements).toEqual({})
    expect(inB.floatIds).toEqual([])
    expect(inB.floatOrder).toEqual([])
    expect(inB.memoryIds).toEqual([])
    expect(inB.ratio).toBeUndefined()
    // W6-a:出厂档从 `panel` 改成 `stage`(主区域新标签,设计 §9 那张落差表)。
    expect(inB.openMode).toBe('stage')
    expect(inB.expandedRooms).toEqual([])
    expect(inB.expanded).toEqual([])
  })

  it('B 里另摆一套 → 切回 A = **原样**,两套互不串', () => {
    furnish('A')
    const inA = readFurniture()

    useWorkspaceStore.getState().switchTo('ws-work')
    furnish('B')
    const inB = readFurniture()

    useWorkspaceStore.getState().switchTo(DEFAULT_SPACE_ID)
    expect(readFurniture()).toEqual(inA)

    useWorkspaceStore.getState().switchTo('ws-work')
    expect(readFurniture()).toEqual(inB)
  })

  it('换装是**同步**的 —— 切完那一句之后立刻读到的就是新世界(零骨架的结构保证)', () => {
    furnish('A')
    useWorkspaceStore.getState().switchTo('ws-work')
    // 没有 await、没有 waitFor:一句 switchTo 之后屏幕上的事实已经换完了。
    expect(readFurniture().shelfTabs).toEqual([])
  })
})

describe('偏好不跟着空间走', () => {
  it('Dock 的位置与身量、界面语言:换空间一个字都不变', () => {
    useStageStore.getState().setDockEdge('left')
    useStageStore.getState().setDockSize('lg')
    useStageStore.getState().setLocale('en')
    useWorkspaceStore.getState().switchTo('ws-work')
    const st = useStageStore.getState()
    expect(st.dockEdge).toBe('left')
    expect(st.dockSize).toBe('lg')
    expect(st.locale).toBe('en')
  })
})

describe('接线的生命周期', () => {
  it('stopPerSpaceLayout 之后不再换装;**幂等**', () => {
    furnish('A')
    const inA = readFurniture()
    stopPerSpaceLayout()
    stopPerSpaceLayout()
    useWorkspaceStore.getState().switchTo('ws-work')
    expect(readFurniture()).toEqual(inA)
  })

  it('startPerSpaceLayout 重复调用不会攒出两条订阅', () => {
    startPerSpaceLayout()
    startPerSpaceLayout()
    furnish('A')
    useWorkspaceStore.getState().switchTo('ws-work')
    expect(readFurniture().shelfTabs).toEqual([])
    // 切回来仍然是当初那一份 —— 两条订阅会让第二条把第一条刚摊开的收进旧空间。
    useWorkspaceStore.getState().switchTo(DEFAULT_SPACE_ID)
    expect(readFurniture().shelfTabs).toContain('files')
  })
})
