import { shell, type WebContents } from 'electron'

export interface ElectronExternalLinkShellLike {
  openExternal(url: string): Promise<void> | void
}

export interface ElectronExternalLinkOptions {
  webContents: WebContents
  isAppUrl(url: string): boolean
  /**
   * 渲染器自己的 index(`file://<rendererIndexPath>`)。**只有**它算 app 的
   * `file://`;其余 `file://` 一律拦下且不交给系统打开 —— 一个漏网的 `file://`
   * 锚点既能把整窗导航走(`isElectronRendererWindowUrl` 把所有 `file://` 都当
   * app URL),也能在系统里打开任意本地文件。
   * 见 docs/design/message-references-2026-08.md §5「主进程兜底」。
   */
  isAppFileUrl?(url: string): boolean
  shell?: ElectronExternalLinkShellLike
}

function isFileUrl(url: string): boolean {
  return url.trim().toLowerCase().startsWith('file://')
}

export function setupElectronExternalLinkHandling(options: ElectronExternalLinkOptions): void {
  const electronShell = options.shell ?? shell

  options.webContents.on('will-navigate', (event, url) => {
    if (isFileUrl(url)) {
      // 这是防御,不是主路径:渲染层已经把 file 类引用的 href 改写成 `#` 了。
      if (options.isAppFileUrl?.(url)) return
      event.preventDefault()
      return
    }

    if (!options.isAppUrl(url)) {
      event.preventDefault()
      void electronShell.openExternal(url)
    }
  })

  options.webContents.setWindowOpenHandler(({ url }) => {
    void electronShell.openExternal(url)
    return { action: 'deny' }
  })
}
