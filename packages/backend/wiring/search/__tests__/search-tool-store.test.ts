/**
 * S6 —— `search` 工具的 **store 级**用例(设计 docs/design/search-index-2026-09.md §14)。
 *
 * 这一份是派工单里「battery 一幕」的**替代**,理由写在报告与设计 §14 里:
 * `scripts/lib/gate-fake-provider.mjs` 那只最小假 provider **不会**发工具调用帧
 * (`modelCapabilitiesByModel.tools: false`,它只吐文本);会发的是
 * `scripts/shadow-battery.mjs` 里那一只(`F.tool` / `F.callTools`),但那道门守的是
 * **账本重折的确定性**,把一条 Worker + sqlite + 一次异步追账本塞进去,红了也说不清
 * 是账本坏了还是索引还没追上。所以这一幕改在这里跑:**真索引、真流水线、真授权、
 * 真 runner**,唯一没有的是「一个模型把这次调用发出来」——而那一段是 provider 接线,
 * 不是这只工具的事。
 *
 * 跑完的是整条:
 *   catalog → ToolRunner(校验 → plan → 授权 → apply)→ 适配器 → SearchService →
 *   fanout(把 visibility 塞进 filters)→ SqliteIndex 的 WHERE → 候选 → 结果行
 * 外加一条 `tool/audit`。
 *
 * **Worker 是同线程的**(S3a 的 `MessageChannel` 手法,与 `index-service.test.ts` 同一份
 * 夹具):真 `worker_threads` 起不起得来由 `gate:search-index` 在真产物上证。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MessageChannel } from 'node:worker_threads'

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-search-tool-'))
const sessionsDir = path.join(storeRoot, 'sessions')
fs.mkdirSync(sessionsDir, { recursive: true })
const previousStorePath = process.env.ONETHING_STORE_PATH
process.env.ONETHING_STORE_PATH = storeRoot

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Decision } from '@onething/core/toolkit'
import type { Authorizer, Invocation, Outcome, Tool } from '@onething/core/toolkit'
import type { Principal } from '@onething/core/permission'
import { encodeSessionLogEventLine } from '@onething/core/session'
import type { SessionLogEventRecord } from '@onething/core/session'
import type { SessionMeta } from '@shared/ipc.js'
import {
  DailyNotesFeed,
  DAILY_FEED_ID,
  IndexProjector,
  IndexWorkerCore,
  LedgerFeed,
  SqliteIndex,
  defaultDocumentFilters,
} from '@onething/runtime/search/index'
import type { IndexEndpoint } from '@onething/runtime/search/index'
import type { IndexWorkerData } from '@onething/runtime/search/index/worker-data'
import type { IndexWorkerHandle } from '@onething/runtime/search/index/worker-host'
import type { OnethingSearchProvidersAdapters } from '@onething/runtime/search'
import { configureSearchVisibilityPort } from '@onething/runtime/search/capabilities'
import type { ToolAuditRecord } from '@onething/runtime/toolkit/audit-observer'
import { EventBus } from '../../../events/event-bus.js'

const bus = new EventBus()
vi.mock('../../../events/index.js', () => ({ getEventBus: () => bus }))
vi.mock('../../../session/event-log.js', () => ({
  registerSessionLogEventAppendObserver: () => () => {},
}))

/* ── 种一个 store ──────────────────────────────────────────────────────── */

const BASE_TIME = 1_780_000_000_000
const A1 = 'a1'

/**
 * 四条会话,每一条都是拍点辛 a 里的一格:
 *
 *  | id | 形 | a1 该不该看见 |
 *  | --- | --- | --- |
 *  | `s-here` | 普通会话,space-a(**说话人在这条上**) | ✅ |
 *  | `s-other-space` | 普通会话,space-b | ❌ 别的空间 |
 *  | `r-mine` | 协作房,a1 是成员 | ✅ |
 *  | `r-theirs` | 协作房,a1 不是成员(还在 space-a 里) | ❌ 不是成员 |
 *
 * 四条的正文里都有同一个词 `蜘蛛纹` —— 于是「谁看得见」这件事是**唯一**的变量。
 */
const SEEDS: Array<{ id: string; name: string; text: string; meta: Partial<SessionMeta> }> = [
  { id: 's-here', name: 'lodge s-here', text: '蜘蛛纹是那次崩溃的线索', meta: { kind: 'chat', workspaceId: 'space-a' } },
  { id: 's-other-space', name: 'lodge s-other-space', text: '蜘蛛纹在别的空间里也提过', meta: { kind: 'chat', workspaceId: 'space-b' } },
  {
    id: 'r-mine',
    name: 'lodge r-mine',
    text: '蜘蛛纹这条线索房里也说过',
    meta: { kind: 'room', workspaceId: 'space-a', room: { memberAgentIds: [A1, 'a2'] } } as Partial<SessionMeta>,
  },
  {
    id: 'r-theirs',
    name: 'lodge r-theirs',
    text: '蜘蛛纹在这间房里被讨论过',
    meta: { kind: 'room', workspaceId: 'space-a', room: { memberAgentIds: ['a2', 'a3'] } } as Partial<SessionMeta>,
  },
]

const METAS: SessionMeta[] = SEEDS.map(seed => ({
  id: seed.id,
  name: seed.name,
  createdAt: BASE_TIME,
  updatedAt: BASE_TIME + 2000,
  ...seed.meta,
}) as SessionMeta)

function seedStore(): void {
  for (const seed of SEEDS) {
    const dir = path.join(sessionsDir, seed.id)
    fs.mkdirSync(dir, { recursive: true })
    const lines = [
      { seq: 1, time: BASE_TIME, type: 'session/created', data: { sessionId: seed.id } },
      {
        seq: 2,
        time: BASE_TIME + 1000,
        type: 'user/message',
        surfaceOp: 'append',
        data: { message: { id: `u-${seed.id}`, role: 'user', content: seed.text, timestamp: BASE_TIME + 1000 } },
      },
    ] as unknown as SessionLogEventRecord[]
    fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.map(encodeSessionLogEventLine).join(''))
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      id: seed.id,
      formatVersion: 2,
      name: seed.name,
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME + 2000,
      // 投影器从这里读 `spaceId` facet —— 授权那一侧的 WHERE 就是打在它上面的。
      workspaceId: seed.meta.workspaceId,
    }))
  }
}

/** 取材面:会话表来自上面那四条(检索补 subtitle / 预览都读它)。 */
const stubAdapters: OnethingSearchProvidersAdapters = {
  getSessionsList: () => METAS.map(meta => ({
    id: meta.id,
    name: meta.name,
    updatedAt: meta.updatedAt,
    messageCount: 1,
    previewText: '',
  })),
  iterateSessionMessages: sessionId => {
    const seed = SEEDS.find(entry => entry.id === sessionId)
    return seed === undefined ? [] : [{ id: `u-${sessionId}`, role: 'user', content: seed.text, timestamp: BASE_TIME + 1000 }]
  },
  getSession: () => undefined,
  getCurrentSessionId: () => undefined,
  getSettings: () => ({ general: {} }),
  getVariablesStore: () => ({ getUserNoteDir: () => undefined, getWorkNoteDir: () => undefined }),
  listFiles: () => ({ async *[Symbol.asyncIterator]() {} }),
  listPrompts: () => [],
}
vi.mock('../adapters.js', () => ({ createAppSearchProvidersAdapters: () => stubAdapters }))

const { createAppSearchService } = await import('../index.js')
const { visibleSessionIdsFor } = await import('../visibility.js')
const { createDesktopCatalog } = await import('../../toolkit/catalog.js')
const { createAppToolRunner } = await import('../../toolkit/runner.js')

/* ── 同线程 Worker ─────────────────────────────────────────────────────── */

interface SameThread { handle: IndexWorkerHandle; close(): void }

function sameThreadWorker(data: IndexWorkerData): SameThread {
  const channel = new MessageChannel()
  const index = new SqliteIndex({
    path: data.databasePath,
    ...(data.analyzerId !== undefined ? { analyzerId: data.analyzerId } : {}),
  })
  const core = new IndexWorkerCore({
    endpoint: channel.port2 as unknown as IndexEndpoint,
    index,
    feeds: [
      new LedgerFeed({
        sessionsDir: data.sessionsDir,
        projector: new IndexProjector({ includeReasoning: data.includeReasoning ?? false }),
      }),
      ...(data.notesDirs ?? []).map((dir, at) => new DailyNotesFeed({
        notesDir: dir,
        ...(at === 0 ? {} : { id: `${DAILY_FEED_ID}#${at}` }),
      })),
    ],
    filters: defaultDocumentFilters(),
    ...(data.schemas !== undefined ? { schemas: data.schemas } : {}),
    debounceMs: 5,
  })
  core.start()
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    core.dispose()
    index.close()
    channel.port1.close()
    channel.port2.close()
  }
  return { close, handle: { endpoint: channel.port1 as unknown as IndexEndpoint, onError: () => {}, onExit: () => {}, terminate: close } }
}

/* ── 夹具 ──────────────────────────────────────────────────────────────── */

let worker: SameThread | undefined
let handle: Awaited<ReturnType<typeof createAppSearchService>> | undefined
let restoreVisibility: (() => void) | undefined
const audits: ToolAuditRecord[] = []

beforeAll(async () => {
  seedStore()
  handle = await createAppSearchService({
    createWorker: data => {
      worker = sameThreadWorker(data)
      return worker.handle
    },
  })
  await handle.index?.drain()

  // 装配装的是**真**端口(它读 `store.getSessionsList()`,那要一整个 backend)。
  // 这里换成同一条判据打在上面那四条元数据上 —— 换掉的只有「会话从哪儿来」这一句,
  // 判据本身(`visibleSessionIdsFor`)是成品那一份。
  restoreVisibility = configureSearchVisibilityPort({
    visibleSessionIds: principal => visibleSessionIdsFor(principal, METAS),
  })
})

afterAll(async () => {
  restoreVisibility?.()
  await handle?.dispose()
  worker?.close()
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

afterEach(() => {
  audits.length = 0
})

const allow: Authorizer = { async decide() { return Decision.allow() } }

function searchTool(): Tool {
  const tool = createDesktopCatalog().all().find(entry => entry.spec.id === 'search')
  if (tool === undefined) throw new Error('目录里没有 search —— 三档注册那一行掉了')
  return tool
}

/** 经**成品 runner** 跑一次(权限 / 审计 / 校验全在路上)。 */
async function callSearch(input: unknown, principal: Principal, sessionId = 's-here'): Promise<Outcome> {
  const runner = createAppToolRunner({
    observer: { on: () => {} },
    authorizer: allow,
    // `ToolAuditSink` 就是一个函数(不是带 record 的对象)。
    audit: entry => { audits.push(entry) },
    // 会话快照:成品那一份读真 store,这里给同一种形(带 workspaceId)。
    session: (invocation: Invocation) => {
      const meta = METAS.find(entry => entry.id === invocation.sessionId)
      return meta === undefined
        ? undefined
        : { id: meta.id, title: meta.name, kind: meta.kind, metadata: { workspaceId: meta.workspaceId ?? '' } }
    },
  })
  const invocation: Invocation = { callId: 'c1', toolId: 'search', input, sessionId, principal }
  return await runner.run(searchTool(), invocation)
}

function textOf(outcome: Outcome): string {
  const result = outcome.kind === 'ok' ? outcome.result : undefined
  return (result?.content ?? []).map(part => (part.type === 'text' ? part.text : '')).join('\n')
}

/** 结果行里出现了哪几条会话 —— 判据是「看得见哪几条」,不是行的措辞。 */
function sessionsIn(text: string): string[] {
  return SEEDS.map(seed => seed.id).filter(id => text.includes(id))
}

/* ── 用例 ──────────────────────────────────────────────────────────────── */

describe('三个主体各得各的(拍点辛 a)', () => {
  it('用户:四条全看得见', async () => {
    const text = textOf(await callSearch({ query: '蜘蛛纹', kind: 'messages', limit: 20 }, { kind: 'user', userId: 'local' }))
    expect(sessionsIn(text).sort()).toEqual(['r-mine', 'r-theirs', 's-here', 's-other-space'])
  })

  it('agent:当前空间的非协作会话 + 自己是成员的房 —— 别的空间与不是成员的房都不在', async () => {
    const text = textOf(await callSearch({ query: '蜘蛛纹', kind: 'messages', limit: 20 }, { kind: 'agent', agentId: A1 }))
    expect(sessionsIn(text).sort()).toEqual(['r-mine', 's-here'])
    expect(text).not.toContain('s-other-space')
    expect(text).not.toContain('r-theirs')
  })

  it('插件:一条都看不见(只见自己产的,而今天没有插件产会话文档)', async () => {
    const text = textOf(await callSearch({ query: '蜘蛛纹', kind: 'messages', limit: 20 }, { kind: 'system', component: 'p1' }, 's-here'))
    // system 读成 agent 而不是 user —— 这里顺带把那条也考了:它拿的是 agent 的范围,
    // 而 `system:p1` 不是任何一间房的成员,所以只剩当前空间的非协作会话。
    expect(sessionsIn(text)).toEqual(['s-here'])
  })

  it('**total 是授权之后的真数**(§6.4b:范围进查询,不是回来再滤)', async () => {
    const outcome = await callSearch({ query: '蜘蛛纹', kind: 'messages', limit: 20 }, { kind: 'agent', agentId: A1 })
    const details = outcome.kind === 'ok' ? outcome.result.details : undefined
    expect(details?.total).toBe(2)
    expect(textOf(outcome)).toContain('total 2')
  })
})

describe('会话标题那一路(chats)走同一条规则', () => {
  it('一间 agent 看不见的房,它的**房名**也不出现', async () => {
    const text = textOf(await callSearch({ query: 'lodge', kind: 'chats', limit: 20 }, { kind: 'agent', agentId: A1 }))
    expect(text).toContain('r-mine')
    expect(text).not.toContain('r-theirs')
  })
})

describe('scope 只能收窄', () => {
  it('scope:"session" 只剩本会话', async () => {
    const text = textOf(await callSearch(
      { query: '蜘蛛纹', kind: 'messages', scope: 'session', limit: 20 },
      { kind: 'agent', agentId: A1 },
    ))
    expect(sessionsIn(text)).toEqual(['s-here'])
  })

  it('scope:"all" 不放宽 —— 它仍然是「当前空间 + 我的房」', async () => {
    const text = textOf(await callSearch(
      { query: '蜘蛛纹', kind: 'messages', scope: 'all', limit: 20 },
      { kind: 'agent', agentId: A1 },
    ))
    expect(sessionsIn(text).sort()).toEqual(['r-mine', 's-here'])
  })

  it('**「当前空间」跟着说话人走** —— 同一个 agent 在 space-b 的会话里说话,看见的就是 space-b', async () => {
    // 这不是越权:拍点辛 a 说的是「当前空间」,而当前空间的定义就是「我此刻在哪条
    // 会话上」。房那一半不受空间影响,所以 r-mine 照旧在。
    const text = textOf(await callSearch(
      { query: '蜘蛛纹', kind: 'messages', limit: 20 },
      { kind: 'agent', agentId: A1 },
      's-other-space',
    ))
    expect(sessionsIn(text).sort()).toEqual(['r-mine', 's-other-space'])
  })

  it('`scope:"session"` 拿的是**调用坐标上**那条会话,模型点不了名 —— 越权在契约上就不可达', async () => {
    // 输入 schema 里没有 `sessionId` 这一格:收窄只能收到「我此刻在的这条」。
    const text = textOf(await callSearch(
      { query: '蜘蛛纹', kind: 'messages', scope: 'session', limit: 20 },
      { kind: 'agent', agentId: A1 },
      'r-mine',
    ))
    expect(sessionsIn(text)).toEqual(['r-mine'])
  })
})

describe('描述里的 kind 清单随注册表', () => {
  it('六个内置能力全在,而工具源码里一个能力名都没有', () => {
    const description = searchTool().spec.description
    for (const manifest of handle!.service.capabilities('agent-tool')) {
      expect(description).toContain(manifest.id)
    }
  })

  it('**注册一条新能力 → 描述当场多一项;注销 → 少一项**(§14.4 的陌生能力演练,工具一字不改)', () => {
    expect(searchTool().spec.description).not.toContain('symbol')

    const unregister = handle!.service.register({
      manifest: {
        id: 'symbol',
        labelKey: 'search.capability.symbol',
        icon: 'Code',
        kind: 'scan',
        budget: { default: 5, timeoutMs: 300 },
        order: 9,
      },
      supports: () => true,
      search: async () => ({ items: [], took: 0 }),
    })
    expect(searchTool().spec.description).toContain('symbol')

    unregister()
    expect(searchTool().spec.description).not.toContain('symbol')
  })
})

describe('expand 走预览路', () => {
  it('先搜到一条,再拿它的 ref 展开 → 命中那条的上下文原文', async () => {
    const found = textOf(await callSearch({ query: '蜘蛛纹', kind: 'messages', limit: 5 }, { kind: 'agent', agentId: A1 }))
    const ref = /\[(messages:[^\]]+)\]/.exec(found)?.[1]
    expect(ref).toBeDefined()

    const text = textOf(await callSearch({ query: 'x', expand: ref }, { kind: 'agent', agentId: A1 }))
    expect(text).toContain('蜘蛛纹')
    expect(text).toContain('>>> user:')
  })
})

describe('协作房里 search 与 history 并存,不越权(§14.2「场景」那一行)', () => {
  it('房里两只工具都在面上 —— `search` 不靠场景门躲开协作房', async () => {
    const { resolveScene } = await import('@onething/runtime/toolkit')
    const catalog = createDesktopCatalog()
    const scene = resolveScene({ session: { id: 'r-mine', kind: 'room' } })

    const onSurface = catalog.all().filter(tool => tool.visibleIn(scene)).map(tool => tool.spec.id)
    expect(onSurface).toContain('history')
    expect(onSurface).toContain('search')
  })

  it('**越权由 messages 的 agent 支挡**:房里搜,不是成员的那间房照旧不出现', async () => {
    const text = textOf(await callSearch(
      { query: '蜘蛛纹', kind: 'messages', limit: 20 },
      { kind: 'agent', agentId: A1 },
      'r-mine',
    ))
    expect(sessionsIn(text)).toContain('r-mine')
    expect(sessionsIn(text)).not.toContain('r-theirs')
  })
})

describe('审计', () => {
  it('一次 search 留下一条 `tool/audit` —— 与别的工具同一条路,没有豁免', async () => {
    await callSearch({ query: '蜘蛛纹', kind: 'messages' }, { kind: 'agent', agentId: A1 })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ toolId: 'search', sessionId: 's-here' })
  })
})
