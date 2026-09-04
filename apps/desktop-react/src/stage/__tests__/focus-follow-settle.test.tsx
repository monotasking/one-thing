import { StrictMode, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, render } from '@testing-library/react'
import { FocusScope } from '../../focus/FocusScope'
import { focusTree } from '../../focus/registry'
import { StageFocusFollow } from '../focus-follow'
import { useStageStore } from '../store'
import { requestFocusOnOpen } from '../summon'
import * as T from '../transitions'

/**
 * **键盘开面:那一层刚挂上来又被重挂一次,焦点仍然在它里面**
 * (设计 `docs/design/react-shell-focus-2026-09.md` §3.5 规则 2)。
 *
 * ── 这一组守的是哪一次报障 ────────────────────────────────────────────────
 * 用户 09-04 报「files 记忆钉左架子,键盘三连按 = 出现 / 没反应 / 隐藏」。真机读数
 * (离屏 StrictMode 实例,隔离 store)把病照出来了:第一下**开了面也送了焦点**
 * (`activateScope` 答 true),但那一层随即被**重挂一次**,卸载那一下树的结构归还
 * (§4.5 的 `returnTo` → 父链)把焦点送回了按键之前的输入框,而点名
 * (`requestFocusOnOpen`)早已被消费掉,新挂上来的那一份没有人再叫它。于是第二下
 * 落在「看得见、焦点不在它里面」那一格 = 只聚焦(那一格无声,因为这些面没有自己的
 * region,焦点落在层根上不画环),第三下才轮到隐藏 —— 逐字就是用户数的那三下。
 *
 * ── 09-04 S4:病根改在树上,这一组跟着改判据 ──────────────────────────────
 * S3 的修法是在 `focus-follow` 上开一扇 250ms 窄口补送。真机证伪:窄口的收手判据
 * 问的是「焦点此刻在不在里面」,而架子上**另有一格 tab** 时,隔壁那一层的注销通知
 * 先到(那一刻焦点确实还在里面),窄口当场收手;0.1ms 之后装着这块面的那一层才
 * 注销、归还把焦点送回输入框。所以 S4 把窄口整段删了,改治源头:
 * **`FocusTree.unregister` 晚一个微任务才结算,同一个实例 id 在那之前回来了就当
 * 它没走过**(判词写在那只方法头上)。
 *
 * 于是这一组的判据从「补送补得回来吗」变成 **「一次重挂根本不该发出归还」**:
 *  · 用 `<StrictMode>` 包根 —— 它发出的正是那一串(同一个 `useId` 先注销再登记),
 *    而且是**用户真正撞上的**那一串;
 *  · 断言前 `await` 一次微任务,否则量的是「延后的那一下还没跑」,不是「它被取消了」;
 *  · 另一半同样要钉:**真卸载仍然归还** —— 少了这一条,把 `settle` 整只删掉也能绿。
 */

const layer = () => document.querySelector('[data-testid="float-layer"]')
const composerInput = () => document.querySelector<HTMLInputElement>('[data-testid="composer-input"]')

/** 排空微任务队列(延后的那一下结算就住在这上面)。 */
const flushMicrotasks = () => act(async () => { await Promise.resolve() })

function Shell({ layerKey = 0 }: { layerKey?: number }) {
  const placements = useStageStore((s) => s.placements)
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <FocusScope scope="root">
      {({ scopeProps }) => (
        <div {...scopeProps}>
          <StageFocusFollow />
          <FocusScope scope="composer" restingTarget={() => inputRef.current}>
            {(c) => (
              <div {...c.scopeProps}>
                <input ref={inputRef} data-testid="composer-input" />
              </div>
            )}
          </FocusScope>
          {placements.files ? (
            /* key 换值 = **换一个实例**(新 `useId` + 新元素),不是一次重挂 ——
             * 判词与读数写在下面那一条用例上头。 */
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
    useStageStore.getState().openAs('files', { kind: 'float' })
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
  it('开出来就进去(基线)', async () => {
    render(<Shell />)
    act(() => composerInput()?.focus())
    summonOpen()
    await flushMicrotasks()
    expect(layer()?.contains(document.activeElement)).toBe(true)
  })

  it('**`<StrictMode>` 的模拟卸载→再挂载:焦点一步不动,归还一句都不发**(用户 09-04 报的那条)', async () => {
    render(
      <StrictMode>
        <Shell />
      </StrictMode>,
    )
    act(() => composerInput()?.focus())
    summonOpen()
    const landed = document.activeElement
    expect(layer()?.contains(landed)).toBe(true)
    /*
     * 反证:把 `FocusTree.unregister` 里那段「延后一个微任务、同 id 回来就取消」
     * 换回从前的当场 `settle()` → 这里红,读数正是
     * `document.activeElement` = `composer-input`(结构归还把它送回去了)。
     *
     * 这一次 `await` 是判据本身:延后的结算就排在微任务上,不排空它量到的是
     * 「它还没跑」,而不是「它被取消了」。
     */
    await flushMicrotasks()
    expect(layer()?.contains(document.activeElement)).toBe(true)
    // 「一步不动」比「最后又回到里面」严:补送式的修法过不了这一条。
    expect(document.activeElement).toBe(landed)
  })

  /*
   * ── 「换 key」不是重挂,是**换了一个实例**(09-04 S4 实测,顺手推翻了 S3 那条注释)──
   * S3 这一组原本用 `key` 换值来「造」StrictMode 那一串,注释写着两者是同一件事。
   * 不是:`useId` 在 StrictMode 的模拟卸载→再挂载里**逐字相同**(读数 `_r_2_` →
   * `_r_2_`),而 `key` 一换就是一个**新号**(`_r_0_` → `_r_1_`),连 DOM 元素都是新的。
   * 所以后者是一次货真价实的卸载 + 一次全新的挂载 —— 焦点回到开它之前的地方正是
   * §3.5 规则 5 要的答案,不是病。这一条把它钉成「预期行为」,免得下一个人看见
   * 焦点跑回输入框又去加一层补送。
   */
  it('**换 key = 换实例**(新号 + 新元素):按规则 5 归还,不是重挂', async () => {
    const view = render(<Shell layerKey={0} />)
    act(() => composerInput()?.focus())
    summonOpen()
    expect(layer()?.contains(document.activeElement)).toBe(true)
    act(() => view.rerender(<Shell layerKey={1} />))
    await flushMicrotasks()
    expect(document.activeElement).toBe(composerInput())
  })

  it('**真卸载仍然归还**:那块面收回 Dock,焦点回到开它之前那个输入框', async () => {
    render(<Shell />)
    act(() => composerInput()?.focus())
    summonOpen()
    expect(layer()?.contains(document.activeElement)).toBe(true)
    act(() => {
      useStageStore.getState().closeToDock('files')
    })
    await flushMicrotasks()
    expect(layer()).toBeNull()
    expect(document.activeElement).toBe(composerInput())
  })

  it('无关的重渲染(层没重挂)不抢焦点', async () => {
    const view = render(<Shell layerKey={0} />)
    act(() => composerInput()?.focus())
    summonOpen()
    const landed = document.activeElement
    act(() => view.rerender(<Shell layerKey={0} />))
    await flushMicrotasks()
    expect(document.activeElement).toBe(landed)
  })

  it('**没人点名**(指针点瓦)时焦点留在原地', async () => {
    render(<Shell />)
    act(() => composerInput()?.focus())
    act(() => {
      useStageStore.getState().openAs('files', { kind: 'float' })
    })
    await flushMicrotasks()
    expect(document.activeElement).toBe(composerInput())
  })
})
