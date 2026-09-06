import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  composerDraftKeys,
  configureDraftRevoke,
  dropComposerDraft,
  EMPTY_DRAFT,
  readComposerDraft,
  resetComposerDrafts,
  saveComposerDraft,
} from './drafts'
import type { Attachment } from './types'

/**
 * **一条会话一份草稿**那张表的规格(W7-t / B2)。
 *
 * 判词整段在 `composer/drafts.ts` 文件头上,这里只钉它的四条行为:
 *  · 按 `sessionId` 分家 —— 存 A 读 A,一格不串;
 *  · **空稿等于删掉**(表里不留空壳);
 *  · 丢一份稿 = 销掉挂在它上面那些附件的对象 URL,而**销那一句是注入的**
 *    (「谁造谁销」:URL 是 `composer/store` 造的);
 *  · `''` 是一格**合法的键**(首开草稿态那些字要留得住),不是「缺席」。
 *
 * 编排那一半(切会话时先存旧的再铺新的)在 `components/Composer.test.tsx` 里,
 * 那是它真正的落点 —— 这一层只管表本身。
 */

const att = (url: string): Attachment => ({ id: url, name: url, url })

/** 被销掉的那些 URL(按销的次序)。 */
let revoked: string[] = []

beforeEach(() => {
  revoked = []
  configureDraftRevoke((atts) => {
    for (const a of atts) if (a.url) revoked.push(a.url)
  })
  resetComposerDrafts()
  revoked = []
})

afterEach(() => {
  resetComposerDrafts()
})

describe('草稿表:按会话分家', () => {
  it('存 A 读 A,存 B 读 B,一格不串', () => {
    saveComposerDraft('A', { html: '<b>甲</b>', attachments: [], attOpen: false })
    saveComposerDraft('B', { html: '乙', attachments: [], attOpen: true })
    expect(readComposerDraft('A').html).toBe('<b>甲</b>')
    expect(readComposerDraft('B').html).toBe('乙')
    expect(readComposerDraft('B').attOpen).toBe(true)
    expect(composerDraftKeys()).toEqual(['A', 'B'])
  })

  it('没存过的会话读到一份空稿(调用方不必判 undefined)', () => {
    expect(readComposerDraft('从来没有过')).toBe(EMPTY_DRAFT)
    expect(readComposerDraft('从来没有过').html).toBe('')
  })

  /**
   * `''` = 「还没绑会话」那一态。它照样是一格合法的键 —— 首开草稿态里打的那些字
   * 要留得住(建会话是那之后才发生的事)。
   * **反证**:把 `saveComposerDraft` 里换成 `if (!sessionId) return` → 这一条当场红。
   */
  it('空串是一格合法的键(首开草稿态那些字要留得住)', () => {
    saveComposerDraft('', { html: '还没建会话就打的字', attachments: [], attOpen: false })
    expect(readComposerDraft('').html).toBe('还没建会话就打的字')
    expect(composerDraftKeys()).toEqual([''])
  })
})

describe('草稿表:空稿等于删掉', () => {
  it('打完字又清空 → 表里不留一具空壳', () => {
    saveComposerDraft('A', { html: '甲', attachments: [], attOpen: false })
    expect(composerDraftKeys()).toEqual(['A'])
    saveComposerDraft('A', { html: '   ', attachments: [], attOpen: false })
    expect(composerDraftKeys()).toEqual([])
  })

  /**
   * 「空」只看**字与附件**,不看摞开着没有:一格空稿加一个展开着的空摞仍旧是空稿。
   * **反证**:把 `isEmpty` 里加上 `&& !draft.attOpen` → 这一条当场红。
   */
  it('只有附件、没有字 → 不是空稿(附件也是没发出去的东西)', () => {
    saveComposerDraft('A', { html: '', attachments: [att('blob:1')], attOpen: true })
    expect(composerDraftKeys()).toEqual(['A'])
  })
})

describe('草稿表:谁造谁销', () => {
  it('丢一份稿 → 挂在它上面的对象 URL 跟着销', () => {
    saveComposerDraft('A', {
      html: '甲',
      attachments: [att('blob:1'), att('blob:2')],
      attOpen: false,
    })
    dropComposerDraft('A')
    expect(revoked).toEqual(['blob:1', 'blob:2'])
    expect(composerDraftKeys()).toEqual([])
  })

  it('被空稿顶掉的那一份也销(空稿等于删掉,走的是同一只口)', () => {
    saveComposerDraft('A', { html: '甲', attachments: [att('blob:3')], attOpen: false })
    saveComposerDraft('A', { html: '', attachments: [], attOpen: false })
    expect(revoked).toEqual(['blob:3'])
  })

  /**
   * 整台壳重置(`resetComposerStore`)要把各条会话那几份稿一起收掉 —— 不然重置完
   * 屏幕是干净的,一切回上一条会话稿又冒出来了。
   * **反证**:把 `resetComposerStore` 里那句 `resetComposerDrafts()` 删掉 →
   * `store.test` 那边看不出来,而这一条读的是同一只口。
   */
  it('整张表清空:每一份都走同一只丢弃口(URL 一个不漏)', () => {
    saveComposerDraft('A', { html: '甲', attachments: [att('blob:a')], attOpen: false })
    saveComposerDraft('B', { html: '乙', attachments: [att('blob:b')], attOpen: false })
    resetComposerDrafts()
    expect(revoked.sort()).toEqual(['blob:a', 'blob:b'])
    expect(composerDraftKeys()).toEqual([])
  })
})
