import { create } from 'zustand'
import { useT } from '../../i18n'
import { baseNameOf } from '../../data/files-source'
import { isDirty, useViewerSource, viewerSaveKey } from '../../data/viewer-source'
import { ViewerCloseConfirm } from './ViewerCloseConfirm'

/**
 * **「关掉之前问一句」的单槽 hub**(W1)。
 *
 * ── 它为什么存在 ────────────────────────────────────────────────────────
 * 关闭一格 tab 的路现在只有一条:tab 上那颗 ✕(或 ⌘W / 右键「关闭」)。那三条
 * 路都在**叶檐**上,而「有没存的改动」这句问话属于 `file` 这一种内容 ——
 * 于是 `ContentKind.beforeClose(ref)` 是那条缝:叶檐问种类,种类自己决定问不问人。
 *
 * `beforeClose` 的签名是 `Promise<'close'|'cancel'>`,而对话框是一棵组件树。
 * 把两者接起来只能靠一个 hub:种类那一侧把一格「待问」推进来并交出 Promise,
 * 宿主那一侧(`<ViewerCloseHost/>`,挂在 `AppShell` 上一次,与 `ConfirmHost` /
 * `ToastHost` 同层同理由)把它画出来。
 *
 * ── 为什么不用 `ui/Dialog` 的通用 `confirm` ──────────────────────────────
 * 这一问有**三条出路**(取消 / 丢弃 / 保存并关闭),而且第三条带一格 pending
 * (`save:<path>` 逐格忙态 + AsyncButton 的 150ms 防闪)。通用那件是两颗钮的
 * yes/no。所以复用的是**既有的 `ViewerCloseConfirm`**(一行未改),
 * 新写的只有「谁来挂它」这一格。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 *  ① 生命周期:hub 是模块级 store(单槽)→ **配 HMR dispose**(文件末尾):
 *     热更时把还悬着的那一问按「取消」结掉,不然那个 Promise 永远不 settle,
 *     调用它的那次关闭就卡在半路。宿主组件挂在壳根上一次,不订阅别的东西。
 *  ② UI 生命状态:`ask === null` 时整棵不挂(焦点陷阱、Esc、点外关全随
 *     `ui/Dialog` 走);存盘失败时**不关**,错误由查看器脚上那条状态栏说。
 *  ③ UI 交互状态:三颗钮逐格照 `ViewerCloseConfirm` 那张表(取消 / 丢弃同步、
 *     保存并关闭读 `save:<path>` 的逐格 pending)。
 */

interface CloseAsk {
  path: string
  resolve: (answer: 'close' | 'cancel') => void
}

interface CloseHub {
  /** 单槽:同一时刻只问一件事。 */
  ask: CloseAsk | null
  push: (ask: CloseAsk) => void
  settle: (answer: 'close' | 'cancel') => void
}

const useCloseHub = create<CloseHub>()((set, get) => ({
  ask: null,
  push: (ask) => {
    /*
     * 已经有一问悬着 = 上一次那条路还没走完。**把旧的按取消结掉**再换新的 ——
     * 悬而不决的 Promise 会让上一次关闭永远停在半路(调用方在 await 它)。
     */
    get().ask?.resolve('cancel')
    set({ ask })
  },
  settle: (answer) => {
    const now = get().ask
    if (!now) return
    set({ ask: null })
    now.resolve(answer)
  },
}))

/**
 * 关掉之前问一句。**没有没存的改动就不问**(直接答 `'close'`)——
 * 这条判据在这里,不在叶檐里:叶檐不认识「脏」这回事。
 */
export function askViewerClose(path: string): Promise<'close' | 'cancel'> {
  const live = useViewerSource.getState().instances[path]
  if (!live || !isDirty(live.file, live.edit)) return Promise.resolve('close')
  return new Promise((resolve) => useCloseHub.getState().push({ path, resolve }))
}

/** 挂在壳根上一次(与 `ConfirmHost` / `ToastHost` 同层)。 */
export function ViewerCloseHost() {
  const t = useT()
  const ask = useCloseHub((st) => st.ask)
  const settle = useCloseHub((st) => st.settle)
  const save = useViewerSource((st) => st.save)
  const path = ask?.path ?? ''
  const name = ask ? (useViewerSource.getState().instances[path]?.file?.name ?? baseNameOf(path)) : ''
  return (
    <ViewerCloseConfirm
      t={t}
      open={ask !== null}
      name={name}
      saveKey={ask ? viewerSaveKey(path) : undefined}
      onCancel={() => settle('cancel')}
      onDiscard={() => settle('close')}
      onSave={() => save(path)}
      onSaved={() => settle('close')}
    />
  )
}

/*
 * 模块级单槽 → HMR 退役(09-01 立法)。热更时把悬着的那一问按取消结掉,
 * 复用 store 已有的那一口 `settle`,不写第二套拆卸。幂等(没有悬着的就什么都不做)。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    useCloseHub.getState().settle('cancel')
  })
}
