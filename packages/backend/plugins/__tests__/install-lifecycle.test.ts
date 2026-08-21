/**
 * P1-3 验收:npm 生命周期命令链。
 *
 * 用**真** CorePluginManager + 真 core 安装编排,只把 npm 本身换成假的
 * (假 npm 在文件系统上逼真模拟 install/uninstall 的账、锁、node_modules
 * 三处效果)。于是脚手架、--ignore-scripts、零依赖校验、SRI 比对、回滚、
 * 互斥单飞全部被钉住,而不起一个真 npm 进程。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CorePluginManager,
  createBuiltinPluginDefinitions,
  installCorePluginPackage,
  readPluginLedgerSpec,
  scanCorePlugins,
  type CorePluginManagerLogger,
  type CorePluginMarketIndex,
  type CorePluginManagerHost,
  type CorePluginStateLike,
  type CorePluginDefinition,
} from '@onething/core/plugins'

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'onething-plugin-install-'))
}

// ── 假 npm:逼真模拟 npm 的三处落盘效果 ──

interface FakePackage {
  pkg: string
  version: string
  runtimeDeps?: Record<string, string>
  minAppVersion?: string
  /** 写进 package-lock 的 integrity(装错包时可以故意与索引不符)。 */
  integrity?: string
  /** 包内 package.json 实际写的 name(默认 = pkg;货不对版模拟)。 */
  innerName?: string
}

interface FakeNpm {
  (args: string[], cwd: string): Promise<{ code: number; stderr: string }>
  calls: string[][]
}

function createFakeNpm(pluginsDir: string, catalog: Map<string, FakePackage>): FakeNpm {
  const calls: string[][] = []
  const run = Object.assign(async (args: string[]): Promise<{ code: number; stderr: string }> => {
    calls.push([...args])
    const [command, spec] = args
    if (command === 'install') {
      const entry = catalog.get(spec)
      if (!entry) return { code: 1, stderr: `404 Not Found: ${spec}` }
      const dir = path.join(pluginsDir, 'node_modules', entry.pkg)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: entry.innerName ?? entry.pkg,
        version: entry.version,
        ...(entry.runtimeDeps ? { dependencies: entry.runtimeDeps } : {}),
      }))
      fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
        name: entry.pkg,
        ...(entry.minAppVersion ? { minAppVersion: entry.minAppVersion } : {}),
      }))
      fs.writeFileSync(path.join(dir, 'plugin-entry.js'), 'export default function () {}\n')
      // 账
      const ledgerPath = path.join(pluginsDir, 'package.json')
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')) as { dependencies?: Record<string, string> }
      ledger.dependencies = { ...ledger.dependencies, [entry.pkg]: spec }
      fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2))
      // 锁
      const lockPath = path.join(pluginsDir, 'package-lock.json')
      const lock = fs.existsSync(lockPath)
        ? JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as { packages: Record<string, unknown> }
        : { packages: {} as Record<string, unknown> }
      lock.packages[`node_modules/${entry.pkg}`] = {
        version: entry.version,
        ...(entry.integrity ? { integrity: entry.integrity } : {}),
      }
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2))
      return { code: 0, stderr: '' }
    }
    if (command === 'uninstall') {
      const pkg = spec
      fs.rmSync(path.join(pluginsDir, 'node_modules', pkg), { recursive: true, force: true })
      const ledgerPath = path.join(pluginsDir, 'package.json')
      if (fs.existsSync(ledgerPath)) {
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')) as { dependencies?: Record<string, string> }
        if (ledger.dependencies) delete ledger.dependencies[pkg]
        fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2))
      }
      const lockPath = path.join(pluginsDir, 'package-lock.json')
      if (fs.existsSync(lockPath)) {
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as { packages: Record<string, unknown> }
        delete lock.packages[`node_modules/${pkg}`]
        fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2))
      }
      return { code: 0, stderr: '' }
    }
    return { code: 1, stderr: `unknown npm command: ${command}` }
  }, { calls })
  return run
}

// ── 真 manager + 最小 host ──

type TestEntry = (api: Record<string, never>) => void
type TestDefinition = CorePluginDefinition<TestEntry>
interface TestState extends CorePluginStateLike { disposed: boolean }

const HOST_APP_VERSION = '1.4.0'

async function createManager(input: {
  pluginsDir: string
  npm: FakeNpm
  index?: CorePluginMarketIndex | null
  logger?: CorePluginManagerLogger
  /** 内置定义(测防撞闸用);扫描时先于一切用户插件占位。 */
  builtin?: TestDefinition[]
  /** 每次加载拿到的热重载令牌 —— 宿主用它做 ESM cache-buster,复用即旧模块。 */
  loadTokens?: Array<{ id: string; token: unknown }>
}) {
  const logger = input.logger ?? { log: () => {}, warn: () => {}, error: () => {} }
  const host: CorePluginManagerHost<
    TestDefinition, TestEntry, Record<string, never>, TestState, unknown, unknown
  > = {
    ensurePluginDirs: () => fs.mkdirSync(input.pluginsDir, { recursive: true }),
    scanPlugins: () => scanCorePlugins<TestEntry>({
      builtinPlugins: input.builtin ?? [],
      pluginsDir: input.pluginsDir,
      getEnabled: () => true,
      appVersion: HOST_APP_VERSION,
      scanMode: 'npm-ledger',
    }),
    loadPluginEntry: async (definition, reloadToken) => {
      input.loadTokens?.push({ id: definition.id, token: reloadToken })
      // 与真宿主同一条规则:loadBlockedReason 置位的插件不执行任何代码。
      if (definition.loadBlockedReason) return null
      return () => {}
    },
    createPluginAPI: () => ({ api: {}, state: { disposed: false, commands: new Map() } }),
    disposePlugin: state => { state.disposed = true },
    setPluginEnabled: () => {},
    installPluginPackage: pkgInput =>
      installCorePluginPackage(input.pluginsDir, pkgInput, { runNpm: input.npm, logger }),
    readInstalledPluginSpec: pkg => readPluginLedgerSpec(input.pluginsDir, pkg),
    fetchPluginMarketIndex: async () => input.index ?? null,
  }
  const manager = new CorePluginManager(host, logger)
  // 与真宿主同一条路径:initialize 才有 context,否则 loadPlugin 一律
  // "not initialized"(插件装得上但永远不 loaded)。
  await manager.initialize({})
  return manager
}

const PLAN_V1_URL = 'https://releases.example/plan-status-1.0.0.tgz'
const PLAN_V2_URL = 'https://releases.example/plan-status-2.0.0.tgz'

describe('installPlugin —— 安装链', () => {
  it('首装自动写脚手架;装完插件进表、默认启用;--ignore-scripts 在场', async () => {
    const pluginsDir = tempRoot()
    const catalog = new Map([[PLAN_V1_URL, { pkg: 'plan-status', version: '1.0.0' }]])
    const npm = createFakeNpm(pluginsDir, catalog)
    const manager = await createManager({ pluginsDir, npm })

    const result = await manager.installPlugin({ pkg: 'plan-status', tarballUrl: PLAN_V1_URL })

    expect(result).toEqual({ success: true, pluginId: 'plan-status' })
    // 脚手架
    const ledger = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'package.json'), 'utf-8'))
    expect(ledger.private).toBe(true)
    expect(ledger.name).toBe('onething-installed-plugins')
    expect(ledger.dependencies['plan-status']).toBe(PLAN_V1_URL)
    // 安全底线旗标
    const installArgs = npm.calls.find(call => call[0] === 'install')!
    expect(installArgs).toContain('--ignore-scripts')
    // 插件进表,默认启用,版本来自 node_modules 里的 package.json
    const plugin = manager.getPlugins().find(p => p.definition.id === 'plan-status')!
    expect(plugin.definition.enabled).toBe(true)
    expect(plugin.definition.manifest.version).toBe('1.0.0')
    expect(plugin.loaded).toBe(true)
  })

  it('file: 开发通道:path 被规范化成 file: spec 交给 npm', async () => {
    const pluginsDir = tempRoot()
    const localDir = path.join(pluginsDir, 'incoming', 'plan-status')
    const spec = `file:${localDir}`
    const catalog = new Map([[spec, { pkg: 'plan-status', version: '0.1.0' }]])
    const npm = createFakeNpm(pluginsDir, catalog)
    const manager = await createManager({ pluginsDir, npm })

    const result = await manager.installPlugin({ pkg: 'plan-status', path: localDir })

    expect(result.success).toBe(true)
    expect(npm.calls[0][1]).toBe(spec)
  })

  it('包带运行时 dependencies = 拒载并回滚(bundle 规则)', async () => {
    const pluginsDir = tempRoot()
    const catalog = new Map([[PLAN_V1_URL, {
      pkg: 'plan-status', version: '1.0.0', runtimeDeps: { zod: '^3.0.0' },
    }]])
    const npm = createFakeNpm(pluginsDir, catalog)
    const manager = await createManager({ pluginsDir, npm })

    const result = await manager.installPlugin({ pkg: 'plan-status', tarballUrl: PLAN_V1_URL })

    expect(result.success).toBe(false)
    expect(result.error).toContain('fully bundled')
    expect(result.error).toContain('zod')
    // 回滚:npm uninstall 跑过,node_modules 与账都干净
    expect(npm.calls.some(call => call[0] === 'uninstall' && call[1] === 'plan-status')).toBe(true)
    expect(fs.existsSync(path.join(pluginsDir, 'node_modules', 'plan-status'))).toBe(false)
    const ledger = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'package.json'), 'utf-8'))
    expect(ledger.dependencies['plan-status']).toBeUndefined()
    expect(manager.getPlugins()).toEqual([])
  })

  it('SRI 与 package-lock 不符 = 拒载并回滚', async () => {
    const pluginsDir = tempRoot()
    const catalog = new Map([[PLAN_V1_URL, {
      pkg: 'plan-status', version: '1.0.0', integrity: 'sha512-actual',
    }]])
    const npm = createFakeNpm(pluginsDir, catalog)
    const manager = await createManager({ pluginsDir, npm })

    const result = await manager.installPlugin({
      pkg: 'plan-status', tarballUrl: PLAN_V1_URL, integrity: 'sha512-expected',
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Integrity mismatch')
    expect(npm.calls.some(call => call[0] === 'uninstall')).toBe(true)
    expect(fs.existsSync(path.join(pluginsDir, 'node_modules', 'plan-status'))).toBe(false)
  })

  it('npm 失败 = 错误原样透传,账不动', async () => {
    const pluginsDir = tempRoot()
    const npm = createFakeNpm(pluginsDir, new Map())
    const manager = await createManager({ pluginsDir, npm })

    const result = await manager.installPlugin({ pkg: 'ghost', tarballUrl: 'https://releases.example/ghost.tgz' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('404')
    // 失败在 npm 层,无需回滚;账保持空(脚手架已建但无依赖行)
    expect(npm.calls.some(call => call[0] === 'uninstall')).toBe(false)
  })
})

describe('updatePlugin / checkPluginUpdates', () => {
  async function installV1(pluginsDir: string, npm: FakeNpm, manager: CorePluginManager<any, any, any, any, any, any>) {
    await manager.installPlugin({ pkg: 'plan-status', tarballUrl: PLAN_V1_URL })
  }

  it('索引有新版 → 走安装链换新 URL;checkPluginUpdates 之前报得出', async () => {
    const pluginsDir = tempRoot()
    const catalog = new Map<string, FakePackage>([
      [PLAN_V1_URL, { pkg: 'plan-status', version: '1.0.0' }],
      [PLAN_V2_URL, { pkg: 'plan-status', version: '2.0.0' }],
    ])
    const npm = createFakeNpm(pluginsDir, catalog)
    const index: CorePluginMarketIndex = {
      version: 1,
      plugins: [{ id: 'plan-status', pkg: 'plan-status', version: '2.0.0', tarballUrl: PLAN_V2_URL }],
    }
    const manager = await createManager({ pluginsDir, npm, index })
    await installV1(pluginsDir, npm, manager)

    const offers = await manager.checkPluginUpdates()
    expect(offers).toEqual([{ pluginId: 'plan-status', current: '1.0.0', latest: '2.0.0' }])

    const result = await manager.updatePlugin('plan-status')
    expect(result).toEqual({ success: true, pluginId: 'plan-status', version: '2.0.0' })
    // 不用 npm update:走的是 install 新 URL
    const installs = npm.calls.filter(call => call[0] === 'install')
    expect(installs[installs.length - 1][1]).toBe(PLAN_V2_URL)
    // 账换新 spec,插件表里的版本刷新
    expect(readPluginLedgerSpec(pluginsDir, 'plan-status')).toBe(PLAN_V2_URL)
    expect(manager.getPlugins()[0].definition.manifest.version).toBe('2.0.0')
    // 更新后再查 = 没有更新
    expect(await manager.checkPluginUpdates()).toEqual([])
  })

  it('装后 minAppVersion 不够 = 回退旧版并明示', async () => {
    const pluginsDir = tempRoot()
    const catalog = new Map<string, FakePackage>([
      [PLAN_V1_URL, { pkg: 'plan-status', version: '1.0.0' }],
      [PLAN_V2_URL, { pkg: 'plan-status', version: '2.0.0', minAppVersion: '99.0.0' }],
    ])
    const npm = createFakeNpm(pluginsDir, catalog)
    const index: CorePluginMarketIndex = {
      version: 1,
      plugins: [{ id: 'plan-status', pkg: 'plan-status', version: '2.0.0', tarballUrl: PLAN_V2_URL }],
    }
    const manager = await createManager({ pluginsDir, npm, index })
    await installV1(pluginsDir, npm, manager)

    const result = await manager.updatePlugin('plan-status')

    expect(result.success).toBe(false)
    expect(result.rolledBack).toBe(true)
    expect(result.error).toContain('rolled back')
    expect(result.error).toContain('99.0.0')
    // 账退回旧 spec,表里的插件回到旧版且正常加载
    expect(readPluginLedgerSpec(pluginsDir, 'plan-status')).toBe(PLAN_V1_URL)
    const plugin = manager.getPlugins()[0]
    expect(plugin.definition.manifest.version).toBe('1.0.0')
    expect(plugin.loaded).toBe(true)
  })

  it('账外的手工目录压根不进插件表(legacy 清零后);无索引 = 更新通道整体关闭', async () => {
    const pluginsDir = tempRoot()
    // 曾经的 legacy 形态:有 plugin.json 不在账 —— 今天它不再被加载。
    const strayDir = path.join(pluginsDir, 'ui-demo')
    fs.mkdirSync(strayDir, { recursive: true })
    fs.writeFileSync(path.join(strayDir, 'plugin.json'), JSON.stringify({ name: 'ui-demo' }))
    fs.writeFileSync(path.join(strayDir, 'plugin-entry.js'), 'export default function () {}\n')

    const npm = createFakeNpm(pluginsDir, new Map())
    const manager = await createManager({ pluginsDir, npm })
    await manager.refreshPlugins()

    expect(manager.getPlugins()).toEqual([])
    const updated = await manager.updatePlugin('ui-demo')
    expect(updated.success).toBe(false)
    expect(updated.error).toContain('Unknown plugin')
    expect(await manager.checkPluginUpdates()).toEqual([])
  })
})

/**
 * 热重载令牌 = 宿主的 ESM cache-buster(`?v=<token>`)。**令牌复用 = 模块缓存
 * 命中 = 磁盘换了新代码、进程里跑的还是旧模块**,而 manifest 现读磁盘已经是
 * 新版本 —— 表现为"版本号变了、行为没变,重启才生效"。
 *
 * 真机实录(2026-08-09,tps-meter 1.0.2 验收):卸载 1.0.1 → 装 1.0.2 之后,
 * 那一轮跑的仍是 1.0.1 的纯内存实现,消息态一条也没落盘;重启 app 才正常。
 * 病根有两条:uninstall 把令牌删回 0,而安装/更新根本不动令牌。
 */
describe('热重载令牌:换了代码就必须换令牌', () => {
  it('装/更新/卸载重装/重新启用 —— 令牌只增不重复', async () => {
    const pluginsDir = tempRoot()
    const catalog = new Map<string, FakePackage>([
      [PLAN_V1_URL, { pkg: 'plan-status', version: '1.0.0' }],
      [PLAN_V2_URL, { pkg: 'plan-status', version: '2.0.0' }],
    ])
    const npm = createFakeNpm(pluginsDir, catalog)
    const index: CorePluginMarketIndex = {
      version: 1,
      plugins: [{ id: 'plan-status', pkg: 'plan-status', version: '2.0.0', tarballUrl: PLAN_V2_URL }],
    }
    const loadTokens: Array<{ id: string; token: unknown }> = []
    const manager = await createManager({ pluginsDir, npm, index, loadTokens })

    await manager.installPlugin({ pkg: 'plan-status', tarballUrl: PLAN_V1_URL })
    await manager.updatePlugin('plan-status')
    await manager.disablePlugin('plan-status')
    await manager.enablePlugin('plan-status')
    // 卸载重装同一个 id —— 曾经的病根:uninstall 把令牌归零,重装拿回用过的号。
    await manager.uninstallPlugin('plan-status')
    await manager.installPlugin({ pkg: 'plan-status', tarballUrl: PLAN_V1_URL })

    const tokens = loadTokens.filter(entry => entry.id === 'plan-status').map(entry => entry.token)
    expect(tokens.length).toBeGreaterThanOrEqual(4)
    // 唯一性是判据本身:重复一次就意味着那一次加载吃的是旧模块。
    expect(new Set(tokens).size).toBe(tokens.length)
  })
})

describe('互斥:生命周期命令与 refresh 共用单飞', () => {
  it('包名去 scope 撞上内置 id = 装前拒绝:npm 不起、账不动(防"付钱买空气")', async () => {
    const root = tempRoot()
    const pluginsDir = path.join(root, 'plugins')
    const catalog = new Map<string, FakePackage>([
      ['file:/market/log-monitor', { pkg: '@onething-plugins/log-monitor', version: '1.0.0' }],
    ])
    const npm = createFakeNpm(pluginsDir, catalog)
    const manager = await createManager({
      pluginsDir,
      npm,
      builtin: createBuiltinPluginDefinitions<TestEntry>([{
        id: 'log-monitor',
        manifest: { name: 'log-monitor', version: '1.0.0' },
        entry: () => {},
        enabled: true,
      }]) as TestDefinition[],
    })

    const result = await manager.installPlugin({ pkg: '@onething-plugins/log-monitor', path: '/market/log-monitor' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('built-in')
    // 装前闸:npm 根本不该被起动,账本自然一字未动。
    expect(npm.calls).toHaveLength(0)
    expect(fs.existsSync(path.join(pluginsDir, 'package.json'))).toBe(false)
  })

  it('非 https/file: 的 spec 协议 = 装前拒(git+ssh、http 都不收),npm 不起', async () => {
    const root = tempRoot()
    const pluginsDir = path.join(root, 'plugins')
    const npm = createFakeNpm(pluginsDir, new Map())
    const manager = await createManager({ pluginsDir, npm })

    for (const spec of ['git+ssh://git@example.com/x.git', 'http://insecure.example/x.tgz']) {
      const result = await manager.installPlugin({ pkg: '@onething-plugins/demo', tarballUrl: spec })
      expect(result.success).toBe(false)
      expect(result.error).toContain('https://')
    }
    expect(npm.calls).toHaveLength(0)
    expect(fs.existsSync(path.join(pluginsDir, 'package.json'))).toBe(false)
  })

  it('包内 name 与 pkg 不符 = 拒载并回滚(账货一致性)', async () => {
    const root = tempRoot()
    const pluginsDir = path.join(root, 'plugins')
    const catalog = new Map<string, FakePackage>([
      ['https://releases.example/wrong-name-1.0.0.tgz', {
        pkg: '@onething-plugins/plan-status',
        version: '1.0.0',
        innerName: '@evil/impostor',
      }],
    ])
    const npm = createFakeNpm(pluginsDir, catalog)
    const manager = await createManager({ pluginsDir, npm })

    const result = await manager.installPlugin({
      pkg: '@onething-plugins/plan-status',
      tarballUrl: 'https://releases.example/wrong-name-1.0.0.tgz',
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('name mismatch')
    // 回滚:uninstall 起过,账与包都清干净。
    expect(npm.calls.some(args => args[0] === 'uninstall')).toBe(true)
    const ledger = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'package.json'), 'utf-8')) as { dependencies?: Record<string, string> }
    expect(ledger.dependencies?.['@onething-plugins/plan-status']).toBeUndefined()
    expect(fs.existsSync(path.join(pluginsDir, 'node_modules', '@onething-plugins', 'plan-status'))).toBe(false)
  })

  it('install 占住单飞期间,refreshPlugins 复用同一张票', async () => {
    const pluginsDir = tempRoot()
    const catalog = new Map([[PLAN_V1_URL, { pkg: 'plan-status', version: '1.0.0' }]])
    const npm = createFakeNpm(pluginsDir, catalog)
    const manager = await createManager({ pluginsDir, npm })

    // install 内部:npm install → doRefreshPlugins。在 install 进行中发起的
    // refreshPlugins 不该另起一轮扫描 —— 它拿到的是 install 那张票。
    const installPromise = manager.installPlugin({ pkg: 'plan-status', tarballUrl: PLAN_V1_URL })
    const refreshPromise = manager.refreshPlugins()
    const [installResult] = await Promise.all([installPromise, refreshPromise])

    expect(installResult.success).toBe(true)
    expect(manager.getPlugins()).toHaveLength(1)
  })
})
