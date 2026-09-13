import { afterEach, describe, expect, it } from 'vitest'
import {
  composerStoreFor,
  disposeComposerStore,
  resetComposerStore,
} from './store'
import { configureComposerSink } from './sink'
import { pickDrawer } from './types'

/**
 * **一条会话一份输入面板状态**(W5-c-2,正本 `composer-in-leaf-2026-09.md` §4.3)。
 *
 * 路线 A 之后屏幕上有几片会话叶就有几块输入面板,而它们从前共用**一格模块级
 * store**:抽屉、搜索词、ask、附件、状态条五样会互相顶替(A 打开模型抽屉,B 那块
 * 面板上也会开一格;B 挂上一个附件,A 的摞里也多一张卡)。这与 W5-a 的「一条会话
 * 一台折叠器」、W7-t/B2 的「一条会话一份草稿」是同一条病、同一条路。
 *
 * 这一组只钉三句,都在 store 这一层(组件那一层归 `components/Composer.test.tsx`):
 *  ① 两个 `sessionId` 拿到的是**两份**,一份动另一份不动;
 *  ② 同一个 `sessionId` 拿到的**恒等**(不是每次读都新建一份);
 *  ③ `disposeComposerStore` 把那一份摘掉 —— 下一次读到的是崭新的。
 *
 * **反证**:把 `composerStoreFor` 里那张 Map 换回一格模块级单例(恒答同一份)→
 * ① 与 ③ 当场红。
 */

afterEach(() => {
  resetComposerStore()
  configureComposerSink(undefined)
})

describe('W5-c-2:输入面板状态按会话分家', () => {
  it('① A 开抽屉,B 那一份一个字不动', () => {
    composerStoreFor('A').getState().toggleModelDrawer()
    expect(composerStoreFor('A').getState().drawerKind).toBe('model')
    expect(composerStoreFor('B').getState().drawerKind).toBeNull()

    // 反过来也一样:B 挂一张附件,A 的摞里没有它。
    composerStoreFor('B').setState({ attachments: [{ id: 'b1', name: 'b.png' }] })
    expect(composerStoreFor('A').getState().attachments).toEqual([])
  })

  it('② 同一条会话读到的恒等(不是每次读都新建一份)', () => {
    expect(composerStoreFor('A')).toBe(composerStoreFor('A'))
    /*
     * **保留键那片叶读作空串,而空串是一格真键**(与草稿表逐字同一条口径:
     * 「是会话叶,但还没绑会话」不是缺席)。所以它也有自己那一份,与别人分家。
     */
    expect(composerStoreFor('')).not.toBe(composerStoreFor('A'))
  })

  it('③ 关掉那一格 = 摘掉那一份,下一次读到的是崭新的', () => {
    composerStoreFor('A').getState().showPick('@', 'model')
    expect(composerStoreFor('A').getState().drawerKind).toEqual(pickDrawer('@'))

    disposeComposerStore('A')
    expect(composerStoreFor('A').getState().drawerKind).toBeNull()
    expect(composerStoreFor('A').getState().pickQuery).toBe('')
  })

  /**
   * **收件人在造这一份的时候就钉死了**:三口出站动作(发送 / ask 交卷 / ask 拒答)
   * 交出去的那条会话,是这一份 store 自己的那条 —— 不是一句「当前会话」投影。
   * 那正是分屏下「在 A 里按发送,话跑到 B 去了」的治法。
   */
  it('发送交出去的是**这一份自己的**那条会话', () => {
    const handed: { text: string; sessionId: string }[] = []
    const notices: string[] = []
    configureComposerSink({
      send: (text, _attachments, sessionId) => {
        handed.push({ text, sessionId })
        return true
      },
      notice: (_kind, sessionId) => void notices.push(sessionId),
      abort: () => undefined,
      startSession: async () => undefined,
    })

    composerStoreFor('A').getState().send('甲说的话')
    composerStoreFor('B').getState().send('乙说的话')
    expect(handed).toEqual([
      { text: '甲说的话', sessionId: 'A' },
      { text: '乙说的话', sessionId: 'B' },
    ])

    composerStoreFor('B').getState().rejectAsk()
    expect(notices).toEqual(['B'])
  })
})
