/**
 * 应用级许可 —— 卡上那个「始终允许这个应用」(2026-09-10 拍板)。
 *
 * 一句话的语义:**这个项目里 × 这个应用 × 这一类事**,以后不再问。三个维度全在
 * 既有的机制上,没有新 scope、没有改匹配算法:
 *   · 项目 = 既有的 `workspace` 档 + 这次 ask 的 `workingDirectory`;
 *   · 应用 = pattern 写成整个命名空间 `<scheme>:*`;
 *   · 这一类事 = grant 的 `type`,而 `grantMatches` 要求它**相等** —— 所以点一次
 *     只覆盖当下这一类效果,换一类还会再弹。这是有意的诚实,不是漏做:一次点击
 *     不该代记一张用户没看过的清单。
 *
 * 这只文件钉的是判定与落账那一半(卡上画不画、点了之后表里落下什么、下一次还弹
 * 不弹)。`alwaysScope` 是**谁**算出来的、算的判据是什么,在
 * `permission-policy.ts` 的 `alwaysScopeOf` 上,由最后两例守着。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Permission,
  type PermissionBusEvent,
  type PermissionCommandEnvelope,
  type PermissionEventBusLike,
} from '../index.js'
import {
  listWorkspaceGrants,
  matchGrant,
  resetPermissionGrantsForTests,
} from '../permission-grants.js'
import { enforcePermissionPolicy } from '../permission-policy.js'

interface EmittedEvent {
  sessionId: string
  event: PermissionBusEvent
}

function createBus(emitted: EmittedEvent[]): PermissionEventBusLike {
  const handlers = new Map<string, (envelope: PermissionCommandEnvelope) => void>()
  return {
    onAnySession: (eventType, handler) => {
      handlers.set(eventType, handler)
      return () => handlers.delete(eventType)
    },
    emit: async (sessionId, event) => {
      emitted.push({ sessionId, event })
    },
  }
}

const WORKDIR = '/tmp/always-grant-project'

let counter = 0

describe('应用级许可(respond 的 always 一支)', () => {
  const emitted: EmittedEvent[] = []
  let sessionId = ''

  beforeEach(() => {
    emitted.length = 0
    resetPermissionGrantsForTests()
    sessionId = `always-${++counter}`
    Permission.initialize(createBus(emitted), () => 'ipc')
  })

  afterEach(() => {
    Permission.clearSession(sessionId)
    Permission.shutdown()
    resetPermissionGrantsForTests()
  })

  /** 起一张卡,返回它(以及那条还在等的 promise)。 */
  function ask(input: {
    type?: string
    resources?: string[]
    alwaysScope?: { scheme: string } | undefined
    workingDirectory?: string | undefined
  } = {}) {
    const pattern = input.resources ?? ['session:s-1']
    const pending = Permission.ask({
      type: input.type ?? 'session_destructive',
      title: 'Remove session content',
      pattern,
      sessionId,
      messageId: 'm-1',
      metadata: {},
      workingDirectory: 'workingDirectory' in input ? input.workingDirectory : WORKDIR,
      ...('alwaysScope' in input
        ? input.alwaysScope ? { alwaysScope: input.alwaysScope } : {}
        : { alwaysScope: { scheme: 'session' } }),
    })
    // 答不掉的那几例会在 afterEach 的 `clearSession` 里被拒 —— 这里就地收下那条
    // 拒绝,免得它变成一条与断言无关的 unhandled rejection。
    pending.catch(() => {})
    // ask 是同步登记的:promise 还没落地,卡已经在表里了。
    const card = Permission.getPending(sessionId)[0]
    return { card, pending }
  }

  it('答 always → 落一条 workspace grant,pattern 是整个命名空间,type 照抄这次问的那一类', async () => {
    const { card, pending } = ask()
    expect(card.alwaysScope).toEqual({ scheme: 'session' })

    expect(Permission.respond({ sessionId, permissionId: card.id, response: 'always' })).toBe(true)
    await pending

    const grants = listWorkspaceGrants(WORKDIR)
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({
      scope: 'workspace',
      type: 'session_destructive',
      pattern: 'session:*',
    })
  })

  it('同一个应用、同一类效果的下一次:不再弹 —— 判定直接 allow 并说得出是哪条许可', async () => {
    const { card, pending } = ask()
    Permission.respond({ sessionId, permissionId: card.id, response: 'always' })
    await pending

    // 换一条**别的地址**(而不是刚才那一条)——「整个应用」的意思就在这里。
    const matched = matchGrant({
      type: 'session_destructive',
      pattern: ['session:another-session'],
      sessionId,
      workspaceRoot: WORKDIR,
    })
    expect(matched?.pattern).toBe('session:*')
  })

  it('同一个应用、**另一类**效果照旧弹 —— 一次点击只许了一类事', async () => {
    const { card, pending } = ask()
    Permission.respond({ sessionId, permissionId: card.id, response: 'always' })
    await pending

    expect(matchGrant({
      type: 'session_message',
      pattern: ['session:another-session'],
      sessionId,
      workspaceRoot: WORKDIR,
    })).toBeUndefined()
  })

  it('别的应用照旧弹', async () => {
    const { card, pending } = ask()
    Permission.respond({ sessionId, permissionId: card.id, response: 'always' })
    await pending

    expect(matchGrant({
      type: 'session_destructive',
      pattern: ['music:radio'],
      sessionId,
      workspaceRoot: WORKDIR,
    })).toBeUndefined()
  })

  /**
   * 反证②的落点:`alwaysScope` 缺席时答 `always` 是一次结构错误的应答 ——
   * **结构化拒绝**(返回 false,卡原封不动地继续挂着),不是抛,更不是当 `once`
   * 放行。把 respond 的那道判据拆掉,这一例当场红(要么变成 true + 落账,要么
   * 变成 `addGrant` 抛出来的一条 workspace 缺 root 的错)。
   */
  it('alwaysScope 缺席 → 拒绝,不落 grant,卡还在', () => {
    const { card } = ask({ alwaysScope: undefined })
    expect(card.alwaysScope).toBeUndefined()

    expect(Permission.respond({ sessionId, permissionId: card.id, response: 'always' })).toBe(false)
    expect(listWorkspaceGrants(WORKDIR)).toHaveLength(0)
    expect(Permission.getPending(sessionId)).toHaveLength(1)
  })

  /** 许可是**项目级**的:没有项目就没有落点,那一档同样不成立。 */
  it('没有工作目录 → 拒绝,不落 grant', () => {
    const { card } = ask({ workingDirectory: undefined })
    expect(Permission.respond({ sessionId, permissionId: card.id, response: 'always' })).toBe(false)
    expect(listWorkspaceGrants(WORKDIR)).toHaveLength(0)
  })

  it('permission:request 事件把这一格带给壳 —— 壳不自己解析 pattern 猜命名空间', () => {
    ask()
    const request = emitted.find(item => item.event.type === 'permission:request')
    expect(request?.event).toMatchObject({ alwaysScope: { scheme: 'session' } })
  })
})

/**
 * 「卡上画不画那个键」这条判定的产地:`enforcePermissionPolicy` 拆效果进 ask 的
 * 那一处(它手里同时有 `effect.kind` 与 `effect.resources`)。
 *
 * 反证①的落点在最后两例:把「每条 resource 都要解析成同一个 scheme」那道判据
 * 拆掉,裸路径那例当场红 —— 而那正是「文件写不给应用级许可」的全部实现。
 */
describe('alwaysScope 的出现条件(permission-policy)', () => {
  const asked: Array<Parameters<typeof Permission.ask>[0]> = []
  const bridge = {
    getMode: () => 'normal' as const,
    ask: async (input: Parameters<typeof Permission.ask>[0]) => {
      asked.push(input)
    },
  }

  beforeEach(() => {
    asked.length = 0
    resetPermissionGrantsForTests()
  })

  async function enforce(kind: string, resources: string[]) {
    await enforcePermissionPolicy({
      sessionId: 'policy-1',
      messageId: 'm-1',
      toolName: 't',
      effects: [{ kind, resources }],
      workspaceRoot: WORKDIR,
      permissionBridge: bridge,
      grantMatcher: () => undefined,
    })
    return asked.at(-1)
  }

  it('资源做法:每条 resource 同一个 scheme → 带 alwaysScope', async () => {
    expect((await enforce('session_destructive', ['session:s-1']))?.alwaysScope)
      .toEqual({ scheme: 'session' })
  })

  it('file_write 的裸路径不是地址 → 不带(所以卡上不画那个键)', async () => {
    expect((await enforce('file_write', ['/Users/me/repo/a.ts']))?.alwaysScope).toBeUndefined()
  })

  it('bash 没有资源 → 不带', async () => {
    expect((await enforce('bash', []))?.alwaysScope).toBeUndefined()
  })

  it('横跨两个应用 → 不带(「这个应用」是一句没有主语的话)', async () => {
    expect((await enforce('session_destructive', ['session:s-1', 'music:radio']))?.alwaysScope)
      .toBeUndefined()
  })

  it('capability_change 永不可授权 → 永远不带', async () => {
    expect((await enforce('capability_change', ['session:s-1']))?.alwaysScope).toBeUndefined()
  })
})
