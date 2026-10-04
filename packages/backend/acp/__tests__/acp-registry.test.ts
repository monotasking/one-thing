/**
 * ACP 名册的三源合并(A1-a,方案 §3.2 / §11.2)。
 *
 * 临时种子目录 + 临时缓存文件 + 注入的 fetch / 探测 —— 测试里**永不联网、不碰真 PATH**。
 * 钉的是:同 id 用户 > 种子 > 注册表;种子吃掉它在注册表里的那一条;`enabled` 缺省 = 探测到
 * 已安装;坏种子一行 warn、其余照常;老盘上的默认拷贝不算用户条目(反证 b);旧 id 认回;
 * 注册表开关关着不联网;TTL;拉失败用缓存。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ACPSettings, AcpAgentDetect, AcpAgentManifest } from '@shared/contracts/acp'

const warns = vi.hoisted(() => [] as Array<{ msg: string; fields?: unknown }>)
vi.mock('@onething/backend/logging', async importOriginal => {
  const actual = await importOriginal<typeof import('@onething/backend/logging')>()
  const logger = {
    ns: 'test', trace() {}, debug() {}, info() {}, error() {}, fatal() {},
    warn(msg: string, fields?: unknown) { warns.push({ msg, fields }) },
    isLevelEnabled: () => false, child: () => logger,
  }
  return { ...actual, getLogger: () => logger, consolePort: () => logger }
})

const { AcpAgentRegistry } = await import('../acp-registry.js')

let root: string
let seedDir: string
let cachePath: string
let settings: ACPSettings

function writeSeed(id: string, body: Record<string, unknown>): void {
  writeFileSync(path.join(seedDir, `${id}.json`), JSON.stringify({ id, ...body }))
}

function writeCache(fetchedAt: number, agents: unknown[]): void {
  mkdirSync(path.dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, JSON.stringify({ fetchedAt, entries: agents }))
}

const REGISTRY_ENTRIES = [
  // 种子 alpha 声明了 registryId = alpha-acp:这一条应被吃掉。
  { id: 'alpha-acp', name: 'Alpha (registry)', distribution: { npx: { package: 'alpha-acp@1.0.0' } } },
  { id: 'gamma', name: 'Gamma', distribution: { npx: { package: '@g/gamma@2.0.0', args: ['--acp'] } } },
  { id: 'delta', name: 'Delta', repository: 'https://example.com/delta', distribution: { uvx: { package: 'delta' } } },
]

function makeRegistry(options: {
  installed?: string[]
  fetch?: ReturnType<typeof vi.fn>
  now?: number
} = {}) {
  const installed = new Set(options.installed ?? ['alpha'])
  const detect = vi.fn(async (manifest: AcpAgentManifest): Promise<AcpAgentDetect> => ({
    installed: installed.has(manifest.id),
    checkedAt: 1,
  }))
  const registry = new AcpAgentRegistry({
    seedDir: () => seedDir,
    cachePath: () => cachePath,
    settings: () => settings,
    detect,
    locate: manifest => ({ installed: installed.has(manifest.id), checkedAt: 1 }),
    fetch: options.fetch ? () => options.fetch as never : undefined,
    now: () => options.now ?? 1_000_000,
    platform: 'darwin-aarch64',
  })
  return { registry, detect }
}

beforeEach(() => {
  warns.length = 0
  root = mkdtempSync(path.join(os.tmpdir(), 'acp-registry-'))
  seedDir = path.join(root, 'acp-agents')
  cachePath = path.join(root, 'store', 'acp', 'registry-cache.json')
  mkdirSync(seedDir)
  writeSeed('alpha', {
    name: 'Alpha',
    launch: { command: 'alpha-acp' },
    registryId: 'alpha-acp',
    aliases: ['alpha-old'],
  })
  writeSeed('beta', { name: 'Beta', launch: { command: 'beta', args: ['acp'] } })
  settings = { enabled: true, agents: [] }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('AcpAgentRegistry', () => {
  it('三源合并:种子在前、用户条目、注册表在后;种子吃掉它在注册表里的那一条', () => {
    writeCache(1_000_000, REGISTRY_ENTRIES)
    settings = { enabled: true, agents: [{ id: 'mine', name: 'Mine', enabled: true, command: '/opt/mine' }] }
    const { registry } = makeRegistry()
    const rows = registry.roster()
    expect(rows.map(row => [row.manifest.id, row.source])).toEqual([
      ['alpha', 'builtin'],
      ['beta', 'builtin'],
      ['mine', 'user'],
      ['gamma', 'registry'],
      ['delta', 'registry'],
    ])
    const gamma = rows.find(row => row.manifest.id === 'gamma')!
    expect(gamma.effective).toMatchObject({ command: 'npx', args: ['-y', '@g/gamma@2.0.0', '--acp'] })
    // uvx 形没有起法:上榜,但喂不了管家。
    expect(rows.find(row => row.manifest.id === 'delta')!.effective.command).toBe('')
  })

  it('enabled 缺省 = 探测到已安装;用户覆盖写了就用覆盖的', () => {
    const { registry } = makeRegistry({ installed: ['alpha'] })
    const byId = () => new Map(registry.roster().map(row => [row.manifest.id, row]))
    expect(byId().get('alpha')!.effective.enabled).toBe(true)
    expect(byId().get('beta')!.effective.enabled).toBe(false)

    settings = { enabled: true, agents: [{ id: 'alpha', name: 'Alpha', enabled: false, command: 'alpha-acp' }] }
    const alpha = byId().get('alpha')!
    expect(alpha.source).toBe('builtin')
    expect(alpha.override?.enabled).toBe(false)
    expect(alpha.effective.enabled).toBe(false)
  })

  it('稀疏覆盖 { id, enabled: true }:没装也启用,且不被当成种子拷贝', () => {
    settings = { enabled: true, agents: [{ id: 'beta', enabled: true } as unknown as ACPSettings['agents'][number]] }
    const beta = makeRegistry({ installed: [] }).registry.roster().find(row => row.manifest.id === 'beta')!
    expect(beta.override).toEqual({ id: 'beta', enabled: true })
    expect(beta.effective).toMatchObject({ name: 'Beta', command: 'beta', args: ['acp'], enabled: true })
  })

  it('同 id 用户 > 种子:覆盖只改它写了的格', () => {
    settings = { enabled: true, agents: [{ id: 'beta', name: 'Beta', enabled: true, command: 'beta', args: ['acp', '--debug'] }] }
    const beta = makeRegistry().registry.roster().find(row => row.manifest.id === 'beta')!
    expect(beta.source).toBe('builtin')
    expect(beta.effective).toMatchObject({ command: 'beta', args: ['acp', '--debug'], enabled: true })
  })

  it('反证 (a):缺 launch.command 的坏种子一行 warn,其余照常上榜', () => {
    writeSeed('broken', { name: 'Broken', launch: { args: ['x'] } })
    writeFileSync(path.join(seedDir, 'garbage.json'), '{not json')
    const rows = makeRegistry().registry.roster()
    expect(rows.map(row => row.manifest.id)).toEqual(['alpha', 'beta'])
    const rejected = warns.filter(warn => warn.msg === 'acp seed manifests rejected')
    expect(rejected).toHaveLength(1)
    expect(JSON.stringify(rejected[0].fields)).toContain('broken: launch.command is required')
  })

  it('反证 (b):老盘上 A1 之前写回去的默认条目是种子拷贝,不产生覆盖行', () => {
    settings = {
      enabled: true,
      agents: [{
        id: 'alpha',
        name: 'Alpha',
        description: 'Alpha ACP-compatible local agent.',
        enabled: true,
        command: 'alpha-acp',
        args: [],
        unattended: 'allow',
        idleTimeoutMs: 600000,
        maxBufferedUpdates: 1000,
      }],
    }
    const rows = makeRegistry().registry.roster().filter(row => row.manifest.id === 'alpha')
    expect(rows).toHaveLength(1)
    expect(rows[0].override).toBeUndefined()
    expect(rows[0].source).toBe('builtin')
    // 于是 enabled 回到「探测到已安装」,而不是那条拷贝里写死的 true。
    expect(rows[0].effective.idleTimeoutMs).toBeUndefined()
  })

  it('旧 id 认回:`alpha-old` 的用户条目成了 alpha 的覆盖;别名表交给管家', () => {
    settings = { enabled: true, agents: [{ id: 'alpha-old', name: 'Alpha', enabled: true, command: '/custom/alpha' }] }
    const { registry } = makeRegistry()
    const rows = registry.roster()
    expect(rows.some(row => row.manifest.id === 'alpha-old')).toBe(false)
    expect(rows.find(row => row.manifest.id === 'alpha')!.effective.command).toBe('/custom/alpha')
    expect(registry.aliases()).toEqual({ 'alpha-old': 'alpha' })

    // 旧 id 且与种子逐字相等 → 认回后就是拷贝,丢掉。
    settings = { enabled: true, agents: [{ id: 'alpha-old', name: 'Alpha', enabled: true, command: 'alpha-acp', args: [] }] }
    expect(registry.roster().find(row => row.manifest.id === 'alpha')!.override).toBeUndefined()
  })

  it('「复制为自定义」:basedOn 继承那一台的 manifest,来源是 user', () => {
    settings = { enabled: true, agents: [{ id: 'alpha-work', name: 'Alpha·工作', enabled: true, command: '', basedOn: 'alpha', args: ['--profile', 'work'] }] }
    const row = makeRegistry().registry.roster().find(entry => entry.manifest.id === 'alpha-work')!
    expect(row.source).toBe('user')
    expect(row.manifest.name).toBe('Alpha·工作')
    expect(row.manifest.aliases).toBeUndefined()
    expect(row.effective).toMatchObject({ command: 'alpha-acp', args: ['--profile', 'work'] })
  })

  it('refresh:缓存过期才联网,拉到的落缓存;名册变了才通知', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ version: '1', agents: REGISTRY_ENTRIES }) }))
    const { registry } = makeRegistry({ fetch, now: 5 * 24 * 3600 * 1000 })
    const changed = vi.fn()
    registry.onChanged(changed)
    await registry.refresh()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(registry.roster().some(row => row.manifest.id === 'gamma')).toBe(true)
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'))
    expect(cache.entries.map((entry: { id: string }) => entry.id)).toEqual(['alpha-acp', 'gamma', 'delta'])

    // TTL 内:不再联网;名册没变:不通知。
    await registry.refresh()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledTimes(1)
    // force:不看 TTL。
    await registry.refresh({ force: true })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('拉失败用缓存,一行 warn', async () => {
    writeCache(0, REGISTRY_ENTRIES)
    const fetch = vi.fn(async () => { throw new Error('offline') })
    const { registry } = makeRegistry({ fetch, now: 10 * 24 * 3600 * 1000 })
    await registry.refresh()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(registry.roster().some(row => row.manifest.id === 'gamma')).toBe(true)
    expect(warns.filter(warn => warn.msg === 'acp registry fetch failed; using cache')).toHaveLength(1)
  })

  it('注册表开关关着:不联网,只用种子(与已有缓存)', async () => {
    settings = { enabled: true, agents: [], registry: { enabled: false } }
    const fetch = vi.fn()
    const { registry } = makeRegistry({ fetch })
    await registry.refresh({ force: true })
    expect(fetch).not.toHaveBeenCalled()
    expect(registry.roster().map(row => row.manifest.id)).toEqual(['alpha', 'beta'])
  })

  it('detect(agentId) 只探测那一台,结果进名册', async () => {
    const { registry, detect } = makeRegistry({ installed: ['alpha', 'beta'] })
    await registry.detect('beta')
    expect(detect).toHaveBeenCalledTimes(1)
    expect(detect.mock.calls[0][0].id).toBe('beta')
    expect(registry.roster().find(row => row.manifest.id === 'beta')!.detect?.installed).toBe(true)
  })

  it('加一台 agent = 加一个 JSON 文件(陌生能力演练):第十份种子零代码上榜', () => {
    writeSeed('tenth', { name: 'Tenth', launch: { command: 'tenth', args: ['--acp'] } })
    const row = makeRegistry({ installed: ['tenth'] }).registry.roster().find(entry => entry.manifest.id === 'tenth')!
    expect(row.source).toBe('builtin')
    expect(row.effective).toMatchObject({ command: 'tenth', args: ['--acp'], enabled: true })
  })
})
