import { beforeEach, describe, expect, it, vi } from 'vitest'
// `vi.mock` 被提升到 import 之上,所以这一行静态 import 拿到的已经是记事本那几只。
import { runScriptInTerminal, __resetRunTerminalsForTests } from '../run-script'
import type { TerminalState } from '../session'

/**
 * **代码块那颗「运行」落到终端上的那一段**(2026-09-14)。
 *
 * 这一组量的只有四件事:去哪个目录、复用哪一格、亮不亮出来、写下去的是什么。
 * 终端那一侧整个换成记事本(注册表、启动瓦、两台 store 都是 mock)——
 * 真终端那半边由 `session.test.ts` 与真机门 `gate:terminal` 守着。
 *
 * 反证(每条真跑过一次):
 *  · 把 `reusableTerminal` 的整段判据换成「账上有就用」→ ③(exited 之后新开)红;
 *  · 把账本键从 `sessionId` 改成常量 → ④(不同会话各一格)红;
 *  · 把 `targetDirOf` 里 `sessionCwdOf` 那一支拆掉 → ⑤ 红;
 *  · 把末尾那句 `endsWith('\n')` 判据拆掉 → ⑥ 红(脚本自带回车时会多打一个)。
 */

/* ── 记事本:活着的那几格 ────────────────────────────────────────────────── */

interface FakeSession {
  state: TerminalState
  input: ReturnType<typeof vi.fn>
}

const sessions = new Map<string, FakeSession>()
let nextId = 0

const createTerminalTab = vi.fn(async (_cwd?: string) => {
  const id = `t${++nextId}`
  sessions.set(id, { state: 'live', input: vi.fn(() => Promise.resolve()) })
  return id
})
const terminalLauncherRegion = vi.fn(() => 'edge:bottom')
const requestTerminalFocus = vi.fn()
const placeRef = vi.fn()
const summonRef = vi.fn(() => 'edge' as const)

/** 树上有哪几格(`regionOfRefIn` 的答案由它说了算)。 */
const onTree = new Set<string>()

vi.mock('../../terminal-launcher', () => ({
  createTerminalTab: (cwd?: string) => createTerminalTab(cwd),
  terminalLauncherRegion: () => terminalLauncherRegion(),
}))

vi.mock('../registry', () => ({
  peekTerminalSession: (id: string) => {
    const live = sessions.get(id)
    return live ? { get: () => ({ state: live.state }) } : undefined
  },
  terminalSessionOf: (id: string) => sessions.get(id),
  requestTerminalFocus: (id: string) => requestTerminalFocus(id),
}))

vi.mock('../../../stage/store', () => ({
  useStageStore: { getState: () => ({ placeRef, summonRef }) },
}))

vi.mock('../../../workbench/store', () => ({
  useWorkbenchStore: { getState: () => ({ regions: {} }) },
  regionOfRefIn: (_regions: unknown, id: string) => (onTree.has(id) ? 'edge:bottom' : null),
}))

/*
 * 会话名册只换 `useSessionsSource` 这一口:`data/files-source` → `expose/store` 那条边
 * 在模块求值时就要订 `onSessionsRemoved`,整只换掉会让那句订阅当场找不到人
 * (真跑出来的报错,不是推测)。所以走 `importOriginal` 的部分替换。
 */
vi.mock('../../../data/sessions-source', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSessionsSource: { getState: () => ({ sessions: sessionRows }) },
}))

/** 会话名册(`projectId` 就是那条会话绑的工作目录 —— 见 `data/files-source`)。 */
let sessionRows: { id: string; projectId?: string }[] = []

/** 刚开出来那一格自然在树上 —— 真实现里 `placeRef` 就是干这件事的。 */
function landLastTerminal(): string {
  const id = `t${nextId}`
  onTree.add(`terminal:${id}`)
  return id
}

beforeEach(() => {
  __resetRunTerminalsForTests()
  sessions.clear()
  onTree.clear()
  sessionRows = []
  nextId = 0
  vi.clearAllMocks()
})

describe('第一次运行:新开一格并写进去', () => {
  it('① 建一格终端、点名焦点、摆出来,然后把脚本 + 回车写下去', async () => {
    await runScriptInTerminal({ shell: 'bash', script: 'ls -l', sessionId: 's1' })
    expect(createTerminalTab).toHaveBeenCalledTimes(1)
    expect(requestTerminalFocus).toHaveBeenCalledWith('t1')
    expect(placeRef).toHaveBeenCalledTimes(1)
    expect(sessions.get('t1')?.input).toHaveBeenCalledWith('ls -l\n')
    // 新开那一格不走召唤 —— 它刚被摆出来,焦点由点名那条子送。
    expect(summonRef).not.toHaveBeenCalled()
  })

  it('⑥ 脚本自己带了末尾换行就**不补第二个**', async () => {
    await runScriptInTerminal({ shell: 'bash', script: 'ls\n', sessionId: 's1' })
    expect(sessions.get('t1')?.input).toHaveBeenCalledWith('ls\n')
  })
})

describe('每会话一格运行终端', () => {
  it('② 同一条会话第二次运行:复用那一格,不再建;并且把它亮出来', async () => {
    await runScriptInTerminal({ shell: 'bash', script: 'a', sessionId: 's1' })
    landLastTerminal()

    await runScriptInTerminal({ shell: 'bash', script: 'b', sessionId: 's1' })
    expect(createTerminalTab).toHaveBeenCalledTimes(1)
    expect(sessions.get('t1')?.input).toHaveBeenNthCalledWith(2, 'b\n')
    // **`reveal` 意图**:点两次「运行」,第二次不该把终端收走(判词在 run-script.ts)。
    expect(summonRef).toHaveBeenCalledWith({ kind: 'terminal', key: 't1' }, 'reveal')
  })

  it('③ 那一格 `exited` 之后再运行 → 新开一格(不往尸体里写)', async () => {
    await runScriptInTerminal({ shell: 'bash', script: 'a', sessionId: 's1' })
    landLastTerminal()
    sessions.get('t1')!.state = 'exited'

    await runScriptInTerminal({ shell: 'bash', script: 'b', sessionId: 's1' })
    expect(createTerminalTab).toHaveBeenCalledTimes(2)
    expect(sessions.get('t2')?.input).toHaveBeenCalledWith('b\n')
  })

  it('③\' 那一格被人从拼贴台关掉(树上没了)→ 同样新开一格', async () => {
    await runScriptInTerminal({ shell: 'bash', script: 'a', sessionId: 's1' })
    // 故意**不** landLastTerminal:树上查不到它。
    await runScriptInTerminal({ shell: 'bash', script: 'b', sessionId: 's1' })
    expect(createTerminalTab).toHaveBeenCalledTimes(2)
  })

  it('④ 不同会话各一格', async () => {
    await runScriptInTerminal({ shell: 'bash', script: 'a', sessionId: 's1' })
    landLastTerminal()
    await runScriptInTerminal({ shell: 'bash', script: 'b', sessionId: 's2' })
    landLastTerminal()

    expect(createTerminalTab).toHaveBeenCalledTimes(2)
    expect(sessions.get('t1')?.input).toHaveBeenCalledWith('a\n')
    expect(sessions.get('t2')?.input).toHaveBeenCalledWith('b\n')
  })

  it('没有会话时按文档目录分格,两份文档各一格', async () => {
    await runScriptInTerminal({ shell: 'bash', script: 'a', baseDir: '/x' })
    landLastTerminal()
    await runScriptInTerminal({ shell: 'bash', script: 'b', baseDir: '/y' })
    landLastTerminal()
    expect(createTerminalTab).toHaveBeenCalledTimes(2)

    await runScriptInTerminal({ shell: 'bash', script: 'c', baseDir: '/x' })
    expect(createTerminalTab).toHaveBeenCalledTimes(2)
  })
})

describe('去哪个目录', () => {
  it('⑤ 会话绑了目录 → 新终端开在那个目录里', async () => {
    sessionRows = [{ id: 's1', projectId: '/repo/app' }]
    await runScriptInTerminal({ shell: 'bash', script: 'ls', sessionId: 's1' })
    expect(createTerminalTab).toHaveBeenCalledWith('/repo/app')
  })

  it('会话没绑目录 → 退到文档所在目录', async () => {
    sessionRows = [{ id: 's1' }]
    await runScriptInTerminal({ shell: 'bash', script: 'ls', sessionId: 's1', baseDir: '/doc' })
    expect(createTerminalTab).toHaveBeenCalledWith('/doc')
  })

  it('两样都答不出 → **不给 cwd**,让后端按自己那条 spawn 规矩落地', async () => {
    await runScriptInTerminal({ shell: 'bash', script: 'ls' })
    expect(createTerminalTab).toHaveBeenCalledWith(undefined)
  })
})
