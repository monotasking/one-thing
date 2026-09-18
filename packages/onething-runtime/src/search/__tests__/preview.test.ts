/**
 * 预览(检索重建 S4a,`docs/design/search-index-2026-09.md` §4.5)。
 *
 * 四问,逐条对着设计那六问的后五问(「要不要算」那一问是 manifest 的 `preview` 格,
 * 由 `capabilities.test.ts` 的自述用例守着):
 *
 *  1. **是什么媒介** —— 四个内置能力各答一种 `kind`,载荷逐格。
 *  2. **几条一起看** —— `compare` 组 `composite{layout:'side-by-side'}`;
 *     `batch` 组 grid + 汇总,而且一条算不出不拖垮另外几条。
 *  3. **零副作用**(§4.5 ④ 的硬规矩)—— 预览前后,会话表与账本的每一格逐字同,
 *     取材口一次写调用都没有。这条是**反证型**断言:把 `iterateSessionMessages`
 *     换成一只会记账的替身,预览跑完之后账上只有读、没有写。
 *  4. **算不出说原话** —— 账本里没这条消息 / 读不到那个文件 / 这个能力压根没有预览,
 *     三种各给一句能看懂的话,而不是一份空预览。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Candidate } from '@onething/core/search'
import type { OnethingSearchProvidersAdapters, OnethingSearchMessage } from '../providers.js'
import {
  createChatsSearchCapability,
  createNotesSearchCapability,
  createFilesSearchCapability,
  createMessagesSearchCapability,
  createPromptsSearchCapability,
  type MessageContextPreview,
  type NoteExcerptPreview,
  type SessionOverviewPreview,
} from '../capabilities/index.js'
import { createSearchContext, OnethingSearchService } from '../service.js'
import { fakeIndexFace } from './fake-index.js'

/** 一间会话四条消息 —— 够 `MESSAGE_CONTEXT_RADIUS = 2` 两头都取满。 */
const MESSAGES: OnethingSearchMessage[] = [
  { id: 'm1', role: 'user', content: '第一条', timestamp: 10 },
  { id: 'm2', role: 'assistant', content: '第二条', timestamp: 20 },
  { id: 'm3', role: 'user', content: '命中就在这条', timestamp: 30 },
  { id: 'm4', role: 'assistant', content: '第四条', timestamp: 40 },
]

function makeAdapters(overrides: Partial<OnethingSearchProvidersAdapters> = {}): OnethingSearchProvidersAdapters {
  return {
    getSessionsList: () => [
      { id: 's1', name: 'Alpha notes', previewText: '开场那句', updatedAt: 200, messageCount: 4 },
    ],
    iterateSessionMessages: sessionId => (sessionId === 's1' ? MESSAGES : []),
    getSession: () => undefined,
    getCurrentSessionId: () => undefined,
    listFiles: () => ({ async *[Symbol.asyncIterator]() {} }),
    listPrompts: () => [],
    ...overrides,
  }
}

/** 一枚只够定位的候选(与 `SearchService` 从 item 造出来的那一枚同形)。 */
function candidateOf(capability: string, kind: string, payload: unknown, extra: Partial<Candidate> = {}): Candidate {
  return { capability, id: 'x', title: '标题', score: 1, target: { kind, payload }, ...extra }
}

const ctx = createSearchContext()

describe('S4a 预览:媒介', () => {
  it('messages → message-context:命中那条 ±2,前后各按时间正序', async () => {
    const capability = createMessagesSearchCapability(makeAdapters(), fakeIndexFace([]))
    const payload = await capability.preview!(
      [candidateOf('messages', 'message', { sessionId: 's1', messageId: 'm3' })],
      ctx,
    )

    expect(payload.kind).toBe('message-context')
    const context = payload.payload as MessageContextPreview
    expect(context.sessionId).toBe('s1')
    expect(context.hit).toEqual({ id: 'm3', role: 'user', text: '命中就在这条', timestamp: 30 })
    // 前面只有两条(m1/m2),正序;后面只剩一条(m4)—— 不够就是不够,不回卷去凑满 2。
    expect(context.before.map(message => message.id)).toEqual(['m1', 'm2'])
    expect(context.after.map(message => message.id)).toEqual(['m4'])
  })

  it('messages:非字符串 content 是空串,与旧扫描路那一刀同源', async () => {
    const adapters = makeAdapters({
      iterateSessionMessages: () => [{ id: 'm1', role: 'user', content: [{ type: 'image' }] }],
    })
    const capability = createMessagesSearchCapability(adapters, fakeIndexFace([]))
    const payload = await capability.preview!(
      [candidateOf('messages', 'message', { sessionId: 's1', messageId: 'm1' })],
      ctx,
    )
    const context = payload.payload as MessageContextPreview
    expect(context.hit.text).toBe('')
    // `timestamp` 缺席就**不加这一格**(不是 undefined):契约上缺席 = 产地没给。
    expect('timestamp' in context.hit).toBe(false)
  })

  it('chats → session-overview:四格全部来自已经在手的会话表', async () => {
    const capability = createChatsSearchCapability(makeAdapters(), fakeIndexFace([]))
    const payload = await capability.preview!([candidateOf('chats', 'chat', { sessionId: 's1' })], ctx)

    expect(payload.kind).toBe('session-overview')
    expect(payload.payload as SessionOverviewPreview).toEqual({
      sessionId: 's1',
      title: '标题',
      messageCount: 4,
      updatedAt: 200,
      preview: '开场那句',
    })
  })

  it('chats 是 inline:概览随候选带在 `SearchResult.preview` 上,不用再问一次', async () => {
    const service = new OnethingSearchService({ index: fakeIndexFace([]) })
    service.register(createChatsSearchCapability(makeAdapters(), fakeIndexFace([])))

    // 空词 = 「最近几间会话」那一路(旧扫描),它也该带预览 —— 自述说的是
    // 「这个能力的候选带 inline 预览」,不是「有词的时候才带」。
    const response = await service.query({ query: '', category: 'chats', limit: 5 })
    const first = response.results[0]
    expect(first?.preview?.kind).toBe('session-overview')
    expect((first?.preview?.payload as SessionOverviewPreview).sessionId).toBe('s1')
    // 自述与实现是一句话的两半。
    expect(service.capabilities().find(m => m.id === 'chats')?.preview).toEqual({ mode: 'inline' })
  })

  it('files → file-excerpt:只有路径,后端一个字节都不读', async () => {
    const capability = createFilesSearchCapability(makeAdapters())
    const payload = await capability.preview!(
      [candidateOf('files', 'file', { filePath: '/tmp/不存在的文件.txt' })],
      ctx,
    )
    // 文件根本不存在都答得出来 —— 这正是「不读」的反证:读了就该抛。
    expect(payload).toMatchObject({ kind: 'file-excerpt', payload: { path: '/tmp/不存在的文件.txt' } })
  })

  describe('notes → note-excerpt', () => {
    const dirs: string[] = []
    afterEach(() => {
      for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    function writeNote(lines: string[]): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-preview-'))
      dirs.push(dir)
      const file = path.join(dir, '2026-09-05.md')
      fs.writeFileSync(file, lines.join('\n'), 'utf-8')
      return file
    }

    it('命中行 ±3 行;命中行由候选那句 subtitle 认,不重跑一遍匹配器', async () => {
      const file = writeNote(['l0', 'l1', 'l2', 'l3', '这里命中了', 'l5', 'l6', 'l7', 'l8'])
      const capability = createNotesSearchCapability(makeAdapters(), fakeIndexFace([]))
      const payload = await capability.preview!(
        [candidateOf('notes', 'note', { filePath: file }, { subtitle: '…这里命中了…' })],
        ctx,
      )

      expect(payload.kind).toBe('note-excerpt')
      const note = payload.payload as NoteExcerptPreview
      expect(note.path).toBe(file)
      expect(note.excerpt.split('\n')).toEqual(['l1', 'l2', 'l3', '这里命中了', 'l5', 'l6', 'l7'])
    })

    it('判不出命中行(标题命中那种)就给开头七行,不伪造一个位置', async () => {
      const file = writeNote(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])
      const capability = createNotesSearchCapability(makeAdapters(), fakeIndexFace([]))
      const payload = await capability.preview!(
        [candidateOf('notes', 'note', { filePath: file })],
        ctx,
      )
      expect((payload.payload as NoteExcerptPreview).excerpt.split('\n')).toEqual(
        ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      )
    })

    it('「还没建出来」那条抛原话 —— 看一眼不许顺手把文件建出来', async () => {
      const capability = createNotesSearchCapability(makeAdapters(), fakeIndexFace([]))
      await expect(
        capability.preview!(
          [candidateOf('notes', 'note', { filePath: '/x/y.md', actionId: 'create-daily' })],
          ctx,
        ),
      ).rejects.toThrow('还没有文件可看')
    })
  })
})

describe('S4a 预览:基数(§4.5 ③)', () => {
  function serviceWith(adapters = makeAdapters()): OnethingSearchService {
    const service = new OnethingSearchService({ index: fakeIndexFace([]) })
    service.register(createChatsSearchCapability(adapters, fakeIndexFace([])))
    service.register(createMessagesSearchCapability(adapters, fakeIndexFace([])))
    service.register(createFilesSearchCapability(adapters))
    service.register(createPromptsSearchCapability(adapters))
    return service
  }

  it('single 是缺省:一条 item = 那个能力自己的预览,原样', async () => {
    const payload = await serviceWith().preview([
      { capability: 'chats', id: 'chat:s1', target: { kind: 'chat', payload: { sessionId: 's1' } } },
    ])
    expect(payload.kind).toBe('session-overview')
  })

  it('compare:两条各 preview 之后组 composite{layout:"side-by-side"}', async () => {
    const payload = await serviceWith().preview(
      [
        { capability: 'messages', id: 'a', target: { kind: 'message', payload: { sessionId: 's1', messageId: 'm1' } } },
        { capability: 'messages', id: 'b', target: { kind: 'message', payload: { sessionId: 's1', messageId: 'm4' } } },
      ],
      'compare',
    )

    expect(payload.kind).toBe('composite')
    const composite = payload.payload as { layout: string; items: Array<{ kind: string }> }
    expect(composite.layout).toBe('side-by-side')
    expect(composite.items.map(item => item.kind)).toEqual(['message-context', 'message-context'])
  })

  it('batch:各条 inline 预览 + 汇总;一条算不出不拖垮另外几条', async () => {
    const payload = await serviceWith().preview(
      [
        { capability: 'chats', id: 'a', target: { kind: 'chat', payload: { sessionId: 's1' } } },
        { capability: 'files', id: 'b', target: { kind: 'file', payload: { filePath: '/a.txt' } } },
        // 账本里没有 m9 —— 这一条算不出。
        { capability: 'messages', id: 'c', target: { kind: 'message', payload: { sessionId: 's1', messageId: 'm9' } } },
      ],
      'batch',
    )

    expect(payload.kind).toBe('composite')
    const composite = payload.payload as {
      layout: string
      items: Array<{ kind: string }>
      summary: { total: number; shown: number; kinds: string[] }
    }
    expect(composite.layout).toBe('grid')
    expect(composite.items.map(item => item.kind)).toEqual(['session-overview', 'file-excerpt'])
    // 汇总如实说「三条里画出来两条」,不假装只有两条。
    expect(composite.summary).toEqual({
      total: 3,
      shown: 2,
      kinds: ['session-overview', 'file-excerpt'],
    })
  })
})

describe('S4a 预览:零副作用(§4.5 ④)', () => {
  it('预览跑完,会话表与账本逐字同,取材口一次写调用都没有', async () => {
    const calls: string[] = []
    const sessions = [{ id: 's1', name: 'Alpha notes', previewText: '开场那句', updatedAt: 200, messageCount: 4 }]
    const before = structuredClone(sessions)
    const messagesBefore = structuredClone(MESSAGES)

    const adapters = makeAdapters({
      getSessionsList: () => {
        calls.push('getSessionsList')
        return sessions
      },
      iterateSessionMessages: sessionId => {
        calls.push(`iterateSessionMessages:${sessionId}`)
        return sessionId === 's1' ? MESSAGES : []
      },
    })

    const service = new OnethingSearchService({ index: fakeIndexFace([]) })
    service.register(createChatsSearchCapability(adapters, fakeIndexFace([])))
    service.register(createMessagesSearchCapability(adapters, fakeIndexFace([])))

    await service.preview([
      { capability: 'messages', id: 'a', target: { kind: 'message', payload: { sessionId: 's1', messageId: 'm3' } } },
    ])
    await service.preview([
      { capability: 'chats', id: 'b', target: { kind: 'chat', payload: { sessionId: 's1' } } },
    ])

    // ① 数据一格没动 —— 已读、打开态这些在这个产品里根本不是持久格,
    //    能观测的「有没有被改」就是这两份结构本身。
    expect(sessions).toEqual(before)
    expect(MESSAGES).toEqual(messagesBefore)
    // ② 只走了读口。取材面上根本没有写口,所以这一条守的是「没有人绕过它」:
    //    调用名单里只该有这两个读函数。
    expect([...new Set(calls)].sort()).toEqual(['getSessionsList', 'iterateSessionMessages:s1'])
  })
})

describe('S4a 预览:算不出说原话(§4.5 ⑤)', () => {
  function service(): OnethingSearchService {
    const svc = new OnethingSearchService({ index: fakeIndexFace([]) })
    svc.register(createMessagesSearchCapability(makeAdapters(), fakeIndexFace([])))
    svc.register(createPromptsSearchCapability(makeAdapters()))
    return svc
  }

  it('账本里没这条消息:说出是哪间会话,不给一段前后皆空的假上下文', async () => {
    await expect(
      service().preview([
        { capability: 'messages', id: 'a', target: { kind: 'message', payload: { sessionId: 's1', messageId: 'm9' } } },
      ]),
    ).rejects.toThrow('会话 s1 的账本里已经没有这条消息了')
  })

  it('target 上缺 messageId:说缺的是哪一格', async () => {
    await expect(
      service().preview([
        { capability: 'messages', id: 'a', target: { kind: 'message', payload: { sessionId: 's1' } } },
      ]),
    ).rejects.toThrow('messageId')
  })

  it('自述里没说有预览的能力被问到 = 结构化拒绝,不是空预览', async () => {
    await expect(
      service().preview([
        { capability: 'prompts', id: 'a', target: { kind: 'prompt', payload: { promptId: 'p1' } } },
      ]),
    ).rejects.toThrow('capability prompts has no preview')
  })

  it('不认识的能力 id:说不认识,不静默给空', async () => {
    await expect(
      service().preview([{ capability: '并不存在', id: 'a' }]),
    ).rejects.toThrow('no such capability: 并不存在')
  })
})

describe('S4a 动作:接通但本批一个都没有', () => {
  it('invoke 恒答 no such action —— 没有能力声明动作', async () => {
    const service = new OnethingSearchService({ index: fakeIndexFace([]) })
    service.register(createMessagesSearchCapability(makeAdapters(), fakeIndexFace([])))
    await expect(service.invoke('messages', 'anything', [])).rejects.toThrow('no such action')
  })

  it('能力声明了动作就调得到 —— 加一个动作不用改服务层一个字', async () => {
    const service = new OnethingSearchService({ index: fakeIndexFace([]) })
    const seen: string[] = []
    const capability = createMessagesSearchCapability(makeAdapters(), fakeIndexFace([]))
    service.register({
      ...capability,
      invoke: async (actionId, candidates) => {
        seen.push(`${actionId}:${candidates.length}`)
      },
    })

    await service.invoke('messages', 'archive', [{ capability: 'messages', id: 'a' }])
    expect(seen).toEqual(['archive:1'])
  })
})
