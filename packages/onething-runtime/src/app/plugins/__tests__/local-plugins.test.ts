/**
 * 轻通道(本地单文件插件形态)—— 装配层验收
 * (docs/design/pi-benchmark-adoption-2026-08.md §2 轻通道)。
 *
 * 打的是"只有装配层知道的事实":plugins-dev 单文件被 scanPlugins 追加、id=文件名、
 * isLocalPlugin 翻真、启动日志列出脚本、坏脚本加载隔离不拖垮别的、能力面物理收窄
 * (LocalPluginAPI 保留白名单、拿不到 sessions/llm/面板/拦截钩子),以及 **A 期不回退**
 * —— `plugins/` 的 npm 账本扫描与本地扫描并存、互不影响。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { collectLogRecordsForTests } from '../../logging/index.js'

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-local-plugins-app-'))
const previousStorePath = process.env.ONETHING_STORE_PATH
process.env.ONETHING_STORE_PATH = storeRoot

afterAll(async () => {
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve))
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const devDir = path.join(storeRoot, 'plugins-dev')
const pluginsDir = path.join(storeRoot, 'plugins')

function writeDevScript(filename: string, body = 'export default function () {}\n'): void {
  fs.mkdirSync(devDir, { recursive: true })
  fs.writeFileSync(path.join(devDir, filename), body)
}

/** 造一个 A 期形态的 npm 账本插件,证明本地扫描与它并存、不干扰。 */
function seedNpmLedgerPlugin(name: string): void {
  const dir = path.join(pluginsDir, 'node_modules', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(pluginsDir, 'package.json'), JSON.stringify({ dependencies: { [name]: 'file:x' } }))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '9.9.9' }))
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name, description: 'npm demo' }))
  fs.writeFileSync(path.join(dir, 'plugin-entry.js'), 'export default function () {}\n')
}

async function loader() {
  return import('../loader.js')
}

describe('scanPlugins —— 轻通道追加在 npm 账本扫描之后', () => {
  it('单文件被扫为 source=local、id=文件名;isLocalPlugin 翻真;账本插件与内置并存', async () => {
    writeDevScript('hello-gauge.ts')
    seedNpmLedgerPlugin('plan-status')
    const { scanPlugins, isLocalPlugin, getLocalPluginsDir } = await loader()

    const defs = scanPlugins()
    const byId = new Map(defs.map(def => [def.id, def]))

    // 本地脚本
    const local = byId.get('hello-gauge')
    expect(local?.source).toBe('local')
    expect(local?.manifest.contributes).toBeUndefined()
    expect(local?.entryPath).toBe(path.join(devDir, 'hello-gauge.ts'))
    expect(isLocalPlugin('hello-gauge')).toBe(true)
    expect(isLocalPlugin('plan-status')).toBe(false)

    // A 期不回退:npm 账本插件照常扫出
    expect(byId.get('plan-status')?.source).toBe('user')
    expect(byId.get('plan-status')?.dirPath).toContain('node_modules')

    // 内置插件仍在
    expect(defs.some(def => def.source === 'builtin')).toBe(true)

    expect(getLocalPluginsDir()).toBe(devDir)
  })

  it('启动可见性:集合变化时吼一声,列出加载了哪些本地脚本', async () => {
    // 加一个新脚本让本地 id 集合发生变化 —— 日志只在变化时打(热路径不刷屏)。
    writeDevScript('gauge-log-probe.ts')
    const logs = collectLogRecordsForTests()
    const { scanPlugins } = await loader()
    scanPlugins()
    const record = logs.records.find(entry => entry.msg === 'loaded local dev plugin scripts')
    expect(record).toBeTruthy()
    expect(record?.fields?.pluginIds).toContain('gauge-log-probe')
    logs.stop()
  })
})

describe('坏脚本隔离', () => {
  it('一个在加载期抛错的本地脚本回 null,不影响同目录的好脚本', async () => {
    writeDevScript('good.mjs', 'export default function () {}\n')
    writeDevScript('bad.mjs', 'throw new Error("boom at module top-level")\n')
    const { scanPlugins, loadPluginEntry } = await loader()
    const defs = scanPlugins()
    const good = defs.find(def => def.id === 'good')!
    const bad = defs.find(def => def.id === 'bad')!

    // 扫描期两个都在(可加载性是加载期的事)
    expect(good).toBeTruthy()
    expect(bad).toBeTruthy()

    // reloadToken 打散 ESM 缓存,避免跨用例命中同一模块记录
    expect(typeof await loadPluginEntry(good, 'g1')).toBe('function')
    expect(await loadPluginEntry(bad, 'b1')).toBeNull()
  })
})

describe('能力收窄:LocalPluginAPI 物理不挂需声明的能力', () => {
  it('narrowApiForLocalPlugin 只保留白名单键,函数绑回原 api,子对象透传', async () => {
    const { narrowApiForLocalPlugin } = await import('../api.js')

    const calls: string[] = []
    // 造一个"完整" api 的替身:白名单里的函数记录被调用,其余能力只需存在。
    const full = {
      id: 'demo',
      registerTool: function () { calls.push('registerTool') },
      registerCommand: function () { calls.push('registerCommand') },
      on: function () { return () => {} },
      events: { emit() {} },
      ui: { notify() {} },
      storage: { readJson() {} },
      store: { get() {}, set() {} },
      scheduler: { register() {} },
      onDispose: function () { calls.push('onDispose') },
      // 需声明才有的能力 —— 收窄后必须物理消失
      sendMessage: () => {},
      sessions: { peek() {}, list() {} },
      isIdle: () => {},
      llm: { complete() {} },
      steer: () => {},
      followUp: () => {},
      interceptInput: () => {},
      interceptToolCall: () => {},
      interceptToolResult: () => {},
      registerWorkspacePanel: () => {},
      registerUiSlot: () => {},
      theme: { updateBackground() {} },
      registerSearchProvider: () => {},
      registerIMConnector: () => {},
      registerCredentialStrategy: () => {},
      registerRequestHandler: () => {},
      settings: { get() {}, onChange() {} },
      registerPromptContextProvider: () => {},
      beforeContextCompact: () => {},
      afterAssistantResponse: () => {},
      registerSkillRoot: () => {},
      status: {},
    } as unknown as Parameters<typeof narrowApiForLocalPlugin>[0]

    const narrow = narrowApiForLocalPlugin(full) as unknown as Record<string, unknown>

    // 白名单:保留
    for (const key of ['id', 'registerTool', 'registerCommand', 'on', 'events', 'ui', 'storage', 'store', 'scheduler', 'onDispose']) {
      expect(narrow[key], `should keep ${key}`).toBeDefined()
    }
    expect(narrow.id).toBe('demo')
    expect(narrow.events).toBe((full as unknown as Record<string, unknown>).events)

    // 需声明的能力:物理不挂(调用即 undefined is not a function)
    for (const key of [
      'sendMessage', 'sessions', 'isIdle', 'llm', 'steer', 'followUp',
      'interceptInput', 'interceptToolCall', 'interceptToolResult',
      'registerWorkspacePanel', 'registerUiSlot', 'theme',
      'registerSearchProvider', 'registerIMConnector', 'registerCredentialStrategy',
      'registerRequestHandler',
      'settings', 'registerPromptContextProvider', 'beforeContextCompact',
      'afterAssistantResponse', 'registerSkillRoot', 'status',
    ]) {
      expect(narrow[key], `should drop ${key}`).toBeUndefined()
    }

    // 函数确实可调用(绑回原 api)
    ;(narrow.registerTool as () => void)()
    expect(calls).toContain('registerTool')
  })

  it('LOCAL_PLUGIN_API_KEYS 不含任何需声明门控的能力', async () => {
    const { LOCAL_PLUGIN_API_KEYS } = await import('../types.js')
    const banned = ['sendMessage', 'sessions', 'llm', 'interceptInput', 'interceptToolCall', 'interceptToolResult', 'registerWorkspacePanel', 'registerUiSlot', 'theme', 'registerSearchProvider', 'registerIMConnector', 'registerCredentialStrategy']
    for (const key of banned) {
      expect(LOCAL_PLUGIN_API_KEYS).not.toContain(key)
    }
  })
})
