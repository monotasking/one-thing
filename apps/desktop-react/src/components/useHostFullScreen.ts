import { useEffect, useState } from 'react'

/**
 * 「此刻是不是 macOS 原生全屏」—— 唯一产地(09-01 自查走查:全屏下红绿灯没了,
 * 顶栏左边那 80px 让位空块还杵着)。
 *
 * ── 为什么必须问宿主,不能自己看 ─────────────────────────────────────────
 * 真机实测,窗口态与全屏态下渲染层能摸到的信号**逐字相同**:
 *   `matchMedia('(display-mode: fullscreen)')`  false / false  (一直报 `browser`)
 *   `document.fullscreenElement`                null  / null
 *   `innerHeight`                               860   / 1084   ← 唯一变的
 * 那个 1084 恰好等于 `screen.availHeight`,拿它当判据会在「用户手动把窗口拉到
 * 屏幕可用高度」时误判 —— 这条状态只有窗口自己知道,所以由主进程推
 * (`enter/leave-full-screen` + `did-finish-load` 首帧对齐)。
 *
 * ── 没有宿主时是 false,不是「不知道」──────────────────────────────────
 * 浏览器里跑(以及 preload 还没挂上的那一瞬)取不到 `onethingHost` —— 那时答
 * **false**:没有原生全屏,也就没有会消失的红绿灯,让位照留才是对的形。
 * 这一格是「诚实降级」,不是兜底猜测。
 */
type HostFullScreenBridge = {
  onFullScreenChange?: (handler: (fullScreen: boolean) => void) => () => void
}

export function useHostFullScreen(): boolean {
  const [fullScreen, setFullScreen] = useState(false)

  useEffect(() => {
    const host = (window as unknown as { onethingHost?: HostFullScreenBridge }).onethingHost
    if (!host?.onFullScreenChange) return
    // 退订函数由 preload 给,卸载时必须调用:否则热更/重挂之后旧回调还挂在
    // ipcRenderer 上(模块级副作用配 dispose 的同一条法,这里是组件级的那一半)。
    return host.onFullScreenChange(setFullScreen)
  }, [])

  return fullScreen
}
