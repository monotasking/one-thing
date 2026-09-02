import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useComposerSend } from './useComposerSend'
import { useCommandsSource } from '../data/commands-source'
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
    focus: () => {},
    insert: () => {},
    text: () => '',
    clear: () => void (clears += 1),
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
