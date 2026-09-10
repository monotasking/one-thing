import { beforeEach, describe, expect, it } from 'vitest'
import {
  composeContent,
  registerContentKind,
  residencyLevelOf,
  resetContentKinds,
} from '../kinds'
import { CENTER_REGION, edgeRegion, floatRegion } from '../regions'
import { nextLeafId } from '../ids'
import * as T from '../tree'
import { pairContentKind } from '../../content/kinds/pair'
import { pairRefOf } from '../../content/kinds/pair-ref'
import type { ContentRef } from '../kinds'
import type { PaneNode } from '../tree'

/**
 * **全局瓦携带**(S1,正本 `apps/desktop-react/docs/dock-scope-2026-09.md` §2)。
 *
 * 与 `companions.test.ts` / `preview-tab.test.ts` 逐字同一条纪律:被测的是**核心层**,
 * 所以这一组里一个瓦名、一个种类名都不出现 —— 夹具三种,全是假的:
 *  · `roam`  —— 自述 `level: 'app'` 的一种(「工作区」瓦的替身);
 *  · `local` —— 什么都不自述的一种(缺省 = `space`,今天全部内容的替身);
 *  · `mixed` —— `level` 是**函数**的一种(`panel` 那一种转问瓦表的形):
 *               key 以 `app-` 打头的那几格随人走,其余归空间。
 *
 * 「携带」这件事的两条端点:剥(进场树上那几格 app 级的是**旧影**)与
 * 携带(离场活树上那几格才是真的)。反证在文件末尾。
 */

const roam = (key: string): ContentRef => ({ kind: 'roam', key })
const local = (key: string): ContentRef => ({ kind: 'local', key })
const mixed = (key: string): ContentRef => ({ kind: 'mixed', key })

const RIGHT = edgeRegion('right')
const FLOAT = floatRegion('w1')

beforeEach(() => {
  resetContentKinds()
  registerContentKind({
    id: 'roam',
    singleton: true,
    level: 'app',
    title: (ref) => ({ text: ref.key }),
    icon: () => 'Layers',
    render: () => null,
  })
  registerContentKind({
    id: 'local',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'File',
    render: () => null,
  })
  registerContentKind({
    id: 'mixed',
    singleton: true,
    // 「12 块瓦整体登记成一种,而层级是**逐瓦**的事实」那个形。
    level: (ref) => (ref.key.startsWith('app-') ? 'app' : 'space'),
    title: (ref) => ({ text: ref.key }),
    icon: () => 'LayoutGrid',
    render: () => null,
  })
})

describe('residencyLevelOf —— 缺席 = space', () => {
  it('没自述的一种答 space(缺省 = 今天全部内容的行为)', () => {
    expect(residencyLevelOf(local('a'))).toBe('space')
  })

  it('压根没登记的种类也答 space —— 「随人走」不该由一格问不出主的 ref 白拿', () => {
    expect(residencyLevelOf({ kind: 'never-registered', key: 'x' })).toBe('space')
  })

  it('函数形按 ref 逐格答', () => {
    expect(residencyLevelOf(mixed('app-workspace'))).toBe('app')
    expect(residencyLevelOf(mixed('search'))).toBe('space')
  })
})

describe('stripByLevel —— 剥', () => {
  it('把这一层的格全摘掉,别的一格不动', () => {
    const regions: Record<string, PaneNode> = {
      [CENTER_REGION]: T.makeLeaf('L1', [local('a'), roam('w'), local('b')]),
      [RIGHT]: T.makeLeaf('L2', [roam('s'), local('c')]),
    }
    const out = T.stripByLevel(regions, 'app')
    expect(T.refIdsOf(out[CENTER_REGION])).toEqual(['local:a', 'local:b'])
    expect(T.refIdsOf(out[RIGHT])).toEqual(['local:c'])
  })

  it('函数形的层级也剥得干净(只剥它自述 app 的那几格)', () => {
    const regions: Record<string, PaneNode> = {
      [CENTER_REGION]: T.makeLeaf('L1', [mixed('app-workspace'), mixed('search')]),
    }
    expect(T.refIdsOf(T.stripByLevel(regions, 'app')[CENTER_REGION]))
      .toEqual(['mixed:search'])
  })

  it('一格都没剥到 = **原样交回同一份**(引用恒等,换装那一句才不会白推一次订阅)', () => {
    const regions: Record<string, PaneNode> = {
      [CENTER_REGION]: T.makeLeaf('L1', [local('a')]),
    }
    expect(T.stripByLevel(regions, 'app')).toBe(regions)
  })

  it('剥空了的叶留在原地(**不 prune**)—— 剪不剪由 store 决定', () => {
    const regions: Record<string, PaneNode> = {
      [CENTER_REGION]: T.makeLeaf('L1', [roam('w')]),
    }
    const out = T.stripByLevel(regions, 'app')
    expect(T.leavesOf(out[CENTER_REGION])).toHaveLength(1)
    expect(T.refIdsOf(out[CENTER_REGION])).toEqual([])
  })
})

describe('carryByLevel —— 携带', () => {
  it('同名区域在 → append 到那片叶(dock-scope §2.3)', () => {
    const from: Record<string, PaneNode> = { [RIGHT]: T.makeLeaf('LA', [local('x'), roam('w')]) }
    const to: Record<string, PaneNode> = { [RIGHT]: T.makeLeaf('LB', [local('y')]) }
    const out = T.carryByLevel(from, to, 'app', nextLeafId)
    expect(T.refIdsOf(out[RIGHT])).toEqual(['local:y', 'roam:w'])
  })

  it('叶 id 对得上 → 落回**原位次**', () => {
    const from: Record<string, PaneNode> = { [RIGHT]: T.makeLeaf('L', [local('x'), roam('w')]) }
    const to: Record<string, PaneNode> = { [RIGHT]: T.makeLeaf('L', [local('y'), local('z')]) }
    const out = T.carryByLevel(from, to, 'app', nextLeafId)
    expect(T.refIdsOf(out[RIGHT])).toEqual(['local:y', 'roam:w', 'local:z'])
  })

  it('区域没了 → **当场建回来**(浮窗里那一格该回到一扇浮窗,不是掉进中央区)', () => {
    const from: Record<string, PaneNode> = { [FLOAT]: T.makeLeaf('LA', [roam('w')]) }
    const to: Record<string, PaneNode> = { [CENTER_REGION]: T.makeLeaf('LB', [local('y')]) }
    const out = T.carryByLevel(from, to, 'app', nextLeafId)
    expect(T.refIdsOf(out[FLOAT])).toEqual(['roam:w'])
    expect(T.refIdsOf(out[CENTER_REGION])).toEqual(['local:y'])
  })

  it('**不点亮任何一格** —— 携带不是「打开」,进场树上谁露脸不该被它改写', () => {
    const from: Record<string, PaneNode> = { [RIGHT]: T.makeLeaf('LA', [roam('w')]) }
    const to: Record<string, PaneNode> = { [RIGHT]: T.makeLeaf('LB', [local('y'), local('z')], 1) }
    const out = T.carryByLevel(from, to, 'app', nextLeafId)
    expect(T.leavesOf(out[RIGHT])[0].active).toBe(1)
  })

  it('这一格已经在进场树上 = 只放一份(不变量:一个内容在一个区域里只出现一次)', () => {
    const from: Record<string, PaneNode> = { [RIGHT]: T.makeLeaf('LA', [roam('w')]) }
    const to: Record<string, PaneNode> = { [RIGHT]: T.makeLeaf('LB', [roam('w')]) }
    expect(T.refIdsOf(T.carryByLevel(from, to, 'app', nextLeafId)[RIGHT])).toEqual(['roam:w'])
  })

  it('离场树上一格 app 级都没有 = 原样交回同一份(引用恒等)', () => {
    const from: Record<string, PaneNode> = { [RIGHT]: T.makeLeaf('LA', [local('x')]) }
    const to: Record<string, PaneNode> = { [RIGHT]: T.makeLeaf('LB', [local('y')]) }
    expect(T.carryByLevel(from, to, 'app', nextLeafId)).toBe(to)
  })
})

describe('登记时的互斥:常驻 与 level:app', () => {
  it('两样一起自述 = **当场抛**(常驻说的是「这个区域里至少留一格」,而区域是空间的地)', () => {
    expect(() => registerContentKind({
      id: 'resident-app',
      singleton: false,
      level: 'app',
      resident: { region: CENTER_REGION, seed: () => 'main' },
      title: (ref) => ({ text: ref.key }),
      icon: () => 'House',
      render: () => null,
    })).toThrow(/常驻/)
  })

  it('函数形也抛 —— 登记这一刻判不出来的互斥等于没有互斥', () => {
    expect(() => registerContentKind({
      id: 'resident-fn',
      singleton: false,
      level: () => 'space',
      resident: { region: CENTER_REGION, seed: () => 'main' },
      title: (ref) => ({ text: ref.key }),
      icon: () => 'House',
      render: () => null,
    })).toThrow(/常驻/)
  })

  it('常驻 + 显式 `level: \'space\'` 放行(那是一句恒等声明)', () => {
    expect(() => registerContentKind({
      id: 'resident-space',
      singleton: false,
      level: 'space',
      resident: { region: CENTER_REGION, seed: () => 'main' },
      title: (ref) => ({ text: ref.key }),
      icon: () => 'House',
      render: () => null,
    })).not.toThrow()
  })
})

describe('跨级二合一:拒绝(拍点 7)', () => {
  beforeEach(() => {
    registerContentKind(pairContentKind)
  })

  it('两格层级不同 → `composeContent` 答 null(并不了)', () => {
    expect(composeContent(roam('w'), local('a'))).toBeNull()
    expect(composeContent(local('a'), roam('w'))).toBeNull()
  })

  it('同级照旧并得起来,而且并出来那一格的层级 = 它两格的层级', () => {
    const bothApp = composeContent(roam('w'), mixed('app-x'))
    expect(bothApp).not.toBeNull()
    expect(residencyLevelOf(bothApp!)).toBe('app')

    const bothSpace = composeContent(local('a'), mixed('search'))
    expect(bothSpace).not.toBeNull()
    expect(residencyLevelOf(bothSpace!)).toBe('space')
  })

  it('一格 app 级的复合标签,整格随人走', () => {
    const paired = pairRefOf(roam('w'), mixed('app-x'))
    const from: Record<string, PaneNode> = { [RIGHT]: T.makeLeaf('LA', [paired, local('x')]) }
    const to: Record<string, PaneNode> = { [RIGHT]: T.makeLeaf('LB', []) }
    expect(T.refIdsOf(T.carryByLevel(from, to, 'app', nextLeafId)[RIGHT]))
      .toEqual([`${paired.kind}:${paired.key}`])
  })
})

/*
 * ── 反证(每条守卫至少真跑一次「拆掉即红」)──────────────────────────────
 * ① 把 `stripByLevel` 的判据改成恒 false(等于「进场不剥」)→ 上面那条
 *    「这一格已经在进场树上 = 只放一份」仍绿(树上只留一份是 `withSeats` 的事),
 *    但 store 那一组的「在 B 关掉、切回 A 它不在」当场红 —— 判词与那条用例
 *    住在 `store-carry.test.ts`,因为「关掉」这件事只有 store 说得出。
 * ② 把 `residencyLevelOf` 改成恒答 `'space'` → 这一组里 `stripByLevel` 与
 *    `carryByLevel` 的每一条携带断言全红(实测 8 条)。
 */
