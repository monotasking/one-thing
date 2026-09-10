/**
 * 自进化会话工具的**闭环**验收（C4 第一档，
 * `docs/design/cordis-adoption-2026-08.md` §7）。
 *
 * 这份测试钉的不是「三个工具存在」，而是那件唯一值得证明的事：**模型现场写的
 * 代码，挂上去立刻能用，改完重挂拿到的是新代码，卸下去干干净净**。所以主用例
 * 是一趟不打断的闭环，中间每一步都用**真的**东西验：真的写盘、真的动态 import、
 * 真的走 RPC 分发、真的经工具执行器调用。
 *
 * 三处刻意不 mock：
 * - **store 根**：用一个真的临时目录（`ONETHING_STORE_PATH`），因为路径夹紧是
 *   本期的安全线，mock 掉它等于把要守的东西关在门外；
 * - **工具执行器**：走 `ToolRunner`(生产路径上那一台)而不是直接调 `apply` ——
 *   参数校验、错误包装、取消都在它里面，绕过去测的就不是生产路径；
 * - **权限判定**：用 core 的 `decidePermission` / `isGrantableType` 真判一次，
 *   而不是断言「我们写了 permissionGuard 这个字段」。字段写对了但判定链接不上，
 *   正是这类接线最常见的失败形态。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decidePermission, isGrantableType } from '@onething/core/permission'
import type { JsonObject } from '@shared/json.js'
import { Catalog, Decision, Intent, Outcome, Tool as ToolkitTool, ToolRunner } from '@onething/core/toolkit'
import type { Result, ToolSpec } from '@onething/core/toolkit'
import { configureToolkitCatalog, ZodValidator } from '@onething/runtime/toolkit'
import { dispatchRpc, hasRpcDomain, resetRpcRegistryForTests } from '../../rpc/registry.js'
import { dumpFeatures, hasFeature, mountFeature, resetFeaturesForTests } from '../index.js'
import { selfEvolutionFeature } from '../builtin/self-evolution.js'

/**
 * 宿主档门的钥匙。三个工具只在「已经有 bash 的宿主」上注册（挂载一个 feature
 * 与跑一条 shell 是同一量级的能力），所以测试也得把这句前提摆成**真的**：目录里
 * 放一只真的 id 为 `bash` 的工具，而不是去 mock 那道判据。
 */
class BashStandIn extends ToolkitTool<Record<string, never>, undefined> {
  readonly spec: ToolSpec = {
    id: 'bash',
    title: 'Bash',
    description: 'stand-in for the tier gate',
    input: { type: 'object', properties: {} },
    effects: ['bash'],
    presentation: { kind: 'bash', shell: 'default' },
    concurrency: 'sequential',
  }

  async plan(): Promise<Intent<undefined>> {
    return Intent.none(undefined)
  }

  async apply(): Promise<Result> {
    return { content: [{ type: 'text', text: '' }] }
  }
}

/** 这一趟的目录。`hasTool` / `registerTool` 的等价物是它的 `has` / `register`。 */
let catalog: Catalog

const hasTool = (id: string) => catalog.has(id)

let storeRoot: string
let previousStorePath: string | undefined

function featuresDevDir(featureId: string): string {
  return path.join(storeRoot, 'features-dev', featureId)
}

/** 一个最小 demo feature 的源码：注册一个 RPC 域，`transform` 决定它的行为。 */
function demoSource(transform: string): string {
  return [
    'export default {',
    "  id: 'demo-echo',",
    '  mount(ctx) {',
    '    ctx.registerRpcDomain(',
    "      { domain: 'demo-echo', channels: { echo: 'demo-echo:echo' }, methods: ['echo'] },",
    `      { async echo(input) { return { value: ${transform} } } },`,
    '    )',
    '  },',
    '}',
    '',
  ].join('\n')
}

function writeDemo(transform: string): void {
  const dir = featuresDevDir('demo-echo')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'feature.mjs'), demoSource(transform), 'utf-8')
}

const toolContext = {
  sessionId: 'self-evolution-test',
  messageId: 'msg-1',
  toolCallId: 'call-1',
}

/** 经**生产路径上那台 runner** 调用，拿回工具的模型文本。 */
async function runTool(toolId: string, args: JsonObject = {}): Promise<string> {
  const tool = catalog.get(toolId)
  expect(tool, `tool ${toolId} is not in the catalog`).toBeDefined()
  const runner = new ToolRunner({
    authorizer: { async decide() { return Decision.allow() } },
    observer: { on: () => {} },
    validator: new ZodValidator(),
  })
  const outcome = await runner.run(tool!, {
    callId: toolContext.toolCallId,
    toolId,
    input: args,
    sessionId: toolContext.sessionId,
    messageId: toolContext.messageId,
    principal: undefined as never,
  })
  expect(outcome.kind, `tool ${toolId} failed: ${Outcome.toModelText(outcome)}`).toBe('ok')
  return outcome.kind === 'ok'
    ? outcome.result.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n')
    : ''
}

beforeAll(() => {
  previousStorePath = process.env.ONETHING_STORE_PATH
  storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-self-evolution-'))
  process.env.ONETHING_STORE_PATH = storeRoot
})

afterAll(() => {
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

beforeEach(() => {
  resetFeaturesForTests()
  resetRpcRegistryForTests()
  catalog = new Catalog().register(new BashStandIn())
  configureToolkitCatalog(catalog)
})

afterEach(() => {
  configureToolkitCatalog(undefined)
  fs.rmSync(path.join(storeRoot, 'features-dev'), { recursive: true, force: true })
})

describe('self-evolution feature', () => {
  it('registers exactly the three session tools, and unregisters them on unmount', async () => {
    const unmount = await mountFeature(selfEvolutionFeature)

    expect(hasTool('feature_mount')).toBe(true)
    expect(hasTool('feature_unmount')).toBe(true)
    expect(hasTool('feature_inspect')).toBe(true)
    expect(dumpFeatures().find(item => item.id === 'self-evolution')).toEqual({
      id: 'self-evolution',
      // R4b:三只工具收成**一个** disposer(`handle.unregister()` 整组摘),
      // 加上动态 feature 的清扫器 = 两个。顺序纪律不变:清扫最后注册、第一个跑。
      registrations: { rpcDomain: 0, disposer: 2 },
      rpcDomains: [],
    })

    await unmount()

    expect(hasTool('feature_mount')).toBe(false)
    expect(hasTool('feature_unmount')).toBe(false)
    expect(hasTool('feature_inspect')).toBe(false)
  })

  it('registers nothing on a host without bash (readonly tier is fail-closed)', async () => {
    catalog.unregister('bash')

    const unmount = await mountFeature(selfEvolutionFeature)

    expect(hasTool('feature_mount')).toBe(false)
    expect(dumpFeatures().find(item => item.id === 'self-evolution')).toEqual({
      id: 'self-evolution',
      registrations: { rpcDomain: 0, disposer: 0 },
      rpcDomains: [],
    })

    await unmount()
  })

  /**
   * 权限接法的**判定级**断言。
   *
   * `capability_change` 是 策略表(`core/toolkit/effects.ts`)里唯一一行 `never-grantable`：每次
   * 都问、答案永不可记住。挑它不是凑数 —— 挂载一个 feature 就是「改变助手够得
   * 着什么」，与该 kind 的定义原文逐字对上。
   */
  it('feature_mount is permission-gated on a never-grantable effect', async () => {
    const unmount = await mountFeature(selfEvolutionFeature)
    const tool = catalog.get('feature_mount')!

    // 旧的 `autoExecute:false` + `permissionGuard:'permission-gated'` 在新树里由
    // 这一条 never-grantable 的效果说出来(派生表的输入就是它)。
    expect(tool.spec.effects).toEqual(['capability_change'])

    const intent = await tool.plan({ id: 'demo-echo' } as never, { cwd: storeRoot } as never)
    const analysis = { effects: intent.effects, preview: intent.preview }
    expect(analysis.effects).toHaveLength(1)
    const effect = analysis.effects[0]
    expect(effect.kind).toBe('capability_change')
    expect(effect.barrier).toBe(true)
    expect(effect.resources[0]).toBe(path.join(featuresDevDir('demo-echo'), 'feature.mjs'))
    // 权限卡的措辞来自 preview.title（titleForEffect 里它排第一）。
    expect(analysis.preview?.title).toContain('demo-echo')

    // 判定链真的接上了：默认模式下这条 effect 要问，而且永远不能变成常驻授权。
    expect(decidePermission({ sessionId: 'x', mode: 'normal', effects: [effect as never] }).decision).toBe('ask')
    expect(isGrantableType(effect.kind)).toBe(false)

    // 反例：读类工具的 effect 在同一条判定里是直通的 —— 证明上面那个 'ask'
    // 是这条 effect 挣来的，不是判定函数对什么都说 ask。
    expect(decidePermission({
      sessionId: 'x',
      mode: 'normal',
      effects: [{ kind: 'read', resources: ['/tmp/x'], barrier: false }],
    }).decision).toBe('allow')

    await unmount()
  })

  /**
   * **闭环**：挂 → 能调 → 自省看得见 → 改源码重挂 → 行为真的变了 → 卸 → 域消失。
   *
   * 「改源码重挂行为变了」这一步是本期的关键证据：Node 的 ESM 缓存以 URL 为键，
   * 不做 cache-bust 的话第二次 import 会给回第一次的模块对象，症状是「代码明明
   * 改了却没生效」—— 一个极难自证的坑。这条用例就是它的证明。
   */
  it('runs the full loop: mount → call → inspect → edit + remount → unmount', async () => {
    const featureUnmount = await mountFeature(selfEvolutionFeature)

    writeDemo('input.value.toUpperCase()')
    const mounted = await runTool('feature_mount', { id: 'demo-echo' })
    expect(mounted).toContain('已挂载并立即生效(第 1 次)')
    expect(mounted).toContain('rpcDomain 1 (demo-echo)')

    // 挂上就能调：新的域立刻出现在通用 RPC 分发面上。
    expect(hasRpcDomain('demo-echo')).toBe(true)
    await expect(dispatchRpc({ domain: 'demo-echo', method: 'echo', payload: { value: 'hi' } }))
      .resolves.toEqual({ ok: true, data: { value: 'HI' } })

    // 自省：动态标记 + 入口路径 + cordis effect 标签树都在。
    const inspected = await runTool('feature_inspect')
    expect(inspected).toContain('demo-echo')
    expect(inspected).toContain('dynamic —')
    expect(inspected).toContain('feature(demo-echo):rpcDomain:demo-echo')
    // 自进化自己也在名单里，并且标成 builtin（吃自己狗粮的那一条自证）。
    expect(inspected).toContain('self-evolution')
    expect(inspected).toContain('builtin — 随应用构建,不可卸载')

    // 改源码 → 重挂 → 行为变了（证明 cache-bust 真的拿到了新代码）。
    await runTool('feature_unmount', { id: 'demo-echo' })
    writeDemo("input.value.toLowerCase() + '!'")
    const remounted = await runTool('feature_mount', { id: 'demo-echo' })
    expect(remounted).toContain('已挂载并立即生效(第 2 次)')
    await expect(dispatchRpc({ domain: 'demo-echo', method: 'echo', payload: { value: 'Hi' } }))
      .resolves.toEqual({ ok: true, data: { value: 'hi!' } })

    // 卸载：域消失、挂载表出表。
    const unmounted = await runTool('feature_unmount', { id: 'demo-echo' })
    expect(unmounted).toContain('已卸载')
    expect(unmounted).toContain('rpcDomain 1 (demo-echo)')
    expect(hasRpcDomain('demo-echo')).toBe(false)
    expect(hasFeature('demo-echo')).toBe(false)
    expect(dumpFeatures().map(item => item.id)).not.toContain('demo-echo')

    // 二次卸载：不是错误，是一段教学文本。
    const again = await runTool('feature_unmount', { id: 'demo-echo' })
    expect(again).toContain('没挂过,或者已经卸过了')
    expect(again).toContain('feature_inspect()')

    await featureUnmount()
  })

  it('inspect lists mountable-but-unmounted candidates in features-dev', async () => {
    const unmount = await mountFeature(selfEvolutionFeature)
    writeDemo('input.value')

    const inspected = await runTool('feature_inspect')
    expect(inspected).toContain('可挂载的候选')
    expect(inspected).toContain('feature_mount({ id: "demo-echo" })')

    await unmount()
  })

  describe('teaching errors — every failure says what happened AND what to call next', () => {
    let unmountFeature: (() => Promise<void>) | undefined

    beforeEach(async () => {
      unmountFeature = await mountFeature(selfEvolutionFeature)
    })

    afterEach(async () => {
      await unmountFeature?.()
      unmountFeature = undefined
    })

    it('missing directory → creation guidance + an inline minimal template, and creates nothing', async () => {
      const output = await runTool('feature_mount', { id: 'not-there' })

      expect(output).toContain('不存在')
      expect(output).toContain('mkdir -p')
      expect(output).toContain('export default {')
      expect(output).toContain('ctx.registerDisposer')
      expect(output).toContain('feature_mount({ id: "not-there" })')
      // 工具自己不 mkdir —— 与 E0 事件日志同纪律。
      expect(fs.existsSync(featuresDevDir('not-there'))).toBe(false)
    })

    it('entryPath escaping the feature directory is refused before any import', async () => {
      writeDemo('input.value')
      const outsideDir = path.join(storeRoot, 'features-dev', 'elsewhere')
      fs.mkdirSync(outsideDir, { recursive: true })
      fs.writeFileSync(path.join(outsideDir, 'evil.mjs'), 'throw new Error("must not run")', 'utf-8')

      const output = await runTool('feature_mount', {
        id: 'demo-echo',
        entryPath: '../elsewhere/evil.mjs',
      })

      expect(output).toContain('之外')
      expect(output).toContain('拒绝加载')
      expect(output).toContain('挂载等于执行任意代码')
      expect(hasFeature('demo-echo')).toBe(false)
    })

    it('an id that is not a single safe path segment is refused', async () => {
      const output = await runTool('feature_mount', { id: '../escape' })

      expect(output).toContain('不合法')
      expect(output).toContain('不能含 / 或 ..')
    })

    it('a module with no usable default export gets the expected export signature', async () => {
      const dir = featuresDevDir('shapeless')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'feature.mjs'), 'export const nope = 1\n', 'utf-8')

      const output = await runTool('feature_mount', { id: 'shapeless' })

      expect(output).toContain('模块没有默认导出')
      expect(output).toContain('export default {')
      expect(output).toContain('ctx.registerRpcDomain(router, handlers) -> disposer')
      expect(output).toContain('feature_mount({ id: "shapeless" })')
    })

    it('an id mismatch between the call and the module is named on both sides', async () => {
      const dir = featuresDevDir('renamed')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'feature.mjs'),
        "export default { id: 'other-name', mount() {} }\n",
        'utf-8',
      )

      const output = await runTool('feature_mount', { id: 'renamed' })

      expect(output).toContain('"other-name"')
      expect(output).toContain('"renamed"')
      expect(output).toContain('必须一致')
    })

    it('a throwing mount reports the original message and says the rollback already happened', async () => {
      const dir = featuresDevDir('boom')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'feature.mjs'),
        "export default { id: 'boom', mount() { throw new Error('kaboom') } }\n",
        'utf-8',
      )

      const output = await runTool('feature_mount', { id: 'boom' })

      expect(output).toContain('kaboom')
      expect(output).toContain('已经回滚')
      expect(output).toContain('不需要先 unmount')
      expect(hasFeature('boom')).toBe(false)
    })

    it('a module that fails to evaluate is reported as a load error, not a mount error', async () => {
      const dir = featuresDevDir('syntax')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'feature.mjs'), 'export default {\n', 'utf-8')

      const output = await runTool('feature_mount', { id: 'syntax' })

      expect(output).toContain('加载')
      expect(output).toContain('什么都没有注册进去')
    })

    it('mounting an already-mounted id points at unmount instead of overwriting', async () => {
      writeDemo('input.value')
      await runTool('feature_mount', { id: 'demo-echo' })

      const output = await runTool('feature_mount', { id: 'demo-echo' })

      expect(output).toContain('已经挂载')
      expect(output).toContain('feature_unmount({ id: "demo-echo" })')

      await runTool('feature_unmount', { id: 'demo-echo' })
    })

    it('unmounting a builtin feature is refused with the list of what CAN be unmounted', async () => {
      const output = await runTool('feature_unmount', { id: 'self-evolution' })

      expect(output).toContain('内置')
      expect(output).toContain('可以卸载的')
      expect(output).toContain('(当前没有动态挂载的 feature)')
      expect(hasFeature('self-evolution')).toBe(true)
    })
  })

  /**
   * 地雷 1（并行 + 吞错的 `_unload`）的正面用例。
   *
   * 自进化 feature 自己被卸载时，模型现场挂进来的那批必须**先**被收掉，工具才
   * 注销 —— 顺序反了就会留下一批没有控制面、还在跑的动态 feature。
   */
  it('unmounting self-evolution sweeps every dynamic feature first, then drops the tools', async () => {
    const featureUnmount = await mountFeature(selfEvolutionFeature)
    writeDemo('input.value')
    await runTool('feature_mount', { id: 'demo-echo' })
    expect(hasRpcDomain('demo-echo')).toBe(true)

    await featureUnmount()

    expect(hasRpcDomain('demo-echo')).toBe(false)
    expect(hasFeature('demo-echo')).toBe(false)
    expect(hasTool('feature_mount')).toBe(false)
    expect(dumpFeatures()).toEqual([])
  })
})
