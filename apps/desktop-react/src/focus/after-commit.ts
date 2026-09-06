import { focusTree } from './registry'
import type { ActivateReason, FocusScopeId } from './types'

/**
 * **「把键盘送进某一层」排在 React 提交之后的那副队列 —— 唯一产地**
 * (W7-p 修一轮裁定 5)。
 *
 * ── 病历 ──────────────────────────────────────────────────────────────────
 * 这副队列(一拍微任务 + 一帧)在壳里长了两份:`workbench/focus-into.ts` 的
 * `focusIntoRefAfterCommit`(切 tab / 拖拽落定进内容)与 `expose/store.ts` 的
 * `focusComposerAfterCommit`(开会话进输入面板)。两份逐字相同 —— 而它们要
 * **互相排队**才对(同一拍里两条落焦规则,后注册的赢),于是「为什么是这一副
 * 队列」这句判词必须两处都读得到,否则下一个人改其中一处就把次序改坏了。
 *
 * ── 为什么是这一副队列(判词正本)────────────────────────────────────────
 * 叫它的那一刻,目标那一层多半还是 `inert`(它要等这次 store 更新提交完才翻面),
 * 当场问 `activateScope` 一定答 false。所以两拍都送、而且**幂等**:
 *  · `queueMicrotask` 接住同步 `set` 之后的那一拍 —— zustand 的订阅者已经跑完,
 *    React 排了一次更新但还没提交;够用的场合(层本来就挂着、只是没被点名)在这里
 *    就成了;
 *  · `requestAnimationFrame` 接住 React 把新宿主层真的铺上来的那一拍 —— 新开一扇窗 /
 *    展开一条架子这类结构变化只有在这里才问得到。
 * 焦点已经在里面时 `activate` 自己就不动(注册表那条判据①),所以送两遍不是送两次。
 *
 * **两个队列都是 FIFO**:同一拍里注册在后的后跑,于是「谁最后说了算」由**调用次序**
 * 决定,读代码的次序就是落焦的次序。`expose/store.enterSession` 那两句的先后正是
 * 靠这一条(召唤那句在上、输入面板那句在下 —— 会话那条赢)。
 *
 * ── 留账已结清(W7-c 裁定 6)────────────────────────────────────────────
 * `workbench/focus-into.ts` 那份逐字相同的排法删了,它今天消费下面那只
 * `runAfterCommit`。**切过来的是队列,不是 `activateScopeAfterCommit`**:
 * 那只文件送的不是一格固定的作用域 —— 它先问内容自述想把焦点交给哪块面
 * (`ContentKind.focusInto`),送不进去再退回 `leaf`,一发里可能问两处。
 * 要收的那件事从来是**「排在 React 提交之后」这副队列**(以及那副队列的先后次序
 * 决定谁最后说了算),而不是「送哪一层」。所以产地是 `runAfterCommit`,
 * `activateScopeAfterCommit` 是它上面最常用的那一层壳。
 */
export function runAfterCommit(send: () => void): void {
  if (typeof queueMicrotask === 'function') queueMicrotask(send)
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(send)
}

/** 把焦点送进某一层,排在提交之后。`runAfterCommit` 之上最常用的那一层壳。 */
export function activateScopeAfterCommit(
  scope: FocusScopeId,
  opts: { owner?: string; reason?: ActivateReason } = {},
): void {
  runAfterCommit(() => void focusTree.activateScope(scope, opts))
}
