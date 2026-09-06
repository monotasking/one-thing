import { focusTree } from '../focus/registry'
import { runAfterCommit } from '../focus/after-commit'
import { focusIntoScopeOf, parseRefId } from './kinds'
import type { ActivateReason } from './../focus/types'
import type { ContentRefId } from './kinds'

/**
 * **「这一格成了活动的 → 焦点进它的内容」那一句话的唯一产地**(W3 从
 * `LeafStrip.useSelectIntoContent` 里抽出来的一行)。
 *
 * ── 为什么抽出来 ────────────────────────────────────────────────────────
 * W4 合树时裁定的原话是:「tab 被激活(指针点击 / Enter / Space)→ 焦点进这片叶
 * 的内容」,四个区域同一句。W3 的拖拽落定给这句话添了**第五个调用点** ——
 * 派工令裁定 8 明写「落定后焦点跟到新叶(与 W4 的『tab 激活 → 焦点进内容』
 * **同一句**)」。同一句话有两个调用点时它就该有一个产地;有五个还各写各的,
 * 「切 tab 进内容」迟早在某一条路上悄悄分叉 —— 而分叉正是那次接缝要治的病。
 *
 * ── 落点怎么找:问的是**那一格 tab 的层**,不是叶,也不是宿主层 ────────────
 * 每一格 tab 的内容层自己是一格 `leaf` 作用域,`owner` = 这一格的 refId
 * (判词在 `PaneLeaf.PaneTabLayer` 上),而 `leaf` 在表上自述 `passThrough` ——
 * 内核穿过它一直走到内容自己那一格。三件事因此白拿:认的是 refId(四个宿主
 * 同一句)、后台那几层是 `inert`(选不错人)、送不进去一律答 false(焦点原地
 * 不动,与形态机「送不进去不追」同一条纪律)。
 *
 * ── 为什么要等一拍 ──────────────────────────────────────────────────────
 * 叫它的那一刻,新活动的那一层多半还是 `inert`(它要等这次 store 更新提交完
 * 才翻面),当场问 `activateScope` 一定答 false。这是 `stage/focus-follow` 那条
 * 「落焦必须排在 React 提交之后」判例的同一件事。
 *
 * 两个调用点排这一拍的方式不同,所以**排队这件事留给调用方**:
 *  · tab 条那一头有 `activeId` 这个现成的信号,它等到那一格真的变成活动的、
 *    在 effect 里叫(见 `LeafStrip.useSelectIntoContent`);
 *  · 拖拽落定那一头没有这种信号(它不是一只组件),所以走 `focus/after-commit`
 *    的 `runAfterCommit` —— 一拍微任务 + 一帧,判词整件写在那只文件上。
 */
export function focusIntoRef(id: ContentRefId, reason: ActivateReason = 'switch-tab'): boolean {
  /*
   * ── 先问**内容自己想把焦点交给哪块面**(W7-t / B3)──────────────────────
   * 报障:切到一格会话标签,焦点落在消息流上,直接打字进不去 —— 而那一格内容
   * 真正的「进它」就是「进它的输入面板」。这一句读的是种类自述那张表
   * (`ContentKind.focusInto`),所以这只文件里**一个种类名都没有**:下一种有
   * 同样需求的内容(终端 / 表单)只改它自己那一行。
   *
   * 送不进去就往下走(那块面此刻一份可交互的实例都没有,比如输入面板还没铺根)
   * —— 与整只函数「送不进去答 false、焦点原地不动」同一条纪律。
   */
  const ref = parseRefId(id)
  const into = ref ? focusIntoScopeOf(ref) : undefined
  if (into && focusTree.activateScope(into, { reason })) return true
  return focusTree.activateScope('leaf', { owner: id, reason })
}

/**
 * 排在 React 提交之后再送(见上面「为什么要等一拍」)。
 * 给**不是组件**的那些调用点用 —— 组件那一头有 `activeId` 可等,不必走这条。
 *
 * **那副队列在 `focus/after-commit.ts`,不在这里**(W7-c 裁定 6,结清 W7-p 留的口)。
 * 从前这只函数自己写了一遍「一拍微任务 + 一帧」,与 `expose/store` 那份逐字相同 ——
 * 而它们要**互相排队**才对(同一拍里两条落焦规则,后注册的赢),所以「为什么是这副
 * 队列」那句判词只能有一处。今天两处都消费 `runAfterCommit`,次序仍旧由调用次序说。
 */
export function focusIntoRefAfterCommit(id: ContentRefId, reason: ActivateReason = 'switch-tab'): void {
  runAfterCommit(() => void focusIntoRef(id, reason))
}
