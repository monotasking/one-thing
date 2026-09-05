import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedSessionsSource } from '../../data/__fixtures__/sessions'
import { chatSources } from '../../data/chat-source'
import { useSessionsSource } from '../../data/sessions-source'
import { useExposeStore } from '../../expose/store'
import { initialExposeState } from '../../expose/transitions'
import { CENTER_REGION } from '../../workbench/regions'
import { useWorkbenchStore } from '../../workbench/store'
import { leavesOf, refIdsOf } from '../../workbench/tree'
import '../kinds'
import {
  startSessionProjection,
  stopSessionProjection,
  syncSessionProjection,
} from '../session-projection'
import { currentSessionOf, sessionRefOf } from '../session-ref'
import { enterSessionInWorkbench } from '../session-open'
import type { PaneNode } from '../../workbench/tree'

/**
 * **「当前会话」那条投影**(W5-b 裁定 3;设计 §8 W5)。
 *
 * 三格,三种问法:纯投影(`currentSessionId`)、粘性(`envSessionId`)、
 * 引用账(树里 ∪ 隐藏表里有哪些会话就持有哪些)。这一组逐格钉,并且每一条
 * 守卫都配一句「拆掉即红」的反证。
 *
 * 这里 `import '../kinds'` 是**必须的**:投影读的是种类表(`resident.seed()`),
 * 而那张表由种类各自登记 —— 那正是「核心层不认识任何一种内容」的另一面。
 */

const A = 'os-expose'
const B = 'os-compact'

const center = (): PaneNode => useWorkbenchStore.getState().regions[CENTER_REGION]
const leaves = () => leavesOf(center())

/**
 * **「并排开第二片叶」在 W6-a 之后演成「开在架子上」**。
 *
 * 中央区收成一条标签条(单叶政策,设计 `workbench-tabs-2026-09.md` §2.1),
 * 所以这一组从前那句 `splitLeaf(first, 'row', X)` 在那里不再受理。被测的判据
 * **一个字没变** —— 那三格问的都是「屏幕上有两片叶,焦点在哪一片」,而两片叶
 * 在哪个区域从来不是判据的一部分(`currentSessionOf` 的梯子按区域阅读序问)。
 */
const ASIDE = 'edge:right' as const
function openAside(ref: Parameters<ReturnType<typeof useWorkbenchStore.getState>['openRef']>[0]): string {
  useWorkbenchStore.getState().openRef(ref, { region: ASIDE })
  return useWorkbenchStore.getState().focusLeafId!
}
/** 全壳(中央 + 架子)此刻摆着哪些 refId。 */
const allRefIds = (): string[] =>
  Object.values(useWorkbenchStore.getState().regions).flatMap((tree) => refIdsOf(tree))

beforeEach(() => {
  seedSessionsSource()
  useExposeStore.setState({ ...initialExposeState })
  useWorkbenchStore.getState().reset()
  useWorkbenchStore.getState().seed()
})

afterEach(() => {
  stopSessionProjection()
  chatSources.resetAll()
  useSessionsSource.getState().reset()
})

describe('currentSessionOf:那条从窄到宽的梯子(纯函数)', () => {
  it('① 焦点叶的活动格是会话 → 它', () => {
    const leafId = leaves()[0].id
    useWorkbenchStore.getState().replaceRef(leafId, sessionRefOf(''), sessionRefOf(A))
    expect(currentSessionOf(useWorkbenchStore.getState().regions, leafId)).toBe(A)
  })

  it('② 焦点叶的活动格是文件、叶里还有会话 → 那一格(输入框不失去目标)', () => {
    const leafId = leaves()[0].id
    useWorkbenchStore.getState().replaceRef(leafId, sessionRefOf(''), sessionRefOf(A))
    useWorkbenchStore.getState().openRef({ kind: 'file', key: '/a.ts' }, { leafId })
    expect(leaves()[0].tabs[leaves()[0].active].kind).toBe('file')
    expect(currentSessionOf(useWorkbenchStore.getState().regions, leafId)).toBe(A)
  })

  it('③ 焦点叶根本不装会话 → 回落到阅读序第一片装着会话的叶', () => {
    const first = leaves()[0].id
    useWorkbenchStore.getState().replaceRef(first, sessionRefOf(''), sessionRefOf(A))
    openAside({ kind: 'file', key: '/a.ts' })
    const fileLeaf = useWorkbenchStore.getState().focusLeafId!
    expect(fileLeaf).not.toBe(first)
    expect(currentSessionOf(useWorkbenchStore.getState().regions, fileLeaf)).toBe(A)
  })

  it('④ 一格会话都没有 → 空串(= 从前「还没有当前会话」那一态)', () => {
    useWorkbenchStore.getState().detachRef(`session:new`)
    expect(currentSessionOf(useWorkbenchStore.getState().regions, null)).toBe('')
  })

  it('保留键读作空串 —— 「是会话叶,但还没绑」', () => {
    expect(refIdsOf(center())).toEqual(['session:new'])
    expect(currentSessionOf(useWorkbenchStore.getState().regions, leaves()[0].id)).toBe('')
  })
})

describe('投影:树是事实,`currentSessionId` 是它的影子', () => {
  it('接上之后,换焦点叶那一格当场跟着换', () => {
    const first = leaves()[0].id
    useWorkbenchStore.getState().replaceRef(first, sessionRefOf(''), sessionRefOf(A))
    startSessionProjection()
    expect(useExposeStore.getState().currentSessionId).toBe(A)

    // 并排开第二片会话叶,焦点落在它上面。
    openAside(sessionRefOf(B))
    expect(useExposeStore.getState().currentSessionId).toBe(B)

    // 点回第一片 = 焦点叶换人 → 投影跟着换回去。
    useWorkbenchStore.getState().setFocusLeaf(first)
    expect(useExposeStore.getState().currentSessionId).toBe(A)
  })

  it('**反证**:投影不写那一格(退订之后)→ 11 处读点读到的还是旧值', () => {
    const first = leaves()[0].id
    useWorkbenchStore.getState().replaceRef(first, sessionRefOf(''), sessionRefOf(A))
    startSessionProjection()
    expect(useExposeStore.getState().currentSessionId).toBe(A)

    stopSessionProjection()
    openAside(sessionRefOf(B))
    // 树已经换人了,而没有写者的那一格停在原地 —— 这正是「独立写一格」的病。
    expect(useExposeStore.getState().currentSessionId).toBe(A)
    syncSessionProjection()
    expect(useExposeStore.getState().currentSessionId).toBe(B)
  })

  it('列表点一行 = 焦点会话叶**原位换 ref**(不多开一片)', () => {
    startSessionProjection()
    const first = leaves()[0].id
    enterSessionInWorkbench(A)
    expect(leaves()).toHaveLength(1)
    expect(leaves()[0].id).toBe(first)
    expect(useExposeStore.getState().currentSessionId).toBe(A)

    enterSessionInWorkbench(B)
    expect(leaves()).toHaveLength(1)
    expect(refIdsOf(center())).toEqual([`session:${B}`])
  })

  it('那条会话已经开在另一片叶里 → 点亮它、焦点过去,不再插一格', () => {
    startSessionProjection()
    const first = leaves()[0].id
    useWorkbenchStore.getState().replaceRef(first, sessionRefOf(''), sessionRefOf(A))
    openAside(sessionRefOf(B))
    useWorkbenchStore.getState().setFocusLeaf(first)

    enterSessionInWorkbench(B)
    expect(allRefIds().sort()).toEqual([`session:${A}`, `session:${B}`].sort())
    expect(useExposeStore.getState().currentSessionId).toBe(B)
  })
})

describe('envSessionId:环境会话带粘性', () => {
  it('焦点落到**文件叶**时不换根(而 currentSessionId 按梯子回落)', () => {
    const first = leaves()[0].id
    useWorkbenchStore.getState().replaceRef(first, sessionRefOf(''), sessionRefOf(A))
    startSessionProjection()
    openAside(sessionRefOf(B))
    expect(useExposeStore.getState().envSessionId).toBe(B)

    // 再切一刀开一片文件叶,焦点落在它上面。
    const secondLeaf = useWorkbenchStore.getState().focusLeafId!
    useWorkbenchStore.getState().splitLeaf(secondLeaf, 'col', { kind: 'file', key: '/a.ts' })

    // 当前会话按梯子回落到阅读序第一片(A);环境会话**原样停在 B**。
    expect(useExposeStore.getState().currentSessionId).toBe(A)
    expect(useExposeStore.getState().envSessionId).toBe(B)
  })

  it('**反证**:去掉粘性(每一拍都跟着 current 走)→ 根会跟着跳到 A', () => {
    const first = leaves()[0].id
    useWorkbenchStore.getState().replaceRef(first, sessionRefOf(''), sessionRefOf(A))
    startSessionProjection()
    openAside(sessionRefOf(B))
    const secondLeaf = useWorkbenchStore.getState().focusLeafId!
    useWorkbenchStore.getState().splitLeaf(secondLeaf, 'col', { kind: 'file', key: '/a.ts' })
    const env = useExposeStore.getState().envSessionId
    const current = useExposeStore.getState().currentSessionId
    // 两格此刻**必须不同** —— 相同就说明粘性那一句没生效(或者被测场景摆错了)。
    expect(env).not.toBe(current)
  })

  it('它指着的那条会话被删了 → 不再粘住(不拿一条死会话去画文件树的根)', () => {
    const first = leaves()[0].id
    useWorkbenchStore.getState().replaceRef(first, sessionRefOf(''), sessionRefOf(A))
    startSessionProjection()
    openAside(sessionRefOf(B))
    const secondLeaf = useWorkbenchStore.getState().focusLeafId!
    useWorkbenchStore.getState().splitLeaf(secondLeaf, 'col', { kind: 'file', key: '/a.ts' })
    expect(useExposeStore.getState().envSessionId).toBe(B)

    // 名册里把 B 摘掉 —— 粘性的失效判据只有这一条。
    useSessionsSource.setState((st) => ({ sessions: st.sessions.filter((s) => s.id !== B) }))
    syncSessionProjection()
    expect(useExposeStore.getState().envSessionId).toBe(A)
  })
})

describe('引用账:树里 ∪ 隐藏表里的那些机器活着', () => {
  it('两片会话叶并排 → 两台机器都在表上', () => {
    const first = leaves()[0].id
    useWorkbenchStore.getState().replaceRef(first, sessionRefOf(''), sessionRefOf(A))
    startSessionProjection()
    openAside(sessionRefOf(B))
    expect(chatSources.ownedIds().sort()).toEqual([A, B].sort())
  })

  it('**藏起来的那一片照样收流**(裁定:hidden 的实例留着)', async () => {
    const first = leaves()[0].id
    useWorkbenchStore.getState().replaceRef(first, sessionRefOf(''), sessionRefOf(A))
    startSessionProjection()
    // W6-a:两条会话开在**同一条标签条**上(中央区单叶)—— 「藏起来的那一格
    // 照样收流」问的是引用账,与它住在哪片叶无关。
    useWorkbenchStore.getState().openRef(sessionRefOf(B))
    const leaf = leaves()[0]
    useWorkbenchStore.getState().hideTab(leaf.id, leaf.tabs.length - 1)

    expect(useWorkbenchStore.getState().hidden.map((e) => e.ref.key)).toEqual([B])
    await Promise.resolve()
    expect(chatSources.ownedIds()).toContain(B)
  })

  it('关掉(不是藏起来)→ 松手', async () => {
    const first = leaves()[0].id
    useWorkbenchStore.getState().replaceRef(first, sessionRefOf(''), sessionRefOf(A))
    startSessionProjection()
    useWorkbenchStore.getState().openRef(sessionRefOf(B))
    const leaf = leaves()[0]
    useWorkbenchStore.getState().closeTab(leaf.id, leaf.tabs.length - 1)

    // release 归零之后那一拍(微任务)才真拆 —— 判词在 chatSources.release 上。
    await Promise.resolve()
    await Promise.resolve()
    expect(chatSources.ownedIds()).not.toContain(B)
  })
})
