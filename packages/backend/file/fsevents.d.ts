/**
 * The narrow public contract used from the pinned fsevents 2.3.2 runtime.
 * Its package (including its bundled declarations) is optional and darwin-only,
 * so backend type checking on other platforms must not depend on its presence.
 * Keep this declaration and the driver's runtime export checks in agreement.
 * This declaration never loads the addon or supplies a non-macOS implementation.
 */
declare module 'fsevents' {
  export function watch(
    root: string,
    since: number,
    onEvent: (path: string, eventFlags: number) => void,
  ): () => Promise<void>

  export const constants: Readonly<{
    MustScanSubDirs: 0x00000001
    UserDropped: 0x00000002
    KernelDropped: 0x00000004
    EventIdsWrapped: 0x00000008
    HistoryDone: 0x00000010
    RootChanged: 0x00000020
    ItemCreated: 0x00000100
    ItemRemoved: 0x00000200
    ItemRenamed: 0x00000800
    ItemCloned: 0x00400000
  }>
}
