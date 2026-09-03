import { announce } from '../../ui/a11y/live-region'
import { t } from '../../i18n'
import { useExposeStore } from '../store'

/**
 * 置顶 / 取消置顶,**并播报一句**(设计 §3.3)。
 *
 * 为什么单独一件而不是各写一遍:这一下有**两个**入口 —— 行上那颗图钉(鼠标)与
 * ⌘⇧P(键盘,面域局部键)。两个入口一件事,播报也就只能有一个产地;
 * 各写一遍的下场是「键盘按的那一下不说话」这种只有读屏用户才发现得了的漂移。
 *
 * 零 Toast、零通知 —— 与「复制类反馈就地」同一条纪律:结果全在屏幕上
 * (行搬进 / 搬出「置顶」那一节),读屏用户缺的只是那一句话。
 * 用的是模块级的 `t()`(它自己去问 store 的 locale),不是 `useT()` ——
 * 这只函数住在事件处理器里,不该逼调用方把 `t` 塞进 `useCallback` 的依赖表
 * (那会让回调每换一次语言就换一个身份,行的 memo 白做)。
 *
 * 写没成就**不播报**:那一刻乐观补丁已经翻了回去,屏幕上什么都没发生,
 * 说一句「已置顶」就是在说谎。
 */
export function togglePinAndAnnounce(sessionId: string): void {
  void useExposeStore
    .getState()
    .togglePin(sessionId)
    .then((done) => {
      if (!done?.ok) return
      announce(
        t(done.isPinned ? 'expose.pinnedAnnounce' : 'expose.unpinnedAnnounce', { name: done.name }),
      )
    })
}
