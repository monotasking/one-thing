import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from '@testing-library/react'
import { openFileInCurrentTarget, setFileOpenMode } from '../viewer/open-target'
import { FILE_OPEN_MODES, regionOfFileOpenMode, useFileOpenMode } from '../../data/file-open-mode'
import { useWorkbenchStore, regionOfRefIn } from '../../workbench/store'
import { useStageStore } from '../../stage/store'
import { initialStageState } from '../../stage/transitions'
import { registerContentKind, resetContentKinds, refId } from '../../workbench/kinds'
import { leavesOf } from '../../workbench/tree'
import { floatRegion } from '../../workbench/regions'
import { nextFloatId } from '../../stage/placement'
import { configureFilesPort } from '../../data/files-port'
import { useViewerSource } from '../../data/viewer-source'
import type { FilesReadContentResponse } from '@shared/ipc/files'
import type { FilesPort } from '../../data/files-port'
import type { FileOpenMode } from '../../data/file-open-mode'

/**
 * **「打开方式」六档全通**(顶架子那档已退役;W4;W1-a 那次「五档禁灰」的临时退化到此结清)。
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
  it('六档逐格对得上;`float` 那一档交回的是哨位(窗号要到落点那一刻才铸得出来)', () => {
    for (const mode of FILE_OPEN_MODES) {
      expect(regionOfFileOpenMode(mode)).toBe(EXPECT[mode])
    }
  })
})

describe('五档解灰:每一档都真的落到那儿', () => {
  it.each(['edge-bottom', 'edge-left', 'edge-right'] as const)(
    '%s → 那条边那棵树,而且顺手把架子展开(动作意图是「让它看得见」)',
    (mode) => {
      act(() => useFileOpenMode.setState({ mode }))
      act(() => useStageStore.getState().toggleShelfCollapsed(sideOf(mode)))
      expect(useStageStore.getState().shelves[sideOf(mode)].collapsed).toBe(true)

      act(() => openFileInCurrentTarget(PATH))

      const region = `edge:${sideOf(mode)}`
      expect(regionOfRefIn(wb().regions, REF_ID)).toBe(region)
      expect(tabsOf(region)).toEqual([REF_ID])
      /*
       * 这一句从前只写在标题里、没有断言(2026-09-14 真机报障「点击文件打不开了,
       * 选择的是 Pinned right」:右架子收着且把手藏着,文件开进去了一格都看不见)。
       * 把手藏着那一档一并盖住 —— 藏的是把手不是架子,展开照旧要露脸。
       */
      expect(useStageStore.getState().shelves[sideOf(mode)].collapsed).toBe(false)
    },
  )

  it('把手藏着(shelfRail=hidden)的收起架子,开文件进去同样展开 —— 藏的是把手不是架子', () => {
    act(() => useFileOpenMode.setState({ mode: 'edge-right' }))
    act(() => useStageStore.getState().setShelfRail('hidden'))
    act(() => useStageStore.getState().toggleShelfCollapsed('right'))
    expect(useStageStore.getState().shelves.right.collapsed).toBe(true)

    act(() => openFileInCurrentTarget(PATH))

    expect(tabsOf('edge:right')).toEqual([REF_ID])
    expect(useStageStore.getState().shelves.right.collapsed).toBe(false)
    expect(useStageStore.getState().shelfRail).toBe('hidden')
  })

  it('开进一扇被别的窗盖着的浮窗 = 那扇窗置顶(露脸这句话对浮窗的读法)', () => {
    act(() => useFileOpenMode.setState({ mode: 'float' }))
    act(() => openFileInCurrentTarget(PATH))
    const region = regionOfRefIn(wb().regions, REF_ID)!
    const winId = region.slice('float:'.length)
    // 再开一扇别的窗压在它上面。不能再「开第二个文件」来造它:09-24 起第二个文件
    // 跟着第一个住进同一扇窗(判词在 `openRefByFileMode` 的三级上),所以这里直接铸一扇。
    const other = nextFloatId()
    act(() => {
      useStageStore.getState().ensureFloatRect(other)
      wb().openRef({ kind: 'file', key: '/repo/b.ts' }, { region: floatRegion(other) })
      useStageStore.getState().revealRegion(floatRegion(other))
    })
    expect(useStageStore.getState().floatOrder.at(-1)).not.toBe(winId)

    act(() => openFileInCurrentTarget(PATH))
    expect(regionOfRefIn(wb().regions, REF_ID)).toBe(region)
    expect(useStageStore.getState().floatOrder.at(-1)).toBe(winId)
  })

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

describe('打开先问它住在哪,最后才问设置(09-24)', () => {
  function moveToCenter(path: string) {
    act(() => wb().moveRef({ kind: 'file', key: path }, 'center'))
  }

  it('① 同一份文件已经开着(被拖进了主区)→ 点亮那一格,右架子不再插第二份', () => {
    act(() => useFileOpenMode.setState({ mode: 'edge-right' }))
    act(() => openFileInCurrentTarget(PATH))
    moveToCenter(PATH)
    expect(regionOfRefIn(wb().regions, REF_ID)).toBe('center')

    act(() => openFileInCurrentTarget(PATH))

    expect(tabsOf('center').filter((id) => id === REF_ID)).toHaveLength(1)
    // 右架子那棵树随最后一格搬走就没了;没有重新长出来 = 没插第二份。
    expect(wb().regions['edge:right']).toBeUndefined()
  })

  it('② 文件这一种住在主区 → 下一份文件也开在主区,而不是设置说的右架子', () => {
    act(() => useFileOpenMode.setState({ mode: 'edge-right' }))
    act(() => openFileInCurrentTarget(PATH))
    moveToCenter(PATH)

    act(() => openFileInCurrentTarget('/repo/b.ts'))

    expect(regionOfRefIn(wb().regions, 'file:/repo/b.ts')).toBe('center')
  })

  it('② 焦点叶优先:主区与右架子都住着文件,焦点在右架子 → 开在右架子', () => {
    act(() => useFileOpenMode.setState({ mode: 'edge-right' }))
    act(() => openFileInCurrentTarget(PATH))
    act(() => openFileInCurrentTarget('/repo/b.ts'))
    moveToCenter(PATH)
    const right = leavesOf(wb().regions['edge:right']!)[0]!
    act(() => wb().setFocusLeaf(right.id))

    act(() => openFileInCurrentTarget('/repo/c.ts'))

    expect(regionOfRefIn(wb().regions, 'file:/repo/c.ts')).toBe('edge:right')
  })

  it('③ 一个文件都没开着 → 才按设置那一档', () => {
    act(() => useFileOpenMode.setState({ mode: 'edge-right' }))
    act(() => openFileInCurrentTarget(PATH))
    expect(regionOfRefIn(wb().regions, REF_ID)).toBe('edge:right')
  })

  it('浮窗那一档:第二份文件跟着第一份住进同一扇窗(一种内容一个落点)', () => {
    act(() => useFileOpenMode.setState({ mode: 'float' }))
    act(() => openFileInCurrentTarget(PATH))
    const region = regionOfRefIn(wb().regions, REF_ID)
    act(() => openFileInCurrentTarget('/repo/b.ts'))
    expect(regionOfRefIn(wb().regions, 'file:/repo/b.ts')).toBe(region)
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

  it('中央区 → 右侧钉,而右架子正收着:搬过去的同时把架子展开(不然搬过去等于搬没了)', () => {
    act(() => useFileOpenMode.setState({ mode: 'stage' }))
    act(() => openFileInCurrentTarget(PATH))
    act(() => useStageStore.getState().toggleShelfCollapsed('right'))
    expect(useStageStore.getState().shelves.right.collapsed).toBe(true)

    act(() => setFileOpenMode('edge-right'))
    expect(regionOfRefIn(wb().regions, REF_ID)).toBe('edge:right')
    expect(useStageStore.getState().shelves.right.collapsed).toBe(false)
  })

  it('面板内 → 浮窗:分栏收起来,窗开出来', () => {
    act(() => openFileInCurrentTarget(PATH))
    expect(wb().panelPath).toBe(PATH)

    act(() => setFileOpenMode('float'))
    expect(wb().panelPath).toBeNull()
    expect(regionOfRefIn(wb().regions, REF_ID)?.startsWith('float:')).toBe(true)
  })
})

/**
 * **落到第几行**(09-18;检索面那条报障的另一半)。
 *
 * 判据只有一条,而且它是个**时序**判据:那一句 `setView({ currentLine })` 必须排在
 * 「内容已经上屏」之后。理由在 `open-target.ts` 那段注上 —— `useViewerScroll` 的跳行
 * effect 依赖 `[bodyRef, currentLine, path]`,在内容之前写就是在没有 `[data-line]` 的
 * 那一帧跑一次、落空,而随后内容到位时依赖一格没变,effect 再也不跑。
 *
 * 所以这一组用一发**手动收口**的读:飞行途中量一次(必须还是 0),落地之后再量一次。
 * 反证:把 `open-target.ts` 里那句 `.then(...)` 摊平成与落点同一拍 → 第一条断言当场红。
 */
describe('落到第几行:写在读回来之后', () => {
  /** 这一组自己换端口,跑完还给 `test/setup.ts` 装的那一份(读一律答失败)。 */
  const BASELINE: FilesPort = {
    ready: async () => undefined,
    listDirectory: async () => ({ success: false, error: 'no files port in tests' }),
    stat: async () => ({ success: false, error: 'no files port in tests' }),
    readContent: async () => ({ success: false, error: 'no files port in tests' }),
    saveContent: async () => ({ success: true }),
    reveal: async () => ({ success: false, error: 'no files port in tests' }),
    list: async () => ({ success: true, files: [], entries: [] }),
  }

  /*
   * 查看器的实例表**跨用例活着**(它是模块级 store,而这个文件上面那几组早就
   * 用同一条 PATH 开过文件了)。不归零的话 `openFile` 那句「已经有实例而且没有在飞的读
   * = 什么都不做」当场命中,这一组量的就不是一发真读 —— 第一遍写出来时正是这么红的。
   */
  beforeEach(() => useViewerSource.getState().reset())

  afterEach(() => {
    configureFilesPort(BASELINE)
    useViewerSource.getState().reset()
  })

  it('读还在飞的那一段 currentLine 一格不动;内容落定之后才落到那一行', async () => {
    let settle: ((response: FilesReadContentResponse) => void) | undefined
    configureFilesPort({
      ...BASELINE,
      readContent: () => new Promise<FilesReadContentResponse>((resolve) => { settle = resolve }),
    })
    act(() => useFileOpenMode.setState({ mode: 'stage' }))

    act(() => openFileInCurrentTarget(PATH, 7))
    // 落点当场就位(四律:先摆再等内容),而行号还没落 —— 屏上此刻没有 `[data-line]`。
    expect(regionOfRefIn(wb().regions, REF_ID)).toBe('center')
    expect(useViewerSource.getState().instances[PATH]?.view.currentLine).toBe(0)

    // 端口是**惰性** await 出来的,所以那一发读要过一拍才真的出门。
    await act(async () => { await flush() })
    expect(typeof settle).toBe('function')
    // 读在飞的这一段:内容还没上屏,行号也还是 0(这一条就是时序判据本身)。
    expect(useViewerSource.getState().instances[PATH]?.file).toBeNull()
    expect(useViewerSource.getState().instances[PATH]?.view.currentLine).toBe(0)

    await act(async () => {
      settle?.({ success: true, content: 'a\nb\nc\nd\ne\nf\ng\nh\n', size: 16 })
      await flush()
    })
    expect(useViewerSource.getState().instances[PATH]?.file?.kind).toBe('code')
    expect(useViewerSource.getState().instances[PATH]?.view.currentLine).toBe(7)
  })

  it('不给行号就一格都不写 —— 「打开」与「打开并跳到第 n 行」是两句话', async () => {
    act(() => useFileOpenMode.setState({ mode: 'stage' }))
    await act(async () => { openFileInCurrentTarget(PATH); await flush() })
    expect(useViewerSource.getState().instances[PATH]?.view.currentLine).toBe(0)
  })

  it('读失败也照落 —— 查看器画的是它自己那句人话,跳行在没有行的面上是恒等操作', async () => {
    act(() => useFileOpenMode.setState({ mode: 'stage' }))
    await act(async () => { openFileInCurrentTarget(PATH, 7); await flush() })
    expect(useViewerSource.getState().instances[PATH]?.file?.kind).toBe('error')
    expect(useViewerSource.getState().instances[PATH]?.view.currentLine).toBe(7)
  })
})

/**
 * 把手上排着的微任务全排干。**不是 `await Promise.resolve()` 数拍** —— 那条读路上
 * 有几个 await 是实现细节(端口惰性 import、readContent、定型),数拍等于把实现
 * 抄一份到用例里,改一行实现就红一条与它无关的断言。
 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function sideOf(mode: 'edge-bottom' | 'edge-left' | 'edge-right') {
  return mode.slice('edge-'.length) as 'bottom' | 'left' | 'right'
}

function tabsOf(region: string) {
  return leavesOf(wb().regions[region]).flatMap((leaf) => leaf.tabs.map(refId))
}
