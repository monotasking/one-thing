/**
 * ① 投影表逐行(§5.2 那张「哪些事件折成什么」)+ ③ `run/end` 前助手文档不存在。
 *
 * 账本是手写的(core 的编码器,不 import backend),所以这里验的是「投影器认得
 * 盘上的格式」,不是「自己写的和自己读的一致」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { parseSessionLogEventLog } from '@onething/core/session'

import { IndexProjector, REL_IN_SESSION, REL_TOUCHED_FILE } from '../projector.js'
import {
  BASE_TIME,
  LedgerWriter,
  MESSAGE_CAPABILITY,
  SESSION_CAPABILITY,
  createTempStore,
  writeMeta,
  writeTypicalSession,
} from './helpers.js'
import type { TempStore } from './helpers.js'

const stores: TempStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
})

function newStore(): TempStore {
  const store = createTempStore()
  stores.push(store)
  return store
}

function project(dir: string, sessionId: string, options: ConstructorParameters<typeof IndexProjector>[0] = {}) {
  const events = parseSessionLogEventLog(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf-8'))
  const metaPath = path.join(dir, 'meta.json')
  const meta = fs.existsSync(metaPath)
    ? JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>
    : undefined
  return new IndexProjector(options).project({
    sessionId,
    events,
    ...(meta === undefined ? {} : { meta: meta as never }),
  })
}

describe('IndexProjector 投影表(§5.2)', () => {
  it('user/message 一到就有文档;facets 带会话 / 空间 / 角色 / 归档 / 时刻', () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    writeTypicalSession(store, { sessionId: 's1' })
    writeMeta(dir, 's1', { name: '狼人杀开局', workspaceId: 'w1' })

    const docs = project(dir, 's1')
    const user = docs.find(doc => doc.key === 's1:u-s1')
    expect(user).toBeDefined()
    expect(user!.capability).toBe(MESSAGE_CAPABILITY)
    expect(user!.fields.content).toContain('身份牌')
    expect(user!.facets).toEqual({
      sessionId: 's1',
      spaceId: 'w1',
      role: 'user',
      archived: false,
      time: BASE_TIME + 2000,
    })
    expect(user!.relations).toEqual([{ rel: REL_IN_SESSION, to: 's1' }])
  })

  it('会话标题一份文档,来自 meta.json 不是账本(拍点甲 b)', () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    writeTypicalSession(store, { sessionId: 's1' })
    writeMeta(dir, 's1', { name: '狼人杀开局', workspaceId: 'w1' })

    const session = project(dir, 's1').find(doc => doc.capability === SESSION_CAPABILITY)
    expect(session).toBeDefined()
    expect(session!.key).toBe('s1')
    expect(session!.fields).toEqual({ title: '狼人杀开局' })
  })

  it('③ run/end 之前助手节点不产文档(流式中不搜半条)', () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    writeTypicalSession(store, { sessionId: 's1', endRun: false })
    writeMeta(dir, 's1', { name: 'x' })

    const streaming = project(dir, 's1')
    expect(streaming.some(doc => doc.key === 's1:a-s1')).toBe(false)
    // 用户那条照样在 —— 「不搜半条」说的只是助手。
    expect(streaming.some(doc => doc.key === 's1:u-s1')).toBe(true)

    // 补一条 run/end,同一份账本再折一遍,助手文档就出来了。
    fs.appendFileSync(
      path.join(dir, 'events.jsonl'),
      `${JSON.stringify({ seq: 99, time: BASE_TIME + 9000, type: 'run/end', data: { runId: 'r-s1', outcome: 'completed' } })}\n`,
    )
    const ended = project(dir, 's1')
    const assistant = ended.find(doc => doc.key === 's1:a-s1')
    expect(assistant).toBeDefined()
    expect(assistant!.fields.content).toBe('索引重建大约五秒,期间还能查旧数据')
    expect(assistant!.facets.role).toBe('assistant')
  })

  it('tool/call 的 edit path 变成 touched-file 边,不产文档', () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    writeTypicalSession(store, { sessionId: 's1', touchedFile: 'src/main/index.ts' })
    writeMeta(dir, 's1', { name: 'x' })

    const docs = project(dir, 's1')
    const assistant = docs.find(doc => doc.key === 's1:a-s1')!
    expect(assistant.relations).toEqual([
      { rel: REL_IN_SESSION, to: 's1' },
      { rel: REL_TOUCHED_FILE, to: 'src/main/index.ts' },
    ])
    // 工具**结果**一律不索引(拍点乙),所以没有第二份文档。
    expect(docs.filter(doc => doc.capability === MESSAGE_CAPABILITY)).toHaveLength(2)
  })

  it('user/message-edited 替换那一条(重折之后是新正文,旧正文没了)', () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    const writer = new LedgerWriter(dir)
    writer.append({ type: 'user/message', surfaceOp: 'append', data: { message: { id: 'm1', role: 'user', content: '第一版正文', timestamp: BASE_TIME } } })
    const seq = writer.lastSeq
    writer.append({
      type: 'user/message-edited',
      surfaceOp: { op: 'replace', start: seq, end: seq },
      data: { messageId: 'm1', message: { id: 'm2', role: 'user', content: '改过的正文', timestamp: BASE_TIME + 10 } },
    })
    writer.write()
    writeMeta(dir, 's1', { name: 'x' })

    const contents = project(dir, 's1')
      .filter(doc => doc.capability === MESSAGE_CAPABILITY)
      .map(doc => doc.fields.content)
    expect(contents).toEqual(['改过的正文'])
  })

  it('message/deleted 与 session/cleared 都是「不再产出」= 墓碑', () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    const writer = new LedgerWriter(dir)
    writer.append({ type: 'user/message', surfaceOp: 'append', data: { message: { id: 'm1', role: 'user', content: '留下的', timestamp: BASE_TIME } } })
    writer.append({ type: 'user/message', surfaceOp: 'append', data: { message: { id: 'm2', role: 'user', content: '要删的', timestamp: BASE_TIME + 1 } } })
    const target = writer.lastSeq
    writer.append({
      type: 'message/deleted',
      surfaceOp: { op: 'replace', start: target, end: target },
      data: { messageId: 'm2' },
    })
    writer.write()
    writeMeta(dir, 's1', { name: 'x' })

    const keys = project(dir, 's1').filter(doc => doc.capability === MESSAGE_CAPABILITY).map(doc => doc.key)
    expect(keys).toEqual(['s1:m1'])

    const cleared = new LedgerWriter(path.join(store.sessionsDir, 's2'))
    cleared.append({ type: 'user/message', surfaceOp: 'append', data: { message: { id: 'x1', role: 'user', content: '会被清空', timestamp: BASE_TIME } } })
    cleared.append({ type: 'session/cleared', data: { reason: 'clear' } })
    cleared.write()
    writeMeta(path.join(store.sessionsDir, 's2'), 's2', { name: 'y' })
    expect(project(path.join(store.sessionsDir, 's2'), 's2')
      .filter(doc => doc.capability === MESSAGE_CAPABILITY)).toHaveLength(0)
  })

  /**
   * **与设计 §5.2 那张表的一处出入,写在这里而不是藏在注释里**:表上写
   * `session/compacted` → 「被压缩的消息打墓碑(按投影状态里消失的节点)」。真跑
   * 一遍才知道:`reduceSessionProjection` 的 `session/compacted` 分支**只隐藏那条
   * 占位消息**,被压掉的那些一格都不 hide —— 压缩遮蔽的是**模型可见历史**
   * (`state.surface` 的 replace 区间),不是屏幕上的记录。用户压缩之后照样能往上
   * 滚看见旧消息,所以把它们打成墓碑等于「屏幕上有、搜不到」。
   *
   * 于是这里守的是**修正后的事实**:压掉的消息仍然索引,压缩卡自己不索引
   * (它的正文是摘要,§5.2 没有给它「产一份文档」这个动作)。
   */
  it('session/compacted:被压掉的消息仍在(遮的是模型历史不是屏幕),压缩卡自己不索引', () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    const writer = new LedgerWriter(dir)
    writer.append({ type: 'user/message', surfaceOp: 'append', data: { message: { id: 'm1', role: 'user', content: '压之前的老消息', timestamp: BASE_TIME } } })
    const first = writer.lastSeq
    writer.append({ type: 'system/message', surfaceOp: 'append', data: { message: { id: 'c1', role: 'system', content: '压缩中', timestamp: BASE_TIME + 5 } } })
    const placeholder = writer.lastSeq
    writer.append({
      type: 'session/compacted',
      surfaceOp: { op: 'replace', start: first, end: placeholder },
      data: { summary: '这里是压缩摘要', messageId: 'c1', compactedMessageCount: 1, status: 'completed' },
    })
    writer.append({ type: 'user/message', surfaceOp: 'append', data: { message: { id: 'm2', role: 'user', content: '压之后的新消息', timestamp: BASE_TIME + 10 } } })
    writer.write()
    writeMeta(dir, 's1', { name: 'x' })

    const docs = project(dir, 's1').filter(doc => doc.capability === MESSAGE_CAPABILITY)
    expect(docs.map(doc => doc.fields.content)).toEqual(['压之前的老消息', '压之后的新消息'])
    // 压缩卡(`compacted` 节点)不产文档 —— 摘要不是一条消息。
    expect(docs.some(doc => doc.fields.content.includes('这里是压缩摘要'))).toBe(false)
  })

  it('无关事件跳过:model-changed / workdir-changed 一份文档都不多', () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    const writer = new LedgerWriter(dir)
    writer.append({ type: 'user/message', surfaceOp: 'append', data: { message: { id: 'm1', role: 'user', content: '一条', timestamp: BASE_TIME } } })
    writer.append({ type: 'session/model-changed', data: { model: 'x', provider: 'y' } })
    writer.append({ type: 'session/workdir-changed', data: { workingDirectory: '/tmp' } })
    writer.write()
    writeMeta(dir, 's1', { name: 'x' })
    expect(project(dir, 's1').filter(doc => doc.capability === MESSAGE_CAPABILITY)).toHaveLength(1)
  })

  it('推理默认不索引;开关一开才有 reasoning 字段(拍点乙 a)', () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    const writer = new LedgerWriter(dir)
    writer.append({ type: 'run/start', surfaceOp: 'append', data: { runId: 'r1', kind: 'send', assistantMessageId: 'a1', timestamp: BASE_TIME } })
    writer.append({
      type: 'assistant/chunks',
      data: { runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'reasoning', time0: BASE_TIME, dt: [0], text: ['这是一段推理正文'] },
    })
    writer.append({ type: 'assistant/part-end', data: { runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'reasoning', len: 8 } })
    writer.append({
      type: 'assistant/chunks',
      data: { runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 1, kind: 'text', time0: BASE_TIME, dt: [0], text: ['正式回答'] },
    })
    writer.append({ type: 'assistant/part-end', data: { runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 1, kind: 'text', len: 4 } })
    writer.append({ type: 'request/end', data: { requestIndex: 1, runId: 'r1' } })
    writer.append({ type: 'run/end', data: { runId: 'r1', outcome: 'completed' } })
    writer.write()
    writeMeta(dir, 's1', { name: 'x' })

    const off = project(dir, 's1').find(doc => doc.key === 's1:a1')!
    expect(off.fields.reasoning).toBeUndefined()
    expect(off.fields.content).toContain('正式回答')

    const on = project(dir, 's1', { includeReasoning: true }).find(doc => doc.key === 's1:a1')!
    expect(on.fields.reasoning).toContain('这是一段推理正文')
  })

  it('超长正文(> 64KB)折得出来,不炸也不截断在投影这一层(截断是索引的事)', () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    writeTypicalSession(store, { sessionId: 's1', bigMessage: true })
    writeMeta(dir, 's1', { name: 'x' })
    const big = project(dir, 's1').find(doc => doc.key === 's1:big-s1')!
    expect(big.fields.content.length).toBeGreaterThan(64 * 1024)
    expect(big.fields.content.startsWith('超长正文开头')).toBe(true)
  })

  it('归档在 facet 上,不是「跳过」(拍点丙:搜得到带徽)', () => {
    const store = newStore()
    const dir = path.join(store.sessionsDir, 's1')
    writeTypicalSession(store, { sessionId: 's1' })
    writeMeta(dir, 's1', { name: 'x', isArchived: true })
    for (const doc of project(dir, 's1')) expect(doc.facets.archived).toBe(true)
  })
})
