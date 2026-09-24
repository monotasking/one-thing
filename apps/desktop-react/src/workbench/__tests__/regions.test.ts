import { beforeEach, describe, expect, it } from 'vitest'
import {
  hiddenInRegion,
  regionOfLeafIn,
  regionOfRefIn,
  useWorkbenchStore,
} from '../store'
import { refId, registerContentKind, resetContentKinds } from '../kinds'
import { leavesOf } from '../tree'
import type { ContentRef } from '../kinds'

/**
 * **区域 = 树的持有者**(W4,设计 §1.3)。
 *
 * W1-a 只点亮了中央区一格,所以 store 那几口动作都只在一棵树上打转。
 * W4 起四条边与每一扇浮窗也各持一棵,于是多了三件事要守:
 *  · `moveRef` —— **搬家不是关闭**:从这棵树摘掉、插进那棵树,实例一路留着;
 *  · `detachRef` —— 从**每一棵**树里摘掉,什么都不留(「收回 Dock」的树侧动作);
 *  · `hideRegion` —— 一个区域里的每一格各记自己的 `returnTo`(浮窗那颗 ✕)。
 * 加上一条读法:`hiddenInRegion` —— 「隐藏的标签 ⋯」只列本区域的。
 */

const panel = (key: string): ContentRef => ({ kind: 'panel', key })
const file = (key: string): ContentRef => ({ kind: 'file', key })

beforeEach(() => {
  resetContentKinds()
  // 两种最小的登记:一种单例(瓦)、一种不是(文件)。核心层只读这张表。
  registerContentKind({
    id: 'panel',
    singleton: true,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'LayoutGrid',
    render: () => null,
  })
  registerContentKind({
    id: 'file',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'File',
    render: () => null,
  })
  useWorkbenchStore.getState().reset()
})

const store = () => useWorkbenchStore.getState()
const tabsOf = (region: string) =>
  leavesOf(store().regions[region]).flatMap((leaf) => leaf.tabs.map(refId))

describe('区域没有树时,第一格插进来就把树建起来', () => {
  it('`openRef` 建得出来 —— 空区域不必先摆一棵空树(空树会让架子画出一条空带子)', () => {
    expect(store().regions['edge:right']).toBeUndefined()
    store().openRef(panel('files'), { region: 'edge:right' })
    expect(tabsOf('edge:right')).toEqual(['panel:files'])
  })

  it('最后一格走了,整个区域删掉 —— 剩一棵空树等于屏幕上多一条空架子', () => {
    store().openRef(panel('files'), { region: 'edge:right' })
    store().detachRef('panel:files')
    expect(store().regions['edge:right']).toBeUndefined()
    // 中央区例外:它永远在(设计 §1.3)。
    expect(store().regions.center).toBeTruthy()
  })
})

describe('moveRef:搬家不是关闭', () => {
  it('从这棵树摘掉、插进那棵树,一个 id 只在一处', () => {
    store().openRef(panel('files'), { region: 'edge:right' })
    store().moveRef(panel('files'), 'edge:left')
    expect(store().regions['edge:right']).toBeUndefined()
    expect(tabsOf('edge:left')).toEqual(['panel:files'])
    expect(regionOfRefIn(store().regions, 'panel:files')).toBe('edge:left')
  })

  it('`at` 是**叶内下标**:按记忆插回原位,而不是永远排末尾', () => {
    store().openRef(panel('a'), { region: 'edge:bottom' })
    store().openRef(panel('b'), { region: 'edge:bottom' })
    store().moveRef(panel('c'), 'edge:bottom', { at: 1 })
    expect(tabsOf('edge:bottom')).toEqual(['panel:a', 'panel:c', 'panel:b'])
  })

  it('藏着的那一份被搬出来 = 它不再是「藏着的」', () => {
    store().openRef(file('/a.ts'), { region: 'center' })
    const leaf = leavesOf(store().regions.center)[0]
    store().hideTab(leaf.id, leaf.tabs.findIndex((t) => t.kind === 'file'))
    expect(store().hidden.map((e) => refId(e.ref))).toEqual(['file:/a.ts'])
    store().moveRef(file('/a.ts'), 'edge:bottom')
    expect(store().hidden).toEqual([])
    expect(tabsOf('edge:bottom')).toEqual(['file:/a.ts'])
  })

  it('单例跨区域也只有一份:再 `openRef` 到别处会先把旧那份摘掉', () => {
    store().openRef(panel('files'), { region: 'edge:right' })
    store().openRef(panel('files'), { region: 'edge:left' })
    expect(store().regions['edge:right']).toBeUndefined()
    expect(tabsOf('edge:left')).toEqual(['panel:files'])
  })
})

describe('hideRegion:一整个区域藏起来(浮窗那颗 ✕)', () => {
  it('每一格各记自己的 `returnTo`,区域随之删掉', () => {
    store().openRef(panel('files'), { region: 'float:w1' })
    store().openRef(file('/a.ts'), { region: 'float:w1' })
    store().hideRegion('float:w1')

    expect(store().regions['float:w1']).toBeUndefined()
    const hidden = store().hidden
    expect(hidden.map((e) => refId(e.ref))).toEqual(['panel:files', 'file:/a.ts'])
    expect(hidden.map((e) => e.returnTo.index)).toEqual([0, 1])
    expect(new Set(hidden.map((e) => e.returnTo.region))).toEqual(new Set(['float:w1']))
  })

  /*
   * **次序要在动手之前整条拓下来**。逐格摘会让后面那些的下标一路往前塌,
   * 记下的就是塌过的次序 —— 藏起来再一个个请回来,三格会挤成一摞
   * (与 `closeShelf` 那条判例同型)。反证:把 `hideRegion` 改成逐格
   * `hideTab` → 下面这句读到 [0,0,0]。
   */
  it('三格藏起来记的是**原来那三个位置**,不是塌过的', () => {
    for (const key of ['a', 'b', 'c']) store().openRef(panel(key), { region: 'float:w1' })
    store().hideRegion('float:w1')
    expect(store().hidden.map((e) => e.returnTo.index)).toEqual([0, 1, 2])
  })

  it('藏起来之后请得回来:区域没了就把它建回来(`returnTo.region` 记的就是它该回哪儿)', () => {
    store().openRef(panel('files'), { region: 'float:w1' })
    store().hideRegion('float:w1')
    store().restoreHidden('panel:files')
    expect(tabsOf('float:w1')).toEqual(['panel:files'])
    expect(store().hidden).toEqual([])
  })

  it('空区域是空动作', () => {
    const before = store().regions
    store().hideRegion('float:nope')
    expect(store().regions).toBe(before)
  })
})

describe('按区域读', () => {
  it('`hiddenInRegion` 只给本区域的那几行', () => {
    store().openRef(file('/shelf.ts'), { region: 'edge:right' })
    store().openRef(file('/center.ts'), { region: 'center' })
    for (const region of ['edge:right', 'center']) {
      const leaf = leavesOf(store().regions[region])[0]
      const at = leaf.tabs.findIndex((t) => t.kind === 'file')
      store().hideTab(leaf.id, at)
    }
    expect(hiddenInRegion(store().hidden, 'edge:right').map((e) => refId(e.ref))).toEqual([
      'file:/shelf.ts',
    ])
    expect(hiddenInRegion(store().hidden, 'center').map((e) => refId(e.ref))).toEqual([
      'file:/center.ts',
    ])
    // 答不出区域的(那片叶已经不在任何一棵树上)= 一行都不列,而不是列全部。
    expect(hiddenInRegion(store().hidden, null)).toEqual([])
  })

  it('`regionOfLeafIn` / `regionOfRefIn` 各说各的坐标', () => {
    store().openRef(panel('files'), { region: 'edge:bottom' })
    const leaf = leavesOf(store().regions['edge:bottom'])[0]
    expect(regionOfLeafIn(store().regions, leaf.id)).toBe('edge:bottom')
    expect(regionOfLeafIn(store().regions, 'leaf-nope')).toBeNull()
    expect(regionOfRefIn(store().regions, 'panel:files')).toBe('edge:bottom')
    expect(regionOfRefIn(store().regions, 'panel:nope')).toBeNull()
  })
})
