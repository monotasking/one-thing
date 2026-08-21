import { describe, expect, it } from 'vitest'
import { isElectronMainAppWindowUrl as isMainAppWindowUrl } from '@onething/electron-host/window/renderer-targets'

describe('Search Everywhere window targeting', () => {
  it('accepts the main app route', () => {
    expect(isMainAppWindowUrl('http://127.0.0.1:5173#theme=dark')).toBe(true)
    expect(isMainAppWindowUrl('file:///app/dist/renderer/index.html#theme=light')).toBe(true)
  })

  it('rejects auxiliary renderer routes', () => {
    expect(isMainAppWindowUrl('http://127.0.0.1:5173/#/search?theme=dark')).toBe(false)
    expect(isMainAppWindowUrl('http://127.0.0.1:5173/#/settings?theme=dark')).toBe(false)
    expect(isMainAppWindowUrl('http://127.0.0.1:5173/#/todo-plan?theme=dark')).toBe(false)
    expect(isMainAppWindowUrl('file:///app/dist/renderer/index.html#/image-preview?mode=single')).toBe(false)
  })

  it('rejects non-renderer urls', () => {
    expect(isMainAppWindowUrl('devtools://devtools/bundled/inspector.html')).toBe(false)
    expect(isMainAppWindowUrl('https://example.com/#theme=dark')).toBe(false)
  })
})
