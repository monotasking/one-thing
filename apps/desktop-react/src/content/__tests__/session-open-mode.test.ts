import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedSessionsSource } from '../../data/__fixtures__/sessions'
import { resetComposerDrafts, saveComposerDraft } from '../../composer/drafts'
import { useSessionOpenMode } from '../../data/session-open-mode'
import { useExposeStore } from '../../expose/store'
import { initialExposeState } from '../../expose/transitions'
import { CENTER_REGION } from '../../workbench/regions'
import { useWorkbenchStore } from '../../workbench/store'
import { leavesOf, previewIndexOf, refIdsOf } from '../../workbench/tree'
import '../kinds'
import { enterSessionInWorkbench, promoteSessionSeat } from '../session-open'
import { sessionRefOf } from '../session-ref'
import type { SessionOpenMode } from '../../data/session-open-mode'
import type { PaneLeafNode, PaneNode } from '../../workbench/tree'

/**
 * **点会话列表一行是什么意思**(C2,正本
 * `apps/desktop-react/docs/session-continuity-2026-09.md` §4)。
 *
 * 用户 09-09 原话:「点击一个 session 的行为还是覆盖,好像没有地方能够控制。」
 * 这一组逐档钉那三档,再逐条钉转正的四条路 —— 每一条都配一句「拆掉即红」的反证
 * (写在各自的用例上)。
 *
 * 树侧那格标记怎么跟着下标走,在 `workbench/__tests__/preview-tab.test.ts`
 * (那一组里一个「会话」的字都没有)。这一组只问**会话这一种内容**的语义。
 */

const A = 'os-expose'
const B = 'os-compact'
const C = 'os-search'

const center = (): PaneNode => useWorkbenchStore.getState().regions[CENTER_REGION]
const leaf = (): PaneLeafNode => leavesOf(center())[0]
const ids = (): string[] => refIdsOf(center())

const mode = (next: SessionOpenMode): void => {
  useSessionOpenMode.setState({ mode: next })
}

beforeEach(() => {
  seedSessionsSource()
  resetComposerDrafts()
  useExposeStore.setState({ ...initialExposeState })
  useSessionOpenMode.setState({ mode: 'preview', byWorkspace: {} })
  useWorkbenchStore.getState().reset()
  useWorkbenchStore.getState().seed()
})

afterEach(() => {
  resetComposerDrafts()
})

describe('三档', () => {
  /*
   * 出厂那一格是**保留键**(`session:new`,播种出来的空脸)。三档一律先把它换掉
   * ——否则每次冷启动点第一条会话都会留下一个点开是空脸的标签(判词在
   * `session-open.ts` 文件头)。所以这三条用例的第一下点击在三档里长得一样,
   * 差别从**第二下**开始。
   */
  it('`replace`:一直原位换,标签永远一格(今天的行为)', () => {
    mode('replace')
    enterSessionInWorkbench(A)
    expect(ids()).toEqual([`session:${A}`])
    enterSessionInWorkbench(B)
    expect(ids()).toEqual([`session:${B}`])
    expect(previewIndexOf(leaf())).toBeUndefined()
  })

  it('`newTab`:第二下起在末尾新开一格,一格都不覆盖', () => {
    mode('newTab')
    enterSessionInWorkbench(A)
    expect(ids()).toEqual([`session:${A}`])
    enterSessionInWorkbench(B)
    expect(ids()).toEqual([`session:${A}`, `session:${B}`])
    enterSessionInWorkbench(C)
    expect(ids()).toEqual([`session:${A}`, `session:${B}`, `session:${C}`])
    expect(previewIndexOf(leaf())).toBeUndefined()
  })

  it('`preview`(出厂):**复用同一格预览位**,来回切着看标签不增', () => {
    mode('preview')
    enterSessionInWorkbench(A)
    expect(ids()).toEqual([`session:${A}`])
    expect(previewIndexOf(leaf())).toBe(0)

    enterSessionInWorkbench(B)
    expect(ids()).toEqual([`session:${B}`])
    expect(previewIndexOf(leaf())).toBe(0)

    enterSessionInWorkbench(C)
    expect(ids()).toEqual([`session:${C}`])
    expect(previewIndexOf(leaf())).toBe(0)
  })

  /*
   * **反证①**(派工令点名的那一条):把 `session-open.previewSeatOf` 拆成
   * 「永远答 null」(= 每次都新开一格)→ 上面这一条当场红:三下点击留下三格标签。
   */

  it('转正之后,下一次点别的会话在它**旁边**新开一格预览', () => {
    mode('preview')
    enterSessionInWorkbench(A)
    // 转正(这里直接调那口;四条路各自的入口在下面一组)。
    promoteSessionSeat(A)
    expect(previewIndexOf(leaf())).toBeUndefined()

    enterSessionInWorkbench(B)
    expect(ids()).toEqual([`session:${A}`, `session:${B}`])
    expect(previewIndexOf(leaf())).toBe(1)

    // 第三条会话接着复用那一格预览位 —— 在干活的那一条一个字都没动。
    enterSessionInWorkbench(C)
    expect(ids()).toEqual([`session:${A}`, `session:${C}`])
    expect(previewIndexOf(leaf())).toBe(1)
  })

  it('已经开着的那一条 → 跳过去(三档同一句,照旧)', () => {
    mode('preview')
    enterSessionInWorkbench(A)
    promoteSessionSeat(A)
    enterSessionInWorkbench(B)
    expect(ids()).toEqual([`session:${A}`, `session:${B}`])

    enterSessionInWorkbench(A)
    // 不多开、不原位换:只是点亮那一格。
    expect(ids()).toEqual([`session:${A}`, `session:${B}`])
    expect(leaf().active).toBe(0)
  })
})

describe('转正的四条路', () => {
  it('① 发了一句话 → `promoteSessionSeat`(唯一调用点在 composer 的发送成功处)', () => {
    mode('preview')
    enterSessionInWorkbench(A)
    expect(previewIndexOf(leaf())).toBe(0)
    promoteSessionSeat(A)
    expect(previewIndexOf(leaf())).toBeUndefined()
    // 幂等:再发一句不会去动别人。
    promoteSessionSeat(A)
    expect(previewIndexOf(leaf())).toBeUndefined()
  })

  /*
   * **反证②**(派工令点名的那一条):把 `useComposerSend` 里那句
   * `promoteSessionSeat(sessionId)` 拆掉 → 「发一句话之后再点别的会话,这一格
   * 被换掉」——也就是下面这一条的形状:少了转正,`ids()` 只会剩一格。
   * 那一句本身在 `composer/useComposerSend.test.tsx` 里另有一条真发送路的用例。
   */

  it('② 输入框有草稿 → 要换掉它之前先把它转正,另开一格预览', () => {
    mode('preview')
    enterSessionInWorkbench(A)
    saveComposerDraft(A, { html: '<p>还没发出去的话</p>', attachments: [], attOpen: false })

    enterSessionInWorkbench(B)
    // A 那一格留在屏幕上(它有稿),B 开在它旁边并且是新的预览位。
    expect(ids()).toEqual([`session:${A}`, `session:${B}`])
    expect(previewIndexOf(leaf())).toBe(1)
  })

  it('② 的反面:没有稿的那一格照旧被换掉', () => {
    mode('preview')
    enterSessionInWorkbench(A)
    saveComposerDraft(A, { html: '   ', attachments: [], attOpen: false }) // 空稿 = 没有稿
    enterSessionInWorkbench(B)
    expect(ids()).toEqual([`session:${B}`])
  })

  it('③ 把标签拖过 = 结构保证(摘一格再插一格,标记在摘的那一下就没了)', () => {
    mode('preview')
    enterSessionInWorkbench(A)
    promoteSessionSeat(A)
    enterSessionInWorkbench(B)
    const at = previewIndexOf(leaf())!
    expect(at).toBe(1)

    // 同叶换序走的就是拖拽落定那一只(`drop-commit.reorderTab` → `store.moveTab`)。
    useWorkbenchStore.getState().moveTab(leaf().id, at, 0)
    expect(ids()).toEqual([`session:${B}`, `session:${A}`])
    expect(previewIndexOf(leaf())).toBeUndefined()
  })

  it('④ 右键「保留」= `store.promoteTab`(菜单那一行调的就是它)', () => {
    mode('preview')
    enterSessionInWorkbench(A)
    const at = previewIndexOf(leaf())!
    useWorkbenchStore.getState().promoteTab(leaf().id, at)
    expect(previewIndexOf(leaf())).toBeUndefined()

    enterSessionInWorkbench(B)
    expect(ids()).toEqual([`session:${A}`, `session:${B}`])
  })
})

describe('保留键那一格', () => {
  it('三档一律**原位换**它 —— 冷启动点第一条会话不会留下一个空脸标签', () => {
    for (const each of ['preview', 'newTab', 'replace'] as const) {
      useWorkbenchStore.getState().reset()
      useWorkbenchStore.getState().seed()
      mode(each)
      expect(ids()).toEqual([`session:${sessionRefOf('').key}`])
      enterSessionInWorkbench(A)
      expect(ids()).toEqual([`session:${A}`])
    }
  })
})
