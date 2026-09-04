import { beforeEach, describe, expect, it } from 'vitest'
import { act } from '@testing-library/react'
import { openFileInCurrentTarget, setFileOpenMode } from '../viewer/open-target'
import { FILE_OPEN_MODES, regionOfFileOpenMode, useFileOpenMode } from '../../data/file-open-mode'
import { useWorkbenchStore, regionOfRefIn } from '../../workbench/store'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import { registerContentKind, resetContentKinds, refId } from '../../workbench/kinds'
import { leavesOf } from '../../workbench/tree'
import type { FileOpenMode } from '../../data/file-open-mode'

/**
 * **「打开方式」七档全通**(W4;W1-a 那次「五档禁灰」的临时退化到此结清)。
 *
 * 判据是一句话:**每一档都真的把这个 ref 插进它说的那个区域**。
 * 五档解灰的机械前提就是 W4 那件事 —— 架子与浮窗的身子换成了拼贴树,于是
 * 「插进架子」与「插进中央区」走的是同一句 `openRef(ref, { region })`。
 *
 * 这一组不渲染外壳:它量的是**编排**(`content/viewer/open-target.ts`)那一层,
 * 屏幕上那张菜单由 `files-panel` / `file-viewer` 两组各守一半。
 */

const PATH = '/repo/a.ts'
const REF_ID = `file:${PATH}`

/** 每一档说得出的那个落点(`float` 那一档是个哨位,由编排层铸真窗号)。 */
const EXPECT: Record<FileOpenMode, string> = {
  panel: 'panel',
  stage: 'center',
  'edge-top': 'edge:top',
  'edge-bottom': 'edge:bottom',
  'edge-left': 'edge:left',
  'edge-right': 'edge:right',
  float: 'float:new',
}

beforeEach(() => {
  resetContentKinds()
  registerContentKind({
    id: 'file',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'File',
    render: () => null,
  })
  useWorkbenchStore.getState().reset()
  useStageStore.setState({ ...initialStageState })
  act(() => useFileOpenMode.setState({ mode: 'panel' }))
})

const wb = () => useWorkbenchStore.getState()

describe('档 → 区域的翻译只有一份', () => {
  it('七档逐格对得上;`float` 那一档交回的是哨位(窗号要到落点那一刻才铸得出来)', () => {
    for (const mode of FILE_OPEN_MODES) {
      expect(regionOfFileOpenMode(mode)).toBe(EXPECT[mode])
    }
  })
})

describe('五档解灰:每一档都真的落到那儿', () => {
  it.each(['edge-top', 'edge-bottom', 'edge-left', 'edge-right'] as const)(
    '%s → 那条边那棵树,而且顺手把架子展开(动作意图是「让它看得见」)',
    (mode) => {
      act(() => useFileOpenMode.setState({ mode }))
      act(() => useStageStore.getState().toggleShelfCollapsed(sideOf(mode)))
      expect(useStageStore.getState().shelves[sideOf(mode)].collapsed).toBe(true)

      act(() => openFileInCurrentTarget(PATH))

      const region = `edge:${sideOf(mode)}`
      expect(regionOfRefIn(wb().regions, REF_ID)).toBe(region)
      expect(tabsOf(region)).toEqual([REF_ID])
    },
  )

  it('float → 一扇**新窗**,而且它有身量(不给的话那扇窗一帧都不画)', () => {
    act(() => useFileOpenMode.setState({ mode: 'float' }))
    act(() => openFileInCurrentTarget(PATH))

    const region = regionOfRefIn(wb().regions, REF_ID)
    expect(region?.startsWith('float:')).toBe(true)
    expect(region).not.toBe('float:new')
    const winId = region!.slice('float:'.length)
    expect(useStageStore.getState().floats[winId]).toBeTruthy()
  })

  it('同一档连开两次同一个文件 = **还是那一扇窗**,不是两扇装着同一个文件的窗', () => {
    act(() => useFileOpenMode.setState({ mode: 'float' }))
    act(() => openFileInCurrentTarget(PATH))
    const first = regionOfRefIn(wb().regions, REF_ID)
    act(() => openFileInCurrentTarget(PATH))
    expect(regionOfRefIn(wb().regions, REF_ID)).toBe(first)
    expect(Object.keys(wb().regions).filter((r) => r.startsWith('float:'))).toHaveLength(1)
  })
})

describe('换档即生效:手上那一份当场搬过去', () => {
  it('中央区 → 右侧钉:树里摘掉、插进那条边,实例一路留着', () => {
    act(() => useFileOpenMode.setState({ mode: 'stage' }))
    act(() => openFileInCurrentTarget(PATH))
    expect(regionOfRefIn(wb().regions, REF_ID)).toBe('center')

    act(() => setFileOpenMode('edge-right'))
    expect(regionOfRefIn(wb().regions, REF_ID)).toBe('edge:right')
    expect(useFileOpenMode.getState().mode).toBe('edge-right')
  })

  it('面板内 → 浮窗:分栏收起来,窗开出来', () => {
    act(() => openFileInCurrentTarget(PATH))
    expect(wb().panelPath).toBe(PATH)

    act(() => setFileOpenMode('float'))
    expect(wb().panelPath).toBeNull()
    expect(regionOfRefIn(wb().regions, REF_ID)?.startsWith('float:')).toBe(true)
  })
})

function sideOf(mode: 'edge-top' | 'edge-bottom' | 'edge-left' | 'edge-right') {
  return mode.slice('edge-'.length) as 'top' | 'bottom' | 'left' | 'right'
}

function tabsOf(region: string) {
  return leavesOf(wb().regions[region]).flatMap((leaf) => leaf.tabs.map(refId))
}
