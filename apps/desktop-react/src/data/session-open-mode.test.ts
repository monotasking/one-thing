import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SPACE_ID } from '../workspace/types'
import { spreadSpace, stashSpace, swapSpace } from '../workspace/per-space'
import {
  FACTORY_SESSION_OPEN_MODE,
  SESSION_OPEN_MODE_LABELS,
  SESSION_OPEN_MODE_PER_SPACE,
  SESSION_OPEN_MODES,
  useSessionOpenMode,
} from './session-open-mode'

/**
 * 「点会话列表一行是什么意思」那一格偏好(C2)。这一组守的是**这只 store 自己**
 * ——三档、出厂那一格、认不出的档一律落回出厂,以及它真的跟着工作区走。
 * 它在拼贴台那一侧的语义在 `content/__tests__/session-open-mode.test.ts`。
 */

beforeEach(() => {
  localStorage.clear()
  useSessionOpenMode.setState({ ...SESSION_OPEN_MODE_PER_SPACE.factory(), byWorkspace: {} })
})

describe('三档与出厂', () => {
  it('三档一张表,次序即菜单与设置页的次序,**缺省那一档排第一**', () => {
    expect([...SESSION_OPEN_MODES]).toEqual(['replace', 'newTab', 'preview'])
    expect(SESSION_OPEN_MODES[0]).toBe(FACTORY_SESSION_OPEN_MODE)
  })

  it('出厂 = 替换(拍点 3 的第二版,09-10 用户改判)', () => {
    expect(FACTORY_SESSION_OPEN_MODE).toBe('replace')
    expect(SESSION_OPEN_MODE_PER_SPACE.factory()).toEqual({ mode: 'replace' })
    expect(useSessionOpenMode.getState().mode).toBe('replace')
  })

  it('每一档都说得出自己的名字(三档都有 i18n 键,漏一档 typecheck 就红)', () => {
    for (const each of SESSION_OPEN_MODES) {
      expect(SESSION_OPEN_MODE_LABELS[each]).toMatch(/^sessions\.openMode\./)
    }
  })

  it('setMode 三档都收得下', () => {
    for (const each of SESSION_OPEN_MODES) {
      useSessionOpenMode.getState().setMode(each)
      expect(useSessionOpenMode.getState().mode).toBe(each)
    }
  })
})

describe('清洗:认不出的档落回出厂', () => {
  /**
   * 直接问 persist 的 `merge` —— 那一句才是清洗真正跑的地方(账上**每一格**都钳
   * 一次,不是只钳当前那一格:只钳当前的话切过去才塌,而那一帧已经画出去了)。
   */
  const merge = (persisted: unknown) =>
    (useSessionOpenMode.persist.getOptions().merge as (p: unknown, c: unknown) => {
      mode: string
      byWorkspace: Record<string, { mode: string }>
    })(persisted, useSessionOpenMode.getState())

  it('手改过 / 版本对不上的档一律落回出厂,**账上每一格都钳**', () => {
    const merged = merge({
      byWorkspace: {
        [DEFAULT_SPACE_ID]: { mode: 'newTab' },
        'ws-a': { mode: '天知道是什么' },
        'ws-b': { mode: 42 },
        'ws-c': {},
      },
    })
    expect(merged.byWorkspace[DEFAULT_SPACE_ID].mode).toBe('newTab')
    expect(merged.byWorkspace['ws-a'].mode).toBe(FACTORY_SESSION_OPEN_MODE)
    expect(merged.byWorkspace['ws-b'].mode).toBe(FACTORY_SESSION_OPEN_MODE)
    expect(merged.byWorkspace['ws-c'].mode).toBe(FACTORY_SESSION_OPEN_MODE)
  })

  /**
   * **换缺省不许改写存量档案**(09-10:出厂从 `preview` 改成 `replace`)。
   * 账上存着 `preview` 的那一格是用户自己选过的,清洗判的是「认不认得」不是
   * 「是不是今天的缺省」—— 拆掉 `clampMode` 里的 `includes` 改成「等于出厂才留」,
   * 这一条当场红,而真机上的形状是「升级一次,所有人选过的预览档被静默抹掉」。
   */
  it('存量档案里选过的 `preview` 原样留着,不被新缺省改写', () => {
    const merged = merge({
      byWorkspace: { [DEFAULT_SPACE_ID]: { mode: 'preview' }, 'ws-a': { mode: 'preview' } },
    })
    expect(merged.byWorkspace[DEFAULT_SPACE_ID].mode).toBe('preview')
    expect(merged.byWorkspace['ws-a'].mode).toBe('preview')
    expect(merged.mode).toBe('preview')
  })

  it('merge 把当前空间那一格**同步摊开** —— 第一帧就是对的', () => {
    // 存的这一档**不能是出厂那一档**:否则摊开与不摊开答案一样,这条用例会空过。
    const merged = merge({ byWorkspace: { [DEFAULT_SPACE_ID]: { mode: 'newTab' } } })
    expect(merged.mode).toBe('newTab')
    expect(merged.mode).not.toBe(FACTORY_SESSION_OPEN_MODE)
  })

  it('档案里什么都没有 → 出厂那一格', () => {
    expect(merge(undefined).mode).toBe(FACTORY_SESSION_OPEN_MODE)
    expect(merge({}).mode).toBe(FACTORY_SESSION_OPEN_MODE)
  })
})

describe('它是 per-space 家具', () => {
  it('换装:旧空间那一格收进账,新空间没记录就是出厂', () => {
    useSessionOpenMode.getState().setMode('newTab')
    const state = useSessionOpenMode.getState()
    const swapped = swapSpace(state, SESSION_OPEN_MODE_PER_SPACE, 'ws-work', DEFAULT_SPACE_ID)
    expect(swapped.byWorkspace[DEFAULT_SPACE_ID]).toEqual({ mode: 'newTab' })
    expect(swapped.mode).toBe(FACTORY_SESSION_OPEN_MODE)
  })

  it('落盘的是账,不是活状态(`partialize` 走的就是 `stashSpace`)', () => {
    // 同上:设一档**不是出厂**的,否则「收没收进账」这一问答案恒真。
    useSessionOpenMode.getState().setMode('preview')
    const ledger = stashSpace(
      useSessionOpenMode.getState(),
      useSessionOpenMode.getState().byWorkspace,
      SESSION_OPEN_MODE_PER_SPACE,
      DEFAULT_SPACE_ID,
    )
    expect(ledger[DEFAULT_SPACE_ID]).toEqual({ mode: 'preview' })
    expect(spreadSpace(ledger, SESSION_OPEN_MODE_PER_SPACE, 'ws-never')).toEqual({
      mode: FACTORY_SESSION_OPEN_MODE,
    })
  })
})
