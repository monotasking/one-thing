// @vitest-environment happy-dom
/**
 * 来源行(P4-3)。守两件事:
 *
 *  1. **认得的只有 citations**。`provider-data` 是一格公用袋子,codex 的
 *     `encrypted-reasoning`、openrouter 的 `reasoning-details` 走的是同一格 —— 它们
 *     一个字都不该出现在屏幕上。判据在契约层的 `isProviderCitations`,这里验的是
 *     渲染侧确实只信那一个判据。
 *  2. **多回合合成一行**。一个回合一条 citations part,合并去重发生在
 *     `collectMessageCitations`,模板永远只画一行。
 */
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import MessageBubble from '../MessageBubble.vue'
import { citationLabel, collectMessageCitations } from '../citations'
import type { ContentPart } from '@/types'

const platformApiMock = vi.hoisted(() => ({
  openImagePreview: vi.fn(),
  openImageGallery: vi.fn(),
}))

const openReferenceMock = vi.hoisted(() =>
  vi.fn((_ref: unknown, _modifiers?: unknown) => Promise.resolve({ ok: true as const })),
)

vi.mock('@/platform', () => ({ platformApi: platformApiMock }))
vi.mock('@/platform/media-window-client', () => ({
  mediaWindowApi: {
    openPreview: (request: unknown) => platformApiMock.openImagePreview(request),
    openGallery: (request: unknown) => platformApiMock.openImageGallery(request),
  },
}))
vi.mock('@/references', () => ({ openReference: openReferenceMock }))

const stubs = {
  StreamingMarkdown: { props: ['content'], template: '<div class="md">{{ content }}</div>' },
  StaticMarkdown: { props: ['content'], template: '<div class="md">{{ content }}</div>' },
  StepsPanel: { template: '<div />' },
  TextEditor: { template: '<textarea />' },
}

function installLocalStorage() {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
    removeItem: vi.fn((key: string) => { values.delete(key) }),
    clear: vi.fn(() => { values.clear() }),
  })
}

function citationsPart(citations: unknown[], turnIndex = 0): ContentPart {
  return {
    type: 'provider-data',
    providerData: { provider: 'grok', type: 'citations', citations },
    turnIndex,
  } as ContentPart
}

function renderBubble(contentParts: ContentPart[]) {
  return mount(MessageBubble, {
    props: { role: 'assistant', content: '答案在这', contentParts },
    global: { stubs },
  })
}

describe('collectMessageCitations', () => {
  it('多条 citations part 合成一份清单,按首次出现去重', () => {
    const collected = collectMessageCitations([
      { type: 'text', content: '先说一句' },
      citationsPart(['https://b.example/x', 'https://a.example/y'], 0),
      { type: 'text', content: '再说一句' },
      citationsPart(['https://a.example/y', 'https://c.example/z'], 1),
    ])
    expect(collected.map(c => c.url)).toEqual([
      'https://b.example/x',
      'https://a.example/y',
      'https://c.example/z',
    ])
  })

  it('空白项被丢掉;没有 part / 没有 citations 时是空清单', () => {
    expect(collectMessageCitations(undefined)).toEqual([])
    expect(collectMessageCitations([])).toEqual([])
    expect(collectMessageCitations([{ type: 'text', content: 'x' }])).toEqual([])
    expect(collectMessageCitations([citationsPart(['  ', ''])])).toEqual([])
    // 前后空白只影响去重的口径,URL 本身按 trim 后的算。
    expect(collectMessageCitations([citationsPart([' https://a.example '])])[0].url)
      .toBe('https://a.example')
  })

  it('别的 provider-data 一条都不认', () => {
    const others: ContentPart[] = [
      { type: 'provider-data', provider: 'codex', encryptedReasoning: 'AAAA' } as ContentPart,
      {
        type: 'provider-data',
        providerData: { provider: 'codex', type: 'encrypted-reasoning', encryptedContent: 'AAAA' },
      } as ContentPart,
      {
        type: 'provider-data',
        providerData: { provider: 'openrouter', type: 'reasoning-details', details: [{ text: 'x' }] },
      } as ContentPart,
      // 形状不对的 citations(不是字符串数组)也不认 —— 守卫在契约层,不在这里补。
      citationsPart([42, null]),
      { type: 'provider-data', providerData: { type: 'citations', citations: 'nope' } } as ContentPart,
    ]
    expect(collectMessageCitations(others)).toEqual([])
  })
})

describe('citationLabel', () => {
  it('域名优先,去掉 www.', () => {
    expect(citationLabel('https://www.nytimes.com/2026/08/x.html')).toBe('nytimes.com')
    expect(citationLabel('http://arxiv.org/abs/1234')).toBe('arxiv.org')
  })

  it('解析不出主机名就截短原文', () => {
    expect(citationLabel('not a url')).toBe('not a url')
    const long = `not-a-url-${'x'.repeat(80)}`
    const label = citationLabel(long)
    expect(label.endsWith('…')).toBe(true)
    expect(label.length).toBeLessThan(long.length)
  })
})

describe('MessageBubble 的来源行', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    installLocalStorage()
    openReferenceMock.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('有 citations → 尾部一行去重后的链接,标签是域名、hover 全链接', () => {
    const wrapper = renderBubble([
      { type: 'text', content: '答案在这' },
      citationsPart(['https://www.a.example/one', 'https://b.example/two'], 0),
      citationsPart(['https://www.a.example/one'], 1),
    ])

    const row = wrapper.find('.citations')
    expect(row.exists()).toBe(true)

    const links = row.findAll('a.citation-link')
    expect(links.map(l => l.text())).toEqual(['a.example', 'b.example'])
    // 全链接走 Tooltip(title= 被 ui-gate 禁),锚点上不该有 title。
    expect(links.every(l => l.attributes('title') === undefined)).toBe(true)
    // href 是 `#` —— 默认导航由点击处理器同步拦掉,和消息引用同一条约定。
    expect(links.map(l => l.attributes('href'))).toEqual(['#', '#'])
  })

  it('点击走 openReference 的 url 分支,不是 window.open', async () => {
    const wrapper = renderBubble([citationsPart(['https://a.example/one'])])
    await wrapper.find('a.citation-link').trigger('click')

    expect(openReferenceMock).toHaveBeenCalledTimes(1)
    expect(openReferenceMock.mock.calls[0][0]).toEqual({
      kind: 'url',
      url: 'https://a.example/one',
      raw: 'https://a.example/one',
    })
  })

  it('没有 citations → 整行不存在', () => {
    expect(renderBubble([{ type: 'text', content: '答案在这' }]).find('.citations').exists())
      .toBe(false)
  })

  it('encrypted-reasoning / reasoning-details 什么都不画', () => {
    const wrapper = renderBubble([
      { type: 'text', content: '答案在这' },
      {
        type: 'provider-data',
        providerData: { provider: 'codex', type: 'encrypted-reasoning', encryptedContent: 'AAAA' },
      } as ContentPart,
      {
        type: 'provider-data',
        providerData: { provider: 'openrouter', type: 'reasoning-details', details: [{ text: '想了想' }] },
      } as ContentPart,
    ])
    expect(wrapper.find('.citations').exists()).toBe(false)
    expect(wrapper.html()).not.toContain('AAAA')
    expect(wrapper.html()).not.toContain('想了想')
  })
})
