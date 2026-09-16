import type { NativePopupSpec, NativeViewPush } from '../native-view-protocol.js'

export interface PopupMenu {
  popup(options: { x: number; y: number; callback: () => void }): void
  closePopup(): void
}

export type PopupTemplateItem =
  | { type: 'separator' }
  | { label: string; enabled: boolean; click: () => void }

/** Own one popup per window. Results are correlated to the opening component,
 * and delivered once after close so commands may safely move focus elsewhere. */
export class NativePopup {
  private current: { id: string; menu: PopupMenu; finish: () => void } | undefined

  constructor(
    private readonly build: (items: PopupTemplateItem[]) => PopupMenu,
    private readonly push: (message: NativeViewPush) => void,
    private readonly setOpen: (open: boolean) => void,
    private readonly schedule: (run: () => void) => void = run => { setImmediate(run) },
  ) {}

  get open(): boolean { return this.current !== undefined }

  show(spec: NativePopupSpec): void {
    this.close()
    let selected: string | undefined
    let finished = false
    const menu = this.build(spec.items.map(item => item.type === 'separator'
      ? { type: 'separator' }
      : { label: item.label, enabled: item.enabled, click: () => {
          if (!finished && item.enabled) selected = item.id
        } }))
    const finish = (): void => {
      if (finished) return
      finished = true
      if (this.current?.menu === menu) {
        this.current = undefined
        this.setOpen(false)
      }
      this.schedule(() => this.push({ kind: 'popup-result', requestId: spec.requestId,
        ...(selected ? { itemId: selected } : {}) }))
    }
    this.current = { id: spec.requestId, menu, finish }
    this.setOpen(true)
    try { menu.popup({ x: spec.x, y: spec.y, callback: finish }) }
    catch { finish() }
  }

  close(requestId?: string): void {
    const current = this.current
    if (!current || (requestId !== undefined && requestId !== current.id)) return
    current.menu.closePopup()
    current.finish()
  }
}
