import type { ReactElement } from 'react'

/**
 * **行元素账** —— 聊天列那张行表的元素,按消息 id 记下来,输入没变就交回同一个对象
 * (G 线 P4-a ①,正本 `docs/stream-geometry-2026-09.md` §21.5)。
 *
 * ── 病 ──────────────────────────────────────────────────────────────────────
 * 流式期间 `chat-source.compose` 每帧换一次 `messages` 数组,`ChatStream` 跟着重渲,
 * 那张行表就把**每一行**的 React 元素重新造一遍。`MessageRow` / `UserBubble` 的 memo
 * 省掉的只是它们自己的渲染;父层「为每一行新造一个元素 + 调一次浅比」那一段一格没省
 * —— 真店档(412 条)一轮 490ms,是 React render 那一格的一半(§21.3 Q1)。
 *
 * ── 省钱的机理 ──────────────────────────────────────────────────────────────
 * React 协调一个孩子时,若新元素的 `props` 与旧 fiber 的 `memoizedProps` **是同一个
 * 对象**(`oldProps === newProps`),而且这一格上没有排着的更新、context 也没变,
 * 它直接走 `bailoutOnAlreadyFinishedWork` —— 连 memo 的比较函数都不调,整棵子树跳过。
 * 同一个元素对象的 `props` 当然是同一个对象,所以**交回旧元素 = 这一行零成本**。
 * 412 行里只有活的那一两行输入变了、真造元素。
 *
 * 这不改变「谁在什么时候重渲」的语义:一行自己的状态更新、它订的 store、它读的
 * context 变了,React 照样沿 `childLanes` 找下去重渲它(bailout 只跳过**父层推下来**
 * 的那一次);而父层推下来的那一次,输入逐格 `===` 相同时它本来就会被 memo 短路掉
 * —— 结果逐像素相同,省掉的只是走到短路那一步的路费。
 *
 * ── 输入由调用方列,账只比 ──────────────────────────────────────────────────
 * 「这一行元素依赖什么」只有造元素的那一处说得清(它在 `ChatStream.tsx` 里,挨着
 * 那几只组件);这里不认识消息、不认识组件,只做一件事:**上一次记的输入与这一次
 * 逐格 `===` 全等,就交回上一次造的那一组元素**。漏列一格输入 = 那一格变了屏幕不跟,
 * 所以输入清单写在造元素的那一行旁边,判词也在那儿。
 *
 * 一格记的是**一组**元素而不是一个:用户消息那一行后面可能跟着一道上下文更新折痕,
 * 两者同属那条消息(判词在 `ChatStream.tsx` 那张表上),同进同退。
 *
 * ── 寿命 ────────────────────────────────────────────────────────────────────
 * 账挂在**一次 `ChatStream` 挂载**上(调用方用 ref 持有,换会话换一本新的),不是模块级
 * —— 所以不必配 HMR 退役,也不会有两片叶共用一本账的问题。
 * 每一遍渲染 `begin()` 起、`end()` 收:这一遍没被 `take` 到的格(消息被删 / 窗口外 /
 * 重试截掉)在 `end()` 时摘掉,账的大小永远等于列里此刻的行数。
 * 渲染期写 ref 在并发渲染下是安全的:一遍被丢弃的渲染记下的元素,仍是它那组输入的
 * 正确元素(造元素是输入的纯函数),下一遍拿来用逐字等价;被丢弃那一遍没走到 `end()`,
 * 也就没摘过任何一格。
 */

/** 一行元素依赖的全部输入,逐格 `===` 比。 */
export type RowInputs = readonly unknown[]

/**
 * 两组输入是不是**逐格同一个值**。纯函数。
 *
 * 用 `===` 而不是 `Object.is`:与 React memo 的浅比口径对齐只差 `NaN` / `±0`,
 * 而这里的输入是对象引用、布尔、字符串与函数,不会碰到那两种值。
 */
export function sameRowInputs(a: RowInputs, b: RowInputs): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

interface RowEntry {
  inputs: RowInputs
  elements: readonly ReactElement[]
  /** 最近一次被 `take` 到的是第几遍(`end()` 按它摘掉这一遍没用到的格)。 */
  pass: number
}

export class RowElementBook {
  private readonly entries = new Map<string, RowEntry>()
  private pass = 0
  /** 这一遍 `take` 到了几格 —— 等于账的大小时 `end()` 不必逐格扫。 */
  private touched = 0

  /** 一遍渲染开始。 */
  begin(): void {
    this.pass += 1
    this.touched = 0
  }

  /**
   * 这一行的元素。输入与上一次逐格相同 → 交回**同一组**元素对象;否则 `build()` 现造、
   * 记下。`id` 在一遍里不许重复(调用方用的是消息 id / 在飞那一格的 id,本来就唯一)。
   */
  take(id: string, inputs: RowInputs, build: () => readonly ReactElement[]): readonly ReactElement[] {
    const held = this.entries.get(id)
    if (held) {
      /* 同一遍里被 take 两次只算一次,`touched` 才与账的大小可比。 */
      if (held.pass !== this.pass) {
        held.pass = this.pass
        this.touched += 1
      }
      if (sameRowInputs(held.inputs, inputs)) return held.elements
      held.inputs = inputs
      held.elements = build()
      return held.elements
    }
    const elements = build()
    this.entries.set(id, { inputs, elements, pass: this.pass })
    this.touched += 1
    return elements
  }

  /** 一遍渲染收尾:摘掉这一遍没用到的格(消息被删 / 窗口外 / 重试截掉)。 */
  end(): void {
    /* 这一遍用到的格数等于账的大小 = 一格都没多,流式期间几乎每帧都走这条。 */
    if (this.touched === this.entries.size) return
    for (const [id, entry] of this.entries) {
      if (entry.pass !== this.pass) this.entries.delete(id)
    }
  }

  /** 账里此刻记着几格(单测用)。 */
  get size(): number {
    return this.entries.size
  }
}
