import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { CenterRegion } from '../CenterRegion'
import { CENTER_REGION } from '../regions'
import {
  composeContent,
  contentKindOf,
  flattenContent,
  partsOfContent,
  refId,
  registerContentKind,
  resetContentKinds,
} from '../kinds'
import {
  PAIR_RATIO_DEFAULT,
  PAIR_RATIO_MAX,
  PAIR_RATIO_MIN,
  normalizePairRatios,
  startWorkbench,
  useWorkbenchStore,
} from '../store'
import { leavesOf, makeLeaf, refIdsOf } from '../tree'
import { useLiveTitleStore } from '../../stage/live-title'
import { useStageStore } from '../../stage/store'
import { focusTree } from '../../focus/registry'
import { pairPartsOf, pairKeyOf, pairRefOf } from '../../content/kinds/pair-ref'
import { pairContentKind } from '../../content/kinds/pair'
import type { ContentRef } from '../kinds'

/**
 * **一个标签装两格**(W6-a,设计 `apps/desktop-react/docs/workbench-tabs-2026-09.md`
 * §2.1 / §6 / §11 拍点 8)。
 *
 * 这一组守五件:
 *  ① **核心层零枚举** —— `pairRefs` / `unpairAt` 收的是 ref 与下标,判「是不是两格」
 *     问的是**种类自述**(`composite`);`workbench/*` 里 grep `'pair'` 零命中;
 *  ② **三条拒绝**:并自己、并一格已经是两格的、两格相同;
 *  ③ 拆开 = 右格拆成紧邻其后的新标签,左格留原位,活动格不动;
 *  ④ **零重挂**:二合一 / 拆开 / 换比例三步,两格内容的根节点是**同一个 DOM**;
 *  ⑤ 比例是家具:随 ref 走,`sanitize` 时随 ref 清,值钳在 20–80。
 *
 * 这里注册的是**假种类**(`doc`),与 `store.test.ts` 同一条理由:核心层不认识
 * 任何一种内容。真的那一种(`pair`)是 import 进来的 —— 它正是被测的那张自述。
 */

const doc = (key: string): ContentRef => ({ kind: 'doc', key })
let disposed: string[] = []
let closeAnswer: Record<string, 'close' | 'cancel'> = {}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  resetContentKinds()
  disposed = []
  closeAnswer = {}
  registerContentKind({
    id: 'home',
    singleton: true,
    resident: { region: CENTER_REGION, seed: () => 'main' },
    title: () => ({ text: '家' }),
    icon: () => 'Layers',
    render: () => <div data-testid="home-body">家</div>,
  })
  registerContentKind({
    id: 'doc',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'FileText',
    render: (ref) => <div data-testid={`doc-body:${ref.key}`}>{ref.key}</div>,
    beforeClose: (ref) => Promise.resolve(closeAnswer[ref.key] ?? 'close'),
    dispose: (ref) => disposed.push(refId(ref)),
  })
  // 被测的那一种自己装回去(上一句 `reset` 把它也摘了,而注册是模块级副作用)。
  registerContentKind(pairContentKind)
  useWorkbenchStore.getState().reset()
  useLiveTitleStore.setState({ titles: {} })
  startWorkbench()
})

afterEach(() => {
  resetContentKinds()
  focusTree.reset()
})

const st = () => useWorkbenchStore.getState()
const center = () => st().regions[CENTER_REGION]
const onlyLeaf = () => leavesOf(center())[0]

/** 摆好「中央区一条标签条上三格:家 / a / b」,活动格 = a。 */
function seedThree(): string {
  st().openRef(doc('a'))
  useWorkbenchStore.getState().openRef(doc('b'))
  const leaf = onlyLeaf()
  useWorkbenchStore.getState().activateTab(leaf.id, 1)
  return leaf.id
}

describe('① 核心层零枚举:并 / 拆两口问的是种类自述', () => {
  it('`composeContent` 走整张表 —— 核心层不知道并出来的是哪一种', () => {
    const made = composeContent(doc('a'), doc('b'))
    expect(made).toEqual(pairRefOf(doc('a'), doc('b')))
    expect(partsOfContent(made!)).toEqual([doc('a'), doc('b')])
    // 原子内容答 null(「它不是复合的」),而不是一个空数组。
    expect(partsOfContent(doc('a'))).toBeNull()
  })

  it('`flattenContent` 把复合摊成它装着的那几格(引用账 / 计数都读它)', () => {
    const made = composeContent(doc('a'), doc('b'))!
    expect(flattenContent(made)).toEqual([doc('a'), doc('b')])
    expect(flattenContent(doc('a'))).toEqual([doc('a')])
  })

  it('key 的形是 `${refId(a)}|${refId(b)}`,而且路径里真有 `|` 也拆得回来', () => {
    expect(pairKeyOf(doc('a'), doc('b'))).toBe('doc:a|doc:b')
    const weird = doc('/tmp/a|b.ts')
    const made = pairRefOf(weird, doc('b'))
    expect(pairPartsOf(made)).toEqual([weird, doc('b')])
  })
})

describe('② 二合一:三条拒绝 + 一条搬不是复制', () => {
  it('把右边那一格并进活动格 → 一格两格标签顶在原位', () => {
    const leafId = seedThree()
    useWorkbenchStore.getState().pairRefs(leafId, 1, doc('b'), 'right')
    const made = pairRefOf(doc('a'), doc('b'))
    expect(refIdsOf(center())).toEqual(['home:main', refId(made)])
    expect(onlyLeaf().active).toBe(1)
  })

  it('**搬不是复制**:并进来的那一格从原位摘走(不变量 1)', () => {
    const leafId = seedThree()
    useWorkbenchStore.getState().pairRefs(leafId, 1, doc('b'), 'right')
    expect(refIdsOf(center()).filter((id) => id === 'doc:b')).toHaveLength(0)
  })

  it('拒绝:并自己 = 空动作(引用恒等)', () => {
    const leafId = seedThree()
    const before = center()
    useWorkbenchStore.getState().pairRefs(leafId, 1, doc('a'), 'right')
    expect(center()).toBe(before)
  })

  it('拒绝:**两格的标签不能再并**(设计 §6「不允许」)', () => {
    const leafId = seedThree()
    useWorkbenchStore.getState().pairRefs(leafId, 1, doc('b'), 'right')
    const before = center()
    // 再拿那一格两格的去并到「家」上 —— 拒绝。
    useWorkbenchStore.getState().pairRefs(leafId, 0, pairRefOf(doc('a'), doc('b')), 'right')
    expect(center()).toBe(before)
  })

  it('host 已经是两格 → 换掉那一侧,**被换下来的那一格落在它后面**(不掉在地上)', () => {
    const leafId = seedThree()
    useWorkbenchStore.getState().pairRefs(leafId, 1, doc('b'), 'right')
    useWorkbenchStore.getState().openRef(doc('c'))
    // 此刻:家 / (a⫽b) / c,活动 = c。把 c 并进那一格的右侧。
    useWorkbenchStore.getState().pairRefs(leafId, 1, doc('c'), 'right')
    expect(refIdsOf(center())).toEqual([
      'home:main',
      refId(pairRefOf(doc('a'), doc('c'))),
      'doc:b',
    ])
    // 换下来的那一格**没有被 dispose** —— 它只是换出去了,不是被关掉。
    expect(disposed).toEqual([])
  })
})

describe('③ 拆开:右格拆成紧邻其后的新标签', () => {
  it('左格留原位、右格排在它后面、活动格不动', () => {
    const leafId = seedThree()
    useWorkbenchStore.getState().pairRefs(leafId, 1, doc('b'), 'right')
    useWorkbenchStore.getState().unpairAt(leafId, 1)
    expect(refIdsOf(center())).toEqual(['home:main', 'doc:a', 'doc:b'])
    expect(onlyLeaf().active).toBe(1)
  })

  it('不是两格的那一格 = 空动作(引用恒等)', () => {
    const leafId = seedThree()
    const before = center()
    useWorkbenchStore.getState().unpairAt(leafId, 1)
    expect(center()).toBe(before)
  })
})

describe('④ 关一格两格的:两格各问一次,任一格拒绝就不关', () => {
  it('两格都答 close → 关掉,而且两格各自 dispose', async () => {
    const leafId = seedThree()
    useWorkbenchStore.getState().pairRefs(leafId, 1, doc('b'), 'right')
    const made = pairRefOf(doc('a'), doc('b'))
    const kind = contentKindOf('pair')!
    expect(await kind.beforeClose!(made)).toBe('close')
    useWorkbenchStore.getState().closeTab(leafId, 1)
    expect(refIdsOf(center())).toEqual(['home:main'])
    expect(disposed.sort()).toEqual(['doc:a', 'doc:b'])
  })

  it('**任一格说别关就不关**(设计 §6)', async () => {
    const leafId = seedThree()
    useWorkbenchStore.getState().pairRefs(leafId, 1, doc('b'), 'right')
    closeAnswer = { b: 'cancel' }
    const kind = contentKindOf('pair')!
    expect(await kind.beforeClose!(pairRefOf(doc('a'), doc('b')))).toBe('cancel')
  })
})

describe('⑤ 比例是家具:随 ref 走、随 ref 清、钳在两端之间', () => {
  it('缺省 50;落定钳进 20–80', () => {
    const leafId = seedThree()
    useWorkbenchStore.getState().pairRefs(leafId, 1, doc('b'), 'right')
    const id = refId(pairRefOf(doc('a'), doc('b')))
    expect(st().pairRatios[id] ?? PAIR_RATIO_DEFAULT).toBe(PAIR_RATIO_DEFAULT)
    useWorkbenchStore.getState().setPairRatio(id, 5)
    expect(st().pairRatios[id]).toBe(PAIR_RATIO_MIN)
    useWorkbenchStore.getState().setPairRatio(id, 999)
    expect(st().pairRatios[id]).toBe(PAIR_RATIO_MAX)
  })

  it('`sanitize` 那一遍把**已经不在任何一棵树上**的键清掉', () => {
    const id = 'pair:doc:a|doc:b'
    const regions = { [CENTER_REGION]: makeLeaf('L1', [doc('z')]) }
    expect(normalizePairRatios(regions, { [id]: 40 })).toEqual({})
    // 还在树上的那一格留着,而且**一格都没清时引用恒等**。
    const live = { [CENTER_REGION]: makeLeaf('L1', [doc('z')]) }
    const kept = { 'doc:z': 40 }
    expect(normalizePairRatios(live, kept)).toBe(kept)
  })

  it('拆开顺手把那一格比例清掉(它再也不会回来)', () => {
    const leafId = seedThree()
    useWorkbenchStore.getState().pairRefs(leafId, 1, doc('b'), 'right')
    const id = refId(pairRefOf(doc('a'), doc('b')))
    useWorkbenchStore.getState().setPairRatio(id, 30)
    expect(st().pairRatios[id]).toBe(30)
    useWorkbenchStore.getState().unpairAt(leafId, 1)
    expect(st().pairRatios[id]).toBeUndefined()
  })
})

/**
 * **零重挂**(设计 §11 拍点 8:「换序、二合一、拆开、换比例四步内容根节点同一 DOM」)。
 *
 * 判据是**元素同一性**:并之前抓住那两块内容的根节点,并 / 拆 / 换比例之后再抓一次,
 * 必须是同一个对象。反证:把 `PaneContentLayer` 那格 holder 换成「直接渲染在
 * 画法层里」,这三条当场红(React 会把它们卸载重挂)。
 */
describe('⑥ 零重挂:二合一 / 拆开 / 换比例', () => {
  it('三步走完,两格内容的根节点自始至终是同一个 DOM', () => {
    const leafId = seedThree()
    render(<CenterRegion />)
    // 并之前:两格各自是一格普通标签(都挂着 —— keep-alive)。
    const bodyA = screen.getByTestId('doc-body:a')
    const bodyB = screen.getByTestId('doc-body:b')

    act(() => useWorkbenchStore.getState().pairRefs(leafId, 1, doc('b'), 'right'))
    expect(screen.getByTestId('doc-body:a')).toBe(bodyA)
    expect(screen.getByTestId('doc-body:b')).toBe(bodyB)

    const id = refId(pairRefOf(doc('a'), doc('b')))
    act(() => useWorkbenchStore.getState().setPairRatio(id, 35))
    expect(screen.getByTestId('doc-body:a')).toBe(bodyA)
    expect(screen.getByTestId('doc-body:b')).toBe(bodyB)

    act(() => useWorkbenchStore.getState().unpairAt(leafId, 1))
    expect(screen.getByTestId('doc-body:a')).toBe(bodyA)
    expect(screen.getByTestId('doc-body:b')).toBe(bodyB)
  })

  it('两格各自是一格作用域(owner = 各自的 refId),两格都在屏', () => {
    const leafId = seedThree()
    render(<CenterRegion />)
    act(() => useWorkbenchStore.getState().pairRefs(leafId, 1, doc('b'), 'right'))
    // 两格的内容层各带自己的取件口。
    expect(document.querySelector('[data-pane-tab="doc:a"]')).toBeTruthy()
    expect(document.querySelector('[data-pane-tab="doc:b"]')).toBeTruthy()
    // 格头上各一颗「拆开」。
    expect(screen.getAllByLabelText('拆开')).toHaveLength(2)
  })
})
