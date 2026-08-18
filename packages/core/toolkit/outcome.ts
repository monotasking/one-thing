/**
 * §3 内核 —— `Outcome`:一次调用的五种结局,判别联合,不是 `success: boolean`。
 *
 * 为什么值得一个类型:今天"被用户取消"和"工具炸了"最后都变成一条 isError 的
 * 文本,模型分不清该重试还是该换路,审计也分不清该记事故还是记一次正常打断。
 *
 * 内核在这里**不发明用户可见文案**:`denied` 的文本由 Authorizer 给(R2 里那是
 * core `Permission` 的 `formatPermissionRejectedMessage`),`aborted` 的措辞与
 * `core/tools/tool-result.ts` 里 cancelled 的口径对齐。
 */

import { isToolAbortError } from '../tools/abort.js'
import { isToolTimeoutError } from './abort-scope.js'
import type { Result } from './result.js'
import { resultToText } from './result.js'

/** 与 core/tools/tool-result.ts 里 cancelled 分支同一句话,避免两处措辞打架。 */
export const TOOL_CANCELLED_MESSAGE = 'Tool execution was cancelled.'

/** 取消结局里附上的那段"已经干出来的东西"的开头标签。 */
export const PARTIAL_OUTPUT_OPEN_TAG = '<partial_output>'
export const PARTIAL_OUTPUT_CLOSE_TAG = '</partial_output>'

export type Outcome =
  | { readonly kind: 'ok'; readonly result: Result }
  /** 输入不合契约。责任在模型,重发一次可能就对了。 */
  | { readonly kind: 'invalid'; readonly message: string }
  /** 人或策略说不。责任不在任何一方,别重试。 */
  | { readonly kind: 'denied'; readonly reason: string }
  /**
   * 信号响了。尺子③:任何阶段、任何工具,恒是这一种。
   *
   * R2a 决定④:可以附一段 `partial` —— 取消发生前工具最后一次 `partial` 事件的
   * 内容。旧 bash 把已收到的输出塞进取消错误的**消息**里,那是唯一让模型知道
   * "跑到哪儿了"的路;新树把它挪到一个有名字的字段上,措辞与结局分家,但那段
   * 信息不再丢。**Runner 填它,工具不填** —— 工具只管 emit。
   */
  | { readonly kind: 'aborted'; readonly reason?: string; readonly partial?: Result }
  /** 真的炸了。工具越权(声明外的效果)也算在这里 —— 那是工具的 bug。 */
  | { readonly kind: 'failed'; readonly error: Error; readonly message: string }

function ok(result: Result): Outcome {
  return { kind: 'ok', result }
}

function invalid(message: string): Outcome {
  return { kind: 'invalid', message }
}

function denied(reason: string): Outcome {
  return { kind: 'denied', reason }
}

function aborted(reason?: string, partial?: Result): Outcome {
  return { kind: 'aborted', reason, partial }
}

/**
 * 给一个已经成型的取消结局补上尾部。Runner 在 `finally` 里用它 —— `fromError`
 * 那条路造 Outcome 时还不知道最后一条 partial 是什么。
 */
function withPartial(outcome: Outcome, partial: Result | undefined): Outcome {
  if (!partial || outcome.kind !== 'aborted' || outcome.partial) return outcome
  return { ...outcome, partial }
}

function failed(error: unknown): Outcome {
  const normalized = error instanceof Error ? error : new Error(String(error))
  return { kind: 'failed', error: normalized, message: normalized.message }
}

/**
 * 分类只看错误对象与作用域状态,永不看消息文本(见 core/tools/abort.ts 的头注释:
 * 一条引用了文件内容的失败消息里出现 "abort" 字样并不代表用户取消了)。
 *
 * **给了 scope 时,判据只有一个:`scope.aborted`。** 抛出物是不是 AbortError 不算数
 * —— 一个 `scope.child({timeoutMs})` 到点抛的同样是 AbortError,但那是"这一页
 * fetch 超时了",不是"用户按了停止";按错误对象判会把工具的失败洗成用户的取消,
 * 于是重试逻辑不重试、事故统计里也看不见它。反过来,信号确实响了的时候,执行体
 * 抛的是自己的错(子进程 exit 1、fetch TypeError)也一律算取消。
 *
 * 不给 scope 的直接调用方(内核外)退回按错误对象判 —— 它们没有作用域可问。
 */
function fromError(error: unknown, scope?: { readonly aborted: boolean; readonly reason?: string }): Outcome {
  if (scope) return scope.aborted ? aborted(scope.reason) : failed(error)
  if (isToolAbortError(error) && !isToolTimeoutError(error)) {
    const message = error instanceof Error ? error.message : undefined
    return aborted(message)
  }
  return failed(error)
}

/**
 * 投影成给模型看的文本。渲染器/审计各有自己的投影,不复用这一个。
 *
 * R2a 决定③:`invalid` **不加** `Invalid tool input: ` 前缀。每个工具的
 * `formatValidationError` 已经自带一句"你哪儿写错了 + 正确用法"(read 那句甚至
 * 带完整签名),再包一层等于把工具精心写的第一句话推到第二行;旧管线也从来是把
 * `formatValidationError` 的文本原样交给模型的。前缀由**消费者**决定要不要加,
 * 不由内核发明。
 */
function toModelText(outcome: Outcome): string {
  switch (outcome.kind) {
    case 'ok': return resultToText(outcome.result)
    case 'invalid': return outcome.message
    case 'denied': return outcome.reason
    case 'aborted': {
      const head = outcome.reason ? `${TOOL_CANCELLED_MESSAGE} ${outcome.reason}` : TOOL_CANCELLED_MESSAGE
      const tail = outcome.partial ? resultToText(outcome.partial).trim() : ''
      return tail
        ? `${head}\n\n${PARTIAL_OUTPUT_OPEN_TAG}\n${tail}\n${PARTIAL_OUTPUT_CLOSE_TAG}`
        : head
    }
    case 'failed': return `Tool execution failed: ${outcome.message}`
  }
}

function isOk(outcome: Outcome): outcome is Extract<Outcome, { kind: 'ok' }> {
  return outcome.kind === 'ok'
}

export const Outcome = { ok, invalid, denied, aborted, failed, fromError, withPartial, toModelText, isOk }
