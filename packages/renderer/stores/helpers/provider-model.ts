/**
 * provider / model 的纯判据 —— **本体已搬进 `@onething/client`**(C2,
 * `docs/design/client-sdk-2026-09.md` §5.2;C0 搬走时刻意没删原件,C2 才结清)。
 *
 * 这里只剩一行再导出,活着是为了不动 stores 里既有的 import 路径。
 * 唯一的实质差别在包那边:`AppSettings` 从 `@shared/ipc/settings` 直接引,
 * 而不是绕 Vue 的 `@/types` 桶(那张桶本来就是从 `@shared` 再导出的)。
 * 随 Vue 宿主退役一起删。
 */
export * from '@onething/client/model/provider-model.js'
