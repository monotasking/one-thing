import { copyTextToClipboard } from '@/utils/clipboard'
import { perfMark, perfMeasure } from '@/utils/perf'
import {
  collabInlineTagPlugin,
  ensureCollabTagHandler,
  replaceCollabMentionMarkers,
} from '@/composables/collabInlineTags'
import { normalizeStatusEmoji, replaceEmojiShortcodes } from '@/editor/markdown-emoji'
import { createDomButton, unmountDomButtons } from '@/components/common/dom-button'
import { wholePathReference } from '@/references/autolink'
import { installReferenceClickHandler } from '@/references/dom'
import { parseReference } from '@/references/parse'
import type { MarkdownRenderOptions } from '@/editor/markdown-document'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import mathjax3 from 'markdown-it-mathjax3'

interface MarkdownRendererConfig {
  enableMath: boolean
  allowHtml: boolean
}

const markdownRendererCache = new Map<string, MarkdownIt>()
let codeCopyHandlerInstalled = false
let codeCopyObserver: MutationObserver | null = null

function createMarkdownRenderer(config: MarkdownRendererConfig) {
  const instance = new MarkdownIt({
    html: config.allowHtml,
    breaks: true,
    linkify: true,
    typographer: true,
  })

  if (config.enableMath) {
    // Supports $...$ for inline math and $$...$$ for block math.
    instance.use(mathjax3)
  }

  // 群聊行内标签(collab-team-v2 §6.1)。规则常开而非按面区分:它渲染出来的
  // 是一枚中性 span,验真在挂载期做、永不进 HTML 缓存,所以非群聊消息里误写
  // 一个 <card id="…"/> 顶多显示成一段点不动的短 id。
  instance.use(collabInlineTagPlugin)

  // 消息引用(docs/design/message-references-2026-08.md §4.1)。markdown-it 默认
  // 把 `file:` 打进坏 scheme 名单,于是 `[x](file:///a)` 今天连锚点都渲染不出来;
  // 裸 `/abs/path` 本来就放行。这里只把 `file:` 放回来,javascript / vbscript /
  // 非图片 data: 三条拒绝一字不动。
  instance.validateLink = validateReferenceLink

  // §4.2:分类 + 打标。`file` 类的 href 改写成 `#` —— 一个真 `file://` 锚点会被
  // 主进程的 `isElectronRendererWindowUrl` 当成 app URL,中键/拖拽就能把整个渲染
  // 器导航走。原始 target 只留在 data-ref 里。
  const defaultLinkOpen = instance.renderer.rules.link_open
  instance.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const href = token.attrGet('href')
    const ref = href ? parseReference(href) : null
    if (ref) {
      token.attrJoin('class', `msg-ref msg-ref--${ref.kind}`)
      token.attrSet('data-ref-kind', ref.kind)
      token.attrSet('data-ref', JSON.stringify(ref))
      if (ref.kind === 'file') token.attrSet('href', '#')
    }
    return defaultLinkOpen
      ? defaultLinkOpen(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options)
  }

  instance.renderer.rules.text = (tokens, idx) => {
    return instance.utils.escapeHtml(normalizeStatusEmoji(replaceEmojiShortcodes(tokens[idx].content)))
  }

  // Tables render inside a dedicated scroll wrapper so the table itself can
  // stay `display: table; width: 100%`. Making the table element the scroll
  // container (display:block) splits it into two boxes of different widths —
  // full-width block vs content-width rows — and no horizontal rule can span
  // both consistently.
  instance.renderer.rules.table_open = () => '<div class="md-table-scroll">\n<table>\n'
  instance.renderer.rules.table_close = () => '</table>\n</div>\n'

  // Numeric table cells must never wrap: a phone number broken across lines
  // reads as two different numbers. Marking them here (instead of a blanket
  // no-wrap on all cells) keeps prose columns free to wrap normally.
  instance.core.ruler.push('numeric_cells', (state) => {
    const tokens = state.tokens
    for (let i = 0; i < tokens.length - 1; i++) {
      const token = tokens[i]
      if (token.type !== 'td_open' && token.type !== 'th_open') continue
      const inline = tokens[i + 1]
      if (inline?.type !== 'inline') continue
      const content = inline.content.trim()
      if (content && /^[\d\s.,+\-—–/:%()]+$/.test(content)) {
        token.attrJoin('class', 'md-cell-numeric')
      }
    }
    return true
  })

  // Custom fence (code block) renderer
  instance.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx]
    const code = token.content
    const rawLang = token.info.trim().split(/\s+/)[0] || 'text'
    const lang = sanitizeCodeLanguage(rawLang)
    const langLabel = instance.utils.escapeHtml(rawLang || 'text')
    let highlighted: string
    if (rawLang && hljs.getLanguage(rawLang)) {
      try {
        highlighted = hljs.highlight(code, { language: rawLang, ignoreIllegals: true }).value
      } catch (e) {
        console.error('Highlight error:', e)
        highlighted = instance.utils.escapeHtml(code)
      }
    } else {
      highlighted = instance.utils.escapeHtml(code)
    }

    return `<div class="code-block-container">
    <div class="code-block-header">
      <div class="code-block-lang">${langLabel}</div>
      <span class="code-block-copy-host" data-code="${escapeHtmlAttribute(encodeURIComponent(code))}"></span>
    </div>
    <pre><code class="hljs language-${lang}">${highlighted}</code></pre>
  </div>`
  }

  // Custom inline code renderer.
  // §4.3:整段就是一条路径时,在 <code> **外面**包一层锚点。不拆 code 内的文本 ——
  // 拆了高亮、复制、say 折叠的行数统计都要跟着乱。
  instance.renderer.rules.code_inline = (tokens, idx) => {
    const token = tokens[idx]
    const code = `<code class="inline-code">${instance.utils.escapeHtml(token.content)}</code>`
    const ref = wholePathReference(token.content)
    if (!ref) return code
    return `<a class="msg-ref msg-ref--file" href="#" data-ref-kind="file" data-ref="${escapeHtmlAttribute(JSON.stringify(ref))}">${code}</a>`
  }

  // Normalize model-emitted local image paths (sandbox: scheme, bare absolute
  // paths) into file:// URLs the CSP allows; runs after link validation, so
  // the rewritten URL is rendered as-is.
  const defaultImageRule = instance.renderer.rules.image
  instance.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const src = token.attrGet('src')
    if (src) {
      const normalized = normalizeLocalImageSrc(src)
      if (normalized !== src) token.attrSet('src', normalized)
    }
    return defaultImageRule
      ? defaultImageRule(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options)
  }

  return instance
}

/**
 * Rewrite local-file image sources into loadable file:// URLs.
 * Models imitate OpenAI's code-interpreter convention and emit
 * `sandbox:/abs/path` (or a bare absolute path) for files on disk;
 * neither scheme is loadable in the renderer.
 */
export function normalizeLocalImageSrc(src: string): string {
  // src arrives percent-encoded from markdown-it's normalizeLink; do not re-encode.
  const sandboxMatch = /^sandbox:(?:\/\/)?(.+)$/i.exec(src)
  if (sandboxMatch) {
    const path = sandboxMatch[1].startsWith('/') ? sandboxMatch[1] : `/${sandboxMatch[1]}`
    return `file://${path}`
  }
  if (src.startsWith('/') && !src.startsWith('//')) {
    return `file://${src}`
  }
  return src
}

function getMarkdownRenderer(config: MarkdownRendererConfig): MarkdownIt {
  const key = `${config.enableMath}:${config.allowHtml}`
  const existing = markdownRendererCache.get(key)
  if (existing) return existing
  const instance = createMarkdownRenderer(config)
  markdownRendererCache.set(key, instance)
  return instance
}

function sanitizeCodeLanguage(lang: string): string {
  return (lang || 'text').replace(/[^\w-]/g, '-') || 'text'
}

/**
 * markdown-it 默认 `validateLink` 的复刻,只少了 `file:` 一项。
 * 拒绝面必须逐字保持:javascript / vbscript 一律拒,`data:` 只放行四种图片。
 */
const REFERENCE_BAD_PROTO_RE = /^(vbscript|javascript|data):/
const REFERENCE_GOOD_DATA_RE = /^data:image\/(gif|png|jpeg|webp);/

export function validateReferenceLink(url: string): boolean {
  const str = url.trim().toLowerCase()
  return REFERENCE_BAD_PROTO_RE.test(str) ? REFERENCE_GOOD_DATA_RE.test(str) : true
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 群聊 say 里的代码块折叠(im-message 设计稿 §F)。
 *
 * 只在 `.md-say-scope` 里生效:主会话是"读代码的地方",群聊流是"读对话的
 * 地方",一段 40 行的脚本在群里顶三屏就把对话冲没了。阈值以行数判,行数写在
 * 展开条上 —— 折叠必须告诉人被折了多少,否则它是隐藏而不是收纳。
 */
export const SAY_CODE_CLAMP_LINES = 11

export function applySayCodeClamp(root: ParentNode): void {
  const containers = new Set<HTMLElement>()
  const collect = (element: Element | null) => {
    if (element instanceof HTMLElement) containers.add(element)
  }
  if (root instanceof Element && root.closest('.md-say-scope')) {
    if (root.classList.contains('code-block-container')) collect(root)
    root.querySelectorAll<HTMLElement>('.code-block-container').forEach(collect)
  }
  root.querySelectorAll<HTMLElement>('.md-say-scope .code-block-container').forEach(collect)

  containers.forEach((container) => {
    if (container.dataset.sayClamp) return
    const code = container.querySelector('pre > code')
    if (!code) return
    const lines = (code.textContent ?? '').replace(/\n$/, '').split('\n').length
    if (lines <= SAY_CODE_CLAMP_LINES) {
      container.dataset.sayClamp = 'short'
      return
    }
    container.dataset.sayClamp = 'clamped'
    container.classList.add('is-say-clamped')
    const fade = document.createElement('div')
    fade.className = 'say-code-fade'
    fade.setAttribute('aria-hidden', 'true')
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'say-code-more'
    more.dataset.sayCodeLines = String(lines)
    more.textContent = `展开 ${lines} 行 ▾`
    container.append(fade, more)
  })
}

function toggleSayCodeClamp(button: HTMLElement): void {
  const container = button.closest('.code-block-container') as HTMLElement | null
  if (!container) return
  const expanded = container.classList.toggle('is-say-clamped')
  const lines = button.dataset.sayCodeLines ?? ''
  button.textContent = expanded ? `展开 ${lines} 行 ▾` : '收起 ▴'
}

function ensureCodeCopyHandler(): void {
  if (codeCopyHandlerInstalled || typeof document === 'undefined') return
  codeCopyHandlerInstalled = true
  mountCodeCopyButtons(document)
  applySayCodeClamp(document)

  if (typeof MutationObserver !== 'undefined') {
    codeCopyObserver = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => {
          if (node instanceof Element) {
            mountCodeCopyButtons(node)
            applySayCodeClamp(node)
          }
        })
        record.removedNodes.forEach((node) => {
          if (node instanceof Element) unmountDomButtons(node)
        })
      }
    })
    codeCopyObserver.observe(document.body, { childList: true, subtree: true })
  }

  document.addEventListener('click', (event) => {
    const target = event.target as Element | null
    const more = target?.closest?.('.say-code-more') as HTMLElement | null
    if (!more) return
    event.preventDefault()
    toggleSayCodeClamp(more)
  })

  document.addEventListener('click', async (event) => {
    const target = event.target as Element | null
    const button = target?.closest?.('.code-block-copy[data-code]') as HTMLButtonElement | null
    if (!button) return
    const encoded = button.getAttribute('data-code') || ''
    const copied = await copyTextToClipboard(decodeURIComponent(encoded))
    if (!copied) {
      console.warn('Failed to copy code block')
      return
    }

    button.classList.add('copied')
    window.setTimeout(() => button.classList.remove('copied'), 1500)
  })
}

function mountCodeCopyButtons(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('.code-block-copy-host[data-code]').forEach((host) => {
    if (host.dataset.mountedCodeCopy === 'true') return
    const encoded = host.getAttribute('data-code') || ''
    const mounted = createDomButton({
      className: 'code-block-copy',
      title: 'Copy',
      ariaLabel: 'Copy code',
      attrs: {
        'data-code': encoded,
      },
    })
    mounted.button.innerHTML = codeCopyIconMarkup()
    host.dataset.mountedCodeCopy = 'true'
    host.append(mounted.host)
  })
}

function codeCopyIconMarkup(): string {
  return [
    '<svg class="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    '<svg class="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>',
  ].join('')
}

/**
 * Install the once-only DOM handlers rendered markdown depends on: the code
 * copy buttons, the say-scope code clamp, and the collab tag / mention
 * promotion observers.
 *
 * Exported because a **cache hit renders no markdown**: StaticMarkdown returns
 * stored HTML without calling `renderMarkdown`, and a session where every
 * message is cached would otherwise mount DOM that nothing ever observes —
 * dead copy buttons, unpromoted mentions, unclamped code.
 */
export function ensureMarkdownDomHandlers(): void {
  ensureCodeCopyHandler()
  ensureCollabTagHandler()
  installReferenceClickHandler()
}

/**
 * Escape HTML special characters
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

/**
 * The user's own messages never go through markdown-it — they are escaped and
 * injected verbatim. @mention pills still have to appear there (the user is
 * the one doing most of the @-ing), so the mention markers are substituted
 * AFTER escaping, by the same builder the markdown-it rule uses. One pill
 * shape, two surfaces.
 */
export function renderPlainTextWithMentions(content: string): string {
  return replaceCollabMentionMarkers(escapeHtml(content)).replace(/\n/g, '<br>')
}

/**
 * Render markdown content to HTML
 * For user messages, escapes HTML and converts newlines to <br>
 * For assistant messages, uses full markdown rendering
 */
export function renderMarkdown(
  content: string,
  isUserMessage: boolean = false,
  options: MarkdownRenderOptions = {},
): string {
  if (isUserMessage || options.surface === 'user-message') {
    return renderPlainTextWithMentions(content)
  }
  perfMark('md-render-start')
  ensureMarkdownDomHandlers()
  const streaming = options.streaming || options.surface === 'streaming'
  const html = getMarkdownRenderer({
    enableMath: options.math ?? !streaming,
    allowHtml: options.allowHtml ?? false,
  }).render(content)
  perfMark('md-render-end')
  perfMeasure('md.render', 'md-render-start', 'md-render-end')
  return html
}

/**
 * Clean reasoning content by removing XML tags (e.g., <think>...</think> from DeepSeek-R1)
 */
export function cleanReasoningContent(content: string): string {
  if (!content) return ''

  // Remove <think> and </think> tags (case-insensitive)
  let cleaned = content.replace(/<\/?think>/gi, '')

  // Remove other common reasoning-related XML tags
  cleaned = cleaned.replace(/<\/?thinking>/gi, '')
  cleaned = cleaned.replace(/<\/?reasoning>/gi, '')

  // Trim leading/trailing whitespace
  return cleaned.trim()
}

/**
 * Strip markdown formatting from text (for TTS)
 */
export function stripMarkdown(content: string): string {
  if (!content) return ''

  return replaceEmojiShortcodes(content)
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, '')
    // Remove inline code
    .replace(/`[^`]+`/g, '')
    // Remove links but keep text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove images
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    // Remove bold/italic
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Remove headers
    .replace(/^#+\s*/gm, '')
    // Remove horizontal rules
    .replace(/^---+$/gm, '')
    // Remove blockquotes
    .replace(/^>\s*/gm, '')
    // Clean up extra whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Composable for markdown rendering utilities
 */
export function useMarkdownRenderer() {
  return {
    renderMarkdown,
    escapeHtml,
    cleanReasoningContent,
    stripMarkdown,
  }
}
