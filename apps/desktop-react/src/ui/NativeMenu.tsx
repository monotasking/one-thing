import { useEffect, useRef } from 'react'
import { nativeViewBridge } from '../data/browser-port'
import type { NativePopupItem } from '../data/browser-port'

export type NativeMenuAction = NativePopupItem & { onSelect?: () => void }

/** Renderer's action callbacks stay here; only their labels and IDs cross IPC. */
export function NativeMenu({ x, y, items, onClose }: {
  x: number
  y: number
  items: readonly NativeMenuAction[]
  onClose: () => void
}) {
  const latest = useRef({ items, onClose })
  latest.current = { items, onClose }
  useEffect(() => {
    const bridge = nativeViewBridge()
    if (!bridge?.nativePopup) return
    const requestId = crypto.randomUUID()
    let disposed = false
    let opened: readonly NativeMenuAction[] = []
    const off = bridge.on(message => {
      if (disposed || message.kind !== 'popup-result' || message.requestId !== requestId) return
      disposed = true
      const selected = opened.find(item => item.type === 'item' && item.id === message.itemId && item.enabled)
      latest.current.onClose()
      selected?.onSelect?.()
    })
    // StrictMode's discarded mount must never display or cancel a live menu.
    queueMicrotask(() => {
      if (disposed) return
      opened = latest.current.items
      bridge.send({ verb: 'popup', requestId, x, y, items: opened.map(item => item.type === 'separator'
        ? { type: 'separator' }
        : { type: 'item', id: item.id, label: item.label, enabled: item.enabled }) })
    })
    return () => {
      disposed = true
      off()
      bridge.send({ verb: 'popup-close', requestId })
    }
  }, [x, y])
  return null
}
