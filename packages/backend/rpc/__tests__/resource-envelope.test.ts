/**
 * K2c-1 —— `foldOutcomeToEnvelope` 的五支(`rpc/resource-envelope.ts`)。
 *
 * 一只纯函数值得一组用例,是因为它是**每个退成投影的域共用的那一步**:哪一支折成
 * `success:false`、哪一句话交出去,写错一处就是一个域的契约变了,而域自己的用例
 * 只看得见最终信封,看不见是这里折错的。
 */
import { describe, expect, it } from 'vitest'
import { Outcome, TOOL_CANCELLED_MESSAGE, textResult } from '@onething/core/toolkit'
import { foldOutcomeToEnvelope } from '../resource-envelope.js'

class DomainSpecificError extends Error {
  constructor() {
    super('the raw words from the pipeline')
    this.name = 'DomainSpecificError'
  }
}

describe('foldOutcomeToEnvelope(K2c-1)', () => {
  it('ok → success:true,不带载荷(要带的域自己 spread)', () => {
    expect(foldOutcomeToEnvelope(Outcome.ok(textResult('Renamed session to X')))).toEqual({ success: true })
  })

  it('invalid → 校验者写的那句话,不加前缀', () => {
    expect(foldOutcomeToEnvelope(Outcome.invalid('session has no op named "nope"'))).toEqual({
      success: false,
      error: 'session has no op named "nope"',
    })
  })

  it('denied → 授权者写的那句话', () => {
    expect(foldOutcomeToEnvelope(Outcome.denied('User rejected this tool call'))).toEqual({
      success: false,
      error: 'User rejected this tool call',
    })
  })

  it('aborted → 失败,不是成功;没给理由就用取消那句话', () => {
    // 一次被掐断的写**没有发生**。折成 success:true 会让界面把没写下去的东西
    // 当成写下去了 —— 那正是「乐观更新之后不对账」那一类病的源头。
    expect(foldOutcomeToEnvelope(Outcome.aborted())).toEqual({
      success: false,
      error: TOOL_CANCELLED_MESSAGE,
    })
    expect(foldOutcomeToEnvelope(Outcome.aborted('the caller went away'))).toEqual({
      success: false,
      error: 'the caller went away',
    })
  })

  it('failed → 管线那句话;域给了说法就用域的(判据是类,不是消息串)', () => {
    const failure = Outcome.failed(new DomainSpecificError())

    expect(foldOutcomeToEnvelope(failure)).toEqual({
      success: false,
      error: 'the raw words from the pipeline',
    })

    expect(foldOutcomeToEnvelope(failure, {
      describeError: error => (error instanceof DomainSpecificError ? 'Session not found' : undefined),
    })).toEqual({ success: false, error: 'Session not found' })

    // 回 undefined = 「本域对这个类没有专属说法」,于是照旧用管线那句话。
    expect(foldOutcomeToEnvelope(failure, { describeError: () => undefined })).toEqual({
      success: false,
      error: 'the raw words from the pipeline',
    })
  })

  it('describeError 只管 failed —— invalid / denied 的文案各有产地,域改不动', () => {
    const rewrite = { describeError: () => 'REWRITTEN' }
    expect(foldOutcomeToEnvelope(Outcome.invalid('as written'), rewrite)).toEqual({
      success: false,
      error: 'as written',
    })
    expect(foldOutcomeToEnvelope(Outcome.denied('as decided'), rewrite)).toEqual({
      success: false,
      error: 'as decided',
    })
  })
})
