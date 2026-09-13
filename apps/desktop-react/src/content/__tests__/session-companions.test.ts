import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ONETHING_DIR,
  SESSION_META,
  seedSessionsSource,
  TRANSREADER_DIR,
} from '../../data/__fixtures__/sessions'
import { configureSessionsPort } from '../../data/sessions-port'
import { useSessionsSource } from '../../data/sessions-source'
import type { SessionLifecycleEvent } from '@onething/client/events/session-lifecycle'
import { useExposeStore } from '../../expose/store'
import { initialExposeState } from '../../expose/transitions'
import { CENTER_REGION } from '../../workbench/regions'
import { useWorkbenchStore } from '../../workbench/store'
import { refIdsOf } from '../../workbench/tree'
import { refId } from '../../workbench/kinds'
import '../kinds'
import { dirRef } from '../kinds/dir-ref'
import { diffRef } from '../kinds/diff-ref'
import { fileRef } from '../viewer/open-target'
import {
  companionEnvOf,
  scheduleCompanionSwap,
  startCompanionUpkeep,
  stopCompanionUpkeep,
} from '../session-companions'
import { sessionRefOf } from '../session-ref'
import type { PaneNode } from '../../workbench/tree'

/**
 * **伴随面在内容层这一侧**(C3,正本
 * `apps/desktop-react/docs/session-continuity-2026-09.md` §3)。
 *
 * 收 / 放 / 继承那四条规则在 `workbench/__tests__/companions.test.ts`(那一组里
 * 一个「目录」「文件」的字都没有)。这一组只问**这一侧**答的那两句:
 *  ① 进场那条会话的 workdir 是哪一个(`companionEnvOf` 读的是会话名册);
 *  ② 换的那一拍排在微任务里,一拍里连换两次只跑一遍(起点是第一个 from)。
 */

const A = 'os-provider'
const B = 'os-toolkit'
const OTHER = 'tr-menubar'

const center = (): PaneNode => useWorkbenchStore.getState().regions[CENTER_REGION]
const ids = (): string[] => refIdsOf(center())
const leafId = (): string => useWorkbenchStore.getState().focusLeafId ?? ''

/** 让微任务队列跑一轮。 */
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve))

/**
 * 「会话真的被删了」那一发。走的是**真路** —— 端口把 `onSessionLifecycle` 的回调
 * 交出来,`sessions-source` 自己判 `deleted`、自己发 `onSessionsDeleted`。
 * 手写一个测试专用的写口等于让这条判据多一个不经过真实路径的产地。
 */
let emitLifecycle: ((event: SessionLifecycleEvent) => void) | undefined

beforeEach(() => {
  emitLifecycle = undefined
  useSessionsSource.getState().reset()
  configureSessionsPort({
    ready: async () => undefined,
    listMeta: async () => ({ success: true, sessions: SESSION_META }),
    getSegments: async () => ({ success: true, segments: [] }),
    getMessagesPage: async () => ({ success: true, messages: [] }),
    getUserMarkers: async () => ({ success: true, markers: [] }),
    create: async () => ({ success: false, error: 'not stubbed' }),
    updateWorkingDirectory: async () => ({ success: true }),
    updatePin: async () => ({ success: true }),
    rename: async () => ({ success: true }),
    delete: async () => ({ success: true }),
    onSessionEvent: () => () => undefined,
    onSessionLifecycle: (callback) => {
      emitLifecycle = callback
      return () => {
        emitLifecycle = undefined
      }
    },
  })
  seedSessionsSource()
  useExposeStore.setState({ ...initialExposeState })
  useWorkbenchStore.getState().reset()
  useWorkbenchStore.getState().seed()
})

afterEach(() => {
  stopCompanionUpkeep()
  useSessionsSource.getState().reset()
})

describe('companionEnvOf:workdir 从会话名册上取', () => {
  it('绑了工作目录的会话答那个目录,没绑的答 null', () => {
    expect(companionEnvOf(A)).toEqual({ sessionId: A, workdir: ONETHING_DIR })
    expect(companionEnvOf(OTHER).workdir).toBe(TRANSREADER_DIR)
    // 名册上没有它(刚删 / 还没到)= 没有 workdir,于是什么都不继承。
    expect(companionEnvOf('ghost')).toEqual({ sessionId: 'ghost', workdir: null })
    expect(companionEnvOf('')).toEqual({ sessionId: '', workdir: null })
  })
})

describe('scheduleCompanionSwap:排在微任务里', () => {
  it('目录跟着换会话走:甲的收进账,乙拿到它自己 workdir 的那一棵', async () => {
    const host = leafIdOfSessionLeaf()
    useWorkbenchStore.getState().openRef(dirRef(ONETHING_DIR), { region: CENTER_REGION, leafId: host })

    scheduleCompanionSwap(A, B)
    // **同步的那一拍什么都没发生** —— 那正是「排在微任务里」的可观测形。
    expect(ids()).toContain(refId(dirRef(ONETHING_DIR)))
    await settle()

    expect(useWorkbenchStore.getState().sessionCompanions[A].seats.map((seat) => seat.ref))
      .toEqual([dirRef(ONETHING_DIR)])
    // 乙也在同一个仓里,所以继承出来的正好是同一棵 —— 这条同时钉着「同 workdir 只放一份」。
    expect(ids().filter((id) => id === refId(dirRef(ONETHING_DIR)))).toHaveLength(1)
  })

  /*
   * 「改动」面(正本 `apps/desktop-react/docs/changes-panel-2026-09.md` §3.1)。
   * C3 那句留账「`diff` 单例瓦留口」在这一条上还清:它与目录那一种走**同一条**
   * 路(`companion.seed`),所以这一条与上面那一条形状逐字相同,只换一种内容 ——
   * 而那正是「加一种伴随面 = 它自己那一格 `seed`,骨架零改动」的可观测形。
   *
   * **反证**:`content/kinds/diff.tsx` 的 `seed` 改成恒 `null` → 这一条当场红
   * (乙那边一格都不开)。
   */
  it('改动面也继承:离场那条开着改动面 → 进场那条拿到**它自己 workdir** 的那一份', async () => {
    const host = leafIdOfSessionLeaf()
    useWorkbenchStore.getState().openRef(diffRef(ONETHING_DIR), { region: CENTER_REGION, leafId: host })

    scheduleCompanionSwap(A, OTHER)
    await settle()

    // 甲那一份收进账;乙拿到的是**它自己那个仓**的改动面,不是甲那个。
    expect(useWorkbenchStore.getState().sessionCompanions[A].seats.map((seat) => seat.ref))
      .toEqual([diffRef(ONETHING_DIR)])
    expect(ids()).toEqual([refId(sessionRefOf('')), refId(diffRef(TRANSREADER_DIR))])
  })

  it('文件不继承:切过去只剩目录', async () => {
    const host = leafIdOfSessionLeaf()
    const store = useWorkbenchStore.getState()
    store.openRef(dirRef(ONETHING_DIR), { region: CENTER_REGION, leafId: host })
    store.openRef(fileRef(`${ONETHING_DIR}/a.ts`), { region: CENTER_REGION, leafId: host })

    scheduleCompanionSwap(A, OTHER)
    await settle()
    expect(ids()).toEqual([refId(sessionRefOf('')), refId(dirRef(TRANSREADER_DIR))])
  })

  it('一拍里连换两次:中间那条会话没人看见过,只跑一遍', async () => {
    const host = leafIdOfSessionLeaf()
    useWorkbenchStore.getState().openRef(dirRef(ONETHING_DIR), { region: CENTER_REGION, leafId: host })

    scheduleCompanionSwap(A, B)
    scheduleCompanionSwap(B, OTHER)
    await settle()

    const ledger = useWorkbenchStore.getState().sessionCompanions
    // 起点是这一批的第一个 from —— 甲名下记着那棵目录树。
    expect(ledger[A].seats.map((seat) => seat.ref)).toEqual([dirRef(ONETHING_DIR)])
    // 中间那条**一个字都没记**:它从来没在屏幕上出现过。
    expect(B in ledger).toBe(false)
    expect(ids()).toEqual([refId(sessionRefOf('')), refId(dirRef(TRANSREADER_DIR))])
  })

  it('from === to 压根不排', async () => {
    const regions = useWorkbenchStore.getState().regions
    scheduleCompanionSwap(A, A)
    await settle()
    expect(useWorkbenchStore.getState().regions).toBe(regions)
  })
})

describe('startCompanionUpkeep:会话被删 → 记录一起删', () => {
  it('一发真的 `deleted` 走完整条路,那条会话的记录当场没了', async () => {
    await useSessionsSource.getState().start()
    const host = leafIdOfSessionLeaf()
    useWorkbenchStore.getState().openRef(dirRef(ONETHING_DIR), { region: CENTER_REGION, leafId: host })
    scheduleCompanionSwap(A, B)
    await settle()
    expect(A in useWorkbenchStore.getState().sessionCompanions).toBe(true)

    startCompanionUpkeep()
    emitLifecycle?.({ type: 'deleted', sessionId: A, cascadedSessionIds: [A] })
    expect(A in useWorkbenchStore.getState().sessionCompanions).toBe(false)
  })

  it('退役之后不再收 —— 模块级订阅的寿命是这个模块实例', async () => {
    await useSessionsSource.getState().start()
    const host = leafIdOfSessionLeaf()
    useWorkbenchStore.getState().openRef(dirRef(ONETHING_DIR), { region: CENTER_REGION, leafId: host })
    scheduleCompanionSwap(A, B)
    await settle()

    startCompanionUpkeep()
    stopCompanionUpkeep()
    emitLifecycle?.({ type: 'deleted', sessionId: A, cascadedSessionIds: [A] })
    expect(A in useWorkbenchStore.getState().sessionCompanions).toBe(true)
  })
})

/** 中央区那片会话叶的 id(播种出来的那一片)。 */
function leafIdOfSessionLeaf(): string {
  const id = leafId()
  if (id) return id
  const store = useWorkbenchStore.getState()
  store.setFocusLeaf(firstLeafId(store.regions[CENTER_REGION]))
  return useWorkbenchStore.getState().focusLeafId ?? ''
}

function firstLeafId(node: PaneNode): string {
  return node.kind === 'leaf' ? node.id : firstLeafId(node.a)
}
