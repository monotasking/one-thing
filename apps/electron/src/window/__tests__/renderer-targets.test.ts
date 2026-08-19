import { describe, expect, it, vi } from 'vitest'
import {
  getElectronRendererDevUrl,
  isElectronAppWebContents,
  isElectronMainAppWindowUrl,
  isElectronRendererIndexFileUrl,
  isElectronRendererWindowUrl,
  loadElectronMainWindowContent,
} from '../renderer-targets.js'

describe('electron renderer targets', () => {
  it('resolves the renderer dev URL from the host environment', () => {
    expect(getElectronRendererDevUrl({})).toBe('http://127.0.0.1:5173')
    expect(getElectronRendererDevUrl({ ELECTRON_RENDERER_URL: 'http://localhost:3000' })).toBe('http://localhost:3000')
  })

  it('identifies main renderer URLs and excludes auxiliary routes', () => {
    expect(isElectronMainAppWindowUrl('http://127.0.0.1:5173#theme=dark')).toBe(true)
    expect(isElectronMainAppWindowUrl('file:///app/dist/renderer/index.html#theme=light')).toBe(true)
    expect(isElectronMainAppWindowUrl('http://127.0.0.1:5173/#/settings?theme=dark')).toBe(false)
    expect(isElectronMainAppWindowUrl('file:///app/dist/renderer/index.html#/image-preview?mode=single')).toBe(false)
    expect(isElectronMainAppWindowUrl('https://example.com/#theme=dark')).toBe(false)
  })

  it('checks app webContents against dev and packaged renderer targets', () => {
    const webContents = { getURL: vi.fn(() => 'http://127.0.0.1:5173/#/chat') } as any

    expect(isElectronAppWebContents(webContents, {
      isDevelopment: true,
      rendererDevUrl: 'http://127.0.0.1:5173',
      rendererIndexPath: '/dist/renderer/index.html',
    })).toBe(true)
    expect(isElectronAppWebContents(null, {
      isDevelopment: true,
      rendererDevUrl: 'http://127.0.0.1:5173',
      rendererIndexPath: '/dist/renderer/index.html',
    })).toBe(false)

    webContents.getURL.mockReturnValue('file:///dist/renderer/index.html#theme=dark')
    expect(isElectronAppWebContents(webContents, {
      isDevelopment: false,
      rendererIndexPath: '/dist/renderer/index.html',
    })).toBe(true)
  })

  it('loads main window content for dev and packaged renderers', () => {
    const mainWindow = {
      loadURL: vi.fn(),
      loadFile: vi.fn(),
    } as any

    loadElectronMainWindowContent({
      mainWindow,
      isDevelopment: true,
      rendererDevUrl: 'http://127.0.0.1:5173',
      rendererIndexPath: '/dist/renderer/index.html',
      themeMode: 'dark',
    })
    expect(mainWindow.loadURL).toHaveBeenCalledWith('http://127.0.0.1:5173#theme=dark')

    loadElectronMainWindowContent({
      mainWindow,
      isDevelopment: false,
      rendererIndexPath: '/dist/renderer/index.html',
      themeMode: 'light',
    })
    expect(mainWindow.loadFile).toHaveBeenCalledWith('/dist/renderer/index.html', {
      hash: 'theme=light',
    })
  })

  it('keeps renderer URL checks configurable for alternate dev ports', () => {
    expect(isElectronRendererWindowUrl('http://localhost:3000/#/chat', {
      rendererDevUrl: 'http://localhost:3000',
    })).toBe(true)
  })

  // docs/design/message-references-2026-08.md §5:导航放行要精确到 index 本身。
  it('matches only the renderer index for file:// navigation', () => {
    const index = '/dist/renderer/index.html'

    expect(isElectronRendererIndexFileUrl('file:///dist/renderer/index.html', index)).toBe(true)
    expect(isElectronRendererIndexFileUrl('file:///dist/renderer/index.html#theme=dark', index)).toBe(true)
    expect(isElectronRendererIndexFileUrl('file:///dist/renderer/index.html?x=1', index)).toBe(true)
    expect(isElectronRendererIndexFileUrl('file:///dist/renderer/other.html', index)).toBe(false)
    expect(isElectronRendererIndexFileUrl('file:///Users/me/secret.txt', index)).toBe(false)
    expect(isElectronRendererIndexFileUrl('https://example.com', index)).toBe(false)
    expect(isElectronRendererIndexFileUrl('file:///dist/renderer/index.html', '')).toBe(false)
  })

  it('handles Windows drive paths and percent-encoded segments', () => {
    expect(isElectronRendererIndexFileUrl(
      'file:///C:/App%20Files/renderer/index.html',
      'C:\\App Files\\renderer\\index.html',
    )).toBe(true)
  })
})
