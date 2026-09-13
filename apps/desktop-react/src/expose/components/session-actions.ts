import { announce } from '../../ui/a11y/live-region'
import { t } from '../../i18n'
import { sessionRefOf } from '../../content/session-ref'
import { useWorkbenchStore } from '../../workbench/store'
import { useExposeStore } from '../store'

/**
 * 会话行三个**有可感知收场**的动作,各配一句话(A2)。
 *
 * 这只文件与 `pin-announce.ts` 是同一族、同一条理由:store 如实说「成没成」,
 * **播报的产地在渲染层**(设计 §3.3)。放在这里而不是摊进 `SessionActionsMenu`
 * 是因为它们各有**两条以上**的入口 —— 关闭今天只有菜单,改名有菜单与那只输入框
 * 的 ↵ 两条,删除有菜单与确认框那一路;各写一遍的下场与图钉那次一模一样:
 * 「键盘按的那一下不说话」这种只有读屏用户才发现得了的漂移。
 *
 * 三条共同的纪律:
 *  · **零 Toast 零通知**(与「复制类反馈就地」同一条)。结果全在屏幕上 ——
 *    那颗点没了 / 行上的字换了 / 那一行没了 —— 读屏用户缺的只是那一句话;
 *  · **成了不播报,没成才播报**。成了的那一下屏幕自己说明白了;而「没成」是
 *    屏幕上**什么都没发生**的那一档,不说一句就是静默失败(F 线那条法);
 *  · 用模块级的 `t()` 而不是 `useT()`:这三只住在事件处理器里,不该逼调用方把
 *    `t` 塞进 `useCallback` 的依赖表(那会让回调每换一次语言就换一个身份)。
 */

/**
 * **关闭** = 把这条会话从开着它的每一个格子里摘掉,**不删数据**(拍板 5)。
 *
 * 判据与动作整件在 `workbench.closeRef`(一只事务动作,三种收场);这里只负责
 * 把 `'refused'` 那一档说出来 —— 它是「常驻那一种在它自己的家里的最后一格」,
 * 屏幕上那一下**什么都不会动**,不说话就与「坏了」在人眼里是同一件事。
 *
 * 那句话复用 `workbench.tabNotClosable`:叶檐上 ⌘W 撞到同一条守卫时说的就是它
 * (`leaf-tabs.useCloseLeafTab`)—— 同一句话只该有一把键。
 *
 * `'absent'` 那一档**不播报**:菜单上「关闭」那一行只在这条会话开着时才在场,
 * 所以走到这一档只可能是竞态(弹出到点下去之间别处把它关了),而那时屏幕上
 * 想要的结果已经成立了。
 */
export function closeSessionAndAnnounce(sessionId: string): void {
  const outcome = useWorkbenchStore.getState().closeRef(sessionRefOf(sessionId))
  if (outcome === 'refused') announce(t('workbench.tabNotClosable'))
}

/**
 * **改名落定**。屏幕上那只框当场收回(store 的 `commitRename` 第一句),
 * 行上的字由数据源那一笔乐观补丁当场换掉;**没成**才说话 —— 那一刻乐观补丁
 * 已经翻回原名,屏幕上看起来什么都没发生。
 *
 * 后端那句原话进播报(而不是只说一句「改名失败」):这一族写口的失败原因
 * 通常是「这条会话不在了」/ 沙箱拒绝,人看得懂,吞掉它等于让人再猜一次。
 */
export function commitRenameAndAnnounce(sessionId: string, newName: string): void {
  void useExposeStore
    .getState()
    .commitRename(sessionId, newName)
    .then((outcome) => {
      if (outcome.ok) return
      announce(t('expose.renameFailed', { error: outcome.error }))
    })
}

/**
 * **删除**(已经确认过了 —— 那一问的产地在菜单那一行,见 `SessionActionsMenu`)。
 *
 * 成了不播报:那一行没了,而且开着它的格子在这一下之前就已经摘掉了(编排在
 * `store.deleteSession`,次序即语义)。没成则那一行留在屏上,原话进播报。
 */
export function deleteSessionAndAnnounce(sessionId: string): Promise<void> {
  return useExposeStore
    .getState()
    .deleteSession(sessionId)
    .then((outcome) => {
      if (outcome.ok) return
      announce(t('expose.deleteFailed', { error: outcome.error }))
    })
}
