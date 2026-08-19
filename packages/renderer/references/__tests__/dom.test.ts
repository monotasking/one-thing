// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installReferenceClickHandler, resetReferenceClickHandler } from '../dom'
import { setReferenceHost, type ReferenceHost } from '../open'
import type { Reference } from '../parse'

function anchorFor(ref: Reference, extra = ''): HTMLAnchorElement {
  document.body.innerHTML = `<div><a class="msg-ref msg-ref--${ref.kind}" href="#" data-ref-kind="${ref.kind}" data-ref='${JSON.stringify(ref)}' ${extra}><code>x</code></a></div>`
  return document.querySelector('a.msg-ref') as HTMLAnchorElement
}

function click(target: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('installReferenceClickHandler', () => {
  type MockedHost = { [K in keyof ReferenceHost]-?: ReturnType<typeof vi.fn> }
  let host: ReferenceHost & MockedHost

  beforeEach(() => {
    host = {
      openFile: vi.fn(),
      openUrl: vi.fn(),
      openExternal: vi.fn(),
      revealPath: vi.fn(),
      openFolder: vi.fn(),
      openImage: vi.fn(),
      statPath: vi.fn().mockResolvedValue({ exists: true, isDirectory: false, isImage: false }),
      notify: vi.fn(),
    } as unknown as ReferenceHost & MockedHost
    setReferenceHost(host)
    resetReferenceClickHandler()
    installReferenceClickHandler()
  })

  afterEach(() => {
    resetReferenceClickHandler()
    setReferenceHost(null)
    document.body.innerHTML = ''
  })

  it('是委托的:点 code 子元素也能命中外面的锚点', async () => {
    const anchor = anchorFor({ kind: 'file', path: '/a/b.ts', line: 12, raw: '/a/b.ts:12' })
    const event = click(anchor.querySelector('code')!)
    await flush()

    expect(event.defaultPrevented).toBe(true)
    expect(host.openFile).toHaveBeenCalledWith('/a/b.ts', { line: 12, endLine: undefined, col: undefined })
  })

  it('⌘-click 交给系统打开,不进编辑器', async () => {
    const anchor = anchorFor({ kind: 'file', path: '/a/b.ts', raw: '/a/b.ts' })
    click(anchor, { metaKey: true })
    await flush()

    expect(host.openExternal).toHaveBeenCalledWith('file:///a/b.ts')
    expect(host.openFile).not.toHaveBeenCalled()
  })

  it('shift-click 在文件管理器里显示', async () => {
    const anchor = anchorFor({ kind: 'file', path: '/a/b.ts', raw: '/a/b.ts' })
    click(anchor, { shiftKey: true })
    await flush()

    expect(host.revealPath).toHaveBeenCalledWith('/a/b.ts')
  })

  it('url 默认进内置浏览器,⌘ 走系统', async () => {
    const anchor = anchorFor({ kind: 'url', url: 'https://example.com', raw: 'https://example.com' })
    const event = click(anchor)
    await flush()
    expect(event.defaultPrevented).toBe(true)
    expect(host.openUrl).toHaveBeenCalledWith('https://example.com')

    click(anchor, { ctrlKey: true })
    await flush()
    expect(host.openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('external 一律交给系统', async () => {
    const anchor = anchorFor({ kind: 'external', url: 'mailto:a@b.com', raw: 'mailto:a@b.com' })
    click(anchor)
    await flush()

    expect(host.openExternal).toHaveBeenCalledWith('mailto:a@b.com')
  })

  it('目录进文件树,图片进灯箱', async () => {
    host.statPath.mockResolvedValueOnce({ exists: true, isDirectory: true, isImage: false })
    click(anchorFor({ kind: 'file', path: '/a/dir', raw: '/a/dir' }))
    await flush()
    expect(host.openFolder).toHaveBeenCalledWith('/a/dir')

    host.statPath.mockResolvedValueOnce({ exists: true, isDirectory: false, isImage: true })
    click(anchorFor({ kind: 'file', path: '/a/pic.png', raw: '/a/pic.png' }))
    await flush()
    expect(host.openImage).toHaveBeenCalledWith('/a/pic.png', 'file:///a/pic.png')
  })

  it('文件不存在:锚点灰化 + 提示,一次点击只判一次', async () => {
    host.statPath.mockResolvedValue({ exists: false, isDirectory: false, isImage: false })
    const anchor = anchorFor({ kind: 'file', path: '/gone.ts', raw: '/gone.ts' })
    click(anchor)
    await flush()

    expect(anchor.classList.contains('is-missing')).toBe(true)
    expect(host.notify).toHaveBeenCalled()
    expect(host.openFile).not.toHaveBeenCalled()
  })

  it('相对路径按会话工作目录解析;解析不到当不存在处理', async () => {
    host.resolveRelative = vi.fn().mockReturnValue('/repo/src/foo.ts')
    click(anchorFor({ kind: 'file', path: 'src/foo.ts', line: 3, raw: 'src/foo.ts:3' }))
    await flush()
    expect(host.openFile).toHaveBeenCalledWith('/repo/src/foo.ts', { line: 3, endLine: undefined, col: undefined })

    host.resolveRelative = vi.fn().mockReturnValue(null)
    const anchor = anchorFor({ kind: 'file', path: 'src/bar.ts', raw: 'src/bar.ts' })
    click(anchor)
    await flush()
    expect(anchor.classList.contains('is-missing')).toBe(true)
  })

  it('非引用锚点一概不碰', async () => {
    document.body.innerHTML = '<a class="other" href="https://example.com">x</a>'
    const event = click(document.querySelector('a')!)
    await flush()

    expect(event.defaultPrevented).toBe(false)
    expect(host.openUrl).not.toHaveBeenCalled()
  })

  it('data-ref 坏掉时不拦默认行为', async () => {
    document.body.innerHTML = '<a class="msg-ref msg-ref--file" href="#" data-ref="{oops">x</a>'
    const event = click(document.querySelector('a')!)
    await flush()

    expect(event.defaultPrevented).toBe(false)
  })
})
