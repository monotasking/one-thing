/**
 * R1:**账本身份章的对账**(`apps/desktop-react/docs/stream-render-2026-09.md`)。
 *
 * 章说的是「这条 delta 是账本哪一段的第几个字符起的那一截」。这条测试要证的正是
 * 那句话不是空话 —— **按章拼出来的每一段,与打包行 decode 出来的那一段逐字节相等,
 * 偏移逐格衔接、无洞无重**。前缀定律(R2 正确性的地基)全靠它。
 *
 * 为什么是这里、为什么用真记录器:章的唯一产地是打包器那台机器
 * (`chunk-codec` 的段边界状态机 + 编码器 `onDelta`),审查条 2 明令**不许第二处
 * 编号**。所以对账必须拿**同一次跑**的两份产物比 —— 一份是台上交出的章,一份是
 * 落到账本上的打包行。两份同源才叫对账;各喂各的只是自说自话。
 *
 * 另加两组**性质**(审查条 7 的第一块砖):乱序喂、重分片喂,终态逐字节同 ——
 * 「按章重组与到达次序无关」的机器证明。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStreamEvent } from '@onething/core/agent-loop'
import type { SessionAssistantChunksEvent } from '@onething/core/session'
import type { StreamDeltaStamp } from '@shared/events/index.js'

const state = vi.hoisted(() => ({ storeDir: '', sessionsDir: '' }))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingSessionsDir: () => state.sessionsDir,
  getOnethingLogDir: () => path.join(state.storeDir, 'log'),
}))

vi.mock('../../../../session/shadow.js', () => ({
  scheduleSessionRunShadow: () => undefined,
  checkSessionRunShadow: () => 'skipped',
  checkSessionHistoryShadow: () => 'skipped',
  resetSessionShadowCache: () => undefined,
}))

const { flushSessionEventLog, readSessionLogEvents, resetSessionEventLogCache } = await import(
  '../../../../session/event-log.js'
)
const { resetSessionSurfaceCache } = await import('../../../../session/event-surface.js')
const { beginSessionRun, resetSessionRuns } = await import('../../../../session/runs.js')
const { resetSessionEventStatsCache } = await import('../../../../session/event-stats.js')
const { createSessionEventRecorder } = await import('../session-event-recorder.js')
const { createStreamBuffer, appendStreamBufferChunk, drainStreamBuffer, SessionStreamCoalescer } = await import(
  '../../../../events/stream-coalescer.js'
)
const { offerDeltaStamp, claimDeltaStamp, clearDeltaStamps } = await import(
  '../../../../events/delta-stamp.js'
)

const SESSION = 'stamp'

/** 台面上交出来的一枚章 + 它那条 delta 的原文。 */
interface Minted {
  kind: 'text' | 'reasoning' | 'tool-input'
  text: string
  toolCallId?: string
  stamp: StreamDeltaStamp
}

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-stamp-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
  fs.writeFileSync(path.join(state.sessionsDir, SESSION, 'meta.json'), '{}')
  resetSessionEventLogCache()
  resetSessionSurfaceCache()
  resetSessionRuns()
  resetSessionEventStatsCache()
  clearDeltaStamps()
  beginSessionRun(SESSION, { kind: 'send', assistantMessageId: 'a1' })
})

afterEach(async () => {
  await flushSessionEventLog()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
  clearDeltaStamps()
})

function run(events: AgentStreamEvent[]): Minted[] {
  const minted: Minted[] = []
  const recorder = createSessionEventRecorder({
    sessionId: SESSION,
    providerId: 'p',
    model: 'm',
    systemPrompt: 'sys',
    tools: [],
    getMessageId: () => 'a1',
    offerDeltaStamp: slot => { minted.push({ ...slot }) },
  })
  for (const event of events) recorder.handle(event)
  recorder.flush()
  return minted
}

async function packedParts(): Promise<Map<number, string>> {
  await flushSessionEventLog(SESSION)
  const rows = (await readSessionLogEvents(SESSION)).filter(
    (event): event is SessionAssistantChunksEvent => event.type === 'assistant/chunks',
  )
  const parts = new Map<number, string>()
  for (const row of rows) {
    parts.set(row.data.partIndex, (parts.get(row.data.partIndex) ?? '') + row.data.text.join(''))
  }
  return parts
}

/** 按章重组:每段按 `charOffset` 排好再拼。**到达次序在这里被丢掉**——那正是要证的。 */
function assembleByStamp(minted: readonly Minted[]): Map<number, string> {
  const byPart = new Map<number, Minted[]>()
  for (const one of minted) {
    const bucket = byPart.get(one.stamp.partIndex)
    if (bucket) bucket.push(one)
    else byPart.set(one.stamp.partIndex, [one])
  }
  const out = new Map<number, string>()
  for (const [partIndex, list] of byPart) {
    out.set(
      partIndex,
      [...list].sort((a, b) => a.stamp.charOffset - b.stamp.charOffset).map(one => one.text).join(''),
    )
  }
  return out
}

/** 偏移逐格衔接:从 0 起,每条的起点 = 上一条的起点 + 上一条的长度。 */
function offsetGaps(minted: readonly Minted[]): string[] {
  const byPart = new Map<number, Minted[]>()
  for (const one of minted) {
    const bucket = byPart.get(one.stamp.partIndex)
    if (bucket) bucket.push(one)
    else byPart.set(one.stamp.partIndex, [one])
  }
  const bad: string[] = []
  for (const [partIndex, list] of byPart) {
    let expected = 0
    for (const one of list) {
      if (one.stamp.charOffset !== expected) {
        bad.push(`part ${partIndex}: 期望偏移 ${expected},章上写的是 ${one.stamp.charOffset}`)
      }
      expected = one.stamp.charOffset + one.text.length
    }
  }
  return bad
}

const cut = (text: string, size: number): string[] => text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? []

/** 一段「说话 → 想 → 说话 → 调工具」的流,按 `size` 切片。 */
function script(size: number): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [{ type: 'turn-start', turn: 1 } as AgentStreamEvent]
  const say = (kind: 'text-delta' | 'reasoning-delta', text: string) => {
    for (const piece of cut(text, size)) events.push({ type: kind, turn: 1, delta: piece } as AgentStreamEvent)
  }
  say('reasoning-delta', '先想一想要说什么,想得久一点好跨过打包闸。')
  say('text-delta', '第一段正文。它与推理各自成段,段号不共用。')
  say('reasoning-delta', '再想一层:换 kind 就换段,这是边界机器的第一条规矩。')
  say('text-delta', '第二段正文,收在工具调用之前。')
  events.push({ type: 'tool-call-start', turn: 1, toolCallId: 'c1', toolName: 'time' } as AgentStreamEvent)
  for (const piece of cut('{"action":"now","timezone":"Asia/Shanghai"}', size)) {
    events.push({ type: 'tool-call-delta', turn: 1, toolCallId: 'c1', argumentsDelta: piece } as AgentStreamEvent)
  }
  return events
}

describe('R1 账本身份章:与打包行同源同数', () => {
  it('按章拼出来的每一段 = 打包行 decode 出来的那一段,逐字节相等', async () => {
    const minted = run(script(6))
    const packed = await packedParts()
    const assembled = assembleByStamp(minted)

    // 段数对得上:章认识的段与账本落下来的段是同一批。
    expect([...assembled.keys()].sort()).toEqual([...packed.keys()].sort())
    for (const [partIndex, text] of assembled) {
      expect(text, `part ${partIndex}`).toBe(packed.get(partIndex))
    }
    // 真的采到了东西(空跑也会让上面两条恒真)。
    expect(assembled.size).toBeGreaterThanOrEqual(4)
    expect([...assembled.values()].join('').length).toBeGreaterThan(80)
  })

  it('偏移逐格衔接:从 0 起,无洞无重', () => {
    expect(offsetGaps(run(script(6)))).toEqual([])
  })

  it('章的身份与打包行同源:messageId / runId / requestIndex / kind 逐格相同', async () => {
    const minted = run(script(6))
    await flushSessionEventLog(SESSION)
    const rows = (await readSessionLogEvents(SESSION)).filter(
      (event): event is SessionAssistantChunksEvent => event.type === 'assistant/chunks',
    )
    const byPart = new Map(rows.map(row => [row.data.partIndex, row.data]))
    for (const one of minted) {
      const row = byPart.get(one.stamp.partIndex)
      expect(row, `part ${one.stamp.partIndex} 该有打包行`).toBeDefined()
      expect(one.stamp.messageId).toBe(row!.messageId)
      expect(one.stamp.runId).toBe(row!.runId)
      expect(one.stamp.requestIndex).toBe(row!.requestIndex)
      expect(one.stamp.kind).toBe(row!.kind)
      // gen:换代律的字段先占位,R1 恒 0。
      expect(one.stamp.gen).toBe(0)
    }
  })

  it('工具参数那一段也盖章(三条车道一视同仁)', () => {
    const minted = run(script(6))
    const toolInput = minted.filter(one => one.stamp.kind === 'tool-input')
    expect(toolInput.length).toBeGreaterThan(0)
    expect(toolInput.map(one => one.text).join('')).toBe('{"action":"now","timezone":"Asia/Shanghai"}')
    expect(new Set(toolInput.map(one => one.stamp.partIndex)).size).toBe(1)
  })
})

describe('R1 性质:乱序无害、重分片同终态(审查条 7 第一块砖)', () => {
  it('乱序喂:打乱到达次序,按章重组的结果一字不差', async () => {
    const minted = run(script(6))
    const ordered = assembleByStamp(minted)
    // 固定种子的洗牌:测试要可重跑,不要今天绿明天红。
    const shuffled = [...minted]
    let seed = 20260901
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648
      const j = seed % (i + 1)
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    expect(assembleByStamp(shuffled)).toEqual(ordered)
  })

  it('重分片喂:同一段话切成 2/3/7/40 字,四次的每段终态逐字节相同', async () => {
    const sizes = [2, 3, 7, 40]
    const results: Array<Map<number, string>> = []
    for (const size of sizes) {
      // 每一轮换一条干净的会话账,免得四次跑的打包行叠在一起。
      resetSessionEventLogCache()
      resetSessionSurfaceCache()
      resetSessionRuns()
      beginSessionRun(SESSION, { kind: 'send', assistantMessageId: 'a1' })
      fs.rmSync(path.join(state.sessionsDir, SESSION), { recursive: true, force: true })
      fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
      fs.writeFileSync(path.join(state.sessionsDir, SESSION, 'meta.json'), '{}')

      const minted = run(script(size))
      expect(offsetGaps(minted), `切片 ${size}`).toEqual([])
      const assembled = assembleByStamp(minted)
      // 同一次跑内先与打包行对账,再拿去与别的切片比 —— 两条都要成立。
      const packed = await packedParts()
      for (const [partIndex, text] of assembled) {
        expect(text, `切片 ${size} part ${partIndex}`).toBe(packed.get(partIndex))
      }
      results.push(assembled)
    }
    for (let i = 1; i < results.length; i += 1) {
      // 逐段比,不拼成一条 —— 拼接要挑分隔符,而任何分隔符都可能出现在正文里。
      expect([...results[i].values()], `切片 ${sizes[i]} 对 ${sizes[0]}`)
        .toEqual([...results[0].values()])
    }
  })
})

describe('R1 交接台:对不上就不给', () => {
  const stamp = (over: Partial<StreamDeltaStamp> = {}): StreamDeltaStamp => ({
    messageId: 'a1', runId: 'r1', requestIndex: 1, partIndex: 0, kind: 'text', charOffset: 0, gen: 0, ...over,
  })

  it('原文对得上才给,而且只给一次', () => {
    offerDeltaStamp('s1', { kind: 'text', text: '你好', stamp: stamp() })
    expect(claimDeltaStamp('s1', 'text', '你好')).toEqual(stamp())
    expect(claimDeltaStamp('s1', 'text', '你好')).toBeUndefined()
  })

  it('原文对不上 = 这条 delta 没走过那台机器,不盖章(宁缺勿错)', () => {
    offerDeltaStamp('s1', { kind: 'text', text: '你好', stamp: stamp() })
    expect(claimDeltaStamp('s1', 'text', '别的字')).toBeUndefined()
  })

  it('车道对不上不给;工具那一路还要对上 toolCallId', () => {
    offerDeltaStamp('s1', { kind: 'text', text: '你好', stamp: stamp() })
    expect(claimDeltaStamp('s1', 'reasoning', '你好')).toBeUndefined()
    offerDeltaStamp('s1', { kind: 'tool-input', text: '{}', toolCallId: 'c1', stamp: stamp({ kind: 'tool-input' }) })
    expect(claimDeltaStamp('s1', 'tool-input', '{}', 'c2')).toBeUndefined()
    expect(claimDeltaStamp('s1', 'tool-input', '{}', 'c1')).toBeDefined()
  })

  it('按会话分格:别的会话取不走这一枚', () => {
    offerDeltaStamp('s1', { kind: 'text', text: '你好', stamp: stamp() })
    expect(claimDeltaStamp('s2', 'text', '你好')).toBeUndefined()
    expect(claimDeltaStamp('s1', 'text', '你好')).toBeDefined()
  })
})

describe('R1 合批器:只搬运,不编号', () => {
  const chunk = (text: string, over: Partial<StreamDeltaStamp>) => ({
    type: 'text-delta' as const,
    text,
    stamp: {
      messageId: 'a1', runId: 'r1', requestIndex: 1, partIndex: 0, kind: 'text' as const, charOffset: 0, gen: 0,
      ...over,
    },
  })

  it('连着的并成一批,批上留的是**批首**那枚章', () => {
    const buffer = createStreamBuffer()
    appendStreamBufferChunk(buffer, chunk('甲', { charOffset: 0 }))
    appendStreamBufferChunk(buffer, chunk('乙', { charOffset: 1 }))
    appendStreamBufferChunk(buffer, chunk('丙', { charOffset: 2 }))
    const out = drainStreamBuffer(buffer)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ text: '甲乙丙', stamp: { charOffset: 0 } })
  })

  it('偏移接不上:另起一条,不许并(并了那枚批首章就在替后半截说假话)', () => {
    const buffer = createStreamBuffer()
    appendStreamBufferChunk(buffer, chunk('甲', { charOffset: 0 }))
    appendStreamBufferChunk(buffer, chunk('丙', { charOffset: 99 }))
    const out = drainStreamBuffer(buffer)
    expect(out).toHaveLength(2)
    expect(out.map(one => (one as { stamp?: StreamDeltaStamp }).stamp?.charOffset)).toEqual([0, 99])
  })

  it('换段:另起一条', () => {
    const buffer = createStreamBuffer()
    appendStreamBufferChunk(buffer, chunk('甲', { charOffset: 0 }))
    appendStreamBufferChunk(buffer, chunk('乙', { partIndex: 3, charOffset: 1 }))
    expect(drainStreamBuffer(buffer)).toHaveLength(2)
  })

  it('两边都没有章:按老规矩并,行为逐字不变', () => {
    const buffer = createStreamBuffer()
    appendStreamBufferChunk(buffer, { type: 'text-delta', text: '甲' })
    appendStreamBufferChunk(buffer, { type: 'text-delta', text: '乙' })
    const out = drainStreamBuffer(buffer)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ text: '甲乙' })
  })

  it('一边有章一边没有:不并 —— 拼起来那枚章就不认识后半截了', () => {
    const buffer = createStreamBuffer()
    appendStreamBufferChunk(buffer, chunk('甲', { charOffset: 0 }))
    appendStreamBufferChunk(buffer, { type: 'text-delta', text: '乙' })
    expect(drainStreamBuffer(buffer)).toHaveLength(2)
  })
})

/**
 * R1:**两条路同一份序列化**。
 *
 * 桌面 IPC(`IPCBridge`)与 web SSE(`server/http.ts`)是**同一台合帧器的两个 sink**
 * —— 一个 `safeSend` 结构化克隆整个对象,一个 `JSON.stringify` 整个对象,两边都不挑
 * 字段。所以「章带没带到」这件事只需要在合帧器的出口证一次:出口带了,两条路就都带了。
 */
describe('R1 出口:合帧器交出去的那一份带着章', () => {
  it('sink 收到的 chunk 上有章,且是批首那一枚', async () => {
    const sent: Array<Record<string, unknown>> = []
    const coalescer = new SessionStreamCoalescer(
      { sendChunk: (_sessionId, chunk) => { sent.push(chunk as Record<string, unknown>) } },
      { flushIntervalMs: 1 },
    )
    coalescer.start('s1', 'a1')
    const stamp = (charOffset: number): StreamDeltaStamp => ({
      messageId: 'a1', runId: 'r1', requestIndex: 1, partIndex: 0, kind: 'text', charOffset, gen: 0,
    })
    coalescer.handleChunk('s1', { type: 'text-delta', text: '甲', stamp: stamp(0) })
    coalescer.handleChunk('s1', { type: 'text-delta', text: '乙', stamp: stamp(1) })
    await new Promise(resolve => setTimeout(resolve, 20))

    const deltas = sent.filter(chunk => chunk.type === 'text-delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toMatchObject({ text: '甲乙', messageId: 'a1', stamp: { charOffset: 0, partIndex: 0 } })
    coalescer.dispose()
  })
})
