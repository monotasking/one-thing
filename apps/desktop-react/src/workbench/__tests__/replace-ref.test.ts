import { beforeEach, describe, expect, it } from 'vitest'
import { registerContentKind, resetContentKinds } from '../kinds'
import { CENTER_REGION } from '../regions'
import { rewriteRefsInPersisted } from '../persist-migrate'
import {
  canDetachTab,
  normalizeRegions,
  useWorkbenchStore,
} from '../store'
import { countKind, indexOfRef, leavesOf, makeLeaf, refIdsOf, replaceRef, sanitize } from '../tree'
import { rewriteLegacyContentRef } from '../../content/legacy-refs'
import type { ContentRef } from '../kinds'
import type { PaneNode } from '../tree'

/**
 * **W5-b 的树侧四件**(设计 `apps/desktop-react/docs/workbench-2026-09.md` §8 W5):
 * 原位换 ref、延迟铸 key 的播种、死格清洗、以及存量档案 v1 → v2 的翻译。
 *
 * 四件都在**核心层**,所以这一组里一个「会话」的字都不该出现在被测代码里 ——
 * 夹具用的种类名是 `home`,它只是「一种自述了 resident 的内容」。
 * 会话那一种自己的判据在 `content/__tests__/session-projection.test.ts`。
 */

const doc = (key: string): ContentRef => ({ kind: 'doc', key })
const home = (key: string): ContentRef => ({ kind: 'home', key })

/** 播种时摆哪一个 —— 夹具可改,这就是「延迟铸 key」那一格的全部含义。 */
let seedKey = 'main'

beforeEach(() => {
  resetContentKinds()
  seedKey = 'main'
  registerContentKind({
    id: 'home',
    singleton: false,
    resident: { region: CENTER_REGION, seed: () => seedKey },
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
const onlyLeaf = () => leavesOf(center())[0]

describe('tree.replaceRef:原位换一格', () => {
  it('同叶同下标同活动格 —— 换的只是「这一格代表谁」', () => {
    const leaf = makeLeaf('L1', [doc('a'), doc('b'), doc('c')], 1, null)
    const next = replaceRef(leaf, 'L1', doc('b'), doc('B'))
    expect(refIdsOf(next)).toEqual(['doc:a', 'doc:B', 'doc:c'])
    expect(leavesOf(next)[0].active).toBe(1)
  })

  it('换的那一格是预览 tab → 预览跟着改名(不留一个指不到 tab 的 refId)', () => {
    const leaf = makeLeaf('L1', [doc('a'), doc('b')], 0, 'doc:b')
    const next = replaceRef(leaf, 'L1', doc('b'), doc('B'))
    expect(leavesOf(next)[0].preview).toBe('doc:B')
  })

  it('要换上去的那一格这片叶里已经有了 → 合并:摘掉旧的,活动落到它身上', () => {
    const leaf = makeLeaf('L1', [doc('a'), doc('b')], 0, null)
    const next = replaceRef(leaf, 'L1', doc('a'), doc('b'))
    expect(refIdsOf(next)).toEqual(['doc:b'])
    expect(leavesOf(next)[0].active).toBe(0)
  })

  it('换成它自己 / 那一格不在这片叶 → 恒等(引用都不变)', () => {
    const leaf = makeLeaf('L1', [doc('a')], 0, null)
    expect(replaceRef(leaf, 'L1', doc('a'), doc('a'))).toBe(leaf)
    expect(replaceRef(leaf, 'L1', doc('zz'), doc('b'))).toBe(leaf)
    expect(replaceRef(leaf, 'L9', doc('a'), doc('b'))).toBe(leaf)
  })

  it('兄弟叶原样带过 —— 结构共享是零重挂那条断言的前提', () => {
    const tree: PaneNode = {
      kind: 'split',
      id: 'S1',
      dir: 'row',
      ratio: 50,
      a: makeLeaf('L1', [doc('a')], 0, null),
      b: makeLeaf('L2', [doc('b')], 0, null),
    }
    const next = replaceRef(tree, 'L1', doc('a'), doc('A'))
    expect(next).not.toBe(tree)
    expect((next as { b: unknown }).b).toBe(tree.b)
  })
})

describe('store.replaceRef:叶不被剪掉重建(零重挂的结构前提)', () => {
  it('这片叶唯一那一格换掉之后,叶 id 一个字没变', () => {
    const before = onlyLeaf().id
    useWorkbenchStore.getState().replaceRef(before, home('main'), home('s-1'))
    expect(onlyLeaf().id).toBe(before)
    expect(refIdsOf(center())).toEqual(['home:s-1'])
  })

  it('**反证**:换成「摘一格 + 开一格」→ 叶被 prune 掉,新叶换了 id', () => {
    const before = onlyLeaf().id
    // 这就是「remove + insert」那条路:摘掉之后那片叶空了,`prune` 当场剪掉它,
    // 再开一格开出来的是**另一片叶**。屏幕上那一整片连同兄弟一起重挂。
    useWorkbenchStore.getState().detachRef('home:main')
    useWorkbenchStore.getState().openRef(home('s-1'))
    expect(onlyLeaf().id).not.toBe(before)
    expect(refIdsOf(center())).toEqual(['home:s-1'])
  })

  it('要换上去的那一格开在别处 → 先摘干净,树上不会有两格同名', () => {
    const first = onlyLeaf().id
    useWorkbenchStore.getState().splitLeaf(first, 'row', home('s-2'))
    const second = useWorkbenchStore.getState().focusLeafId!
    expect(refIdsOf(center()).sort()).toEqual(['home:main', 'home:s-2'])

    useWorkbenchStore.getState().replaceRef(first, home('main'), home('s-2'))
    expect(refIdsOf(center())).toEqual(['home:s-2'])
    expect(second).not.toBe(first)
  })
})

describe('resident.seed():延迟铸 key', () => {
  it('播种问的是那一种自己,而且是**播种那一刻**问的', () => {
    expect(refIdsOf(center())).toEqual(['home:main'])
    seedKey = 's-later'
    useWorkbenchStore.getState().reset()
    useWorkbenchStore.getState().seed()
    expect(refIdsOf(center())).toEqual(['home:s-later'])
  })

  it('**反证**:摘掉 `seed()` 那一格自述 → 冷启动那一片播不出来', () => {
    resetContentKinds()
    registerContentKind({
      id: 'home',
      singleton: false,
      // resident 缺席 = 这一种不常驻
      title: (ref) => ({ text: ref.key }),
      icon: () => 'House',
      render: () => null,
    })
    useWorkbenchStore.getState().reset()
    useWorkbenchStore.getState().seed()
    expect(refIdsOf(center())).toEqual([])
  })

  it('「已经有了」问的是**同种还剩几个**,不是「有没有这一个」', () => {
    useWorkbenchStore.getState().replaceRef(onlyLeaf().id, home('main'), home('s-1'))
    useWorkbenchStore.getState().seed()
    // 再播一次不会补出第二格 —— key 变了,但这个区域里同种的还在。
    expect(refIdsOf(center())).toEqual(['home:s-1'])
    expect(countKind(center(), 'home')).toBe(1)
  })

  it('最后一格常驻关不掉那条判据一个字没改(key 换了它照样成立)', () => {
    useWorkbenchStore.getState().replaceRef(onlyLeaf().id, home('main'), home('s-1'))
    expect(canDetachTab(center(), onlyLeaf().id, 0)).toBe(false)
    useWorkbenchStore.getState().openRef(home('s-2'))
    expect(canDetachTab(center(), onlyLeaf().id, 0)).toBe(true)
  })
})

describe('alive():死格清洗的三形', () => {
  /** 「这些 key 已经死了」。别的种类一律活着(清洗不该顺手动文件 tab)。 */
  const aliveExcept = (dead: string[]) => (ref: ContentRef) =>
    ref.kind !== 'home' || !dead.includes(ref.key)

  it('形一:这个区域里**最后一格**常驻死了 → 原位换成新播的那一格', () => {
    useWorkbenchStore.getState().replaceRef(onlyLeaf().id, home('main'), home('s-1'))
    const leafId = onlyLeaf().id
    seedKey = 'main'
    useWorkbenchStore.getState().sweepRefs(aliveExcept(['s-1']))
    expect(refIdsOf(center())).toEqual(['home:main'])
    expect(onlyLeaf().id).toBe(leafId)
  })

  it('形二:还有别的同种 → 整格摘掉', () => {
    useWorkbenchStore.getState().replaceRef(onlyLeaf().id, home('main'), home('s-1'))
    useWorkbenchStore.getState().openRef(home('s-2'))
    useWorkbenchStore.getState().sweepRefs(aliveExcept(['s-1']))
    expect(refIdsOf(center())).toEqual(['home:s-2'])
  })

  it('形三:**隐藏表里那些也扫**(藏起来不等于还活着)', () => {
    useWorkbenchStore.getState().openRef(home('s-2'))
    const leafId = onlyLeaf().id
    useWorkbenchStore.getState().hideTab(leafId, indexOfRef(onlyLeaf(), home('s-2')))
    expect(useWorkbenchStore.getState().hidden.map((e) => e.ref.key)).toEqual(['s-2'])

    useWorkbenchStore.getState().sweepRefs(aliveExcept(['s-2']))
    expect(useWorkbenchStore.getState().hidden).toEqual([])
  })

  it('一格都没死 → **引用恒等**(不惊动任何订阅者)', () => {
    const before = useWorkbenchStore.getState().regions
    useWorkbenchStore.getState().sweepRefs(() => true)
    expect(useWorkbenchStore.getState().regions).toBe(before)
  })

  it('**反证**:`alive` 缺席时 `sanitize` 一格都不扫', () => {
    const tree = makeLeaf('L1', [home('dead'), doc('a')], 0, null)
    const kept = sanitize(tree, { known: () => true, singleton: () => false })
    expect(refIdsOf(kept!)).toEqual(['home:dead', 'doc:a'])
    const swept = sanitize(tree, {
      known: () => true,
      singleton: () => false,
      alive: (ref) => ref.key !== 'dead',
    })
    expect(refIdsOf(swept!)).toEqual(['doc:a'])
  })
})

describe('persist v1 → v2:存量档案的翻译', () => {
  const v1 = () => ({
    byWorkspace: {
      default: {
        regions: {
          center: {
            kind: 'leaf',
            id: 'L1',
            tabs: [{ kind: 'chat', key: 'main' }, { kind: 'file', key: '/a.ts' }],
            active: 0,
            preview: 'chat:main',
          },
        },
        hidden: [
          { ref: { kind: 'chat', key: 'main' }, returnTo: { region: 'center', leafId: 'L1', index: 0 } },
        ],
      },
    },
  })

  it('`chat:main` → `session:new`,下标与预览都跟着走', () => {
    const next = rewriteRefsInPersisted(v1(), rewriteLegacyContentRef) as never as ReturnType<typeof v1>
    const leaf = next.byWorkspace.default.regions.center
    expect(leaf.tabs).toEqual([{ kind: 'session', key: 'new' }, { kind: 'file', key: '/a.ts' }])
    expect(leaf.preview).toBe('session:new')
    expect(next.byWorkspace.default.hidden[0].ref).toEqual({ kind: 'session', key: 'new' })
  })

  it('**幂等**:翻过一遍的档案再翻一遍,交回的是**同一个对象**', () => {
    const once = rewriteRefsInPersisted(v1(), rewriteLegacyContentRef)
    const twice = rewriteRefsInPersisted(once, rewriteLegacyContentRef)
    expect(twice).toBe(once)
  })

  it('没有那一种的档案 → 引用恒等(一格都不重建)', () => {
    const clean = {
      byWorkspace: {
        default: {
          regions: { center: { kind: 'leaf', id: 'L1', tabs: [{ kind: 'file', key: '/a.ts' }], active: 0, preview: null } },
          hidden: [],
        },
      },
    }
    expect(rewriteRefsInPersisted(clean, rewriteLegacyContentRef)).toBe(clean)
  })

  it('split 与形状烂掉的那些原样带过(迁移不是校验器)', () => {
    const nested = {
      byWorkspace: {
        default: {
          regions: {
            center: {
              kind: 'split',
              id: 'S1',
              dir: 'row',
              ratio: 50,
              a: { kind: 'leaf', id: 'L1', tabs: [{ kind: 'chat', key: 'main' }], active: 0, preview: null },
              b: { kind: 'leaf', id: 'L2', tabs: [{ kind: 'file', key: '/b.ts' }], active: 0, preview: null },
            },
          },
          hidden: 'not an array',
        },
      },
    }
    const next = rewriteRefsInPersisted(nested, rewriteLegacyContentRef) as never as typeof nested
    expect(next.byWorkspace.default.regions.center.a.tabs).toEqual([{ kind: 'session', key: 'new' }])
    expect(next.byWorkspace.default.regions.center.b).toBe(nested.byWorkspace.default.regions.center.b)
    expect(next.byWorkspace.default.hidden).toBe('not an array')
  })
})

describe('normalizeRegions 仍旧幂等(播种 + 洗一遍)', () => {
  it('洗过一遍再洗一遍,中央区那一格不会变成两格', () => {
    const once = normalizeRegions({})
    const twice = normalizeRegions(once)
    expect(refIdsOf(twice[CENTER_REGION])).toEqual(['home:main'])
  })
})
