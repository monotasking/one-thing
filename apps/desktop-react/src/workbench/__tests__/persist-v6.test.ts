import { describe, expect, it } from 'vitest'
import { migrateWorkbenchPersisted } from '../store'
import { CENTER_REGION } from '../regions'

/**
 * **persist v6:`panel:diff` 从档案里丢掉**(「改动」面,正本
 * `apps/desktop-react/docs/changes-panel-2026-09.md` §3.2 末段)。
 *
 * 改动那块瓦降格成启动瓦之后 `renderContent('diff')` 答 `null`,存量档案里那一格
 * 于是变成**一格画不出东西的 tab**(标签还在 —— `panel` 那一种认得它,`sanitize`
 * 的 `known` 判的是**种类**不是瓦 id;点开是一块空白)。留着不是无害的:它与
 * stage v8 清 `viewer` 那一段是同一个病,判词逐字抄那儿。
 *
 * 守四条:
 *  ① tab 里那一格丢掉,**别的瓦一格不动**;
 *  ② hidden 里那一格也丢掉(两处都走同一只改写器);
 *  ③ **幂等** —— 走过一遍的档案再走一遍,交回的是同一个对象;
 *  ④ 已经是 v6 形的档案 → **引用恒等**。
 *
 * **反证**:把 `store.ts` 里 `if (version < 6)` 那条拆掉 → ①② 当场红;
 * 把 `legacy-refs.ts` 那句 `return null` 改成 `return ref` → 同样两条红。
 */

const V5 = 5
const V6 = 6

/** v5 的形:中央区一片叶,里面一格改动面 + 一格检索瓦 + 一格目录树;hidden 里也躺着一格改动面。 */
const v5 = () => ({
  byWorkspace: {
    default: {
      regions: {
        [CENTER_REGION]: {
          kind: 'leaf',
          id: 'L1',
          tabs: [
            { kind: 'panel', key: 'diff' },
            { kind: 'panel', key: 'search' },
            { kind: 'dir', key: '/x' },
          ],
          active: 0,
        },
      },
      hidden: [
        { ref: { kind: 'panel', key: 'diff' }, at: 'edge:left' },
        { ref: { kind: 'panel', key: 'notifications' }, at: 'edge:right' },
      ],
      sessionCompanions: {},
    },
  },
})

const centerTabs = (out: unknown) =>
  (out as ReturnType<typeof v5>).byWorkspace.default.regions[CENTER_REGION].tabs

const hiddenOf = (out: unknown) => (out as ReturnType<typeof v5>).byWorkspace.default.hidden

describe('v6:`panel:diff` 从档案里丢掉', () => {
  it('① tab 里那一格丢掉,**别的瓦一格不动**', () => {
    const next = migrateWorkbenchPersisted(v5(), V5)
    expect(centerTabs(next)).toEqual([
      { kind: 'panel', key: 'search' },
      { kind: 'dir', key: '/x' },
    ])
  })

  it('② hidden 里那一格也丢掉(两处都走同一只改写器)', () => {
    const next = migrateWorkbenchPersisted(v5(), V5)
    expect(hiddenOf(next)).toEqual([{ ref: { kind: 'panel', key: 'notifications' }, at: 'edge:right' }])
  })

  it('③ 幂等:走过一遍的再走一遍,逐字相同', () => {
    const once = migrateWorkbenchPersisted(v5(), V5)
    const twice = migrateWorkbenchPersisted(once, V5)
    expect(twice).toEqual(once)
  })

  it('④ 已经是 v6 形的档案:**引用恒等**(一格都不重建)', () => {
    const clean = migrateWorkbenchPersisted(v5(), V5)
    expect(migrateWorkbenchPersisted(clean, V6)).toBe(clean)
  })
})
