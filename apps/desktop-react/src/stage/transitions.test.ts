import { describe, it, expect } from 'vitest'
import {
  PIN_MIN,
  activatePinnedTab,
  clamp,
  clickDockIcon,
  closeStage,
  formOf,
  initialStageState,
  migrateStagePersisted,
  pinStage,
  resolveOpen,
  setPinnedWidth,
  unpin,
} from './transitions'
import type { OpenBehavior, StageState } from './types'

const base: StageState = initialStageState

/** 造一个「钉栏里有几个 tab」的态,省得每个用例手拼。 */
function withPinned(pinned: string[], activePinnedId = pinned[pinned.length - 1] ?? null): StageState {
  return { ...base, pinned, activePinnedId }
}

describe('resolveOpen', () => {
  it("override 为 'default' → 跟随全局默认", () => {
    expect(resolveOpen('files', { files: 'default' }, 'stage')).toBe('stage')
    expect(resolveOpen('files', { files: 'default' }, 'pinned')).toBe('pinned')
  })

  it('没登记过的 id 等价于 default(所以初始表是空的)', () => {
    expect(resolveOpen('files', {}, 'pinned')).toBe('pinned')
  })

  it("override 'stage' 压过默认 'pinned'", () => {
    expect(resolveOpen('files', { files: 'stage' }, 'pinned')).toBe('stage')
  })

  it("override 'pinned' 压过默认 'stage'", () => {
    expect(resolveOpen('files', { files: 'pinned' }, 'stage')).toBe('pinned')
  })

  it('覆盖只作用于自己那一个 id', () => {
    const o: Record<string, OpenBehavior> = { files: 'pinned' }
    expect(resolveOpen('diff', o, 'stage')).toBe('stage')
  })
})

describe('clickDockIcon', () => {
  it("从收拢态点一下(behavior='stage') → 上舞台", () => {
    expect(clickDockIcon(base, 'files', 'stage').stageId).toBe('files')
  })

  it('舞台上的同一个再点一下 → 关舞台', () => {
    const opened = clickDockIcon(base, 'files', 'stage')
    expect(clickDockIcon(opened, 'files', 'stage').stageId).toBeNull()
  })

  it('舞台一次只有一个:点另一个是直接替换,不排队', () => {
    const opened = clickDockIcon(base, 'files', 'stage')
    const next = clickDockIcon(opened, 'diff', 'stage')
    expect(next.stageId).toBe('diff')
    expect(formOf(next, 'files')).toBe('dock')
  })

  it("behavior='pinned' → 追加成新 tab 并激活,不上舞台", () => {
    const next = clickDockIcon(base, 'files', 'pinned')
    expect(next.pinned).toEqual(['files'])
    expect(next.activePinnedId).toBe('files')
    expect(next.stageId).toBeNull()
    expect(formOf(next, 'files')).toBe('pinned')
  })

  it('连开两个 pinned → 两个 tab 共存,次序即点击次序,活动的是后来的那个', () => {
    const next = clickDockIcon(clickDockIcon(base, 'files', 'pinned'), 'diff', 'pinned')
    expect(next.pinned).toEqual(['files', 'diff'])
    expect(next.activePinnedId).toBe('diff')
    expect(formOf(next, 'files')).toBe('pinned')
  })

  it("behavior='pinned' 时舞台开着也不动它:钉栏与舞台正交", () => {
    const state: StageState = { ...base, stageId: 'terminal' }
    const next = clickDockIcon(state, 'files', 'pinned')
    expect(next.stageId).toBe('terminal')
    expect(next.pinned).toEqual(['files'])
  })

  it('已在钉栏的再点 → 聚焦那个 tab + 闪一下,不开舞台也不重复追加', () => {
    const state = withPinned(['diff'])
    const next = clickDockIcon(state, 'diff', 'stage')
    expect(next.stageId).toBeNull()
    expect(next.pinned).toEqual(['diff'])
    expect(next.flashPinned).toBe(state.flashPinned + 1)
    expect(next.activePinnedId).toBe('diff')
  })

  it('点钉栏里「非活动」的那个 → 活动 tab 切过去(behavior 是什么都一样)', () => {
    const state = withPinned(['files', 'diff'], 'diff')
    const next = clickDockIcon(state, 'files', 'pinned')
    expect(next.activePinnedId).toBe('files')
    expect(next.pinned).toEqual(['files', 'diff'])
    expect(next.flashPinned).toBe(1)
  })

  it('闪烁是累加的,连点两次记两次', () => {
    const state = withPinned(['diff'])
    const twice = clickDockIcon(clickDockIcon(state, 'diff', 'stage'), 'diff', 'stage')
    expect(twice.flashPinned).toBe(2)
  })

  it('钉住 A 时点 B 上舞台,两者共存', () => {
    const state = withPinned(['diff'])
    const next = clickDockIcon(state, 'files', 'stage')
    expect(next.stageId).toBe('files')
    expect(next.pinned).toEqual(['diff'])
    expect(next.flashPinned).toBe(0)
  })

  it('是纯函数:不改原对象', () => {
    const before = { ...base, pinned: [...base.pinned] }
    clickDockIcon(base, 'files', 'pinned')
    expect(base).toEqual(before)
  })
})

describe('pinStage', () => {
  it('把舞台落成新 tab 并激活,舞台清空', () => {
    const opened = clickDockIcon(base, 'files', 'stage')
    const next = pinStage(opened)
    expect(next.pinned).toEqual(['files'])
    expect(next.activePinnedId).toBe('files')
    expect(next.stageId).toBeNull()
    expect(formOf(next, 'files')).toBe('pinned')
  })

  it('已有 tab 时追加到末尾,不再是替换', () => {
    const state: StageState = { ...withPinned(['diff']), stageId: 'files' }
    const next = pinStage(state)
    expect(next.pinned).toEqual(['diff', 'files'])
    expect(next.activePinnedId).toBe('files')
  })

  it('舞台上的东西已经在钉栏里 → 去重,只激活它', () => {
    const state: StageState = { ...withPinned(['diff', 'files'], 'diff'), stageId: 'files' }
    const next = pinStage(state)
    expect(next.pinned).toEqual(['diff', 'files'])
    expect(next.activePinnedId).toBe('files')
    expect(next.stageId).toBeNull()
  })

  it('没有舞台时是恒等变换', () => {
    expect(pinStage(base)).toBe(base)
  })
})

describe('unpin', () => {
  it('摘掉唯一的 tab → 钉栏空,活动为 null,该 item 回 dock 形态', () => {
    const next = unpin(withPinned(['diff']), 'diff')
    expect(next.pinned).toEqual([])
    expect(next.activePinnedId).toBeNull()
    expect(formOf(next, 'diff')).toBe('dock')
  })

  it('摘掉活动 tab → 焦点先落右边那个', () => {
    const next = unpin(withPinned(['files', 'diff', 'terminal'], 'diff'), 'diff')
    expect(next.pinned).toEqual(['files', 'terminal'])
    expect(next.activePinnedId).toBe('terminal')
  })

  it('摘掉最右的活动 tab → 右边没有了,退回左边', () => {
    const next = unpin(withPinned(['files', 'diff'], 'diff'), 'diff')
    expect(next.pinned).toEqual(['files'])
    expect(next.activePinnedId).toBe('files')
  })

  it('摘掉非活动 tab → 活动的不动', () => {
    const next = unpin(withPinned(['files', 'diff'], 'diff'), 'files')
    expect(next.pinned).toEqual(['diff'])
    expect(next.activePinnedId).toBe('diff')
  })

  it('摘一个不在钉栏里的 → 恒等变换', () => {
    const state = withPinned(['diff'])
    expect(unpin(state, 'files')).toBe(state)
    expect(unpin(base, 'files')).toBe(base)
  })
})

describe('activatePinnedTab', () => {
  it('切换活动 tab', () => {
    const next = activatePinnedTab(withPinned(['files', 'diff'], 'diff'), 'files')
    expect(next.activePinnedId).toBe('files')
    expect(next.pinned).toEqual(['files', 'diff'])
  })

  it('已经是活动的 / 不在钉栏里 → 都是恒等变换', () => {
    const state = withPinned(['files', 'diff'], 'diff')
    expect(activatePinnedTab(state, 'diff')).toBe(state)
    expect(activatePinnedTab(state, 'terminal')).toBe(state)
  })
})

describe('closeStage', () => {
  it('closeStage 关舞台,不动钉栏', () => {
    const state: StageState = { ...withPinned(['diff']), stageId: 'files' }
    const next = closeStage(state)
    expect(next.stageId).toBeNull()
    expect(next.pinned).toEqual(['diff'])
  })

  it('无舞台时是恒等变换', () => {
    expect(closeStage(base)).toBe(base)
  })
})

describe('migrateStagePersisted', () => {
  it('v0 的单值 pinnedId → v1 的 tab 数组 + 活动 tab', () => {
    const out = migrateStagePersisted({ pinnedId: 'diff', pinnedWidth: 500 }, 0) as Record<string, unknown>
    expect(out.pinned).toEqual(['diff'])
    expect(out.activePinnedId).toBe('diff')
    expect(out.pinnedWidth).toBe(500)
    expect('pinnedId' in out).toBe(false)
  })

  it('v0 但没有 pinnedId(或是 null)→ 只是把这个字段丢掉', () => {
    const out = migrateStagePersisted({ pinnedId: null, dockDisplay: 'autohide' }, 0) as Record<string, unknown>
    expect(out.pinned).toBeUndefined()
    expect(out.dockDisplay).toBe('autohide')
    expect('pinnedId' in out).toBe(false)
  })

  it('已经是 v1 的原样放行', () => {
    const v1 = { pinned: ['files'], activePinnedId: 'files' }
    expect(migrateStagePersisted(v1, 1)).toBe(v1)
  })
})

describe('setPinnedWidth', () => {
  it('区间内的宽度原样通过', () => {
    expect(setPinnedWidth(base, 500, 1600).pinnedWidth).toBe(500)
  })

  it('小于 320 抬到 320', () => {
    expect(setPinnedWidth(base, 100, 1600).pinnedWidth).toBe(PIN_MIN)
  })

  it('大于视口一半压回视口一半', () => {
    expect(setPinnedWidth(base, 1400, 1600).pinnedWidth).toBe(800)
  })

  it('视口太窄时下界赢(不会算出小于 320 的上界)', () => {
    expect(setPinnedWidth(base, 400, 500).pinnedWidth).toBe(PIN_MIN)
  })
})

describe('formOf / clamp', () => {
  it('三种形态互斥,默认 dock', () => {
    const state: StageState = { ...withPinned(['diff']), stageId: 'files' }
    expect(formOf(state, 'files')).toBe('stage')
    expect(formOf(state, 'diff')).toBe('pinned')
    expect(formOf(state, 'terminal')).toBe('dock')
  })

  it('钉栏里的非活动 tab 也是 pinned 形态(形态说的是「在哪」不是「可见吗」)', () => {
    const state = withPinned(['files', 'diff'], 'diff')
    expect(formOf(state, 'files')).toBe('pinned')
  })

  it('clamp 在 max < min 时返回 min', () => {
    expect(clamp(50, 320, 100)).toBe(320)
  })
})
