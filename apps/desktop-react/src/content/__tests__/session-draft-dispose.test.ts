import { afterEach, describe, expect, it } from 'vitest'
import { composerDraftKeys, resetComposerDrafts, saveComposerDraft } from '../../composer/drafts'
import { contentKindOf } from '../../workbench/kinds'
import { NEW_SESSION_KEY, SESSION_KIND, sessionRefOf } from '../session-ref'
import '../kinds'

/**
 * **关掉一格会话 = 丢掉它那份稿**(W7-t / B2 的丢弃时机;09-06 审查逮到的那笔账)。
 *
 * `sessionIdOfRef` 有**两种「没有会话 id」**,它们从来不是一件事(判词在
 * `content/session-ref.ts`):`null` = 「这一格根本不是会话」,`''` = 「是会话叶,
 * 但还没绑会话」——后者是首开那一格,它的稿(还没发的话、挂着的附件)照样得有
 * 主人。修前 `ContentKind.dispose` 里写的是 `if (id)`,把 `''` 当成了缺席,于是
 * **关掉「新会话」那一格永远丢不掉它的稿**,连同挂在附件上的对象 URL。
 *
 * 这一组因此只钉两句:绑了会话的那一格按会话 id 丢;没绑的那一格按空串丢。
 */
describe('会话那一种:关掉 = 丢掉它那份稿', () => {
  afterEach(() => resetComposerDrafts())

  it('绑了会话的那一格:按会话 id 丢', () => {
    saveComposerDraft('s-1', { html: '<p>还没发的话</p>', attachments: [], attOpen: false })
    contentKindOf(SESSION_KIND)?.dispose?.(sessionRefOf('s-1'))
    expect(composerDraftKeys()).not.toContain('s-1')
  })

  it('还没绑会话的那一格(保留键 `new`):空串是一格键,不是缺席', () => {
    saveComposerDraft('', { html: '<p>首开就打的字</p>', attachments: [], attOpen: false })
    expect(composerDraftKeys()).toContain('')
    /*
     * **反证**:把 `content/kinds/session.tsx` 的 `dispose` 换回 `if (id)` →
     * 下面这一句红(表里那份稿永远留着,下一次开「新会话」读到的是一份陈年的稿)。
     */
    contentKindOf(SESSION_KIND)?.dispose?.({ kind: SESSION_KIND, key: NEW_SESSION_KEY })
    expect(composerDraftKeys()).not.toContain('')
  })
})
