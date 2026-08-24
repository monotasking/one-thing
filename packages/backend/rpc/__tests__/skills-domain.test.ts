/**
 * skills 域,端到端穿过 dispatcher(结构债 P4c 第二批)。
 *
 * 接的是被删掉的四处转发的测试位:`apps/electron/src/ipc/skills.ts` 的工厂
 * (连同它的 `__tests__/skills.test.ts`)、`@main/ipc/skills.ts` 的壳适配、
 * bridge 上那十二条包装、server 的六条 REST 路由 + 一个正则块。
 *
 * 只桩装配层的端口(设置缓存 / `wiring/skills` / 会话技能表),**投影不桩** ——
 * `@onething/runtime/skills` 的那批 `*ForIpc` 是真跑的,所以这组用例证的是
 * 「域把端口接对了」,而不是「域自己又实现了一遍」。
 *
 * 值得钉的三件:
 *  - 十二条方法都在 router 的白名单上,一条不多一条不少;
 *  - `openDirectory` 在**没有宿主外壳能力**时结构化降级(server / CLI 的现实),
 *    注入之后才真的去打开目录 —— 这是本批新立的 `configureShellHost` 端口的
 *    唯一消费者,也是它降级语义的判据;
 *  - `setAgent` 会先读一遍当前可见状态再写(不带 currentEnabled 就会把一条
 *    开着的技能顺手关掉)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureShellHost } from '@onething/runtime/shell/host-ports'
import { skillsRouter } from '@shared/ipc/skills.js'

const settings = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
}))

const skillsWiring = vi.hoisted(() => ({
  createSkill: vi.fn(),
  deleteSkill: vi.fn(),
  getUserSkillsPath: vi.fn(() => '/store/skills'),
  readSkillFile: vi.fn(),
  // `wiring/skills/index.js` 的其余出口这里用不到,但 import 的是整只模块。
  loadAllSkills: vi.fn(),
  loadProjectSkillsForDirectory: vi.fn(),
  ensureSkillsDirectories: vi.fn(),
}))

const sessionSkills = vi.hoisted(() => ({
  getAllSkillsForDisplay: vi.fn(),
  initializeSkills: vi.fn(async () => {}),
  invalidateSkillsCache: vi.fn(),
}))

vi.mock('../../stores/settings.js', () => settings)
vi.mock('../../wiring/skills/index.js', () => skillsWiring)
vi.mock('../../wiring/skills/session-skills.js', () => sessionSkills)

const SKILL = {
  id: 'user:demo',
  name: 'demo',
  description: 'Demo skill',
  source: 'user' as const,
  path: '/store/skills/demo/SKILL.md',
  directoryPath: '/store/skills/demo',
  enabled: true,
  instructions: 'Use demo.',
}

async function loadDomain() {
  const [{ dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests }, { skillsRpcHandlers }] =
    await Promise.all([import('../registry.js'), import('../domains/skills.js')])
  return { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, skillsRpcHandlers }
}

describe('skills RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    settings.getSettings.mockReset().mockReturnValue({ skills: { enableSkills: true, skills: {} } })
    settings.saveSettings.mockReset().mockResolvedValue(undefined)
    sessionSkills.getAllSkillsForDisplay.mockReset().mockReturnValue([SKILL])
    sessionSkills.initializeSkills.mockReset().mockResolvedValue(undefined)
    sessionSkills.invalidateSkillsCache.mockReset()
    skillsWiring.readSkillFile.mockReset().mockResolvedValue('# demo')
    skillsWiring.getUserSkillsPath.mockReset().mockReturnValue('/store/skills')
    // 每个用例从「没有宿主」起步 —— server / CLI 的现实。
    configureShellHost({})

    const { resetRpcRegistryForTests, registerRouterHandlers, skillsRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(skillsRouter, skillsRpcHandlers)
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
    configureShellHost({})
  })

  it('binds exactly the twelve methods the old channels carried', async () => {
    const { dispatchRpc } = await loadDomain()

    const methods = [
      'getAll', 'refresh', 'readFile', 'openDirectory', 'create', 'delete',
      'toggleEnabled', 'listDirectories', 'addDirectory', 'updateDirectory',
      'removeDirectory', 'setAgent',
    ]
    for (const method of methods) {
      const response = await dispatchRpc({ domain: 'skills', method, payload: {} })
      expect(response.ok, `${method} must be on the router allowlist`).toBe(true)
    }

    // 白名单是封闭的:server 那条 `/api/skills/execute` 路由随本批一起删,
    // 域上不留一个「执行技能」的方法(它从来没有真实现)。
    const unknown = await dispatchRpc({ domain: 'skills', method: 'execute', payload: {} })
    expect(unknown.ok).toBe(false)
  })

  it('getAll runs the idempotent init latch and returns the display list', async () => {
    const { dispatchRpc } = await loadDomain()

    const response = await dispatchRpc({
      domain: 'skills',
      method: 'getAll',
      payload: { workingDirectory: '/repo' },
    })

    expect(sessionSkills.initializeSkills).toHaveBeenCalledTimes(1)
    expect(sessionSkills.getAllSkillsForDisplay).toHaveBeenCalledWith({
      workingDirectory: '/repo',
      enabledOnly: false,
    })
    expect(response.ok && response.data).toEqual({ success: true, skills: [SKILL] })
  })

  it('openDirectory degrades structurally when no shell host is wired', async () => {
    const { dispatchRpc } = await loadDomain()

    const response = await dispatchRpc({
      domain: 'skills',
      method: 'openDirectory',
      payload: { skillId: 'user:demo' },
    })

    // dispatcher 仍然 ok —— 失败是**业务结果**,不是通道错误(渲染侧那套
    // `response.success` 判断照旧成立)。
    expect(response.ok).toBe(true)
    expect(response.ok && response.data).toEqual({
      success: false,
      error: 'shell host not available',
    })
  })

  it('openDirectory opens the skill directory once the host wires the port', async () => {
    const openPath = vi.fn(async () => '')
    configureShellHost({ openPath })
    const { dispatchRpc } = await loadDomain()

    const response = await dispatchRpc({
      domain: 'skills',
      method: 'openDirectory',
      payload: { skillId: 'user:demo' },
    })

    expect(openPath).toHaveBeenCalledWith('/store/skills/demo')
    expect(response.ok && response.data).toEqual({ success: true })

    // 不带 skillId = 打开用户技能根,与旧通道一致。
    await dispatchRpc({ domain: 'skills', method: 'openDirectory', payload: {} })
    expect(openPath).toHaveBeenLastCalledWith('/store/skills')
  })

  it('toggleEnabled and setAgent write through the settings cache', async () => {
    const { dispatchRpc } = await loadDomain()
    const stored = { skills: { enableSkills: true, skills: {} as Record<string, unknown> } }
    settings.getSettings.mockReturnValue(stored)

    await dispatchRpc({
      domain: 'skills',
      method: 'toggleEnabled',
      payload: { skillId: 'user:demo', enabled: false },
    })
    expect(stored.skills.skills['user:demo']).toEqual({ enabled: false })

    // 绑定 agent 时沿用当前可见状态,不把一条开着的技能顺手关掉。
    stored.skills.skills = {}
    await dispatchRpc({
      domain: 'skills',
      method: 'setAgent',
      payload: { skillId: 'user:demo', agentId: 'writer' },
    })
    expect(stored.skills.skills['user:demo']).toEqual({ enabled: true, agentId: 'writer' })
    expect(sessionSkills.invalidateSkillsCache).toHaveBeenCalled()
  })

  it('addDirectory refuses a relative path before it ever touches settings', async () => {
    const { dispatchRpc } = await loadDomain()

    const response = await dispatchRpc({
      domain: 'skills',
      method: 'addDirectory',
      payload: { path: 'relative/skills' },
    })

    expect(response.ok && response.data).toEqual({
      success: false,
      error: 'Directory path must be absolute',
    })
    expect(settings.saveSettings).not.toHaveBeenCalled()
  })
})
