import { describe, expect, it } from 'vitest'
import { parseCompactMarker, selectCompacting, selectCompactingReadout } from './marker'
import type { CompactMarkerSource } from './marker'

/**
 * 压缩标记的解析(壳侧唯一产地)。
 *
 * 正文的**产地是后端** —— `buildContextCompactContent`
 * (`packages/core/engine/context-compact-content.ts`)。所以这里的夹具一律用
 * 那个函数写出来的形状**逐字**摆:手抄一份自己想象中的 JSON 去测,测的是想象。
 */

const system = (content: string): CompactMarkerSource => ({ role: 'system', content })

const marker = (over: Record<string, unknown>): CompactMarkerSource =>
  system(JSON.stringify({ type: 'context-compact', summary: '', compactedMessageCount: 42, ...over }))

describe('parseCompactMarker', () => {
  it('compacting · 单块:没有 progress —— 不编一个「1 / 1」', () => {
    const parsed = parseCompactMarker(marker({ status: 'compacting' }))
    expect(parsed?.status).toBe('compacting')
    expect(parsed?.compactedMessageCount).toBe(42)
    expect(parsed?.progress).toBeUndefined()
  })

  it('compacting · 多块:progress 原样交出', () => {
    const parsed = parseCompactMarker(marker({ status: 'compacting', progress: { chunk: 2, totalChunks: 5 } }))
    expect(parsed?.progress).toEqual({ chunk: 2, totalChunks: 5 })
  })

  it('completed:摘要 / 切点 / 压缩前读数都读得出来', () => {
    const parsed = parseCompactMarker(marker({
      status: 'completed',
      summary: '## Goal\nX',
      compactedThroughMessageId: 'assistant-4',
      contextSizeBefore: 701_297,
      retainedContextSize: 96_000,
    }))
    expect(parsed?.status).toBe('completed')
    expect(parsed?.summary).toBe('## Goal\nX')
    expect(parsed?.compactedThroughMessageId).toBe('assistant-4')
    expect(parsed?.contextSizeBefore).toBe(701_297)
    expect(parsed?.retainedContextSize).toBe(96_000)
  })

  it('completed · 旧标记没有 contextSizeBefore:照常解析,那一格缺席(不是 0)', () => {
    const parsed = parseCompactMarker(marker({ status: 'completed', summary: '## Goal\nX' }))
    expect(parsed?.status).toBe('completed')
    expect(parsed?.contextSizeBefore).toBeUndefined()
    expect(parsed?.retainedContextSize).toBeUndefined()
  })

  it('failed:错误原文原样交出(不改写 provider 那句话)', () => {
    const parsed = parseCompactMarker(marker({ status: 'failed', error: 'requested 1085297 tokens' }))
    expect(parsed?.status).toBe('failed')
    expect(parsed?.error).toBe('requested 1085297 tokens')
  })

  it('看不懂的一律 null —— 不半信半疑地交出半件事实', () => {
    // 角色不对(同一段正文长在 assistant 身上)
    expect(parseCompactMarker({ role: 'assistant', content: JSON.stringify({ type: 'context-compact', status: 'compacting' }) })).toBeNull()
    // 普通正文
    expect(parseCompactMarker(system('今天天气不错'))).toBeNull()
    // 碎掉的 JSON(正文里有那几个字,但解析不出来)
    expect(parseCompactMarker(system('{"type":"context-compact","status":'))).toBeNull()
    // 别人的 JSON
    expect(parseCompactMarker(system(JSON.stringify({ type: 'something-else', status: 'compacting' })))).toBeNull()
    // status 不是那三个之一
    expect(parseCompactMarker(marker({ status: 'pending' }))).toBeNull()
    // 没有消息
    expect(parseCompactMarker(undefined)).toBeNull()
    expect(parseCompactMarker(null)).toBeNull()
  })

  it('半个进度不是进度:缺一格就整格不出', () => {
    const parsed = parseCompactMarker(marker({ status: 'compacting', progress: { chunk: 2 } }))
    expect(parsed?.status).toBe('compacting')
    expect(parsed?.progress).toBeUndefined()
  })
})

describe('selectCompacting', () => {
  const user = (content: string): CompactMarkerSource => ({ role: 'user', content })

  it('账本上最新一条标记正在压 → 真', () => {
    const state = { messages: [user('hi'), marker({ status: 'compacting', progress: { chunk: 2, totalChunks: 5 } })] }
    expect(selectCompacting(state)).toEqual({ progress: { chunk: 2, totalChunks: 5 } })
    expect(selectCompactingReadout(state)).toEqual({ on: true, chunk: 2, totalChunks: 5 })
  })

  it('单块压缩:是真,但没有 k/N', () => {
    const state = { messages: [marker({ status: 'compacting' })] }
    expect(selectCompacting(state)).toEqual({})
    expect(selectCompactingReadout(state)).toEqual({ on: true, chunk: 0, totalChunks: 0 })
  })

  it('压完 / 失败 → 假。不需要谁来「关掉」它:同一条 marker 的正文被刷了', () => {
    expect(selectCompacting({ messages: [marker({ status: 'completed' })] })).toBeNull()
    expect(selectCompacting({ messages: [marker({ status: 'failed', error: 'x' })] })).toBeNull()
  })

  it('看的是**最新**那一条:上一次压完了,这一次在压', () => {
    const state = {
      messages: [marker({ status: 'completed' }), user('go on'), marker({ status: 'compacting' })],
    }
    expect(selectCompactingReadout(state).on).toBe(true)
  })

  it('反过来也一样:这一次已经压完,上一条早先的 compacting 不该把它拽回去', () => {
    const state = {
      messages: [marker({ status: 'compacting' }), user('go on'), marker({ status: 'completed' })],
    }
    expect(selectCompactingReadout(state).on).toBe(false)
  })

  it('一条压缩标记都没有(全新会话)→ 假', () => {
    expect(selectCompacting({ messages: [] })).toBeNull()
    expect(selectCompacting({ messages: [user('hi')] })).toBeNull()
  })

  it('不在压时交出来的是**同一个**对象 —— 订阅方比得动(不是每次新造一个假)', () => {
    const a = selectCompactingReadout({ messages: [] })
    const b = selectCompactingReadout({ messages: [user('hi')] })
    expect(a).toBe(b)
  })
})
