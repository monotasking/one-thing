/** Programmatic focus may also need to cross a native view boundary. DOM focus
 * events alone cannot distinguish that request from window focus restoration. */
const nativeTargets = new WeakMap<HTMLElement, () => void>()
const hosts = new WeakMap<Document, () => void>()

export function registerFocusHost(document: Document, focus: () => void): () => void {
  hosts.set(document, focus)
  return () => { if (hosts.get(document) === focus) hosts.delete(document) }
}

export function registerFocusTarget(element: HTMLElement, focus: () => void): () => void {
  nativeTargets.set(element, focus)
  return () => { if (nativeTargets.get(element) === focus) nativeTargets.delete(element) }
}

export function focusElement(element: HTMLElement | null | undefined): void {
  if (!element?.isConnected) return
  const native = nativeTargets.get(element)
  if (native) native()
  else {
    element.focus({ preventScroll: true })
    if (!element.ownerDocument.hasFocus()) hosts.get(element.ownerDocument)?.()
  }
}
