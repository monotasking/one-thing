import { StrictMode } from 'react'
import { act, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeMenu } from '../NativeMenu'
import { configureBrowserPort } from '../../data/browser-port'
import type { BrowserPort, NativeViewPush, NativeViewRequest } from '../../data/browser-port'

afterEach(() => configureBrowserPort(undefined))

it('opens once in StrictMode, creates no DOM overlay, and routes only its own selection once', async () => {
  const sent: NativeViewRequest[] = []
  const listeners = new Set<(m: NativeViewPush) => void>()
  const port: BrowserPort = { ready: async () => undefined, read: async () => ({ kind: 'ok', value: {} }),
    do: async () => ({ kind: 'ok', text: '' }), onResourceEvent: () => () => {},
    nativeView: { nativePopup: true,
      send: m => { sent.push(m) }, on: f => { listeners.add(f); return () => { listeners.delete(f) } },
    } }
  configureBrowserPort(port)
  const select = vi.fn()
  const close = vi.fn()
  const ui = render(<StrictMode><NativeMenu x={10} y={20} onClose={close}
    items={[{ type: 'item', id: 'give', label: 'Give to chat', enabled: true, onSelect: select }]} /></StrictMode>)
  await act(async () => {})
  const requests = sent.filter((m): m is Extract<NativeViewRequest, { verb: 'popup' }> => m.verb === 'popup')
  expect(requests).toHaveLength(1)
  expect(ui.queryByRole('menu')).toBeNull()
  expect(sent.some(m => m.verb === 'occlude')).toBe(false)
  const push = (m: NativeViewPush) => act(() => { listeners.forEach(f => f(m)) })
  push({ kind: 'popup-result', requestId: 'stale', itemId: 'give' })
  expect(select).not.toHaveBeenCalled()
  push({ kind: 'popup-result', requestId: requests[0].requestId, itemId: 'give' })
  push({ kind: 'popup-result', requestId: requests[0].requestId, itemId: 'give' })
  expect(select).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledTimes(1)
  ui.unmount()
  expect(listeners.size).toBe(0)
})
