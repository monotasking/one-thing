import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { KeymapSettings } from '../KeymapSettings'
import { FOCUS_SCOPES } from '../../focus/scopes'
import { useKeymapStore } from '../../keymap/store'
import { useStageStore } from '../../stage/store'
import { zh } from '../../i18n/zh'
import type { Combo } from '../../keymap/types'

/**
 * 设置页快捷键区的**撞键那一问**(09-03 R3)。
 *
 * 这块面要说得出两种撞车,而这一组只守其中一种:**全局命令 ↔ 面域局部键**。
 * 它的正本是 `focus/scopes.ts` 的 `FOCUS_SCOPES[id].keys`(R2 之前
 * `keymap/scopes.ts` 还留着一层旧形状的投影,R2 把那层连同 `files.row` 这个
 * 旧 id 一起退役了),这里钉的就是「读的是那张正本、并且说得出所属的**那块面**」。
 *
 * 为什么它值得一条用例:F1 那条留账的原话是「用户把某条全局命令改绑到 ⌘I,
 * bindCombo 看不见这条行内键,会**静默**把它盖住」。静默正是这条病的形状 ——
 * 而一句默认不出现的提示,人眼是走查不出「它到底还在不在」的。
 *
 * 反证:把 KeymapSettings 里那段 `scopedCollisions.map(...)` 删掉 → 第二条红;
 * 把 `t('keymap.scopedConflict', { scope: … })` 的 scope 换成 `c.scoped.scope`
 * (作用域 id 而不是它的 labelKey)→ 第三条红。
 */

const MOD_I: Combo = { meta: true, key: 'i' }

/** 「⌘I 已被谁占着」那句话里,{scope} 与 {action} 该填的两个词。 */
const FILES_LABEL = zh[FOCUS_SCOPES.files.labelKey]
const DETAIL_LABEL = zh['files.detailAction']

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

describe('设置页快捷键区:全局 ↔ 面域局部键的撞车', () => {
  it('出厂表下一句都不出现(今天零撞车)', () => {
    render(<KeymapSettings />)
    expect(screen.queryByText(new RegExp(DETAIL_LABEL))).toBeNull()
  })

  it('把某条命令改绑到 ⌘I:那一行旁边说出**所属的那块面**与被占的动作', () => {
    useKeymapStore.setState({ overrides: { 'toc.toggle': MOD_I } })
    render(<KeymapSettings />)
    /*
     * 断言整句而不是「含 files 两个字」:这句话的价值全在**两个填空**上
     * (哪块面 / 哪个动作),少填一个就等于没说清。
     */
    const expected = zh['keymap.scopedConflict']
      .replace('{scope}', FILES_LABEL)
      .replace('{action}', DETAIL_LABEL)
    expect(screen.getByText(expected)).toBeTruthy()
  })

  it('填的是作用域的 labelKey(人读的名字),不是它的 id', () => {
    useKeymapStore.setState({ overrides: { 'toc.toggle': MOD_I } })
    render(<KeymapSettings />)
    /*
     * 先**取到**那句话再看它里面有什么 —— 只写一句「屏幕上找不到 files」的话,
     * 整段渲染被摘掉时它也是绿的(首版就是这么写的,反证时当场发现,改锐)。
     * `files` 是 `FocusScopeId`,不该出现在给人看的那句话里。
     */
    const line = screen.getByText(
      // 「{scope} 那一格填了什么」是这一条要问的,所以 scope 留成通配。
      new RegExp(zh['keymap.scopedConflict'].replace('{scope}', '.+').replace('{action}', DETAIL_LABEL)),
    )
    expect(line.textContent ?? '').toContain(FILES_LABEL)
    expect(line.textContent ?? '').not.toMatch(/files/)
    expect(FILES_LABEL).not.toBe('files')
  })

  it('撞车**不拦写入**:那条命令的键位仍然显示成 ⌘I(局部先接、没接住放行全局)', () => {
    useKeymapStore.setState({ overrides: { 'toc.toggle': MOD_I } })
    render(<KeymapSettings />)
    /*
     * 撞车不是错误:⌘I 在文件树里开详情,在别处仍然是那条全局命令。
     * 所以这一行的键帽照旧画 ⌘ 与 I —— 它不该被改写成「未绑定」或灰掉。
     */
    expect(screen.getAllByText('I').length).toBeGreaterThan(0)
  })
})
