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

import type { JsonObject } from '@onething/core/json'
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

/**
 * `Outcome` → **带载荷的**域信封(K2c-3)。
 *
 * ## 它为什么不是 `foldOutcomeToEnvelope` 的一个可选参数
 *
 * 因为那只函数答的是一句完整的话:「写面的 `ok` 折成 `{ success: true }`,回执没有
 * 载荷」—— 本仓那批写面绝大多数逐条如此。给它加一个可选的 `project` 会让这句话变成
 * 「回执可能有载荷也可能没有」,而读它的人再也说不出哪个域是哪一种。两只函数,
 * 两句话,各自成立。
 *
 * ## 谁需要它
 *
 * 少数写面的回执**带着做法自己算出来的事实**,而那些事实调用方算不出来:
 * `sessions.delete` 的 `deletedCount`(级联删掉了几条),两条标记消息删除的
 * `removedId`(按标记找回来的那条消息是哪一条)。
 *
 * ## 载荷从哪来:`Result.details`,不是 `content`
 *
 * `Outcome.ok` 带的是一份 `Result`,而 `Result` 有两半:`content` 是给模型看的那段
 * 话,`details` 是结构化的那一份(`core/toolkit/result.ts` 上写着它的用途是「渲染器 /
 * 审计用的结构化载荷,对内核不透明」,而 `OutputBudget` 只裁 `content`,`details`
 * 原样过)。域要的永远是后者 —— 从 `content` 里把 JSON 解析回来,是把一次调用做成
 * 「一次往返、一次形状损失」(`undefined` 会在那趟往返里消失,K2c-1 在真店上量到过)。
 *
 * 所以 provider 的责任是**把结构化的那一份放进 `details`**,这只函数的责任只是把它
 * 交给域。失败那四支与 `foldOutcomeToEnvelope` 逐字同一套口径。
 */
export interface FoldDetailedOutcomeOptions<T extends object> extends FoldOutcomeOptions {
  /** 这次调用的 `Result.details` → 这个域的信封载荷。只在 `ok` 那一支被调用。 */
  readonly project: (details: JsonObject | undefined) => T
}

export function foldOutcomeToDetailedEnvelope<T extends object>(
  outcome: Outcome,
  options: FoldDetailedOutcomeOptions<T>,
): ({ success: true } & T) | { success: false; error: string } {
  if (outcome.kind === 'ok') return { success: true, ...options.project(outcome.result.details) }
  return foldOutcomeToEnvelope(outcome, options) as { success: false; error: string }
}

/**
 * `ReadOutcome` → **一个裸值**(音乐收尾这一单)。
 *
 * ## 它为什么不是 `foldReadOutcomeToEnvelope` 的一个分支
 *
 * 因为有些域的读面契约上**根本没有 `success` 那一格**:`music.getNowPlaying` 答的是
 * `MusicNowPlaying | null`、`music.getRadio` 答的是一份简报、`music.getLyrics` 答的是
 * 歌词或者 `null`。它们从前就是「调一只函数,它抛就让派发器去接」,所以退成投影之后
 * 也只能是同一句话 —— 折进一个信封等于悄悄改了这些方法的返回形状,而对外契约一个字
 * 不许改是这一批的硬约束。
 *
 * 非 `ok` 一律**抛**,而且 `failed` 那一支抛的是管线交回来的**那只错本身**,不是一个
 * 新造的:判据读类不读消息串(`core/tools/abort.ts` 那条判例),而域的派发器接住之后
 * 答的仍是它一直在答的那个 `{ ok:false, error }`。域想给这次失败起个自己的名字时,
 * `describeError` 与另外两只函数逐字同一格。
 */
export function unwrapReadOutcome<T>(outcome: ReadOutcome, options: FoldOutcomeOptions = {}): T {
  switch (outcome.kind) {
    case 'ok':
      return outcome.value as T
    case 'invalid':
      throw new Error(outcome.message)
    case 'denied':
      throw new Error(outcome.reason)
    case 'failed': {
      const named = options.describeError?.(outcome.error)
      throw named ? new Error(named) : outcome.error
    }
  }
}
