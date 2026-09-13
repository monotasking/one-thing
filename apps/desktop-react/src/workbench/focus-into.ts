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
   *
   * ── 先点名**这一格自己**那一份(W5-c),点不到再不点名 ────────────────────
   * 路线 A 之前输入面板全应用只有一块,`composer` 那格作用域因此只有一份实例,
   * 不点名也不会挑错。现在它是会话叶的器官 —— 两片会话叶并排就是两份实例,
   * 不点名 = 让 MRU 替用户猜,而 MRU 记的是「上一次焦点在哪一份」,与「人刚点的
   * 是哪一格标签」正好是两件事(点 B 的标签,焦点会落回刚才用过的 A)。
   * `owner` 就是这一格的 refId,而 `Composer` 的 `FocusScope` 上挂的正是它 ——
   * 与下面 `leaf` 那句**同一个 owner、同一条判据**。
   *
   * **两步,不是一步**:`owner` 是一次**收窄**,不是一条新的前提。今天把自己的
   * owner 报上来的只有 `composer` 与 `browser` 两格作用域(`FocusScope owner=`),
   * `files` / `diff` / `terminal` 三格还没报 —— 对它们点名等于一个都挑不到,
   * 于是这一句会静默地退到 `leaf`,而「激活这一格 = 焦点进它那块面」当场失效
   * (W5-c-3 真机门逮到的:那三种的 `focusInto` 一并哑掉)。所以点不到就**不点名
   * 再问一次** = 改前那一句逐字。等那三格也把 owner 报上来,第二问自然再也命中
   * 不到第二份实例,这一行不必再改。
   */
  const ref = parseRefId(id)
  const into = ref ? focusIntoScopeOf(ref) : undefined
  if (into && focusTree.activateScope(into, { owner: id, reason })) return true
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
