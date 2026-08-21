/**
 * `onething plugin` 命令域单测。
 *
 * 三条自证:
 * 1. 安装机器全部经 vi.mock 拦下 —— 断言 mock **被调过**,真 npm 就一定没跑
 *    (真 installPluginPackage 会 spawn npm 写盘)。
 * 2. pluginsDir 经 mock 的 getPluginsDir 指到临时目录,断言它就是传进安装机器
 *    的第一参 —— 写不到真实 ~/.onething。
 * 3. 账本读走的是 core 真实实现,读的是临时目录里真写出来的 package.json。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-cli-plugin-'))
const pluginsDir = path.join(tmpRoot, 'plugins')

vi.mock('@onething/backend/plugins/loader.js', () => ({
  getPluginsDir: () => pluginsDir,
}))

// CLI 的用户输出走 stdout.ts(不是 console)—— 断言面跟着换到那个口。
const stdoutLines: string[] = []
const stderrLines: string[] = []
vi.mock('../stdout.js', () => ({
  stdout: (line = '') => { stdoutLines.push(String(line)) },
  stderr: (line = '') => { stderrLines.push(String(line)) },
  stdoutRaw: (text: string) => { stdoutLines.push(String(text)) },
}))

vi.mock('@onething/backend/plugins/install.js', () => ({
  probePluginNpmAvailability: vi.fn(async () => true),
  installPluginPackage: vi.fn(async () => ({ ok: true, pluginId: 'stub' })),
  uninstallPluginPackage: vi.fn(async () => ({ removed: true })),
  configurePluginMarketIndex: vi.fn(),
  getPluginMarketIndexSnapshot: vi.fn(async () => ({
    index: null,
    fetchedAt: null,
    stale: false,
    error: 'not configured in this test',
  })),
}))

vi.mock('@onething/backend/plugins/tarball.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@onething/backend/plugins/tarball.js')>()
  return { ...actual, readPluginTarballSummary: vi.fn() }
})

const install = await import('@onething/backend/plugins/install.js')
const tarball = await import('@onething/backend/plugins/tarball.js')
const { pluginCommand } = await import('../plugin-command.js')

const probeNpm = vi.mocked(install.probePluginNpmAvailability)
const installPkg = vi.mocked(install.installPluginPackage)
const uninstallPkg = vi.mocked(install.uninstallPluginPackage)
const marketSnapshot = vi.mocked(install.getPluginMarketIndexSnapshot)
const readTarball = vi.mocked(tarball.readPluginTarballSummary)

function writeLedger(dependencies: Record<string, string>): void {
  fs.mkdirSync(pluginsDir, { recursive: true })
  fs.writeFileSync(
    path.join(pluginsDir, 'package.json'),
    JSON.stringify({ name: 'onething-plugins', private: true, dependencies }, null, 2),
  )
}

function makeTarball(name: string): string {
  const file = path.join(tmpRoot, name)
  fs.writeFileSync(file, 'not a real tarball — readPluginTarballSummary is mocked')
  return file
}

function summaryOk(pkg: string, version = '1.0.0') {
  return { success: true, summary: { path: 'x', pkg, pluginId: pkg.split('/').pop()!, version } }
}

let logs: string[] = []
let errors: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
  probeNpm.mockResolvedValue(true)
  installPkg.mockResolvedValue({ ok: true, pluginId: 'stub' })
  uninstallPkg.mockResolvedValue({ removed: true })
  marketSnapshot.mockResolvedValue({ index: null, fetchedAt: null, stale: false, error: 'offline' })
  stdoutLines.length = 0
  stderrLines.length = 0
  logs = stdoutLines
  errors = stderrLines
  fs.rmSync(pluginsDir, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  // 命令失败会设 process.exitCode —— 不还原会把整个 vitest 进程判负。
  process.exitCode = 0
})

describe('plugin install — 参数二义性判定', () => {
  it('看起来是本地 .tgz 的走 file: 通道,包名从 tarball 里读,不碰市场索引', async () => {
    const file = makeTarball('demo-1.0.0.tgz')
    readTarball.mockReturnValue(summaryOk('@onething-plugins/demo') as never)

    await pluginCommand('install', [file])

    expect(readTarball).toHaveBeenCalledWith(file)
    expect(installPkg).toHaveBeenCalledWith(pluginsDir, {
      pkg: '@onething-plugins/demo',
      spec: `file:${file}`,
    })
    // 自证:安装机器是 mock(真实现会 spawn npm),且盘上落点是临时目录。
    expect(installPkg.mock.calls[0][0]).toBe(pluginsDir)
    expect(marketSnapshot).not.toHaveBeenCalled()
    expect(process.exitCode).toBeFalsy()
  })

  it('裸标识符走市场通道:索引条目的 pkg/tarballUrl/integrity 一起交给安装机器', async () => {
    marketSnapshot.mockResolvedValue({
      index: {
        version: 1,
        plugins: [{
          id: 'tps-meter',
          pkg: '@onething-plugins/tps-meter',
          version: '2.1.0',
          tarballUrl: 'https://example.test/tps-meter-2.1.0.tgz',
          integrity: 'sha512-abc',
        }],
      },
      fetchedAt: Date.now(),
      stale: false,
      error: null,
    })

    await pluginCommand('install', ['tps-meter'])

    expect(readTarball).not.toHaveBeenCalled()
    expect(installPkg).toHaveBeenCalledWith(pluginsDir, {
      pkg: '@onething-plugins/tps-meter',
      spec: 'https://example.test/tps-meter-2.1.0.tgz',
      integrity: 'sha512-abc',
    })
  })

  it('市场 id 找不到时列出可用 id,并以非 0 退出', async () => {
    marketSnapshot.mockResolvedValue({
      index: {
        version: 1,
        plugins: [
          { id: 'tps-meter', pkg: '@onething-plugins/tps-meter', version: '1.0.0', tarballUrl: 'https://e.test/a.tgz' },
          { id: 'plan-status', pkg: '@onething-plugins/plan-status', version: '1.0.0', tarballUrl: 'https://e.test/b.tgz' },
        ],
      },
      fetchedAt: Date.now(),
      stale: false,
      error: null,
    })

    await pluginCommand('install', ['no-such-plugin'])

    expect(installPkg).not.toHaveBeenCalled()
    expect(errors.join('\n')).toContain('plan-status, tps-meter')
    expect(process.exitCode).toBe(1)
  })
})

describe('plugin install — 多参数串行', () => {
  it('单败不中断,后续继续装,退出码非 0', async () => {
    const bad = makeTarball('bad-1.0.0.tgz')
    const good = makeTarball('good-1.0.0.tgz')
    readTarball.mockImplementation(((file: string) => (file === bad
      ? { success: false, errorCode: 'not-gzip', error: 'The file is not a gzip archive' }
      : summaryOk('@onething-plugins/good'))) as never)

    await pluginCommand('install', [bad, good])

    // 第一个在预读阶段就败了,第二个仍然装了 —— 这就是"不中断"。
    expect(installPkg).toHaveBeenCalledTimes(1)
    expect(installPkg).toHaveBeenCalledWith(pluginsDir, {
      pkg: '@onething-plugins/good',
      spec: `file:${good}`,
    })
    expect(errors.join('\n')).toContain('not-gzip')
    expect(process.exitCode).toBe(1)
  })

  it('全成时退出码保持 0,并且每次成功都提示桌面需要刷新', async () => {
    const a = makeTarball('a-1.0.0.tgz')
    const b = makeTarball('b-1.0.0.tgz')
    readTarball.mockImplementation(((file: string) => summaryOk(
      file === a ? '@onething-plugins/a' : '@onething-plugins/b',
    )) as never)

    await pluginCommand('install', [a, b])

    expect(installPkg).toHaveBeenCalledTimes(2)
    expect(process.exitCode).toBeFalsy()
    expect(logs.filter(line => line.includes('Settings → Plugins → Refresh'))).toHaveLength(2)
  })

  it('安装机器返回 ok:false 也算一败', async () => {
    const file = makeTarball('c-1.0.0.tgz')
    readTarball.mockReturnValue(summaryOk('@onething-plugins/c') as never)
    installPkg.mockResolvedValue({ ok: false, pluginId: 'c', error: 'Integrity mismatch' })

    await pluginCommand('install', [file])

    expect(errors.join('\n')).toContain('Integrity mismatch')
    expect(process.exitCode).toBe(1)
  })
})

describe('plugin install — npm 不可用', () => {
  it('探测失败时一句人话报错,一个包都不装', async () => {
    probeNpm.mockResolvedValue(false)

    await expect(pluginCommand('install', [makeTarball('x-1.0.0.tgz')])).rejects.toThrow(/npm was not found/)
    expect(installPkg).not.toHaveBeenCalled()
    expect(readTarball).not.toHaveBeenCalled()
  })

  it('没有参数时直接拒绝,不去探 npm', async () => {
    await expect(pluginCommand('install', [])).rejects.toThrow(/requires at least one/)
    expect(probeNpm).not.toHaveBeenCalled()
  })
})

describe('plugin list', () => {
  it('读账本输出 id/pkg/spec', async () => {
    writeLedger({
      '@onething-plugins/tps-meter': 'https://example.test/tps-meter-1.0.0.tgz',
      '@onething-plugins/plan-status': 'file:/tmp/plan-status.tgz',
    })

    await pluginCommand('list', [])

    const output = logs.join('\n')
    expect(output).toContain('tps-meter')
    expect(output).toContain('@onething-plugins/plan-status')
    expect(output).toContain('file:/tmp/plan-status.tgz')
  })

  it('账本为空时说明为空', async () => {
    await pluginCommand('list', [])
    expect(logs.join('\n')).toContain('(none)')
  })

  it('账本损坏时报错而不是当成空账', async () => {
    fs.mkdirSync(pluginsDir, { recursive: true })
    fs.writeFileSync(path.join(pluginsDir, 'package.json'), '{ this is not json')
    await expect(pluginCommand('list', [])).rejects.toThrow(/corrupt plugin ledger/)
  })
})

describe('plugin uninstall', () => {
  it('短 id 补全 scope 前缀后命中账本', async () => {
    writeLedger({ '@onething-plugins/tps-meter': 'https://example.test/tps-meter-1.0.0.tgz' })

    await pluginCommand('uninstall', ['tps-meter'])

    expect(uninstallPkg).toHaveBeenCalledWith(pluginsDir, '@onething-plugins/tps-meter')
    expect(logs.join('\n')).toContain('Settings → Plugins → Refresh')
  })

  it('完整包名也接受', async () => {
    writeLedger({ '@onething-plugins/tps-meter': 'https://example.test/tps-meter-1.0.0.tgz' })

    await pluginCommand('uninstall', ['@onething-plugins/tps-meter'])

    expect(uninstallPkg).toHaveBeenCalledWith(pluginsDir, '@onething-plugins/tps-meter')
  })

  it('账本里没有时报错并列出已装', async () => {
    writeLedger({ '@onething-plugins/tps-meter': 'https://example.test/tps-meter-1.0.0.tgz' })

    await expect(pluginCommand('uninstall', ['ghost'])).rejects.toThrow(/@onething-plugins\/tps-meter/)
    expect(uninstallPkg).not.toHaveBeenCalled()
  })

  it('npm uninstall 失败时原样透传错误', async () => {
    writeLedger({ '@onething-plugins/tps-meter': 'https://example.test/tps-meter-1.0.0.tgz' })
    uninstallPkg.mockResolvedValue({ removed: false, error: 'npm uninstall failed' })

    await expect(pluginCommand('uninstall', ['tps-meter'])).rejects.toThrow(/npm uninstall failed/)
  })

  it('缺参数时报错', async () => {
    await expect(pluginCommand('uninstall', [])).rejects.toThrow(/requires a plugin id/)
  })
})

describe('plugin — 未知子命令', () => {
  it('报错而不是静默', async () => {
    await expect(pluginCommand('frobnicate', [])).rejects.toThrow(/Unknown plugin command: frobnicate/)
  })
})
