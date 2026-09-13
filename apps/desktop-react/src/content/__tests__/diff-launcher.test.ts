import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIFF_ITEM_ID, openChangesPanel, openSessionChanges } from '../diff-launcher'
import { stageLauncherOf } from '../../stage/launchers'
import { DIFF_KIND, diffRef } from '../kinds/diff-ref'
import { CENTER_REGION, edgeRegion } from '../../workbench/regions'
import { useWorkbenchStore } from '../../workbench/store'
import { refIdsOf } from '../../workbench/tree'
import { useStageStore } from '../../stage/store'
import { useExposeStore } from '../../expose/store'
import { initialExposeState } from '../../expose/transitions'
import { useNotifyStore } from '../../services/notify-store'
import { useSessionsSource } from '../../data/sessions-source'
import { configureSessionsPort } from '../../data/sessions-port'
import { ONETHING_DIR, seedSessionsSource } from '../../data/__fixtures__/sessions'
import '../kinds'

/**
 * **「改动」那块启动瓦**(正本 §3.2;壳侧 §4 第五组)。
 *
 * 四条:
 *  ① 会话绑着工作目录 → 点它开 `diff:<那个目录>`,落**中央区**(天生那一档缺席,
 *    所以是兜底);
 *  ② 会话没绑目录、屏幕上**已经开着**别的改动面 → 走 `residentKind` 那条退路
 *    (这块瓦只自述种类名,查找归 `workbench/tree.firstRefOfKindIn`);
 *  ③ 两条都不成立 → 一条 info,**零新标签**;
 *  ④ 有位置记忆时**记忆压过兜底**。
 *
 * **反证**:`open()` 里那句 `if (cwd)` 拆掉(无 cwd 也直接 `placeRef`)→ ③ 当场红
 * (屏幕上多出一格,而且 toast 一条都没有)。
 */

const SESSION_WITH_DIR = 'os-provider'
const SESSION_WITHOUT_DIR = 'lo-notes'

const centerIds = () => refIdsOf(useWorkbenchStore.getState().regions[CENTER_REGION])
const toasts = () => useNotifyStore.getState().items

beforeEach(() => {
  useSessionsSource.getState().reset()
  configureSessionsPort({
    ready: async () => undefined,
    listMeta: async () => ({ success: true, sessions: [] }),
    getSegments: async () => ({ success: true, segments: [] }),
    getMessagesPage: async () => ({ success: true, messages: [] }),
    getUserMarkers: async () => ({ success: true, markers: [] }),
    create: async () => ({ success: false, error: 'not stubbed' }),
    updateWorkingDirectory: async () => ({ success: true }),
    updatePin: async () => ({ success: true }),
    rename: async () => ({ success: true }),
    delete: async () => ({ success: true }),
    onSessionEvent: () => () => undefined,
    onSessionLifecycle: () => () => undefined,
  })
  seedSessionsSource()
  useExposeStore.setState({ ...initialExposeState, envSessionId: SESSION_WITH_DIR })
  useWorkbenchStore.getState().reset()
  useWorkbenchStore.getState().seed()
  useStageStore.setState({ memory: {} })
  useNotifyStore.getState().clear()
})

afterEach(() => {
  configureSessionsPort(undefined)
  useNotifyStore.getState().clear()
})

describe('「改动」瓦登记成了启动瓦', () => {
  it('表上有它,而且自述 `residentKind = diff`', () => {
    const launcher = stageLauncherOf(DIFF_ITEM_ID)
    expect(launcher).toBeDefined()
    expect(launcher?.residentKind).toBe(DIFF_KIND)
  })

  it('拖它拖出的是当前会话那个目录的改动面;没绑目录时答 null', () => {
    expect(stageLauncherOf(DIFF_ITEM_ID)?.dragRef?.()).toEqual(diffRef(ONETHING_DIR))
    useExposeStore.setState({ envSessionId: SESSION_WITHOUT_DIR })
    expect(stageLauncherOf(DIFF_ITEM_ID)?.dragRef?.()).toBeNull()
  })
})

describe('点它', () => {
  it('① 有 cwd → 开那个目录的改动面,落中央区', () => {
    openSessionChanges()
    expect(centerIds()).toContain(`${DIFF_KIND}:${ONETHING_DIR}`)
    expect(toasts()).toHaveLength(0)
  })

  it('③ 没有 cwd → **一条 info,零新标签**(不退到 `~`)', () => {
    useExposeStore.setState({ envSessionId: SESSION_WITHOUT_DIR })
    const before = centerIds()
    openSessionChanges()
    expect(centerIds()).toEqual(before)
    expect(toasts().map((x) => x.level)).toEqual(['info'])
  })

  it('④ 有位置记忆时**记忆压过兜底**(中央区 → 左架子)', () => {
    useStageStore.setState({ memory: { [DIFF_ITEM_ID]: { kind: 'edge', side: 'left', index: 0 } } })
    openChangesPanel(ONETHING_DIR)
    const left = useWorkbenchStore.getState().regions[edgeRegion('left')]
    expect(left && refIdsOf(left)).toContain(`${DIFF_KIND}:${ONETHING_DIR}`)
  })

  it('打开**不记一笔最近目录** —— 那本账是「我从目录瓦打开过哪几个」', () => {
    const before = useWorkbenchStore.getState().recentRoots
    openChangesPanel('/repo/never-opened-as-a-dir')
    expect(useWorkbenchStore.getState().recentRoots).toEqual(before)
  })
})
