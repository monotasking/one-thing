import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  WORKBENCH_PER_SPACE,
  canGoFull,
  fullRegionOf,
  fullStillStands,
  occludedByFull,
  startWorkbench,
  useWorkbenchStore,
} from '../store'
import { registerContentKind, resetContentKinds } from '../kinds'
import { CENTER_REGION, edgeRegion } from '../regions'
import { leavesOf } from '../tree'
import type { ContentRef } from '../kinds'

/**
 * **真全屏那一格瞬态**(W2,设计 `docs/workbench-2026-09.md` §4)。
 *
 * 这一组守五件:
 *  ① `toggleFull` 取的是**焦点叶的活动 tab**,而且同一下再按一次是退出;
 *  ② 「进不进得了全屏」问的是**种类的自述**(`fullable`),不是种类的名字 ——
 *     拒绝是**结构化**的(答 `'refused'`),不是静默不做;
 *  ③ 它是**瞬态**:不进 per-space 的 `pick`、不落盘、`reset` 归零;
 *  ④ 装着它的那一格离开树(关 / 藏 / 整区收掉)时**当场退出** ——
 *     不这么做的话全屏层会变成一块空白;
 *  ⑤ 「谁被它盖住」只有一个产地(`occludedByFull`),装着它的那个区域留活口。
 *
 * 用例里注册的是**假种类**(`home` / `doc` / `locked`),与 `store.test.ts` 同一条
 * 理由:换成 `chat` / `file` 会把读者引向「核心层认识聊天」那个错的直觉。
 */

const doc = (key: string): ContentRef => ({ kind: 'doc', key })

beforeEach(() => {
  resetContentKinds()
  registerContentKind({
    id: 'home',
    singleton: true,
    resident: { region: CENTER_REGION, seed: () => 'main' },
    regions: [CENTER_REGION],
    title: () => ({ text: '家' }),
    icon: () => 'Layers',
    render: () => null,
  })
  registerContentKind({
    id: 'doc',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'FileText',
    render: () => null,
  })
  // 「这一种进不了全屏」——今天真库里说 false 的是 chat(输入框会被盖掉)。
  registerContentKind({
    id: 'locked',
    singleton: true,
    fullable: false,
    title: () => ({ text: '锁着的' }),
    icon: () => 'Lock',
    render: () => null,
  })
  useWorkbenchStore.getState().reset()
  startWorkbench()
})

afterEach(() => {
  resetContentKinds()
})

const st = () => useWorkbenchStore.getState()
const center = () => st().regions[CENTER_REGION]
const onlyLeaf = () => leavesOf(center())[0]

describe('① toggleFull:焦点叶的活动 tab 进 / 出', () => {
  it('取的是**活动 tab**,`from` 记下它当时那一格', () => {
    st().openRef(doc('a'))
    st().openRef(doc('b'))
    const leaf = onlyLeaf()
    expect(st().toggleFull()).toBe('entered')
    expect(st().full?.ref).toEqual(doc('b'))
    expect(st().full?.from).toEqual({ region: CENTER_REGION, leafId: leaf.id, index: leaf.active })
  })

  it('再按一次 = 退出(同一个键收回去)', () => {
    st().openRef(doc('a'))
    expect(st().toggleFull()).toBe('entered')
    expect(st().toggleFull()).toBe('exited')
    expect(st().full).toBeNull()
  })

  it('**焦点叶**说了算:焦点指到另一片,铺的就是另一片的活动 tab', () => {
    st().openRef(doc('a'))
    const first = onlyLeaf()
    st().splitLeaf(first.id, 'row', doc('b'))
    const second = st().focusLeafId
    expect(second).not.toBe(first.id)
    expect(st().toggleFull()).toBe('entered')
    expect(st().full?.ref).toEqual(doc('b'))

    st().exitFull()
    st().setFocusLeaf(first.id)
    expect(st().toggleFull()).toBe('entered')
    expect(st().full?.ref).toEqual(doc('a'))
  })

  it('`exitFull` 是**恒等变换**:没开着时不惊动订阅者', () => {
    const before = st().full
    st().exitFull()
    expect(st().full).toBe(before)
  })
})

describe('② 拒绝是结构化的,判据是种类的自述', () => {
  it('`fullable: false` 的那一格 → `refused`,而且一格状态都没写', () => {
    st().openRef({ kind: 'locked', key: 'x' })
    expect(st().toggleFull()).toBe('refused')
    expect(st().full).toBeNull()
  })

  it('判据问表不问名字:`canGoFull` 缺席读作「进得了」,认不得的种类读作「进不了」', () => {
    expect(canGoFull(doc('a'))).toBe(true)
    expect(canGoFull({ kind: 'locked', key: 'x' })).toBe(false)
    expect(canGoFull({ kind: 'ghost', key: 'x' })).toBe(false)
  })

  it('`enterFull` 对同一格也认这条自述(它是另一个入口,静默不做)', () => {
    st().enterFull({ kind: 'locked', key: 'x' })
    expect(st().full).toBeNull()
  })
})

describe('③ 它是瞬态:不进家具账、不落盘、reset 归零', () => {
  it('**`pick` 里没有它** —— 换空间那一句因此不会把它收进账,也就不会落盘', () => {
    st().openRef(doc('a'))
    st().toggleFull()
    const furniture = WORKBENCH_PER_SPACE.pick(st())
    expect(Object.keys(furniture).sort()).toEqual(['hidden', 'regions'])
    expect('full' in furniture).toBe(false)
  })

  it('`reset` 归零', () => {
    st().openRef(doc('a'))
    st().toggleFull()
    expect(st().full).not.toBeNull()
    st().reset()
    expect(st().full).toBeNull()
  })
})

describe('④ 装着它的那一格离开树 → 当场退出', () => {
  it('关掉那一格', () => {
    st().openRef(doc('a'))
    const leaf = onlyLeaf()
    st().toggleFull()
    st().closeTab(leaf.id, leaf.tabs.length - 1)
    expect(st().full).toBeNull()
  })

  it('藏起那一格', () => {
    st().openRef(doc('a'))
    const leaf = onlyLeaf()
    st().toggleFull()
    st().hideTab(leaf.id, leaf.tabs.length - 1)
    expect(st().full).toBeNull()
  })

  it('整区收掉(浮窗那颗 ✕ 走的就是它)', () => {
    st().openRef(doc('a'), { region: edgeRegion('right') })
    st().toggleFull()
    expect(st().full?.ref).toEqual(doc('a'))
    st().hideRegion(edgeRegion('right'))
    expect(st().full).toBeNull()
  })

  it('从每棵树里摘掉(收回 Dock 那条路的树侧动作)', () => {
    st().openRef(doc('a'))
    st().toggleFull()
    st().detachRef('doc:a')
    expect(st().full).toBeNull()
  })

  it('**`from === null` 那一路天生站得住**:它本来就不在任何树里', () => {
    st().enterFull(doc('z'), null)
    expect(st().full?.from).toBeNull()
    expect(fullStillStands(st().full, st().regions)).toBe(true)
    // 关掉别的格也动不了它。
    const leaf = onlyLeaf()
    st().closeTab(leaf.id, 0)
    expect(st().full).not.toBeNull()
  })
})

describe('⑤ 谁被它盖住:一个产地', () => {
  it('装着它的那个区域**留活口**,别的区域一律盖住', () => {
    st().openRef(doc('a'), { region: edgeRegion('right') })
    st().toggleFull()
    expect(fullRegionOf(st())).toBe(edgeRegion('right'))
    expect(occludedByFull(st(), edgeRegion('right'))).toBe(false)
    expect(occludedByFull(st(), CENTER_REGION)).toBe(true)
    // 没有区域的宿主(舞台)在全屏期间恒被盖住 —— 全屏 550 > overlay 500。
    expect(occludedByFull(st(), null)).toBe(true)
  })

  it('没开全屏时谁都没被盖住(`region: null` 也一样)', () => {
    expect(occludedByFull(st(), CENTER_REGION)).toBe(false)
    expect(occludedByFull(st(), null)).toBe(false)
    expect(fullRegionOf(st())).toBeNull()
  })

  it('`from === null` 那一路:它不在任何区域里,所以每一层都被盖住', () => {
    st().enterFull(doc('z'), null)
    expect(fullRegionOf(st())).toBeNull()
    expect(occludedByFull(st(), CENTER_REGION)).toBe(true)
  })
})

