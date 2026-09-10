import { beforeEach, describe, expect, it } from 'vitest'
import { registerContentKind, resetContentKinds } from '../kinds'
import { CENTER_REGION } from '../regions'
import { normalizeRegions, useWorkbenchStore, WORKBENCH_PER_SPACE } from '../store'
import {
  clearPreviewIndex,
  foldLeaves,
  insertTab,
  leavesOf,
  makeLeaf,
  moveTab,
  previewIndexOf,
  refIdsOf,
  removeTab,
  replaceRef,
  sanitize,
  setPreviewIndex,
  stripPreviewIndex,
} from '../tree'
import type { ContentRef } from '../kinds'
import type { PaneLeafNode, PaneNode } from '../tree'

/**
 * **预览格那一格标记**(C2,正本 `apps/desktop-react/docs/session-continuity-2026-09.md`
 * §4.3)—— 树侧与 store 侧。
 *
 * 与 `replace-ref.test.ts` 逐字同一条纪律:被测的是**核心层**,所以这一组里
 * 一个「会话」的字都不该出现。夹具的种类名是 `doc` / `home`,`home` 只是
 * 「一种自述了 resident 的内容」。会话那一档的判据在
 * `content/__tests__/session-open-mode.test.ts`。
 */

const doc = (key: string): ContentRef => ({ kind: 'doc', key })

beforeEach(() => {
  resetContentKinds()
  registerContentKind({
    id: 'home',
    singleton: false,
    resident: { region: CENTER_REGION, seed: () => 'main' },
    title: (ref) => ({ text: ref.key }),
    icon: () => 'House',
    render: () => null,
  })
  registerContentKind({
    id: 'doc',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'File',
    render: () => null,
  })
  useWorkbenchStore.getState().reset()
  useWorkbenchStore.getState().seed()
})

const center = (): PaneNode => useWorkbenchStore.getState().regions[CENTER_REGION]
const onlyLeaf = (): PaneLeafNode => leavesOf(center())[0]
const leafOf = (node: PaneNode): PaneLeafNode => leavesOf(node)[0]

describe('previewIndexOf:越界的一律当没有', () => {
  it('缺席 / 越界 / 不是整数 → undefined', () => {
    const leaf = makeLeaf('L', [doc('a'), doc('b')], 0)
    expect(previewIndexOf(leaf)).toBeUndefined()
    expect(previewIndexOf({ ...leaf, previewIndex: 0 })).toBe(0)
    expect(previewIndexOf({ ...leaf, previewIndex: 2 })).toBeUndefined()
    expect(previewIndexOf({ ...leaf, previewIndex: -1 })).toBeUndefined()
    expect(previewIndexOf({ ...leaf, previewIndex: 1.5 })).toBeUndefined()
  })
})

describe('标记跟着下标走', () => {
  it('插在预览格**之前** → 标记往后挪一格;插在它之后 → 不动', () => {
    const base = setPreviewIndex(makeLeaf('L', [doc('a'), doc('b')], 0), 'L', 1)
    expect(previewIndexOf(leafOf(base))).toBe(1)

    const before = insertTab(base, 'L', doc('x'), { at: 0 })
    expect(refIdsOf(before)).toEqual(['doc:x', 'doc:a', 'doc:b'])
    expect(previewIndexOf(leafOf(before))).toBe(2)

    const after = insertTab(base, 'L', doc('y'))
    expect(previewIndexOf(leafOf(after))).toBe(1)
  })

  it('`preview: true` 插进来的那一格**就是**预览格,顶掉原来那一格的标记', () => {
    const base = setPreviewIndex(makeLeaf('L', [doc('a'), doc('b')], 0), 'L', 0)
    const next = insertTab(base, 'L', doc('x'), { at: 2, preview: true })
    expect(refIdsOf(next)).toEqual(['doc:a', 'doc:b', 'doc:x'])
    // 一片叶最多一格预览位 —— 原来 doc:a 那一格于是转正。
    expect(previewIndexOf(leafOf(next))).toBe(2)
  })

  it('摘掉预览格本身 = 这片叶没有预览格了(转正之三:拖走它)', () => {
    const base = setPreviewIndex(makeLeaf('L', [doc('a'), doc('b'), doc('c')], 0), 'L', 1)
    expect(previewIndexOf(leafOf(removeTab(base, 'L', 1)))).toBeUndefined()
    // 摘掉它**前面**那一格 → 标记往前收一格;摘后面的 → 不动。
    expect(previewIndexOf(leafOf(removeTab(base, 'L', 0)))).toBe(0)
    expect(previewIndexOf(leafOf(removeTab(base, 'L', 2)))).toBe(1)
  })

  it('原位换 ref:格数没变,**它还是预览格**(§4.1「预览格里原来那条被换掉」)', () => {
    const base = setPreviewIndex(makeLeaf('L', [doc('a'), doc('b')], 0), 'L', 1)
    const next = replaceRef(base, 'L', doc('b'), doc('B'))
    expect(refIdsOf(next)).toEqual(['doc:a', 'doc:B'])
    expect(previewIndexOf(leafOf(next))).toBe(1)
  })

  it('换上去的那一格这片叶里已经有了(合并)→ 真的少一格,标记按「摘掉」重算', () => {
    const base = setPreviewIndex(makeLeaf('L', [doc('a'), doc('b'), doc('c')], 0), 'L', 2)
    const next = replaceRef(base, 'L', doc('a'), doc('b'))
    expect(refIdsOf(next)).toEqual(['doc:b', 'doc:c'])
    expect(previewIndexOf(leafOf(next))).toBe(1)
  })

  it('同叶换序:搬的是**预览格自己** → 转正;搬别人 → 标记跟着下标走', () => {
    const base = setPreviewIndex(makeLeaf('L', [doc('a'), doc('b'), doc('c')], 0), 'L', 0)
    // `at` 是对着**换之前那张表**量的下标(判词在 `tree.moveTab` 上)。
    const dragged = moveTab(base, { leafId: 'L', index: 0 }, { leafId: 'L', at: 2 })
    expect(refIdsOf(dragged)).toEqual(['doc:b', 'doc:a', 'doc:c'])
    expect(previewIndexOf(leafOf(dragged))).toBeUndefined()

    const other = moveTab(base, { leafId: 'L', index: 2 }, { leafId: 'L', at: 0 })
    expect(refIdsOf(other)).toEqual(['doc:c', 'doc:a', 'doc:b'])
    expect(previewIndexOf(leafOf(other))).toBe(1)
  })
})

describe('归一那几遍', () => {
  it('折叶:第一片那一格留着,后面几片的转正(一片叶只有一个预览位)', () => {
    const a = setPreviewIndex(makeLeaf('A', [doc('a1'), doc('a2')], 0), 'A', 1) as PaneLeafNode
    const b = setPreviewIndex(makeLeaf('B', [doc('b1')], 0), 'B', 0) as PaneLeafNode
    const folded = foldLeaves({ kind: 'split', id: 'S', dir: 'row', ratio: 50, a, b })
    expect(refIdsOf(folded)).toEqual(['doc:a1', 'doc:a2', 'doc:b1'])
    expect(previewIndexOf(folded)).toBe(1)
  })

  it('清洗:洗掉一格之后标记重算;洗掉的**就是**预览格 → 没有预览格', () => {
    const opts = { known: (k: string) => k !== 'gone', singleton: () => false }
    const live = setPreviewIndex(
      makeLeaf('L', [{ kind: 'gone', key: 'x' }, doc('a'), doc('b')], 0),
      'L',
      2,
    )
    const washed = sanitize(live, opts)!
    expect(refIdsOf(washed)).toEqual(['doc:a', 'doc:b'])
    expect(previewIndexOf(leafOf(washed))).toBe(1)

    const dead = setPreviewIndex(
      makeLeaf('L', [doc('a'), { kind: 'gone', key: 'x' }], 0),
      'L',
      1,
    )
    expect(previewIndexOf(leafOf(sanitize(dead, opts)!))).toBeUndefined()
  })

  it('清洗是**幂等**的:洗过一遍的树再洗一遍交回同一个对象', () => {
    const opts = { known: () => true, singleton: () => false }
    const live = setPreviewIndex(makeLeaf('L', [doc('a'), doc('b')], 0), 'L', 1)
    const once = sanitize(live, opts)!
    expect(sanitize(once, opts)).toBe(once)
  })
})

describe('它不落盘', () => {
  it('`stripPreviewIndex` 剥干净;一格都没剥到时**原样交回同一个对象**', () => {
    const clean = makeLeaf('L', [doc('a')], 0)
    expect(stripPreviewIndex(clean)).toBe(clean)

    const marked = setPreviewIndex(clean, 'L', 0)
    const stripped = stripPreviewIndex(marked)
    expect(previewIndexOf(leafOf(stripped))).toBeUndefined()
    expect('previewIndex' in (leafOf(stripped) as object)).toBe(false)
  })

  it('`WORKBENCH_PER_SPACE.pick` 交出去的家具里没有它(重启 / 换空间 = 转正)', () => {
    const store = useWorkbenchStore.getState()
    store.openRef(doc('a'), { region: CENTER_REGION, preview: true })
    expect(previewIndexOf(onlyLeaf())).not.toBeUndefined()

    const furniture = WORKBENCH_PER_SPACE.pick(useWorkbenchStore.getState())
    expect(previewIndexOf(leafOf(furniture.regions[CENTER_REGION]))).toBeUndefined()
    // 账上剥掉,**活状态一个字不动**(账与活状态是两份)。
    expect(previewIndexOf(onlyLeaf())).not.toBeUndefined()
  })

  /*
   * **反证**:把 `pick` 里那一句 `strippedRegions(s.regions)` 换回 `s.regions`
   * → 上面那一条当场红(家具账里躺着 `previewIndex`,重启之后预览格还在)。
   */
})

describe('store:标一格 / 转正', () => {
  it('previewTab 标上,promoteTab 清掉;两口都幂等(引用恒等)', () => {
    const store = useWorkbenchStore.getState()
    store.openRef(doc('a'), { region: CENTER_REGION })
    const leafId = onlyLeaf().id
    const at = onlyLeaf().tabs.findIndex((tab) => tab.key === 'a')

    store.previewTab(leafId, at)
    expect(previewIndexOf(onlyLeaf())).toBe(at)
    const marked = center()
    store.previewTab(leafId, at)
    expect(center()).toBe(marked)

    store.promoteTab(leafId, at)
    expect(previewIndexOf(onlyLeaf())).toBeUndefined()
    const promoted = center()
    store.promoteTab(leafId, at)
    expect(center()).toBe(promoted)
  })

  it('promoteTab 点名了下标 → **只在它恰好是预览格时才清**', () => {
    const leaf = setPreviewIndex(makeLeaf('L', [doc('a'), doc('b')], 0), 'L', 1)
    // 点名第 0 格:那不是预览格,一个字都不该动。
    expect(clearPreviewIndex(leaf, 'L', 0)).toBe(leaf)
    expect(previewIndexOf(leafOf(clearPreviewIndex(leaf, 'L', 1)))).toBeUndefined()
    expect(previewIndexOf(leafOf(clearPreviewIndex(leaf, 'L')))).toBeUndefined()
  })

  it('关掉预览格之后,`normalizeRegions` 那一遍不会把标记落到隔壁头上', () => {
    const store = useWorkbenchStore.getState()
    store.openRef(doc('a'), { region: CENTER_REGION })
    store.openRef(doc('b'), { region: CENTER_REGION, preview: true })
    const leafId = onlyLeaf().id
    const previewAt = previewIndexOf(onlyLeaf())!
    expect(onlyLeaf().tabs[previewAt].key).toBe('b')

    store.closeTab(leafId, previewAt)
    expect(previewIndexOf(onlyLeaf())).toBeUndefined()
    // 再洗一遍照旧(幂等)。
    expect(previewIndexOf(leafOf(normalizeRegions({ [CENTER_REGION]: center() })[CENTER_REGION]))).toBeUndefined()
  })
})
