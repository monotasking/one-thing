/**
 * 三档工具注册的**清单测试**(2026-08-11 止血 4)。
 *
 * 桌面全量档此前没有 Grep —— 实现一直是完整的,只在 apps/server 的只读档接过线,
 * 于是「找出所有引用点」在桌面上退化成 `bash rg`。补注册这种事没有编译期护栏:
 * 少 import 一行不会红,只会在真机上少一个工具。所以清单钉在这里。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const registered = vi.hoisted(() => ({ ids: [] as string[] }))

vi.mock('../../registry.js', () => ({
  registerTool: (tool: { id: string }) => {
    registered.ids.push(tool.id)
  },
  // The barrels drag in the stream runtime, which builds `desktopPromptComposer`
  // at module scope from the registry-as-prompt-source. A mock without it makes
  // the whole file fail to load, and the failure names the composer, not the tools.
  toolPromptSource: { name: 'tools', collect: () => [] },
}))

async function idsFrom(register: () => void): Promise<string[]> {
  registered.ids = []
  register()
  return [...registered.ids]
}

/**
 * 三档 barrel 一次性载入。
 *
 * 载入桌面全量档要把整棵工具图拖进来(store、collab、web-search…),冷启一次要
 * 两秒多;**挂在第一个 it 里就等于把这笔开销记在「碰巧跑在最前面」的那条用例头上**,
 * 于是并行跑整批测试时它会撞上 vitest 默认的 5s 用例超时 —— 一条与它要守的东西
 * (清单对不对)毫无关系的红。开销记在它真正发生的地方,并给这一处显式预算。
 */
let tiers: {
  full: () => void
  headless: () => void
  readonly: () => void
}

beforeAll(async () => {
  const [full, headless, readonly] = await Promise.all([
    import('../index.js'),
    import('../headless.js'),
    import('../readonly.js'),
  ])
  tiers = {
    full: full.registerBuiltinTools,
    headless: headless.registerHeadlessBuiltinTools,
    readonly: readonly.registerReadonlyBuiltinTools,
  }
}, 60_000)

describe('builtin tool tiers', () => {
  beforeEach(() => {
    registered.ids = []
  })

  /**
   * 2026-08-18 工具梳理:find / grep / glob / fart / bash_output / kill_bash 全部摘掉。
   * 找文件与找内容走 bash(rg / fd);后台任务的读与停并回 bash 的启动结果。
   */
  it('registers the desktop full tier as the chat floor + goal + collab tools', async () => {
    const ids = await idsFrom(tiers.full)
    expect(ids.sort()).toEqual([
      'ask_user', 'bash', 'board', 'edit', 'goal', 'history', 'notebook', 'practice',
      'radio', 'read', 'send_message', 'task', 'time', 'variable', 'web_open', 'web_search', 'write',
    ].sort())
    for (const gone of ['find', 'grep', 'glob', 'fart', 'bash_output', 'kill_bash']) {
      expect(ids).not.toContain(gone)
    }
  })

  /**
   * 派工(2026-08-11 批 5,审计 P0-3)。它开真会话、真花 token、真在本机跑工具 ——
   * 桌面全量档独有,另外两档都不该有它。
   */
  it('registers Task in the desktop full tier only', async () => {
    expect(await idsFrom(tiers.full)).toContain('task')
    expect(await idsFrom(tiers.headless)).not.toContain('task')
    expect(await idsFrom(tiers.readonly)).not.toContain('task')
  })

  /**
   * 提问(ask_user)。桌面全量档独有 —— headless 与 readonly 两档没有人在屏幕前,
   * 注册一个没有人能答的提问工具,等于在工具清单里写一句谎话:模型会真的去调,
   * 然后挂到 deadline 才知道这里根本没有人。
   */
  it('registers AskUser in the desktop full tier only', async () => {
    expect(await idsFrom(tiers.full)).toContain('ask_user')
    expect(await idsFrom(tiers.headless)).not.toContain('ask_user')
    expect(await idsFrom(tiers.readonly)).not.toContain('ask_user')
  })

  it('leaves the headless and readonly tiers untouched', async () => {
    const headless = await idsFrom(tiers.headless)
    const readonly = await idsFrom(tiers.readonly)

    expect(headless).not.toContain('grep')
    expect(headless).not.toContain('bash_output')
    // 只读档仍是零本机副作用的那四件。
    expect(readonly.sort()).toEqual(['read', 'time', 'web_open', 'web_search'].sort())
  })
})
