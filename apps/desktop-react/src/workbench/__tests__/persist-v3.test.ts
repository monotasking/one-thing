import { describe, expect, it } from 'vitest'
import { foldRegionsInPersisted } from '../persist-migrate'
import { CENTER_REGION } from '../regions'

/**
 * **persist v3:中央区折成一片叶 + 预览那一格退役**(W6-a,设计
 * `apps/desktop-react/docs/workbench-tabs-2026-09.md` §10)。
 *
 * 这一组守四件,前两件是这只文件从 v2 起就有的硬要求:
 *  ① **幂等** —— 走过一遍的档案再走一遍,结果逐字相同;
 *  ② **引用恒等** —— 一格都没改到时原样交回同一个对象(没有这一条,每次启动都会
 *     写回一份「内容相同、身份不同」的档案);
 *  ③ 多叶按**阅读序**并成一条标签列表,比例随 split 节点一起丢掉,叶 id 取第一片;
 *  ④ **点名的区域才折** —— 架子与浮窗的树不动(设计 §12:那两处仍可分屏)。
 */

const doc = (key: string) => ({ kind: 'doc', key })

/** v2 的形:中央区一棵两叶的树,每片叶身上还带着那一格 `preview`。 */
const v2 = () => ({
  byWorkspace: {
    default: {
      regions: {
        [CENTER_REGION]: {
          kind: 'split',
          id: 'S1',
          dir: 'row',
          ratio: 40,
          a: { kind: 'leaf', id: 'L1', tabs: [doc('a'), doc('b')], active: 1, preview: 'doc:b' },
          b: { kind: 'leaf', id: 'L2', tabs: [doc('c')], active: 0, preview: null },
        },
        'edge:right': {
          kind: 'split',
          id: 'S2',
          dir: 'col',
          ratio: 50,
          a: { kind: 'leaf', id: 'R1', tabs: [doc('x')], active: 0, preview: null },
          b: { kind: 'leaf', id: 'R2', tabs: [doc('y')], active: 0, preview: null },
        },
      },
      hidden: [],
    },
  },
})

const centerOf = (out: unknown) =>
  (out as ReturnType<typeof v2>).byWorkspace.default.regions[CENTER_REGION] as unknown as {
    kind: string
    id: string
    tabs: { kind: string; key: string }[]
    active: number
    preview?: unknown
  }

describe('v3:多叶中央树折成一条标签列表', () => {
  it('按阅读序并成一条,叶 id 取第一片,比例随 split 一起丢掉', () => {
    const next = foldRegionsInPersisted(v2(), [CENTER_REGION])
    const center = centerOf(next)
    expect(center.kind).toBe('leaf')
    expect(center.id).toBe('L1')
    expect(center.tabs.map((t) => `${t.kind}:${t.key}`)).toEqual(['doc:a', 'doc:b', 'doc:c'])
    // 活动格取第一片的(它是「留下来的那一片」)。
    expect(center.active).toBe(1)
  })

  it('每一片叶身上那格 `preview` 都抹掉(留着 = 一个谁都不读的字段)', () => {
    const next = foldRegionsInPersisted(v2(), [CENTER_REGION])
    expect('preview' in centerOf(next)).toBe(false)
    const shelf = (next as ReturnType<typeof v2>).byWorkspace.default.regions['edge:right'] as
      unknown as { a: object; b: object }
    expect('preview' in shelf.a).toBe(false)
    expect('preview' in shelf.b).toBe(false)
  })

  it('**点名的区域才折**:架子那棵树的两片叶原样留着', () => {
    const next = foldRegionsInPersisted(v2(), [CENTER_REGION])
    const shelf = (next as ReturnType<typeof v2>).byWorkspace.default.regions['edge:right'] as
      unknown as { kind: string }
    expect(shelf.kind).toBe('split')
  })

  it('**幂等**:折过一遍再折一遍,交回的是**同一个对象**', () => {
    const once = foldRegionsInPersisted(v2(), [CENTER_REGION])
    const twice = foldRegionsInPersisted(once, [CENTER_REGION])
    expect(twice).toBe(once)
  })

  it('已经是 v3 形的档案 → **引用恒等**(一格都不重建)', () => {
    const clean = {
      byWorkspace: {
        default: {
          regions: {
            [CENTER_REGION]: { kind: 'leaf', id: 'L1', tabs: [doc('a')], active: 0 },
          },
          hidden: [],
        },
      },
    }
    expect(foldRegionsInPersisted(clean, [CENTER_REGION])).toBe(clean)
  })

  it('形状认不出来的原样带过(迁移不是校验器)', () => {
    const junk = { byWorkspace: { default: { regions: { [CENTER_REGION]: 42 } } } }
    expect(foldRegionsInPersisted(junk, [CENTER_REGION])).toBe(junk)
    expect(foldRegionsInPersisted({}, [CENTER_REGION])).toEqual({})
  })
})
