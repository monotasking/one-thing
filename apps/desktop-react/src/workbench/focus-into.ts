import { focusTree } from '../focus/registry'
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
 *  · 拖拽落定那一头没有这种信号(它不是一只组件),所以由这只函数自己排一拍
 *    微任务 + 一帧 —— `queueMicrotask` 接住同步 `set` 之后的那一拍,`rAF` 接住
 *    React 把新宿主层铺上来的那一拍。两拍都送,**幂等**:焦点已经在里面时
 *    `activate` 自己就不动(注册表那条判据①)。
 */
export function focusIntoRef(id: ContentRefId, reason: ActivateReason = 'switch-tab'): boolean {
  return focusTree.activateScope('leaf', { owner: id, reason })
}

/**
 * 排在 React 提交之后再送(见上面「为什么要等一拍」)。
 * 给**不是组件**的那些调用点用 —— 组件那一头有 `activeId` 可等,不必走这条。
 */
export function focusIntoRefAfterCommit(id: ContentRefId, reason: ActivateReason = 'switch-tab'): void {
  if (typeof queueMicrotask === 'function') queueMicrotask(() => void focusIntoRef(id, reason))
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => void focusIntoRef(id, reason))
  }
}
