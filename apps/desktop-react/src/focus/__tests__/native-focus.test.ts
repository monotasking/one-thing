import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureBrowserPort } from '../../data/browser-port'
import type { BrowserPort, NativeViewRequest } from '../../data/browser-port'
import { installNativeFocusSync, observeNativeFocus, requestNativeFocus } from '../native-focus'
import { focusElement, registerFocusTarget } from '../target'

afterEach(() => { configureBrowserPort(undefined); vi.restoreAllMocks(); document.body.replaceChildren() })

function harness() {
  const sent: NativeViewRequest[] = []
  const port: BrowserPort = { ready: async () => undefined, read: async () => ({ kind: 'ok', value: {} }),
    do: async () => ({ kind: 'ok', text: '' }), onResourceEvent: () => () => {},
    nativeView: { send: m => { sent.push(m) }, on: () => () => {} } }
  configureBrowserPort(port)
  const slot = document.createElement('div')
  slot.dataset.nativeView = 'v1'
  slot.tabIndex = -1
  const input = document.createElement('input')
  document.body.append(slot, input)
  const unregister = registerFocusTarget(slot, () => requestNativeFocus(slot, 'v1'))
  const stop = installNativeFocusSync()
  return { slot, input, sent, close: () => { unregister(); stop() } }
}

describe('focus across a native boundary', () => {
  it('a programmatic shell target also transfers native focus back to the shell (Cmd+L)', () => {
    const h = harness()
    try {
      vi.spyOn(document, 'hasFocus').mockReturnValue(false)
      focusElement(h.input)
      expect(document.activeElement).toBe(h.input)
      expect(h.sent.at(-1)).toMatchObject({ verb: 'focus-shell' })
    } finally { h.close() }
  })
  it('window focus restoration is not a request to enter the webpage', () => {
    const h = harness()
    try {
      h.slot.focus()
      h.slot.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: null }))
      expect(h.sent).toEqual([])
      focusElement(h.slot)
      expect(h.sent.filter(m => m.verb === 'focus')).toHaveLength(1)
    } finally { h.close() }
  })

  it('address-bar focus supersedes native requests and rejects old notifications', () => {
    const h = harness()
    try {
      focusElement(h.slot)
      const previous = h.sent.find(m => m.verb === 'focus') as Extract<NativeViewRequest, { verb: 'focus' }>
      h.input.focus()
      expect(h.sent.at(-1)).toMatchObject({ verb: 'focus-shell' })
      const adopt = vi.fn(() => focusElement(h.slot))
      observeNativeFocus(h.slot, previous.revision, adopt)
      expect(adopt).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(h.input)
    } finally { h.close() }
  })

  it('adopting a real webpage focus notification does not echo another native request', () => {
    const h = harness()
    try {
      vi.spyOn(document, 'hasFocus').mockReturnValue(false)
      observeNativeFocus(h.slot, undefined, () => focusElement(h.slot))
      expect(document.activeElement).toBe(h.slot)
      expect(h.sent).toEqual([])
    } finally { h.close() }
  })
})
