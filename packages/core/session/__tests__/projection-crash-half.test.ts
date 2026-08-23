/**
 * M5 裁定的读侧证据(§13.12 / §13.15)。
 *
 * 场景 W-B(F12):进程在助手**文本流中途**被杀。`assistant/chunks` 是攒批落盘的,
 * 所以事件里有用户**实际已看到的半篇**;而 `messages.jsonl` 的那格正文要到
 * `part-end` / `run-end` 才 flush —— 崩溃时它是 `content:''`(flush 缺口,不是
 * `sanitizeSessionOnStartup` 清的:那个纯函数 `computeMessageRepair` 只清
 * `isStreaming` + 修中断 step,从不动 `content`)。
 *
 * **裁定:投影为准,保留半篇。** 这里钉住的是:`events` 读模式的投影
 * (`projectChatMessages`)从 chunks 折出那半篇 —— 哪怕这条 run **没有** `part-end`、
 * 没有 `run/end`(纯崩溃),或只补了 `prepare` 合成的 `run/end{interrupted}`。
 * 这正是切默认到 `events` 之后崩溃恢复"更接近用户所见"的来源;所以 M5 的读路径
 * **无需改代码**,本测试是它的回归护栏。把 chunks 的 fold 改成"要 part.ended 才算"
 * 会当场红。
 */
import { describe, expect, it } from 'vitest'
import { projectChatMessages } from '../projection/index.js'
import type { SessionLogEventRecord } from '../events/index.js'

const HALF = '这是一句只写到一半就被'

/** 崩在文本流中途:user + run/start + 一条 text chunk,然后……什么都没有。 */
function crashHalfEvents(withInterruptedRunEnd: boolean): SessionLogEventRecord[] {
  const events: Record<string, unknown>[] = [
    { seq: 1, time: 1, type: 'user/message', data: { message: { id: 'u1', role: 'user', content: '写一句话', timestamp: 1 } }, surfaceOp: 'append' },
    { seq: 2, time: 2, type: 'run/start', data: { runId: 'r1', kind: 'send', assistantMessageId: 'a1', timestamp: 2 }, surfaceOp: 'append' },
    // 攒批落盘的半篇 —— 没有随后的 assistant/part-end。
    { seq: 3, time: 3, type: 'assistant/chunks', data: { runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text', time0: 1, dt: [0], text: [HALF] } },
  ]
  if (withInterruptedRunEnd) {
    // prepare 冷加载合成的收尾(§11.1):只补 run/end,**不**补 part-end。
    events.push({ seq: 4, time: 4, type: 'run/end', data: { runId: 'r1', outcome: 'interrupted' } })
  }
  return events as unknown as SessionLogEventRecord[]
}

describe('M5 crash-truncated text stream (events read mode keeps the half)', () => {
  it('projects the half from assistant/chunks even with the run still open (no part-end, no run/end)', () => {
    const { messages } = projectChatMessages(crashHalfEvents(false))
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant'])
    const assistant = messages[1]
    // 半篇在,不是空 —— 这才是"投影为准"。
    expect(assistant.content).toBe(HALF)
    expect(assistant.content).not.toBe('')
  })

  it('still keeps the half after prepare synthesizes run/end{interrupted}', () => {
    const { messages } = projectChatMessages(crashHalfEvents(true))
    const assistant = messages[1]
    expect(assistant.content).toBe(HALF)
    // 收尾只改状态,不该抹掉已折出的正文。
    expect(assistant.isStreaming).not.toBe(true)
  })
})
