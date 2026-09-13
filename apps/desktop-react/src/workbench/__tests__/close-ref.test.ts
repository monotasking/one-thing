import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkbenchStore } from '../store'
import { refId, registerContentKind, resetContentKinds } from '../kinds'
import { CENTER_REGION } from '../regions'
import { leavesOf } from '../tree'
import type { ContentRef } from '../kinds'

/**
 * **`closeRef`:把一格内容从「开着它的每一处」都摘掉**(A2,会话侧栏菜单
 * 「关闭」那一行的树侧动作)。
 *
 * 与 `preview-tab.test.ts` / `replace-ref.test.ts` 逐字同一条纪律:被测的是
 * **核心层**,所以这一组里一个「会话」的字都不该出现 —— 夹具的种类名是
 * `doc`(普通内容)与 `home`(一种**自述了 `resident`** 的内容)。产品那一侧
 * 谁是 `home` 不是这只动作该知道的事(`canDetachTab` 的判词:问的是种类的
 * 自述,不是种类的名字)。
 *
 * 四种收场逐条钉住:在树里 / 在隐藏表里 / 两处都不在 / 找到了却摘不掉。
 */

const doc = (key: string): ContentRef => ({ kind: 'doc', key })
const home = (key: string): ContentRef => ({ kind: 'home', key })

let disposed: string[] = []

beforeEach(() => {
  disposed = []
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
    dispose: (ref) => disposed.push(refId(ref)),
  })
  useWorkbenchStore.getState().reset()
  useWorkbenchStore.getState().seed()
})

const store = () => useWorkbenchStore.getState()
const tabsOf = (region: string) =>
  leavesOf(store().regions[region] ?? { kind: 'leaf', id: 'x', tabs: [], activeIndex: 0 }).flatMap(
    (leaf) => leaf.tabs.map(refId),
  )

describe('closeRef:在树里的那几处', () => {
  it('开在一处 → 摘掉,并 dispose 实例(关掉 = 丢实例,与 closeTab 同一句)', () => {
    store().openRef(doc('/a.ts'), { region: CENTER_REGION })
    expect(tabsOf(CENTER_REGION)).toContain('doc:/a.ts')

    expect(store().closeRef(doc('/a.ts'))).toBe('closed')
    expect(tabsOf(CENTER_REGION)).not.toContain('doc:/a.ts')
    expect(disposed).toEqual(['doc:/a.ts'])
  })

  it('**同时开在两个区域** → 两处一起摘(这正是它不是 `closeTab` 的理由)', () => {
    store().openRef(doc('/a.ts'), { region: CENTER_REGION })
    store().openRef(doc('/a.ts'), { region: 'edge:right' })
    expect(tabsOf(CENTER_REGION)).toContain('doc:/a.ts')
    expect(tabsOf('edge:right')).toContain('doc:/a.ts')

    expect(store().closeRef(doc('/a.ts'))).toBe('closed')
    expect(tabsOf(CENTER_REGION)).not.toContain('doc:/a.ts')
    // 那个区域的最后一格走了 = 整棵树删掉(区域不留空树)。
    expect(store().regions['edge:right']).toBeUndefined()
  })

  it('**藏起来的那一格也算开着**(屏幕上那颗空心点)→ 走 dropHidden', () => {
    store().openRef(doc('/a.ts'), { region: CENTER_REGION })
    const leaf = leavesOf(store().regions[CENTER_REGION])[0]
    store().hideTab(leaf.id, leaf.tabs.findIndex((tab) => refId(tab) === 'doc:/a.ts'))
    expect(store().hidden.map((row) => refId(row.ref))).toEqual(['doc:/a.ts'])

    expect(store().closeRef(doc('/a.ts'))).toBe('closed')
    expect(store().hidden).toEqual([])
    // 隐藏那一格关掉也 dispose —— 隐藏留实例,关掉不留。
    expect(disposed).toEqual(['doc:/a.ts'])
  })

  it('树里一处 + 隐藏表一处 → 两处一起没(一次调用把「开着」这件事清干净)', () => {
    store().openRef(doc('/a.ts'), { region: CENTER_REGION })
    store().openRef(doc('/b.ts'), { region: 'edge:right' })
    const right = leavesOf(store().regions['edge:right'])[0]
    store().hideTab(right.id, right.tabs.findIndex((tab) => refId(tab) === 'doc:/b.ts'))
    // /b.ts 藏着,/a.ts 在中央区摆着 —— 现在关 /b.ts:它只在隐藏表里。
    expect(store().closeRef(doc('/b.ts'))).toBe('closed')
    expect(store().hidden).toEqual([])
    expect(tabsOf(CENTER_REGION)).toContain('doc:/a.ts')
  })
})

describe('closeRef:两种「没关成」', () => {
  it('哪儿都没开着 → `absent`,而且一棵树都不动', () => {
    const before = store().regions
    expect(store().closeRef(doc('/nope.ts'))).toBe('absent')
    expect(store().regions).toBe(before)
    expect(disposed).toEqual([])
  })

  it('常驻那一种在它自己的家里的**最后一格** → `refused`(播报归渲染层)', () => {
    // 播种把 `home` 摆进中央区(`resident.region`),此刻它是那儿唯一一格。
    expect(tabsOf(CENTER_REGION)).toEqual(['home:main'])
    expect(store().closeRef(home('main'))).toBe('refused')
    expect(tabsOf(CENTER_REGION)).toEqual(['home:main'])
  })

  it('**同一格**既在家里(受守卫)又在别处 → 摘掉别处那一处,家里那一处留着', () => {
    /*
     * 这一条钉的是「挑第一个**摘得掉的**」那一句(不是挑第一个):`canDetachTab`
     * 的答案**按区域**给 —— 中央区那一处是常驻种类在它自己家里的最后一格
     * (拒),右架子那一处不受那条守卫(可摘)。挑第一个的话中央区那一处当场
     * 答 `refused`,右架子里同一格会话就永远关不掉 —— 那正是 U3 报障的形状。
     */
    store().openRef(home('main'), { region: 'edge:right' })
    expect(tabsOf('edge:right')).toEqual(['home:main'])

    expect(store().closeRef(home('main'))).toBe('closed')
    expect(store().regions['edge:right']).toBeUndefined()
    expect(tabsOf(CENTER_REGION)).toEqual(['home:main'])
  })

  it('同一种在家里还剩一格时,**别处那一格照样摘得掉**(U3 报障的反面)', () => {
    /*
     * 判据是**按区域**的:中央区那一格关不掉,不该连带让右架子里同一种的另一格
     * 也关不掉。所以这里开的是**两条不同的** home —— 中央区那一格受守卫护着,
     * 右架子那一格不受(`resident.region !== 'edge:right'`)。
     */
    store().openRef(home('guest'), { region: 'edge:right' })
    expect(store().closeRef(home('guest'))).toBe('closed')
    expect(store().regions['edge:right']).toBeUndefined()
    // 家里那一格一个字没动。
    expect(tabsOf(CENTER_REGION)).toEqual(['home:main'])
  })

  it('拖拽中(`dragging`)什么都不做 —— `closeTab` 那条静默早退不许变成空转', () => {
    store().openRef(doc('/a.ts'), { region: CENTER_REGION })
    useWorkbenchStore.setState({ dragging: true })
    expect(store().closeRef(doc('/a.ts'))).toBe('absent')
    expect(tabsOf(CENTER_REGION)).toContain('doc:/a.ts')
    useWorkbenchStore.setState({ dragging: false })
  })
})
