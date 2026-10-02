/**
 * K2c-2 —— 「读」自己那一种结局(`docs/design/atom-2026-09.md` §2 不变量 1「读无
 * 效果」;本单是原子方案对**读**的一次修正)。
 *
 * ## 为什么读需要一个自己的结局类型,而不是复用 `Outcome`
 *
 * `Outcome.ok` 装的是 `Result` —— 一段**给模型看的文本**(`toolkit/result.ts`)。
 * 那对「做」是对的:一次做完之后要交给模型的就是一句话。但一次读的答案是**一个
 * 值**:一页消息、一份元数据、一张读数表。把它塞进 `Outcome` 只有一条路 ——
 * `JSON.stringify` 进文本、调用方再 `JSON.parse` 回来。K2c-1 在真店(483 条会话)
 * 量出这条路的三处硬伤,原文记在 `runtime/sessions/resource-spec.ts` 的文件头:
 *
 *   ① 那段文本要过 `OutputBudget`(4000 行 / 256KB),一页 20 条消息就能越界,
 *      越界之后交给壳的是一段带 `<truncation>` 的文本,不是那一页;
 *   ② 全量序列化往返本身是白花的两次遍历,而且 `undefined` 在往返里消失;
 *   ③ 管线每跑完一次落一条 `tool/audit`(无发起会话那一档是同步 `appendFileSync`),
 *      而那本账的流量假设是「人点一次按钮」,不是界面每翻一页。
 *
 * 三条的共同点:它们全都是**「做」那条管线的正确行为**,只是读不该走那条管线。
 * §2 不变量二说的是「每一次**做**经过同一条管线」—— 读从来不在那句话的要求里,
 * K1 让读也走 `ToolRunner` 是一条捷径,K2c-2 把它还回去。
 *
 * ## 四支,没有 `aborted`
 *
 * 「做」有五支,读只有四支,少的是 `aborted`。这是想清楚的:一次被掐断的**做**
 * 与一次失败的做是两件事(前者可能已经写了一半,后者没有),所以要分开说;而一次
 * 被掐断的**读**没有任何后果 —— 它与「没读成」在调用方那里是同一件事,归因写在
 * 那只 `AbortError` 上,由读到它的人自己判(`core/tools/abort.ts` 那条判例:判类
 * 不判措辞)。为一个没有区别的区别开一支,每个调用方都得多写一个分支。
 *
 * ## `denied` 为什么留着 —— 它今天还没有产地
 *
 * 读不进权限管线(读无效果,授权者恒静默放行),所以 `denied` 只可能来自
 * `ReadGuard`(`kernel.ts` 的那只可选端口),而今天没有宿主装它。留这一支是因为
 * 「命名空间许可」与「这条 ref 归不归你」是已经写在设计正本里的下一步 —— 到那时
 * 补的是一只端口的实现,不是给这个联合改形状(改形状要动每一个调用方)。
 */

/**
 * 一次读的结局。四支,判别键与 `Outcome` **同名同义**(`ok` / `invalid` /
 * `denied` / `failed`),是一次转手不是翻译:同一个词在两个类型里指的是同一件事。
 */
export type ReadOutcome =
  /** 读到了。`value` 是读法自己交出来的那个值 —— 内核不解释、不包装、不序列化。 */
  | { readonly kind: 'ok'; readonly value: unknown }
  /** 这次调用本身不成立(没有这条读法、地址不是本 scheme 的)。 */
  | { readonly kind: 'invalid'; readonly message: string }
  /** 守卫说不。见文件头:今天没有产地。 */
  | { readonly kind: 'denied'; readonly reason: string }
  /** 真的读不出来(实现抛了,或者信号响了)。 */
  | { readonly kind: 'failed'; readonly error: Error; readonly message: string }

function ok(value: unknown): ReadOutcome {
  return { kind: 'ok', value }
}

function invalid(message: string): ReadOutcome {
  return { kind: 'invalid', message }
}

function denied(reason: string): ReadOutcome {
  return { kind: 'denied', reason }
}

/**
 * 非 `Error` 的抛出物归一化成 `Error` —— 与 `Outcome.failed` 逐字同一句话:
 * 判定读的是类名,而一个 `throw 'nope'` 没有类名。
 */
function failed(error: unknown): ReadOutcome {
  const normalized = error instanceof Error ? error : new Error(String(error))
  return { kind: 'failed', error: normalized, message: normalized.message }
}

function isOk(outcome: ReadOutcome): outcome is Extract<ReadOutcome, { kind: 'ok' }> {
  return outcome.kind === 'ok'
}

export const ReadOutcome = { ok, invalid, denied, failed, isOk }
