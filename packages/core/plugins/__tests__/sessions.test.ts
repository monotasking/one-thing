/**
 * N1 —— 跨会话信使与感知快照的**协议层**验收。
 *
 * 这一份打的是 core 说了算的那一半:三态矩阵的纯函数、两道声明门(未声明即拒,
 * 且**不计熔断**)、拒绝的结构化形状、以及"宿主没接这条线"时的诚实降级。
 * 真实投递链路与循环闸在装配层那一份
 * (`packages/backend/wiring/plugins/__tests__/session-messenger.test.ts`)。
 */
import { describe, expect, it } from 'vitest'

import { createCorePluginAPI } from '../api-builder.js'
import { disposeCorePluginState } from '../api-state.js'
import {
  PLUGIN_PERMISSION_SESSIONS_PEEK,
  PLUGIN_PERMISSION_SESSIONS_POST,
  PLUGIN_PERMISSION_SESSIONS_TRIGGER,
  PLUGIN_TRIGGER_MAX_HOP,
  describePluginPermission,
  pluginDeliveryStartsTurn,
  pluginPeekPreview,
  resolvePluginDelivery,
  type PluginSendMessageResult,
  type PluginSessionPeek,
} from '../sessions.js'

interface HostCall {
  sessionId: string
  content: string
  options: unknown
}

function build(options: {
  permissions?: string[]
  peek?: PluginSessionPeek | null
  withSessionPorts?: boolean
} = {}) {
  const calls: HostCall[] = []
  const errors: string[] = []
  const failures: string[] = []
  const sessionPorts = options.withSessionPorts === false
    ? {}
    : {
      async sendMessage(_pluginId: string, sessionId: string, content: string, opts: unknown): Promise<PluginSendMessageResult> {
        calls.push({ sessionId, content, options: opts })
        return { ok: true, delivered: 'triggered', hop: 1 }
      },
      async peekSession(): Promise<PluginSessionPeek | null> {
        return options.peek ?? null
      },
      async listSessions() {
        return [{ sessionId: 's1', title: 'One', state: 'idle' as const, updatedAt: 1 }]
      },
    }

  const built = createCorePluginAPI<any, any, any, any, any, any, any, any, any, any, any>({
    pluginId: 'messenger',
    store: {} as never,
    scheduler: {} as never,
    declaredPermissions: options.permissions ?? [],
    logger: {
      log() {},
      error(message: string) { errors.push(message) },
    },
    onPluginFailure({ scope }: { scope: string }) { failures.push(scope) },
    host: {
      registerTool() {},
      subscribeEvent() { return () => {} },
      steer() {},
      followUp() {},
      notify() {},
      registerPromptContextProvider() { return () => {} },
      registerBeforeContextCompactHook() { return () => {} },
      registerAfterAssistantResponseHook() { return () => {} },
      registerSkillRoot() { return () => {} },
      ...sessionPorts,
    } as never,
  })
  return { api: built.api as any, state: built.state, calls, errors, failures }
}

describe('三态矩阵(纯函数 —— 照抄矩阵,不是布尔)', () => {
  it('triggerTurn 三态 × 忙闲', () => {
    expect(resolvePluginDelivery({ triggerTurn: true }, false)).toBe('triggered')
    expect(resolvePluginDelivery({ triggerTurn: true }, true)).toBe('steered')
    expect(resolvePluginDelivery({ triggerTurn: false }, false)).toBe('posted')
    expect(resolvePluginDelivery({ triggerTurn: false }, true)).toBe('posted')
    // 缺省 fail-closed:不声明就不花 token。
    expect(resolvePluginDelivery({}, false)).toBe('posted')
    expect(resolvePluginDelivery(undefined, true)).toBe('posted')
  })

  it('deliverAs 压过 triggerTurn;nextTurn 诚实映射到 follow-up', () => {
    expect(resolvePluginDelivery({ deliverAs: 'steer', triggerTurn: true }, false)).toBe('steered')
    expect(resolvePluginDelivery({ deliverAs: 'followUp' }, false)).toBe('followed-up')
    expect(resolvePluginDelivery({ deliverAs: 'nextTurn' }, false)).toBe('followed-up')
  })

  it('只有 triggered 那一格会起轮 —— 它才是 sessions:trigger 的判据', () => {
    expect(pluginDeliveryStartsTurn('triggered')).toBe(true)
    for (const delivery of ['steered', 'followed-up', 'posted'] as const) {
      expect(pluginDeliveryStartsTurn(delivery)).toBe(false)
    }
  })
})

describe('声明门(声明先于代码)', () => {
  it('没声明 sessions:post → 拒绝、报错、**不计熔断**', async () => {
    const { api, calls, errors, failures } = build({ permissions: [] })
    const result = await api.sendMessage('s1', 'hi', { triggerTurn: false })

    expect(result).toEqual({ ok: false, reason: 'not-declared', detail: PLUGIN_PERMISSION_SESSIONS_POST })
    expect(calls).toHaveLength(0)
    expect(errors.join('\n')).toContain(PLUGIN_PERMISSION_SESSIONS_POST)
    // 作者写错 manifest 不该连坐整个插件(与 theme.updateBackground 同规)。
    expect(failures).toEqual([])
  })

  it('只声明 post 就想起轮 → 拒绝;补上 trigger 才放行', async () => {
    const postOnly = build({ permissions: [PLUGIN_PERMISSION_SESSIONS_POST] })
    expect(await postOnly.api.sendMessage('s1', 'hi', { triggerTurn: true }))
      .toEqual({ ok: false, reason: 'not-declared', detail: PLUGIN_PERMISSION_SESSIONS_TRIGGER })
    // 不起轮的那几格照常放行。
    expect((await postOnly.api.sendMessage('s1', 'hi', { deliverAs: 'steer' })).ok).toBe(true)
    expect(postOnly.failures).toEqual([])

    const full = build({
      permissions: [PLUGIN_PERMISSION_SESSIONS_POST, PLUGIN_PERMISSION_SESSIONS_TRIGGER],
    })
    expect((await full.api.sendMessage('s1', 'hi', { triggerTurn: true })).ok).toBe(true)
    expect(full.calls).toHaveLength(1)
    // post-only 那份只放行了不起轮的那一次。
    expect(postOnly.calls).toHaveLength(1)
  })

  it('没声明 sessions:peek → peek 回 null、list 回空、isIdle 回 false', async () => {
    const { api, errors } = build({
      permissions: [PLUGIN_PERMISSION_SESSIONS_POST],
      peek: { sessionId: 's1', title: 'x', state: 'idle', updatedAt: 1 },
    })
    expect(await api.sessions.peek('s1')).toBeNull()
    expect(await api.sessions.list()).toEqual([])
    // "不知道"绝不能被当成"可以随便打扰"。
    expect(await api.isIdle('s1')).toBe(false)
    expect(errors.join('\n')).toContain(PLUGIN_PERMISSION_SESSIONS_PEEK)
  })

  it('声明了 peek → 快照读得到,且是**深冻结**的快照而不是活引用', async () => {
    const { api } = build({
      permissions: [PLUGIN_PERMISSION_SESSIONS_PEEK],
      peek: { sessionId: 's1', title: 'One', state: 'idle', updatedAt: 7 },
    })
    const peek = await api.sessions.peek('s1')
    expect(peek).toMatchObject({ sessionId: 's1', state: 'idle' })
    expect(Object.isFrozen(peek)).toBe(true)
    expect(await api.isIdle('s1')).toBe(true)
    expect(await api.sessions.list()).toHaveLength(1)
  })
})

describe('拒绝一律结构化 —— 插件感知得到,而不是以为发出去了', () => {
  it('空内容 / 空会话 id', async () => {
    const { api } = build({ permissions: [PLUGIN_PERMISSION_SESSIONS_POST] })
    expect(await api.sendMessage('', 'hi', {})).toMatchObject({ ok: false, reason: 'unknown-session' })
    expect(await api.sendMessage('s1', '   ', {})).toMatchObject({ ok: false, reason: 'empty-content' })
  })

  it('宿主没接这条线(headless / server)→ unsupported,而不是静默假装成功', async () => {
    const { api } = build({
      permissions: [PLUGIN_PERMISSION_SESSIONS_POST],
      withSessionPorts: false,
    })
    expect(await api.sendMessage('s1', 'hi', {})).toMatchObject({ ok: false, reason: 'unsupported' })
    expect(await api.sessions.peek('s1')).toBeNull()
  })

  it('宿主抛错 → 回 error 并**计**熔断(那是真的运行期失败,不是声明失误)', async () => {
    const calls: string[] = []
    const built = createCorePluginAPI<any, any, any, any, any, any, any, any, any, any, any>({
      pluginId: 'messenger',
      store: {} as never,
      scheduler: {} as never,
      declaredPermissions: [PLUGIN_PERMISSION_SESSIONS_POST],
      logger: { log() {}, error() {} },
      onPluginFailure({ scope }: { scope: string }) { calls.push(scope) },
      host: {
        registerTool() {}, subscribeEvent() { return () => {} }, steer() {}, followUp() {},
        notify() {}, registerPromptContextProvider() { return () => {} },
        registerBeforeContextCompactHook() { return () => {} },
        registerAfterAssistantResponseHook() { return () => {} },
        registerSkillRoot() { return () => {} },
        async sendMessage() { throw new Error('bus down') },
      } as never,
    })
    const result = await (built.api as any).sendMessage('s1', 'hi', {})
    expect(result).toMatchObject({ ok: false, reason: 'error', detail: 'bus down' })
    expect(calls).toEqual(['sendMessage'])
  })
})

describe('协议常量与工具函数', () => {
  it('preview 硬截 + 折行', () => {
    expect(pluginPeekPreview('  a\n\n  b  ')).toBe('a b')
    const long = pluginPeekPreview('x'.repeat(500))
    expect(long).toHaveLength(120)
    expect(long.endsWith('…')).toBe(true)
    expect(pluginPeekPreview('short')).toBe('short')
  })

  it('披露文案是人话,未登记的权限名原样显示(向前兼容)', () => {
    expect(describePluginPermission(PLUGIN_PERMISSION_SESSIONS_PEEK))
      .toContain('can read summaries of your sessions')
    expect(describePluginPermission(PLUGIN_PERMISSION_SESSIONS_TRIGGER)).toContain('spends tokens')
    expect(describePluginPermission('future:thing')).toBe('future:thing')
  })

  it('链长闸的上限是一个数字常量,不是散在实现里的字面量', () => {
    expect(PLUGIN_TRIGGER_MAX_HOP).toBe(8)
  })
})

describe('拆除之后的晚到调用', () => {
  it('拆除之后 sendMessage 不再投递,快照读面回空', async () => {
    const { api, state, calls } = build({
      permissions: [
        PLUGIN_PERMISSION_SESSIONS_POST,
        PLUGIN_PERMISSION_SESSIONS_TRIGGER,
        PLUGIN_PERMISSION_SESSIONS_PEEK,
      ],
      peek: { sessionId: 's1', title: 'One', state: 'idle', updatedAt: 1 },
    })
    expect((await api.sendMessage('s1', 'before', { triggerTurn: true })).ok).toBe(true)

    disposeCorePluginState(state, { unregisterTool() {} })

    expect(await api.sendMessage('s1', 'after', { triggerTurn: true }))
      .toMatchObject({ ok: false, reason: 'unsupported' })
    expect(await api.sessions.peek('s1')).toBeNull()
    expect(await api.isIdle('s1')).toBe(false)
    // 拆除前那一条投递出去了,拆除后那一条没有。
    expect(calls).toHaveLength(1)
  })
})
