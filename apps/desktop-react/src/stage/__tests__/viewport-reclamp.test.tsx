import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStageStore } from '../store'
import { useViewportReclamp } from '../viewport-reclamp'
import {
  FLOAT_MARGIN,
  FLOAT_MIN_W,
  STAGE_PERSIST_VERSION,
  factoryStageFurniture,
  initialStageState,
} from '../transitions'
import { DEFAULT_SPACE_ID } from '../../workspace/types'

/**
 * **视口重钳的宿主那一半**(09-04,设计
 * `docs/design/react-shell-sessions-list-2026-09.md` §4)。
 *
 * 算术那一半在 `transitions.test.ts`(`clampFloatRect` / `reclampAll` 是纯函数);
 * 这里钉的是只有宿主才答得出的两件:
 *  ① **开机那一刻**(persist 的 `merge`)拿当下视口钳一遍档案里的浮窗;
 *  ② **窗子改尺寸**时那条 resize 监听经 rAF 合并后真的把动作发出去。
 *
 * 时间是自己造的:rAF 换成手推的,免得测试跟着真机帧率飘(同
 * `components/__tests__/dock-lens-hook.test.tsx` 那一手)。
 */

/** 报障那一份逐字:1400 宽的窗里摆好的 880 浮窗,搬进 1100 宽的窗里右缘在屏幕外。 */
const OVERFLOW = { x: 260, y: 40, w: 879, h: 700 }

function setViewport(w: number, h: number): void {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true, writable: true })
}

beforeEach(() => {
  setViewport(1100, 800)
  useStageStore.setState({ ...initialStageState, byWorkspace: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem('onething.stage')
})

describe('rehydrate:档案里的浮窗按当下视口钳一遍', () => {
  it('宽窗存下的 879 宽浮窗,开在 1100 的窗里右缘不出界', async () => {
    localStorage.setItem(
      'onething.stage',
      JSON.stringify({
        version: STAGE_PERSIST_VERSION,
        state: {
          byWorkspace: {
            [DEFAULT_SPACE_ID]: {
              ...factoryStageFurniture(),
              placements: { sessions: { kind: 'float' } },
              floats: { sessions: OVERFLOW },
              floatOrder: ['sessions'],
              memory: { sessions: { kind: 'float', rect: OVERFLOW } },
            },
          },
        },
      }),
    )

    // 反证:把 store.ts `merge` 里那句 `Object.assign(merged, T.reclampAll(...))` 删掉
    // → 这里读回的就是原样的 879,右缘 1139 —— 正是 09-04 报障的现场。
    await act(async () => {
      await useStageStore.persist.rehydrate()
    })

    const rect = useStageStore.getState().floats.sessions
    expect(rect.x + rect.w).toBeLessThanOrEqual(1100 - FLOAT_MARGIN)
    expect(rect.x).toBeLessThan(OVERFLOW.x)
    expect(rect.w).toBeGreaterThanOrEqual(FLOAT_MIN_W)
    // 记忆那一份同样钳过 —— 不然关掉再开又是坏的。
    expect(useStageStore.getState().memory.sessions).toEqual({ kind: 'float', rect })
  })

  it('视口量不出来(jsdom / SSR 的 0)就跳过,不把窗子压成最小档', async () => {
    setViewport(0, 0)
    localStorage.setItem(
      'onething.stage',
      JSON.stringify({
        version: STAGE_PERSIST_VERSION,
        state: {
          byWorkspace: {
            [DEFAULT_SPACE_ID]: { ...factoryStageFurniture(), floats: { sessions: OVERFLOW } },
          },
        },
      }),
    )

    // 反证:把 `vp.w > 0 && vp.h > 0` 那道闸删掉 → 这一条读回的是被 0 视口压成
    // 最小档(280×200)的窗子。
    await act(async () => {
      await useStageStore.persist.rehydrate()
    })

    expect(useStageStore.getState().floats.sessions).toEqual(OVERFLOW)
  })
})

describe('useViewportReclamp:一条 resize 监听,rAF 合并', () => {
  /** 手推的帧:rAF 只把回调收进队列,测试自己决定什么时候跑。 */
  function stubFrames() {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => {})
    return {
      frames,
      run: () => act(() => void frames.splice(0).forEach((cb) => cb(0))),
    }
  }

  it('窗子变窄 → 下一帧把越界的浮窗钳回视口里', () => {
    const { frames, run } = stubFrames()
    useStageStore.setState({ floats: { sessions: { ...OVERFLOW } } })
    renderHook(() => useViewportReclamp())

    setViewport(1100, 800)
    act(() => void window.dispatchEvent(new Event('resize')))
    // 合并:这一帧还没跑,所以状态一格没动(反证:去掉 `if (frame !== null) return`
    // 之后连发两下 resize 会排两帧,这条断言看不出来 —— 看得出来的是下面 length 那条)。
    expect(useStageStore.getState().floats.sessions).toEqual(OVERFLOW)

    // 反证:把 hook 里的 `window.addEventListener('resize', schedule)` 删掉 → 这条红。
    run()
    const rect = useStageStore.getState().floats.sessions
    expect(rect.x + rect.w).toBeLessThanOrEqual(1100 - FLOAT_MARGIN)
    expect(frames.length).toBe(0)
  })

  it('一帧之内连发多下 resize 只排一帧', () => {
    const { frames } = stubFrames()
    renderHook(() => useViewportReclamp())
    act(() => {
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('resize'))
    })
    // 反证:去掉 `if (frame !== null) return` → 这里是 3。
    expect(frames.length).toBe(1)
  })

  it('卸载即退订:拆完再 resize 一帧都不排', () => {
    const { frames } = stubFrames()
    const { unmount } = renderHook(() => useViewportReclamp())
    unmount()
    act(() => void window.dispatchEvent(new Event('resize')))
    // 反证:把 effect 的 return(removeEventListener)删掉 → 这里是 1。
    expect(frames.length).toBe(0)
  })
})
