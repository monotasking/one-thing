// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../useMarkdownRenderer'

describe('useMarkdownRenderer', () => {
  it('escapes raw html for document markdown by default', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">', false, { surface: 'document' })

    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img src=x')
  })

  it('renders code copy button hosts without inline handlers', () => {
    const html = renderMarkdown('```ts\nconst value = 1\n```', false, { surface: 'document' })

    expect(html).toContain('class="code-block-copy-host"')
    expect(html).toContain('data-code=')
    expect(html).not.toContain(['<', 'button'].join(''))
    expect(html).not.toContain('onclick=')
  })

  it('renders emoji shortcodes in document text', () => {
    const html = renderMarkdown('Ship it :rocket: :sparkles:', false, { surface: 'document' })

    expect(html).toContain('🚀')
    expect(html).toContain('✨')
    expect(html).not.toContain(':rocket:')
  })

  it('keeps emoji shortcodes literal inside inline code', () => {
    const html = renderMarkdown('`:rocket:`', false, { surface: 'document' })

    expect(html).toContain(':rocket:')
    expect(html).not.toContain('🚀')
  })

  it('rewrites sandbox: image sources to file:// URLs', () => {
    const html = renderMarkdown('![cat](<sandbox:/Users/me/cute cat.png>)', false, { surface: 'document' })

    expect(html).toContain('src="file:///Users/me/cute%20cat.png"')
    expect(html).not.toContain('sandbox:')
  })

  it('rewrites bare absolute-path image sources to file:// URLs', () => {
    const html = renderMarkdown('![shot](/Users/me/pic.png)', false, { surface: 'document' })

    expect(html).toContain('src="file:///Users/me/pic.png"')
  })

  it('leaves remote and media image sources untouched', () => {
    const remote = renderMarkdown('![web](https://example.com/a.png)', false, { surface: 'document' })
    const media = renderMarkdown('![Generated Image|mediaId:abc](media://abc.png)', false, { surface: 'document' })

    expect(remote).toContain('src="https://example.com/a.png"')
    expect(media).toContain('src="media://abc.png"')
  })
})

// docs/design/message-references-2026-08.md §4
describe('message references', () => {
  it('stamps a file link and drops its navigable href', () => {
    const html = renderMarkdown('[a](/repo/src/a.ts:12)', false, { surface: 'document' })

    expect(html).toContain('class="msg-ref msg-ref--file"')
    expect(html).toContain('data-ref-kind="file"')
    expect(html).toContain('&quot;path&quot;:&quot;/repo/src/a.ts&quot;')
    expect(html).toContain('&quot;line&quot;:12')
    expect(html).toContain('href="#"')
    expect(html).not.toContain('href="/repo/src/a.ts')
  })

  it('renders file: links at all (markdown-it rejects them by default)', () => {
    const html = renderMarkdown('[a](file:///repo/a.ts#L7)', false, { surface: 'document' })

    expect(html).toContain('data-ref-kind="file"')
    expect(html).toContain('&quot;line&quot;:7')
  })

  it('keeps the real href on url links but marks them', () => {
    const html = renderMarkdown('[docs](https://example.com/a)', false, { surface: 'document' })

    expect(html).toContain('href="https://example.com/a"')
    expect(html).toContain('msg-ref--url')
    expect(html).toContain('data-ref-kind="url"')
  })

  it('marks other schemes as external', () => {
    const html = renderMarkdown('[mail](mailto:a@b.com)', false, { surface: 'document' })

    expect(html).toContain('msg-ref--external')
    expect(html).toContain('href="mailto:a@b.com"')
  })

  it('wraps a whole-path inline code span without splitting the code text', () => {
    const html = renderMarkdown('见 `/repo/src/a.ts:12`', false, { surface: 'document' })

    expect(html).toContain('<a class="msg-ref msg-ref--file" href="#"')
    expect(html).toContain('<code class="inline-code">/repo/src/a.ts:12</code>')
  })

  it('leaves ordinary inline code alone', () => {
    const html = renderMarkdown('`const x = 1` 和 `npm`', false, { surface: 'document' })

    expect(html).not.toContain('msg-ref')
  })

  it('still refuses javascript:, vbscript: and non-image data: links', () => {
    const js = renderMarkdown('[x](javascript:alert(1))', false, { surface: 'document' })
    const vb = renderMarkdown('[x](vbscript:msgbox)', false, { surface: 'document' })
    const data = renderMarkdown('[x](data:text/html,<b>1</b>)', false, { surface: 'document' })

    for (const html of [js, vb, data]) {
      expect(html).not.toContain('<a ')
      expect(html).not.toContain('msg-ref')
    }
  })

  // StreamingMarkdown 的分段各自调 renderMarkdown,只是换了一个 cache key
  // (math 开关);规则由同一个工厂装上,所以流式段落也有引用。
  it('streaming segments get the same rules', () => {
    const html = renderMarkdown('见 `/repo/a.ts:3`', false, { surface: 'streaming' })

    expect(html).toContain('msg-ref--file')
    expect(html).toContain('&quot;line&quot;:3')
  })

  it('linkified bare URLs go through the same classifier', () => {
    const html = renderMarkdown('see https://example.com/a', false, { surface: 'document' })

    expect(html).toContain('data-ref-kind="url"')
  })
})
