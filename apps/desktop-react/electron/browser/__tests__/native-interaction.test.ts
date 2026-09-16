import { describe, expect, it, vi } from 'vitest'
import { NativeFocus } from '../native-focus'
import { NativePopup, type PopupTemplateItem } from '../native-popup'
import { parseNativeViewRequest } from '../native-view-ipc'

describe('native focus intents', () => {
  it('a newer address-bar intent cancels queued native focus and ignores late requests', () => {
    const pending: (() => void)[] = []
    const focus = vi.fn()
    const controller = new NativeFocus(focus, run => pending.push(run))
    controller.request('page', 1)
    controller.request(null, 2)
    controller.request('page', 1)
    pending.forEach(run => run())
    expect(focus.mock.calls).toEqual([[null]])
    expect(controller.revision).toBe(2)
  })

  it('opening a menu cancels pending focus, and closing does not replay it', () => {
    const pending: (() => void)[] = []
    const focus = vi.fn()
    const controller = new NativeFocus(focus, run => pending.push(run))
    controller.request('page', 1)
    controller.suspend(true)
    controller.request('page', 2)
    controller.suspend(false)
    pending.forEach(run => run())
    expect(focus).not.toHaveBeenCalled()
    controller.request('page', 3)
    pending.at(-1)!()
    expect(focus).toHaveBeenCalledWith('page')
  })
})

describe('native popup lifecycle', () => {
  function harness() {
    const pending: (() => void)[] = []
    const built: { items: PopupTemplateItem[]; close: () => void }[] = []
    const push = vi.fn()
    const opened = vi.fn()
    const popup = new NativePopup(items => {
      const entry = { items, close: () => {} }
      built.push(entry)
      return { popup: options => { entry.close = options.callback }, closePopup: () => entry.close() }
    }, push, opened, run => pending.push(run))
    const show = (requestId: string) => popup.show({ requestId, x: 4, y: 8,
      items: [{ type: 'item', id: 'action', label: 'Action', enabled: true }] })
    return { pending, built, push, opened, popup, show }
  }

  it('delivers a selection once after the menu has closed', () => {
    const h = harness()
    h.show('one')
    const item = h.built[0].items[0]
    if ('click' in item) item.click()
    expect(h.push).not.toHaveBeenCalled()
    h.built[0].close()
    h.built[0].close()
    expect(h.popup.open).toBe(false)
    h.pending.forEach(run => run())
    expect(h.push.mock.calls).toEqual([[{ kind: 'popup-result', requestId: 'one', itemId: 'action' }]])
  })

  it('stale cleanup cannot dismiss the replacement menu or execute a cancelled action', () => {
    const h = harness()
    h.show('old')
    h.show('new')
    h.popup.close('old')
    const oldItem = h.built[0].items[0]
    if ('click' in oldItem) oldItem.click()
    expect(h.popup.open).toBe(true)
    h.pending.forEach(run => run())
    expect(h.push.mock.calls).toEqual([[{ kind: 'popup-result', requestId: 'old' }]])
    expect(h.opened.mock.calls).toEqual([[true], [false], [true]])
  })
})

describe('interaction IPC validation', () => {
  it('rejects invalid revisions, duplicate menu action IDs and invalid coordinates', () => {
    expect(parseNativeViewRequest({ verb: 'focus-shell', revision: NaN })).toBeUndefined()
    expect(parseNativeViewRequest({ verb: 'focus', viewId: 'a', revision: -1 })).toBeUndefined()
    const item = { type: 'item', id: 'a', label: 'A', enabled: true }
    const valid = { verb: 'popup', requestId: 'p', x: 1.2, y: 4.8, items: [item] }
    expect(parseNativeViewRequest(valid)).toMatchObject({ x: 1, y: 5 })
    expect(parseNativeViewRequest({ ...valid, items: [item, item] })).toBeUndefined()
    expect(parseNativeViewRequest({ ...valid, x: Infinity })).toBeUndefined()
  })
})
