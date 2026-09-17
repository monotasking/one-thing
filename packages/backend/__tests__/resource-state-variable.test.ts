/**
 * K4-a —— 资源自述的 `state` 真的进了提示词(`docs/design/atom-2026-09.md` §4
 * 「提示词」那一行:`turn` 的进 `<context-update>` 尾块,按块去重;「= 变量系统,
 * 不另立」)。
 *
 * 它跑一整只 `createOnethingBackend`(临时 store),因为这一单要证的四句话没有一句
 * 在单测里说得出口:
 *
 *   ① `buildStateVariablesPromptText(sessionId)` —— 也就是模型真正读到的那块板 ——
 *      里有 `resource_session_current`,而它的值是**真会话**的摘要;
 *   ② 那一格是 `state="true"`(进的是尾块的状态半边,不是名录半边);
 *   ③ 一条资源事件(`rename`)之后,变量注册表朝**那一条会话**发了一次变更;
 *   ④ 什么都不动的两回合,板子**逐字相同** —— 那是尾块按块去重的前提。
 *
 * 外加两条自我约束:`live` 档不投(`music` 那份自述在 headless 档上根本没 mount,
 * 所以这里用注册表现有的事实来判,不写死名单),以及 `singleton` + `turn` 今天
 * 投不出去这件事是**留账不是缺口**(`core/resource/spec.ts` 的 `StateScope`)。
 *
 * store 隔离与全动态 import 的写法照 `resource-kernel.test.ts`。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const previousStorePath = process.env.ONETHING_STORE_PATH
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-resource-state-var-'))
process.env.ONETHING_STORE_PATH = storeRoot

afterAll(async () => {
  const { getCurrentBackendSafe, setCurrentBackend } = await import('../current.js')
  if (getCurrentBackendSafe()) setCurrentBackend(null)
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

class NoopSender extends EventEmitter {
  isDestroyed(): boolean {
    return false
  }
  send(): void {}
}

type Backend = Awaited<ReturnType<typeof import('../backend.js')['createOnethingBackend']>>

async function assemble(): Promise<Backend> {
  const { createOnethingBackend } = await import('../backend.js')
  return createOnethingBackend({
    host: {
      storePath: {},
      sandbox: {},
      auth: null,
      logging: null,
      shell: null,
      voice: null,
      terminal: null,
      skillsEnvironment: null,
      todoPlan: null,
      scratchpad: null,
      plugins: null,
      gateway: null,
      settings: null,
      evals: null,
      mcp: null,
      localTrust: null,
      speechOutput: null,
    },
    toolRegistry: 'headless',
    sender: new NoopSender() as never,
  })
}

const PRINCIPAL = { kind: 'user', userId: 'local' } as const

describe('资源 state 进提示词(K4-a)', () => {
  let backend: Backend
  let sessionId: string

  beforeAll(async () => {
    backend = await assemble()
    const store = await import('../store.js')
    sessionId = store.createSession(`resource-state-${Date.now()}`, 'Board session').id
  }, 180_000)

  it('变量板上有 resource_session_current,值是这条真会话的摘要', async () => {
    const { buildStateVariablesPromptText } = await import('../wiring/variables/index.js')
    const board = await buildStateVariablesPromptText(sessionId)

    // ② 它进的是状态半边(`state="true"`),不是只报名字的名录半边。
    expect(board).toContain('<var name="resource_session_current" state="true"')
    // 自述里那句人话原样当说明。
    expect(board).toContain('desc="The session this turn is happening in"')
    // ① 值是真会话的摘要 —— 标题与 id 都对得上,而且**没有抄本**。
    const line = board.split('\n').find(row => row.includes('resource_session_current'))!
    // `escapeText` 只转 `&` 与 `<`,引号原样 —— 断言照渲染出来的字节写。
    expect(line).toContain(`"id":"${sessionId}"`)
    expect(line).toContain('"title":"Board session"')
    expect(line).not.toContain('messages')
    // 恒定一行:值里没有换行,所以 format.ts 不会把后半截折成 `(+N more lines)`。
    expect(line).not.toContain('more line')
  })

  it('④ 什么都不动的两回合,板子逐字相同(尾块按块去重的前提)', async () => {
    const { buildStateVariablesPromptText } = await import('../wiring/variables/index.js')
    // 时间变量是小时粒度的,但为了不让这一条在整点翻页时偶红,只比资源那一行。
    const rowOf = (text: string) =>
      text.split('\n').find(row => row.includes('resource_session_current'))
    const first = rowOf(await buildStateVariablesPromptText(sessionId))
    const second = rowOf(await buildStateVariablesPromptText(sessionId))
    expect(first).toBeTruthy()
    expect(second).toBe(first)
  })

  /**
   * K4-a' —— ④ 的**真形态**。
   *
   * ④ 证的是「什么都不动」,而那一句在真机上永远不成立:一条会话在两个回合之间
   * 至少多一条消息。摘要(`get`)里带 `messageCount`,于是只要那一格进板,`variables`
   * 这个 section 就每回合重发一次 —— 而尾块按块比字节的去重,前提正是「没变的块
   * 逐字相同」。定法是 `state.current` 自己列键(不引用 `SESSION_SUMMARY_SCHEMA`),
   * 投影方按那张 `properties` 过滤 `read` 的返回值。
   *
   * 这一例在定法之前是红的:值里带 `"messageCount":N`,追一条消息就变一次。
   */
  it("K4-a':追一条消息之后,板上那一行逐字不变(计数不进提示词)", async () => {
    const { buildStateVariablesPromptText } = await import('../wiring/variables/index.js')
    const { sessionCommands } = await import('../session/commands.js')
    const rowOf = (text: string) =>
      text.split('\n').find(row => row.includes('resource_session_current'))

    const before = rowOf(await buildStateVariablesPromptText(sessionId))
    expect(before).toBeTruthy()
    // 每回合都在动的那两格,一格都不该在板上。
    expect(before).not.toContain('messageCount')
    expect(before).not.toContain('createdAt')

    sessionCommands.appendMessage(sessionId, {
      message: {
        id: `k4a2-${Date.now()}`,
        role: 'system',
        content: 'one more turn',
        timestamp: Date.now(),
      } as never,
    })

    expect(rowOf(await buildStateVariablesPromptText(sessionId))).toBe(before)
  })

  it('③ 改名之后,变量注册表朝这条会话发了一次变更', async () => {
    const { getVariableRegistry } = await import('../wiring/variables/index.js')
    const seen: string[] = []
    const stop = getVariableRegistry().subscribe(ctx => seen.push(ctx.sessionId))

    await backend.resources.do(
      `session:${sessionId}`,
      'rename',
      { title: 'Renamed board session' },
      { principal: PRINCIPAL, sessionId },
    )
    // 变更是异步链(资源事件 → 总线 → gateway → registry.list → emit)。
    await new Promise(resolve => setTimeout(resolve, 50))
    stop()

    expect(seen).toContain(sessionId)

    const { buildStateVariablesPromptText } = await import('../wiring/variables/index.js')
    expect(await buildStateVariablesPromptText(sessionId)).toContain(
      '"title":"Renamed board session"',
    )
  })

  it('只投 turn 档:注册表上非 turn 的状态一格都不在板上', async () => {
    const { buildStateVariablesPromptText } = await import('../wiring/variables/index.js')
    const board = await buildStateVariablesPromptText(sessionId)
    // 名单从注册表现读,不写死 —— 第二种带 state 的资源落地时这一条不该跟着红。
    const notTurn: string[] = []
    for (const spec of backend.resources.registry.list()) {
      for (const [name, state] of Object.entries(spec.state ?? {})) {
        if (state.volatility !== 'turn') notTurn.push(`resource_${spec.scheme.replace(/-/g, '_')}_${name}`)
      }
    }
    for (const name of notTurn) expect(board).not.toContain(name)
  })

  it('这些名字是保留的:自建变量抢不到,于是变量板不会被 PROVIDER_CONFLICT 掀掉', async () => {
    const { getVariableRegistry, VariableError } = await import('../wiring/variables/index.js')
    await expect(
      getVariableRegistry().set({ sessionId }, {
        name: 'resource_session_current',
        value: 'mine',
        scope: 'session',
      }),
    ).rejects.toBeInstanceOf(VariableError)
  })
})
