/**
 * K2c-1 —— `Outcome` → 域信封(`docs/design/atom-2026-09.md` §4「RPC 域」那一行:
 * 「24 个手写域逐个退成投影」)。
 *
 * ## 为什么需要这一只函数
 *
 * 一个域退成投影之后,处理器只剩三件事:拼参数、`backend.resources.do/read`、
 * **把 `Outcome` 折回这个域一直在答的那个信封**。前两件每个域各自不同,第三件
 * 每个域都一样 —— 因为 `Outcome` 的五支是内核定的,不是某个域的私事。写第二遍
 * 就会开始有第二种口径:一个域把 `denied` 折成 `error`,另一个折成 `success:true`
 * 加一句提示,而客户端分不出来。所以它在这里,而且是**纯函数**:不读进程状态、
 * 不认识任何 scheme、不认识任何一个域。
 *
 * ## 五支各折成什么,以及为什么
 *
 * | Outcome | 信封 | 理由 |
 * | --- | --- | --- |
 * | `ok` | `{ success: true }` | 成功就是成功;要带载荷的域自己往上 spread。 |
 * | `invalid` | `{ success: false, error: message }` | 请求本身不成立。文案是校验者写的,这里不加前缀(与 `Outcome.toModelText` 对 `invalid` 不加前缀同一条判例)。 |
 * | `denied` | `{ success: false, error: reason }` | 人或策略说不。`reason` 已经是给人看的那句话。 |
 * | `aborted` | `{ success: false, error: reason ?? 取消那句话 }` | 信号响了。**不折成成功** —— 一次被掐断的写没有发生。 |
 * | `failed` | `{ success: false, error: describeError(err) ?? message }` | 真的炸了。 |
 *
 * ## `describeError` 为什么是回调,不是一张错误名对照表
 *
 * 「这次失败在**这个域**的契约里叫什么」只有域自己知道:会话域把
 * `SessionNotFoundError` 叫 `'Session not found'`(那是它二十六条方法共用的那句
 * 话),别的域对同一个类可能根本没有对应的措辞。让这只函数持有一张表,等于让
 * 一个通用件认识每一个域 —— 那正是它想消灭的形状。回调回 `undefined` = 「没有
 * 域专属的说法」,于是用管线那句话。
 *
 * 判据是**类**不是消息串(`core/tools/abort.ts` 那条判例:靠消息文本分类,迟早
 * 把一次失败洗成一次别的东西)—— 所以回调收到的是 `Error` 对象本身。
 */

import type { ReadOutcome } from '@onething/core/resource'
import { TOOL_CANCELLED_MESSAGE, type Outcome } from '@onething/core/toolkit'

/** 本仓那批写面共用的回执形状(`@shared/ipc/sessions.ts` 的 `SessionMutationResponse` 等)。 */
export type ResourceEnvelope =
  | { success: true }
  | { success: false; error: string }

export interface FoldOutcomeOptions {
  /**
   * 给一次 `failed` 起一个域自己的名字。回 `undefined` = 用 `Outcome` 带的那句话。
   * 只在 `failed` 那一支被调用 —— `invalid` / `denied` 的文案各有各的产地,不该
   * 被域改写。
   */
  readonly describeError?: (error: Error) => string | undefined
}

export function foldOutcomeToEnvelope(
  outcome: Outcome,
  options: FoldOutcomeOptions = {},
): ResourceEnvelope {
  switch (outcome.kind) {
    case 'ok':
      return { success: true }
    case 'invalid':
      return { success: false, error: outcome.message }
    case 'denied':
      return { success: false, error: outcome.reason }
    case 'aborted':
      return { success: false, error: outcome.reason ?? TOOL_CANCELLED_MESSAGE }
    case 'failed':
      return { success: false, error: options.describeError?.(outcome.error) ?? outcome.message }
  }
}

/**
 * `ReadOutcome` → 域信封(K2c-2)。
 *
 * ## 它为什么不是上面那只函数的一个分支
 *
 * 因为读的成功那一支**带着东西**:一页消息、一份记录、一张读数表。写面的 `ok` 折成
 * `{ success: true }` 就完了(回执没有载荷),读面的 `ok` 必须让域说出「这个值在我
 * 的契约里叫什么」——`messages` 还是 `markers` 还是 `segments`。那句话只有域知道,
 * 所以它是一个回调(`project`),与 `describeError` 是同一条理由:一个通用件不认识
 * 任何一个域。
 *
 * 失败那三支与写面**逐字同一套口径**(`invalid` 用校验者的话、`denied` 用守卫的话、
 * `failed` 先问域再退回管线那句),所以两条路上同一次失败在客户端看到的是同一句话。
 * 读没有 `aborted` 那一支(`core/resource/read-outcome.ts` 的文件头)。
 */
export interface FoldReadOutcomeOptions<T extends object> extends FoldOutcomeOptions {
  /** 读到的值 → 这个域的信封载荷。只在 `ok` 那一支被调用。 */
  readonly project: (value: unknown) => T
}

export function foldReadOutcomeToEnvelope<T extends object>(
  outcome: ReadOutcome,
  options: FoldReadOutcomeOptions<T>,
): ({ success: true } & T) | { success: false; error: string } {
  switch (outcome.kind) {
    case 'ok':
      return { success: true, ...options.project(outcome.value) }
    case 'invalid':
      return { success: false, error: outcome.message }
    case 'denied':
      return { success: false, error: outcome.reason }
    case 'failed':
      return { success: false, error: options.describeError?.(outcome.error) ?? outcome.message }
  }
}
