/**
 * 引用锚点的**委托点击**(docs/design/message-references-2026-08.md §4.5)。
 *
 * 和 code-copy / say-clamp / collab tag 同一条路数:一个装在 document 上的委托
 * 监听器,一次性安装。消息 HTML 有缓存命中的路径(StaticMarkdown 不走
 * renderMarkdown),所以安装点必须是 `ensureMarkdownDomHandlers()` 而不是渲染函数。
 *
 * 这是 `references/` 里**唯一**碰 DOM 的文件。
 */
import { openReference } from './open'
import type { Reference } from './parse'

let installed = false

function readReference(anchor: Element): Reference | null {
  const raw = anchor.getAttribute('data-ref')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Reference
    if (parsed && (parsed.kind === 'file' || parsed.kind === 'url' || parsed.kind === 'external')) {
      return parsed
    }
  } catch {
    return null
  }
  return null
}

export function handleReferenceClick(event: MouseEvent): void {
  const target = event.target as Element | null
  const anchor = target?.closest?.('a.msg-ref') as HTMLElement | null
  if (!anchor) return
  const ref = readReference(anchor)
  if (!ref) return

  // preventDefault 必须同步发生:`href="#"` 与真 URL 的默认导航都要拦住,
  // 而 openReference 是异步的。
  event.preventDefault()

  void openReference(ref, {
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
  }).then((result) => {
    // 只有"确实不存在"才灰化 —— 宿主没装/不支持不是这条引用的错。
    if (!result.ok && result.reason === 'missing') anchor.classList.add('is-missing')
    else anchor.classList.remove('is-missing')
  })
}

export function installReferenceClickHandler(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('click', handleReferenceClick)
}

/** 仅供测试:让下一次 install 重新装上。 */
export function resetReferenceClickHandler(): void {
  if (installed && typeof document !== 'undefined') {
    document.removeEventListener('click', handleReferenceClick)
  }
  installed = false
}
