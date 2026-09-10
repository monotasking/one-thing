import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useComposerSend } from './useComposerSend'
import { useCommandsSource } from '../data/commands-source'
import { useSessionOpenMode } from '../data/session-open-mode'
import '../content/kinds'
import { enterSessionInWorkbench } from '../content/session-open'
import { CENTER_REGION } from '../workbench/regions'
import { useWorkbenchStore } from '../workbench/store'
import { leavesOf, previewIndexOf } from '../workbench/tree'
import type { ComposerInputHandle } from './components/ComposerInput'

/**
 * 发送那一口的**第二把闸**(`running`)。
 *
 * 09-02 批 9c 把发送三口拆成 `useComposerSend` 时点出的一处留账:两把防重闸
 * (`starting` 建会话 / `running` 跑命令)只有前一把有守卫 —— 组件测试里那条
 * 「建会话在飞时第二下当没按」钉的是 `starting`,把 `running` 那句
 * `if (running.current) return` 删掉,整份组件测试**全绿**。
 *
 * 两把闸挡的是同一件真事:**中文输入法一次回车发两下**(08-31 真机报障)。
 * 所以第二把也该有自己的红。这份用例走 hook 层而不是组件层,理由是它要的现场
 * 只有一个 —— 「命令那条异步路正在飞」,组件层为它搭一遍模型 / 候选 / sink
 * 的全套夹具是浪费,而且钉不到闸本身。
 *
 * **反证**:删掉 `useComposerSend` 里那句 `if (running.current) return`,
 * 下面这条立刻红(`send` 收到两次)。
 */

/** 一只只记账的输入框把手 —— 这一层不关心 DOM,只关心「交出去了几次」。 */
function fakeInput(): { ref: { current: ComposerInputHandle | null }; clears: () => number } {
  let clears = 0
  const handle: ComposerInputHandle = {
    element: () => null,
    insert: () => {},
    text: () => '',
    clear: () => void (clears += 1),
    html: () => '',
    restore: () => {},
  }
  return { ref: { current: handle }, clears: () => clears }
}

/** 表里一定没有的那个词:走完「补拉插件表再查一次」还是查不到,于是原样当话发。 */
const UNKNOWN = '/zzz-not-a-real-command'

describe('发送的第二把闸:命令在飞时的第二下', () => {
  /** 挂起的那一发补拉 —— 它一直不结束,`running` 就一直是 true。 */
  let releasePluginPull: () => void
  let pulls = 0

  beforeEach(() => {
    useCommandsSource.getState().reset()
    pulls = 0
    releasePluginPull = () => {}
    useCommandsSource.setState({
      pluginCommands: [],
      ensurePluginCommands: () =>
        new Promise<void>((resolve) => {
          pulls += 1
          releasePluginPull = resolve
        }),
    })
  })

  afterEach(() => {
    useCommandsSource.getState().reset()
  })

  it('在飞时后来的那一下当没按:补拉只发一次,话也只交出去一次', async () => {
    const input = fakeInput()
    const sent: string[] = []
    const { result } = renderHook(() =>
      useComposerSend({
        allCommands: [],
        sessionId: 's1',
        inputRef: input.ref,
        openAsk: () => {},
        closeDrawer: () => {},
        send: (text) => {
          sent.push(text)
          return true
        },
      }),
    )

    // 第一下:进命令那条异步路,停在「补拉插件表」上。
    act(() => result.current(UNKNOWN))
    expect(pulls).toBe(1)
    expect(sent).toHaveLength(0)

    // 第二下(输入法补的那一发):闸在,这一下整个当没按 —— 不再补拉一次。
    act(() => result.current(UNKNOWN))
    expect(pulls).toBe(1)

    // 放行:表里还是没有它,于是原样当一句话发出去 —— **一次**。
    await act(async () => {
      releasePluginPull()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(sent).toEqual([UNKNOWN])
    expect(input.clears()).toBe(1)
  })

  it('这一发落定之后闸就拆了:下一次照常进得去', async () => {
    const input = fakeInput()
    const sent: string[] = []
    const { result } = renderHook(() =>
      useComposerSend({
        allCommands: [],
        sessionId: 's1',
        inputRef: input.ref,
        openAsk: () => {},
        closeDrawer: () => {},
        send: (text) => {
          sent.push(text)
          return true
        },
      }),
    )

    act(() => result.current(UNKNOWN))
    await act(async () => {
      releasePluginPull()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(sent).toHaveLength(1)

    // 闸是「此刻正在跑」,不是「跑过一次就永远关门」。
    act(() => result.current(UNKNOWN))
    expect(pulls).toBe(2)
    await act(async () => {
      releasePluginPull()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(sent).toHaveLength(2)
  })
})

/**
 * **发一句话 = 这一格转正**(C2 转正之一,正本
 * `apps/desktop-react/docs/session-continuity-2026-09.md` §4.1)。
 *
 * 它测在这一层而不是在 `content/__tests__/session-open-mode.test.ts` 里,是因为
 * 那一组问的是「转正之后屏幕上是什么样」,而这一条问的是**时刻**:「一句话真的
 * 交出去了」这件事全壳只有这只 hook 知道,而那正是这一句唯一的产地。
 *
 * **反证**:把 `useComposerSend` 里那句 `promoteSessionSeat(sessionId)` 拆掉
 * → 下面这条立刻红(标签还是预览格,人做过事的那一条会被下一次点击换掉)。
 */
describe('发一句话 → 预览格转正', () => {
  const A = 'os-expose'
  const leaf = () => leavesOf(useWorkbenchStore.getState().regions[CENTER_REGION])[0]

  beforeEach(() => {
    useSessionOpenMode.setState({ mode: 'preview', byWorkspace: {} })
    useWorkbenchStore.getState().reset()
    useWorkbenchStore.getState().seed()
  })

  it('`send` 答 true 的那一下就转正;答 false(空话)一个字都不动', () => {
    const input = fakeInput()
    let accept = false
    enterSessionInWorkbench(A)
    expect(previewIndexOf(leaf())).toBe(0)

    const { result } = renderHook(() =>
      useComposerSend({
        allCommands: [],
        sessionId: A,
        inputRef: input.ref,
        openAsk: () => {},
        closeDrawer: () => {},
        send: () => accept,
      }),
    )

    // 空话交不出去 —— 那不是「发了一句话」,标记原样在。
    act(() => result.current('   '))
    expect(previewIndexOf(leaf())).toBe(0)

    accept = true
    act(() => result.current('真的发出去了'))
    expect(previewIndexOf(leaf())).toBeUndefined()
  })
})
