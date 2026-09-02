import { beforeEach, describe, expect, it } from 'vitest'
import { act, render } from '@testing-library/react'
import { AppShell } from '../AppShell'
import { useStageStore } from '../../stage/store'
import { initialStageSettings, initialStageState } from '../../stage/transitions'

/**
 * Dock 的三格偏好(09-02 追补,对齐 macOS 「Dock 与菜单栏」那一页):
 * **磁性放大开关 / 放大幅度三档 / 运行中指示点开关**。
 *
 * 这一份钉的是「设置里那一格落到条上变成什么」,不是放大本身长什么样
 * (那在 `dock-lens.test.ts` 与真机门 `gate:dock` 里)。三条各对一格:
 *   · 幅度档 → 条上多一个类,类里只覆写 `--dock-lens-max` 一个变量(JS 不认那三个数);
 *   · 运行点 → 那颗点画不画;
 *   · 缺省 → 三格的出厂值就是 09-02 之前的行为,升级上来的人一点感觉都没有。
 * 放大开关那一格的行为(关掉即整条链不跑)在 `dock-lens-hook.test.tsx` 里 ——
 * 它是 hook 的合同,不是这块面的。
 */
beforeEach(() => {
  useStageStore.setState({ ...initialStageState, ...initialStageSettings, locale: 'zh' })
})

const strip = () => document.querySelector('[data-dock="strip"]') as HTMLElement
const runningDots = () => document.querySelectorAll('[data-dock="strip"] [class*="dot"]').length

describe('Dock 偏好:出厂就是升级前的样子', () => {
  it('三格缺省 = 放大开 / 中档 / 运行点开', () => {
    expect(initialStageSettings.dockMagnify).toBe(true)
    expect(initialStageSettings.dockMagnifyLevel).toBe('md')
    expect(initialStageSettings.dockRunningDot).toBe(true)
  })
})

describe('Dock 偏好:放大幅度三档', () => {
  it('换档 = 条上换一个类,三档各不相同', () => {
    render(<AppShell />)
    const seen = new Set<string>()
    for (const level of ['sm', 'md', 'lg'] as const) {
      act(() => useStageStore.getState().setDockMagnifyLevel(level))
      const magnify = [...strip().classList].filter((c) => c.includes('magnify'))
      expect(magnify).toHaveLength(1)
      seen.add(magnify[0])
    }
    expect(seen.size).toBe(3)
  })

  it('关掉放大不换那个类 —— 幅度是幅度,开关是开关,两件事', () => {
    render(<AppShell />)
    const before = [...strip().classList].filter((c) => c.includes('magnify'))
    act(() => useStageStore.getState().setDockMagnify(false))
    expect([...strip().classList].filter((c) => c.includes('magnify'))).toEqual(before)
  })
})

describe('Dock 偏好:运行中指示点', () => {
  it('开着的面上画点,关掉那格之后一颗都不画', () => {
    render(<AppShell />)
    act(() => useStageStore.getState().clickDockIcon('files'))
    const withDots = runningDots()
    expect(withDots).toBeGreaterThan(0)
    act(() => useStageStore.getState().setDockRunningDot(false))
    expect(runningDots()).toBe(0)
    // 关的是**指示**不是状态:那块面照旧开着,再打开开关就又画出来。
    expect(useStageStore.getState().placements.files).toBeTruthy()
    act(() => useStageStore.getState().setDockRunningDot(true))
    expect(runningDots()).toBe(withDots)
  })
})
