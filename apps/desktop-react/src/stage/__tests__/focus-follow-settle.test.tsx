import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, render } from '@testing-library/react'
import { FocusScope } from '../../focus/FocusScope'
import { focusTree } from '../../focus/registry'
import { useStageFocusFollow } from '../focus-follow'
import { useStageStore } from '../store'
import { requestFocusOnOpen } from '../summon'
import * as T from '../transitions'

/**
 * **落定之后那扇窄口:宿主层刚挂上来就被重挂一次,焦点仍然进得去**
 * (09-04,设计 `docs/design/react-shell-focus-2026-09.md` §3.5 规则 2)。
 *
 * ── 这一组守的是哪一次报障 ────────────────────────────────────────────────
 * 用户 09-04 报「键盘开工作区面:第一下面出现、第二下没反应、第三下才隐藏」。
 * 真机读数(隔离 store + 独立 user-data-dir,dev 壳)把病照出来了:第一下**开了面
 * 也送了焦点**(`activateScope` 答 true),但那一层随即被**重挂一次**(dev 的
 * React StrictMode 会给每个新挂载的组件模拟一遍「卸载 → 再挂载」),卸载那一下
 * 树的结构归还(§4.5 的 `returnTo` → 父链)把焦点送回了按键之前的输入框,而
 * 点名(`requestFocusOnOpen`)早已被消费掉,新挂上来的那一份没有人再叫它。
 * 于是第二下落在「看得见、焦点不在它里面」那一格 = 只聚焦(那一格无声,因为
 * 这些面没有自己的 region,焦点落在层根上不画环),第三下才轮到隐藏 ——
 * 逐字就是用户数的那三下。12 块面里 10 块中招,只有自己声明 `activateOnMount`
 * 的检索面与总览幸免(它们重挂时自己又入了一次焦)。
 *
 * ── 为什么这一组用 `key` 换值来造重挂,而不是套一层 `<StrictMode>` ────────
 * 要守的东西不是「StrictMode」,是**「这一层重挂了一次」**:换宿主、错误边界重试、
 * 工作区换装、热更,都会走同一串树操作(`unregister` → 结构归还 → `register`)。
 * `key` 换值造出的正是那一串,而且**它在生产构建里同样成立** —— 用 StrictMode
 * 造的话,这组用例守的就成了一个只在开发期存在的现象。
 */

const layer = () => document.querySelector('[data-testid="float-layer"]')
const composerInput = () => document.querySelector<HTMLInputElement>('[data-testid="composer-input"]')

function Shell({ layerKey }: { layerKey: number }) {
  useStageFocusFollow()
  const placements = useStageStore((s) => s.placements)
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <FocusScope scope="root">
      {({ scopeProps }) => (
        <div {...scopeProps}>
          <FocusScope scope="composer" restingTarget={() => inputRef.current}>
            {(c) => (
              <div {...c.scopeProps}>
                <input ref={inputRef} data-testid="composer-input" />
              </div>
            )}
          </FocusScope>
          {placements.files ? (
            /* key 换值 = 这一层重挂一次(见文件头那段判词)。 */
            <FocusScope key={layerKey} scope="float-layer" owner="files">
              {(l) => <section {...l.scopeProps} data-testid="float-layer" />}
            </FocusScope>
          ) : null}
        </div>
      )}
    </FocusScope>
  )
}

/** 「键盘召唤开面」那条路的两句话:先点名,再落形态。 */
function summonOpen(): void {
  act(() => {
    requestFocusOnOpen('files')
    useStageStore.setState((s) => T.openAs(s, 'files', { kind: 'float' }))
  })
}

/*
 * 每例前后各摊平一次那本家具账。**前**那一次不是多余的:store 是模块单例,
 * 它在 jsdom 里建起来时走的是 persist 的 `merge`(空 localStorage + 没有当前
 * 工作区),摊出来的活状态那几格是空的 —— 第一例若不先摆正,读到的
 * `placements` 是 undefined。
 */
beforeEach(() => {
  useStageStore.setState({ ...T.initialStageState })
})

afterEach(() => {
  focusTree.reset()
  act(() => {
    useStageStore.setState({ ...T.initialStageState })
  })
})

describe('键盘开面 → 焦点进那块面', () => {
  it('开出来就进去(基线)', () => {
    render(<Shell layerKey={0} />)
    act(() => composerInput()?.focus())
    summonOpen()
    expect(layer()?.contains(document.activeElement)).toBe(true)
  })

  it('**那一层刚挂上来又被重挂一次,焦点仍然在它里面**(用户 09-04 报的那条)', () => {
    const view = render(<Shell layerKey={0} />)
    act(() => composerInput()?.focus())
    summonOpen()
    expect(layer()?.contains(document.activeElement)).toBe(true)

    /*
     * 反证:把 `focus-follow` 里那段「窄口内补送」删掉 → 这里红,读数正是
     * `document.activeElement` = `composer-input`(结构归还把它送回去了,
     * 而新挂上来的那一份没有人再叫)。把 `settled` 换回原来那版「最多补送三次」
     * 也红:重挂那一轮先来三下「注销 / setRoot(null)」的通知,三次当场吃光。
     */
    act(() => view.rerender(<Shell layerKey={1} />))
    expect(layer()?.contains(document.activeElement)).toBe(true)
  })

  it('窄口只补**这一次落定**的那块面:焦点已经在它里面时一个字都不动', () => {
    const view = render(<Shell layerKey={0} />)
    act(() => composerInput()?.focus())
    summonOpen()
    const landed = document.activeElement
    // 一次无关的重渲染(层没重挂)不该再抢一次焦点。
    act(() => view.rerender(<Shell layerKey={0} />))
    expect(document.activeElement).toBe(landed)
  })

  it('**没人点名**(指针点瓦)时窄口根本不开:焦点留在原地', () => {
    render(<Shell layerKey={0} />)
    act(() => composerInput()?.focus())
    act(() => {
      useStageStore.setState((s) => T.openAs(s, 'files', { kind: 'float' }))
    })
    expect(document.activeElement).toBe(composerInput())
  })
})
