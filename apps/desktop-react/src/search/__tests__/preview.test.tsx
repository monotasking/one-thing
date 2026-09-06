import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  previewRendererKinds,
  registerPreviewRenderer,
  resolvePreviewRenderer,
} from '../preview'
import { messageContextPayloadOf } from '../preview/kinds/message-context'
import { sessionOverviewPayloadOf } from '../preview/kinds/session-overview'
import { noteExcerptPayloadOf } from '../preview/kinds/note-excerpt'
import { fileExcerptPayloadOf } from '../preview/kinds/file-excerpt'
import { compositePayloadOf } from '../preview/kinds/composite'

/**
 * 预览渲染注册表(检索重建 S4b,设计 §4.5 ②)。
 *
 * 与目标渲染注册表逐条同款的三条判据:重复注册抛 / 注册只在 barrel /
 * **查不到不是错误**(画 Row 放大版 + dev warn 一次)。外加各渲染器那道
 * 「**验而不信**」的载荷校验 —— 插件能力也在同一张注册表上。
 */

describe('注册表', () => {
  it('barrel 一 import 就有五种 —— 「这台上画得出哪几种预览」一眼看全', () => {
    expect(previewRendererKinds().sort()).toEqual(
      ['composite', 'file-excerpt', 'message-context', 'note-excerpt', 'session-overview'],
    )
  })

  it('重复注册 = 抛错,不静默覆盖', () => {
    expect(() => registerPreviewRenderer({
      kind: 'composite',
      Body: () => null,
    })).toThrow('search preview renderer already registered: composite')
  })

  it('注销只删自己那一条 —— 晚到的注销不许把后来那个同名的顺手删掉', () => {
    const first = { kind: 'tmp-preview', Body: () => null }
    const dispose = registerPreviewRenderer(first)
    dispose()
    const second = { kind: 'tmp-preview', Body: () => null }
    const disposeSecond = registerPreviewRenderer(second)
    dispose()
    expect(resolvePreviewRenderer('tmp-preview')).toBe(second)
    disposeSecond()
  })

  /** §11 S4 的反证形:摘一种预览渲染器 → 那一类画 Row 放大版并 warn。 */
  it('查不到不是错误:答 undefined 并 warn 一次(同一种 kind 不刷屏)', async () => {
    const { dumpLog } = await import('../../services/log')
    const before = dumpLog().length
    expect(resolvePreviewRenderer('从来没注册过的媒介')).toBeUndefined()
    expect(resolvePreviewRenderer('从来没注册过的媒介')).toBeUndefined()
    const added = dumpLog().slice(before).filter(r => r.ns === 'search.preview')
    expect(added.length).toBe(1)
    expect(added[0].level).toBe('warn')
  })

  /**
   * §4.5 那张表里今天没有产地的媒介(text / code / image / diff …)**故意不注册**。
   * 这一条钉的正是那个决定:先注册一个没有产地的渲染器,等于替将来的能力作者
   * 先把「这一类长什么样」拍了板。
   */
  it('没有产地的媒介一个都没注册 —— 缺席时的行为已经是对的', () => {
    for (const kind of ['text', 'markdown', 'code', 'image', 'diff', 'pdf']) {
      expect(resolvePreviewRenderer(kind)).toBeUndefined()
    }
  })
})

describe('载荷校验:验而不信', () => {
  it('message-context:缺 hit 就是不认;上下文里形不对的那几条被挑掉', () => {
    expect(messageContextPayloadOf(null)).toBeUndefined()
    expect(messageContextPayloadOf({ before: [], after: [] })).toBeUndefined()
    const ok = messageContextPayloadOf({
      sessionId: 's1',
      messageId: 'm1',
      hit: { id: 'm1', role: 'assistant', text: '命中' },
      before: [{ id: 'm0', role: 'user', text: '上一条' }, { 坏的: 1 }],
      after: 'not-an-array',
    })
    expect(ok?.before.map(m => m.id)).toEqual(['m0'])
    expect(ok?.after).toEqual([])
  })

  it('session-overview:缺 sessionId 就是不认;别的格缺了用中性值', () => {
    expect(sessionOverviewPayloadOf({})).toBeUndefined()
    expect(sessionOverviewPayloadOf({ sessionId: 's1' })).toEqual({
      sessionId: 's1', title: '', messageCount: 0, updatedAt: 0, preview: '',
    })
  })

  it('note-excerpt:缺 excerpt 就是不认', () => {
    expect(noteExcerptPayloadOf({ path: '/a' })).toBeUndefined()
    expect(noteExcerptPayloadOf({ excerpt: '一段' })?.excerpt).toBe('一段')
  })

  it('file-excerpt:只有路径,空路径不认', () => {
    expect(fileExcerptPayloadOf({ path: '' })).toBeUndefined()
    expect(fileExcerptPayloadOf({ path: '/a/b.ts' })).toEqual({ path: '/a/b.ts' })
  })

  it('composite:layout 认不得的按 grid 画(更保守的一档);形不对的格被挑掉', () => {
    expect(compositePayloadOf({ items: 'x' })).toBeUndefined()
    const ok = compositePayloadOf({
      layout: '外星布局',
      items: [{ kind: 'note-excerpt', payload: {} }, null, { 别的键: 1 }],
      summary: { total: 3, shown: 1, kinds: ['note-excerpt'] },
    })
    expect(ok?.layout).toBe('grid')
    expect(ok?.items).toHaveLength(1)
    expect(ok?.summary).toEqual({ total: 3, shown: 1, kinds: ['note-excerpt'] })
  })
})

describe('composite:每一格再交回注册表', () => {
  it('缺渲染器**只塌那一格**,别的格照画', () => {
    const renderer = resolvePreviewRenderer('composite')!
    render(
      <renderer.Body
        query=""
        payload={{
          layout: 'side-by-side',
          items: [
            { kind: 'note-excerpt', payload: { excerpt: '看得见的那一段' } },
            { kind: '外星媒介', payload: {} },
          ],
        }}
      />,
    )
    expect(screen.getByText('看得见的那一段')).toBeTruthy()
    expect(screen.getByText(/外星媒介/)).toBeTruthy()
  })
})

describe('message-context:命中那条与上下文分得出来', () => {
  it('命中那条带 data-preview-turn="hit",上下文是 "context"', () => {
    const renderer = resolvePreviewRenderer('message-context')!
    const { container } = render(
      <renderer.Body
        query=""
        payload={{
          sessionId: 's1',
          messageId: 'm1',
          hit: { id: 'm1', role: 'assistant', text: '命中' },
          before: [{ id: 'm0', role: 'user', text: '前一条' }],
          after: [],
        }}
      />,
    )
    const turns = [...container.querySelectorAll('[data-preview-turn]')]
      .map(el => el.getAttribute('data-preview-turn'))
    expect(turns).toEqual(['context', 'hit'])
  })
})

/**
 * **R6:预览檐标题只出现一次**(09-05 用户报障「预览标题两遍」)。
 *
 * 标题的产地是**檐**(`SearchPreview` 的 `.previewTitle`),渲染器的 `Body` 一个字
 * 都不许再画一遍 —— 从前 `session-overview` 与 `note-excerpt` 各画了第二次,于是
 * 屏幕上同一句话上下叠两行。判据钉在这里,而不是靠下一个作者记得。
 */
describe('R6:Body 不含 title', () => {
  it('session-overview 的 Body 里没有标题(檐已经画过了)', () => {
    const renderer = resolvePreviewRenderer('session-overview')!
    const { container } = render(
      <renderer.Body
        query=""
        payload={{
          sessionId: 's1',
          title: '一间会话的标题',
          messageCount: 7,
          updatedAt: 1,
          preview: '首条',
        }}
      />,
    )
    expect(container.textContent).not.toContain('一间会话的标题')
    // 事实那几格照画 —— 删掉的只有标题那一行。
    expect(container.querySelector('[data-fact="count"]')?.textContent).toBe('7')
  })

  it('note-excerpt 的 Body 里没有标题', () => {
    const renderer = resolvePreviewRenderer('note-excerpt')!
    const { container } = render(
      <renderer.Body
        query=""
        payload={{ path: 'notes/a.md', title: '一篇笔记的标题', excerpt: '正文那一段' }}
      />,
    )
    expect(container.textContent).not.toContain('一篇笔记的标题')
    expect(container.querySelector('[data-fact="path"]')?.textContent).toBe('notes/a.md')
  })
})
