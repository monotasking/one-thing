/**
 * 「provider 解不出来」**不许是沉默**(2026-08-31 真机定位)。
 *
 * ── 病历 ────────────────────────────────────────────────────────────────
 * 会话绑的 provider 构不出来时(凭证池里没有它的条目 —— 例如没登录的订阅家
 * `kimi-code`;或凭证解密失败被当成空表),引擎收下 `user/message` 之后
 * **什么都不发生**:`resolveProvider` 发一条 `stream:error` 浮窗就 `return`,
 * `events.jsonl` 上只剩一条 `user/message`,没有 `run/start` 也没有 `run/end`。
 * 只认账本的壳因此对"发了没反应"一个字都说不出来。
 *
 * 真机取证:`~/.onething/sessions/f66608d1-*`(kimi-code 无凭证,两条
 * `user/message` 零后续)对照 `d2f7618c-*`(deepseek 402 —— 同样没有回答,账本
 * 却是完整的 `run/start → request/error → run/end outcome=error`)。**同一件事
 * 在账本上有两种形状,其中一种是沉默。**
 *
 * ── 这道门守什么 ────────────────────────────────────────────────────────
 * 两个半边一起验,因为分开验漏得掉最要紧的那条缝:
 *  - core 半边(`CoreStreamEngine.handleSendMessage`)判定失败后开 run;
 *  - 宿主半边(`stream-executor` 的 `openAssistantRun` / `failAssistantRun`)
 *    把它落成账本上真正的两条事件。
 * 所以这里用**真的**那两口喂一台真的 `CoreStreamEngine`,断言读的是磁盘上的
 * `events.jsonl`,不是端口的调用次数。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ sessionsDir: '', storeDir: '' }))

vi.mock('@onething/runtime/storage', async importOriginal => {
  const actual = await importOriginal<typeof import('@onething/runtime/storage')>()
  return {
    ...actual,
    getOnethingSessionsDir: () => state.sessionsDir,
    getOnethingLogDir: () => path.join(state.storeDir, 'log'),
  }
})

// stream-executor 的模块级 `getStreamEngine` 只有 `executeMessageStream` 用得着;
// 这条路一步都不进流,所以把整台单例引擎挡在门外。
vi.mock('../../index.js', () => ({ getStreamEngine: () => ({}) }))

const { CoreStreamEngine } = await import('@onething/core/engine')
const { flushSessionEventLog, readSessionLogEventsSync, resetSessionEventLogCache } = await import(
  '../../../../session/event-log.js'
)
const { resetSessionSurfaceCache } = await import('../../../../session/event-surface.js')
const { installSessionLayerForTest } = await import('../../../../session/testing/session-layer.js')
let sessionFixture: ReturnType<typeof installSessionLayerForTest>
const { resetSessionRuns } = await import('../../../../session/runs.js')
const { resetSessionEventStatsCache } = await import('../../../../session/event-stats.js')
const { failAssistantRun, openAssistantRun } = await import('../stream-executor.js')

const SESSION_ID = 'provider-not-configured'

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-provider-missing-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION_ID), { recursive: true })
  fs.writeFileSync(path.join(state.sessionsDir, SESSION_ID, 'meta.json'), '{}')
  resetSessionEventLogCache()
  sessionFixture = installSessionLayerForTest()
  resetSessionSurfaceCache()
  resetSessionRuns()
  resetSessionEventStatsCache()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  await flushSessionEventLog()
  await sessionFixture.dispose()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

interface FakeMessage {
  id: string
  role: string
  content?: string
  timestamp: number
  isStreaming?: boolean
  provider?: string
  model?: string
  errorDetails?: string
}

/**
 * 一台**真的**引擎,只有它够不着的那几样是假的(store / 时钟 / id)。
 *
 * `resolveAuth` 交回 `null` = 凭证池里没有这个 provider 的条目。真机上两种病因
 * 落到这里是同一格:没登录的订阅家,与解密失败被当成空表。
 */
function createEngine(options: {
  providerId: string
  describeMissingCredentials?: () => string | undefined
  requiresOAuth?: boolean
}) {
  const messages: FakeMessage[] = []
  const emitted: Array<Record<string, unknown>> = []
  let idSeq = 0

  const runtime = {
    store: {
      getSettings: () => ({ chat: {}, tools: {}, skills: { enableSkills: false } }),
      getSession: () => ({ id: SESSION_ID, name: 'Session', createdAt: 0, updatedAt: 0 }),
      listMessages: () => messages,
      getMessage: (_s: string, id: string) => messages.find(m => m.id === id),
      addMessage: (_s: string, message: FakeMessage) => {
        messages.push(message)
        return message
      },
      renameSession: () => {},
      updateMessageAndTruncate: () => true,
      deleteMessageAndTruncate: () => true,
      deleteMessage: () => true,
    },
    ids: { createId: () => `id-${++idSeq}` },
    clock: { now: () => 1_700_000_000_000 },
    permission: { clearSession: () => {} },
    skills: { getForSession: () => [] },
    prompts: {
      resolveReferences: (content: string) => ({ modelContent: content, displayContent: content }),
    },
    media: { ingestMessageAttachments: () => {} },
    provider: {
      getEffectiveConfig: () => ({
        providerId: options.providerId,
        providerConfig: { model: 'k2', selectedModels: ['k2'] },
        model: 'k2',
      }),
      // 病灶本身:凭证解析交白卷。
      resolveAuth: async () => null,
      ...(options.describeMissingCredentials
        ? { describeMissingCredentials: options.describeMissingCredentials }
        : {}),
      getApiType: () => 'openai',
      isSupported: () => true,
      requiresOAuth: () => options.requiresOAuth ?? false,
    },
    models: {
      getModelContextLength: async () => 200_000,
    },
    history: { buildMessages: () => [], buildResumeAfterToolConfirmation: () => [] },
    streams: {
      // 真的那两口 —— 这道门的一半意义就在这里。
      openAssistantRun,
      failAssistantRun,
      executeMessageStream: async () => {
        throw new Error('这条路不该进流')
      },
      executeAgentLoopStreamGeneration: async () => ({}),
    },
    compaction: {
      compactSessionContext: async () => ({ success: true }),
      getContextCompactReason: () => null,
      shouldSkipAutoCompactForProviderUsageMismatch: () => false,
    },
  }

  const engine = new CoreStreamEngine(runtime as never)
  engine.setEventBus({
    onAnySession: () => () => {},
    emit: async (_sessionId: string, event: Record<string, unknown>) => {
      emitted.push(event)
    },
  } as never)

  return { engine, messages, emitted }
}

async function ledgerEvents() {
  await flushSessionEventLog(SESSION_ID)
  return readSessionLogEventsSync(SESSION_ID) as unknown as Array<{
    type: string
    data: Record<string, unknown>
  }>
}

describe('provider 解不出来:账本上开 run 并立刻收成 error', () => {
  it('凭证池里没有这个 provider 的条目 → run/start + run/end(error) 两条事件', async () => {
    const harness = createEngine({ providerId: 'kimi-code', requiresOAuth: true })

    await harness.engine.handleSendMessage(
      SESSION_ID,
      { content: '在吗', suppressTitleGeneration: true } as never,
      {} as never,
    )

    const events = await ledgerEvents()
    expect(events.map(e => e.type)).toEqual(['run/start', 'run/end'])

    const start = events[0]!
    const end = events[1]!
    // 这条 run 说得出自己是谁、为谁开的 —— 壳的错误卡就靠这几格。
    expect(start.data.kind).toBe('send')
    expect(start.data.provider).toBe('kimi-code')
    expect(start.data.createdAssistantMessage).toBe(true)
    expect(end.data.runId).toBe(start.data.runId)
    expect(end.data.outcome).toBe('error')
    expect(end.data.error).toMatchObject({ name: 'ProviderNotConfigured' })
    // 人话,而且**自带 providerId**:翻账本的人手上没有别的上下文。
    expect(String((end.data.error as { message: string }).message)).toContain('kimi-code')

    // 浮窗那一句照旧发(旧壳的错误路径一字未改)。
    expect(harness.emitted.some(e => e.type === 'stream:error')).toBe(true)

    // 占位必须盖 isStreaming:命令面按它分流,不盖就会多写一条 `system/message`,
    // 同一条消息在账本上出现两次。
    const placeholder = harness.messages.find(m => m.role === 'assistant')
    expect(placeholder?.isStreaming).toBe(true)
    expect(placeholder?.provider).toBe('kimi-code')
    expect(placeholder?.errorDetails).toContain('kimi-code')
  })

  it('凭证解密失败被当成空表 → 同一条路,宿主给的具体理由原样进账本', async () => {
    const harness = createEngine({
      providerId: 'deepseek',
      describeMissingCredentials: () =>
        'deepseek 的凭证在本空间的凭证池里解不开(密文可能来自另一个宿主身份)。',
    })

    await harness.engine.handleSendMessage(
      SESSION_ID,
      { content: '在吗', suppressTitleGeneration: true } as never,
      {} as never,
    )

    const events = await ledgerEvents()
    expect(events.map(e => e.type)).toEqual(['run/start', 'run/end'])
    expect(events[1]!.data.outcome).toBe('error')
    expect(events[1]!.data.error).toMatchObject({
      name: 'ProviderNotConfigured',
      message: 'deepseek 的凭证在本空间的凭证池里解不开(密文可能来自另一个宿主身份)。',
    })
  })

  it('宿主没接账本这两口时,行为退回本修之前(只发浮窗,不建占位)', async () => {
    const harness = createEngine({ providerId: 'kimi-code' })
    // 端口可缺席 = 宿主没有账本(测试的 mock store 就没有)。
    ;(harness.engine as unknown as {
      runtime: { streams: Record<string, unknown> }
    }).runtime.streams.openAssistantRun = undefined
    ;(harness.engine as unknown as {
      runtime: { streams: Record<string, unknown> }
    }).runtime.streams.failAssistantRun = undefined

    await harness.engine.handleSendMessage(
      SESSION_ID,
      { content: '在吗', suppressTitleGeneration: true } as never,
      {} as never,
    )

    expect(await ledgerEvents()).toHaveLength(0)
    expect(harness.emitted.some(e => e.type === 'stream:error')).toBe(true)
  })
})
