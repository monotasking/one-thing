import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { KeymapSettings } from '../KeymapSettings'
import { FOCUS_SCOPES } from '../../focus/scopes'
import { useKeymapStore } from '../../keymap/store'
import { useStageStore } from '../../stage/store'
import { zh } from '../../i18n/zh'
import type { Combo } from '../../keymap/types'

/**
 * 设置页快捷键区的**「谁答」那一列 + 共键那一句**(09-03 R3 立,K0 改口)。
 *
 * 这块面要说得出三件事,这一组守其中两件:
 *  · **谁答得出这条命令**(`answerersOf`,正本 `FOCUS_SCOPES[id].answers`)——
 *    「查找 ⌘F:浏览器(这一页)/ 终端(这块屏幕)/ 查看器(这份文件)」;
 *  · **合法的共键**(`sharedChordOf`)—— 撞不是错误,但不许**静默**。
 *
 * 为什么它值得一条用例:F1 那条留账的原话是「用户把某条全局命令改绑到 ⌘I,
 * bindCombo 看不见这条行内键,会**静默**把它盖住」。静默正是这条病的形状 ——
 * 而一句默认不出现的提示,人眼是走查不出「它到底还在不在」的。
 *
 * 反证:把 `FOCUS_SCOPES.files.answers` 删掉 → 第一条红;把 KeymapSettings 里
 * 那段 `shared.map(...)` 删掉 → 共键那两条红。
 */

const MOD_I: Combo[] = [{ meta: true, key: 'i' }]

/** 「谁答」那一句里,{scope} 与 {action} 该填的两个词。 */
const FILES_LABEL = zh[FOCUS_SCOPES.files.labelKey]
const DETAIL_LABEL = zh['files.detailAction']
const TOC_LABEL = zh['toc.title']

/*
 * 两处 store 复位都先 `cleanup()` 再写:store 是模块单例,而这块面订阅着它 ——
 * 上一条用例的树还挂在那儿时改 store,React 会告「没包 act」。先卸载再复位,
 * 那次写入就没有消费者了(这也是复位该有的顺序:先散场,再收拾场地)。
 */
beforeEach(() => {
  cleanup()
  act(() => {
    useStageStore.setState({ locale: 'zh' })
    useKeymapStore.setState({ overrides: {} })
  })
})

afterEach(() => {
  cleanup()
  act(() => {
    useKeymapStore.setState({ overrides: {} })
  })
})

describe('设置页快捷键区:「谁答」那一列', () => {
  it('跟随焦点那一节在场,而且「详情」那一行说得出是**文件**答的', () => {
    render(<KeymapSettings />)
    expect(screen.getByText(zh['keymap.sectionScoped'])).toBeTruthy()
    /*
     * 断言整句而不是「含 files 两个字」:这句话的价值全在**两个填空**上
     * (哪块面 / 它管这件事叫什么),少填一个就等于没说清。
     */
    const expected = zh['keymap.answerer']
      .replace('{scope}', FILES_LABEL)
      .replace('{action}', DETAIL_LABEL)
    expect(screen.getByText(expected)).toBeTruthy()
  })

  it('**一条命令三个响应者**:⌘F 那一行同时列出浏览器 / 终端 / 查看器', () => {
    render(<KeymapSettings />)
    for (const [scopeKey, actionKey] of [
      ['item.browser', 'browser.find'],
      ['item.terminal', 'terminal.find'],
      ['viewer.label', 'viewer.findLabel'],
    ] as const) {
      const line = zh['keymap.answerer']
        .replace('{scope}', zh[scopeKey])
        .replace('{action}', zh[actionKey])
      expect(screen.getByText(line), line).toBeTruthy()
    }
  })

  it('填的是作用域的 labelKey(人读的名字),不是它的 id', () => {
    render(<KeymapSettings />)
    const line = screen.getByText(
      // 「{scope} 那一格填了什么」是这一条要问的,所以 scope 留成通配。
      new RegExp(zh['keymap.answerer'].replace('{scope}', '.+').replace('{action}', DETAIL_LABEL)),
    )
    expect(line.textContent ?? '').toContain(FILES_LABEL)
    expect(line.textContent ?? '').not.toMatch(/files/)
    expect(FILES_LABEL).not.toBe('files')
  })

  /**
   * **认领那一句**(Win / Linux 档;jsdom 的 UA 不是 mac,所以终端的 `claims`
   * 在场)。⌘P 在终端里根本到不了应用 —— 这不是错误,但用户有权在键位页上看见。
   * K0 之前这句话由 `scopedCollisionsOf` 说,现在由 `claimantsOf` 说。
   */
  it('「⌘P 在终端里交给终端」说得出口(认领不是命令,但不许静默)', () => {
    render(<KeymapSettings />)
    const line = zh['keymap.answerer']
      .replace('{scope}', zh['item.terminal'])
      .replace('{action}', zh['terminal.keyToPty'])
    expect(screen.getAllByText(line).length).toBeGreaterThan(0)
  })
})

describe('设置页快捷键区:共键说得出口', () => {
  it('出厂档下「目录」那一行没有共键提示(⌘⇧O 只有它一个人在用)', () => {
    render(<KeymapSettings />)
    const shared = zh['keymap.sharedChord'].replace('{name}', DETAIL_LABEL)
    expect(screen.queryByText(shared)).toBeNull()
  })

  it('把「目录」改绑到 ⌘I:那一行说出「与『详情』共用这个键」,而且**不拦写入**', () => {
    useKeymapStore.setState({ overrides: { 'toc.toggle': MOD_I } })
    render(<KeymapSettings />)
    expect(
      screen.getByText(zh['keymap.sharedChord'].replace('{name}', DETAIL_LABEL)),
    ).toBeTruthy()
    // 反过来那一行也说得出(共键是对称的)。
    expect(screen.getByText(zh['keymap.sharedChord'].replace('{name}', TOC_LABEL))).toBeTruthy()
    /*
     * 共键不是错误:⌘I 在文件树里开详情,在别处仍然是那条全局命令。
     * 所以这一行的键帽照旧画 ⌘ 与 I —— 它不该被改写成「未绑定」或灰掉。
     */
    expect(screen.getAllByText('I').length).toBeGreaterThan(0)
  })

  /**
   * **一条命令两个键面**(`files.detail` 的 ⌘I 与 ⌘↵)。旧表把它写成两行,
   * 于是设置页说不出「详情」这一条到底绑着什么;K0 把它归位成一行两键。
   */
  it('「详情」那一行同时画出 ⌘I 与 ⌘↵', () => {
    render(<KeymapSettings />)
    const slot = screen.getByLabelText(
      zh['keymap.recordOf'].replace('{name}', DETAIL_LABEL),
    )
    expect(slot.textContent).toContain('I')
    expect(slot.textContent).toContain('↵')
  })
})
