import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { focusTree } from '../../focus/registry'
import { useStageStore } from '../store'
import { initialStageState } from '../transitions'
import { useWorkbenchStore } from '../../workbench/store'
import { seatOfRefIn } from '../../workbench/tree'
import { makeLeaf } from '../../workbench/tree'
import { CENTER_REGION } from '../../workbench/regions'
import { refId } from '../../workbench/kinds'
import { pairRefOf } from '../../content/kinds/pair-ref'
import { sessionRefOf } from '../../content/session-ref'
import '../../content/kinds'

/**
 * **B4 认得「二合一的一格」**(W7-p 修一轮裁定 2)。
 *
 * ── 病历 ──────────────────────────────────────────────────────────────────
 * 找座位从前有两只(`stage/summon` 与 `content/session-open`),两只都只比**顶层
 * 标签**的 refId。W6-a 之后「在右侧打开」造出来的是一格 `pair:` 复合标签,那条会话
 * 于是在两只眼里都不存在:sidebar 单击它 → `summonRef` 答 `null` → 走
 * 「顶替焦点那片会话叶」,把中央区正看着的那条**顶掉**,而用户要的只是切过去。
 *
 * ── 今天 ────────────────────────────────────────────────────────────────
 * 一只 `workbench/tree.seatOfRefIn`,摊开复合(`kinds.flattenContent`)之后再比,
 * 答案带上「它在 pair 里的哪一侧」。「切过去」= 激活那格标签 + 露出宿主 +
 * 焦点进**那一侧**的内容层(pair 的两侧各是一格 `leaf` 作用域,owner 是那一侧
 * 自己的 refId —— 判词在 `PaneLeaf.PaneContentLayer` 上)。
 *
 * 反证:把 `seatOfRefIn` 的复合那一支拆掉 → 这三条全红(座位答 null、
 * `summonRef` 答 null、标签被顶替)。
 */

const A = sessionRefOf('sess-a')
const B = sessionRefOf('sess-b')
const FILE = { kind: 'file', key: '/tmp/x.ts' }
const PAIR = pairRefOf(B, FILE)

/** 中央区一片叶,两格标签:[会话 A, (会话 B | 文件)];此刻露脸的是 A。 */
function seedPairLeaf(): void {
  useWorkbenchStore.getState().reset()
  useWorkbenchStore.setState({
    regions: { [CENTER_REGION]: makeLeaf('leaf-pair-1', [A, PAIR], 0) },
    hidden: [],
    focusLeafId: 'leaf-pair-1',
    panelPath: null,
  })
  useStageStore.setState({ ...initialStageState })
}

beforeEach(seedPairLeaf)

afterEach(() => {
  focusTree.reset()
  useStageStore.setState({ ...initialStageState })
})

describe('二合一里的那一格也是一个座位', () => {
  it('座位答得出「它在 pair 里的哪一侧」', () => {
    const seat = seatOfRefIn(useWorkbenchStore.getState().regions, refId(B))
    expect(seat).toEqual({
      region: CENTER_REGION,
      leafId: 'leaf-pair-1',
      index: 1,
      active: false,
      partIndex: 0,
    })
    // 顶层那一格标签本身:`partIndex` 是 null(它就是它)。
    expect(seatOfRefIn(useWorkbenchStore.getState().regions, refId(A))?.partIndex).toBeNull()
    expect(seatOfRefIn(useWorkbenchStore.getState().regions, refId(PAIR))?.partIndex).toBeNull()
  })

  it('sidebar 单击 pair 里那条会话 = 切过去:标签数不变、活动标签是那格 pair、焦点进那一侧', async () => {
    const focusSpy = vi.spyOn(focusTree, 'activateScope').mockReturnValue(true)
    try {
      const where = useStageStore.getState().summonRef(B, 'reveal')
      // 答得出住处 = 「这一下已经办完了」,调用方(`expose.enterSession`)不再新开。
      expect(where).toBe('center')
      await Promise.resolve()

      const leaf = useWorkbenchStore.getState().regions[CENTER_REGION]
      expect(leaf.kind === 'leaf' && leaf.tabs.length).toBe(2)
      // 活动的是**那格 pair**(下标 1),不是新开的一格。
      expect(leaf.kind === 'leaf' && leaf.active).toBe(1)
      // 焦点进的是**那一侧**:owner 是会话自己的 refId,不是 pair 的。
      expect(focusSpy).toHaveBeenCalledWith('leaf', { owner: refId(B), reason: 'open' })
    } finally {
      focusSpy.mockRestore()
    }
  })

  it('哪儿都没开着的那一条照旧答 null —— 该怎么开由调用方说了算', () => {
    expect(useStageStore.getState().summonRef(sessionRefOf('sess-zzz'), 'reveal')).toBeNull()
  })
})
