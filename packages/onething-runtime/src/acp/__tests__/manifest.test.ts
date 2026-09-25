/**
 * ACP manifest 的纯函数(A1-a,方案 §3.2 / §9 / §11.2)。
 *
 * 钉四件:种子文件的校验(`launch.command` 必填、不认识的字段丢)、注册表条目的折法
 * (npx / binary / uvx 三形)、生效配置(manifest ⊕ 覆盖,只覆盖写了的格)、种子拷贝的认法。
 * 最后一组把仓里真的 `resources/acp-agents/*.json` 逐个过一遍校验 —— 种子是数据,写坏了
 * 就在这里红,而不是等桌面上少一台 agent 才发现。
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  acpRegistryPlatformKey,
  compareAcpAgentVersions,
  describeAcpAgentConfigProblem,
  effectiveAgentConfig,
  isSeedCopy,
  manifestFromRegistryEntry,
  parseAcpAgentManifest,
  parseAcpRegistryIndex,
  stripNpmPackageVersion,
  type AcpAgentManifest,
} from '../manifest.js'

const SEED: AcpAgentManifest = {
  id: 'claude-code',
  name: 'Claude Code',
  launch: { command: 'claude-agent-acp' },
  quirks: { promptTimeoutMs: 600000 },
}

describe('parseAcpAgentManifest', () => {
  it('收下一份合法的种子,丢掉不认识的字段', () => {
    const parsed = parseAcpAgentManifest({
      id: 'gemini',
      name: 'Gemini CLI',
      launch: { command: 'gemini', args: ['--acp'], env: { OK_KEY: '1', 'bad key': 'x' }, extra: true },
      detect: { bins: ['gemini'], versionArgs: ['--version'] },
      configPaths: ['~/.gemini'],
      somethingNew: { nested: 1 },
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.manifest).toEqual({
      id: 'gemini',
      name: 'Gemini CLI',
      launch: { command: 'gemini', args: ['--acp'], env: { OK_KEY: '1' } },
      detect: { bins: ['gemini'], versionArgs: ['--version'] },
      configPaths: ['~/.gemini'],
    })
  })

  it('反证 (a):缺 `launch.command` 的拒掉,理由点名', () => {
    const parsed = parseAcpAgentManifest({ id: 'broken', name: 'Broken', launch: { args: ['x'] } })
    expect(parsed).toEqual({ ok: false, reason: 'broken: launch.command is required' })
  })

  it('id 只收 [a-z0-9-]', () => {
    expect(parseAcpAgentManifest({ id: 'Claude_Code', name: 'x', launch: { command: 'x' } }).ok).toBe(false)
    expect(parseAcpAgentManifest({ id: 'claude-code-2', name: 'x', launch: { command: 'x' } }).ok).toBe(true)
  })
})

describe('注册表条目 → manifest', () => {
  const base = { id: 'demo', name: 'Demo', repository: 'https://github.com/x/demo' }

  it('npx 形:npx -y <包@版本> …args,install.npm 去掉版本号', () => {
    const manifest = manifestFromRegistryEntry({
      ...base,
      distribution: { npx: { package: '@scope/demo-acp@1.2.3', args: ['--acp'], env: { A: '1' } } },
    }, 'darwin-aarch64')
    expect(manifest.launch).toEqual({ command: 'npx', args: ['-y', '@scope/demo-acp@1.2.3', '--acp'], env: { A: '1' } })
    expect(manifest.install).toEqual({ npm: '@scope/demo-acp' })
  })

  it('binary 形:不下载,只给装法;本平台有目标时 launch 写可执行名,探测认它', () => {
    const manifest = manifestFromRegistryEntry({
      ...base,
      distribution: { binary: { 'darwin-aarch64': { archive: 'https://x/demo.tgz', cmd: './bin/demo', args: ['acp'] } } },
    }, 'darwin-aarch64')
    expect(manifest.launch).toEqual({ command: 'demo', args: ['acp'] })
    expect(manifest.detect).toEqual({ bins: ['demo'] })
    expect(manifest.install).toEqual({ hint: 'https://github.com/x/demo' })
  })

  it('binary 形但本平台没有目标、以及 uvx 形:没有 launch,detect.bins = [id]', () => {
    const noTarget = manifestFromRegistryEntry({
      ...base,
      distribution: { binary: { 'windows-x86_64': { cmd: 'demo.exe' } } },
    }, 'darwin-aarch64')
    expect(noTarget.launch).toBeUndefined()
    expect(noTarget.detect).toEqual({ bins: ['demo'] })

    const uvx = manifestFromRegistryEntry({ ...base, distribution: { uvx: { package: 'demo-acp' } } }, 'darwin-aarch64')
    expect(uvx.launch).toBeUndefined()
    expect(uvx.install).toEqual({ hint: 'https://github.com/x/demo' })
  })

  it('索引解析容忍不认识的字段,坏条目丢掉并记下来', () => {
    const parsed = parseAcpRegistryIndex({
      version: '1',
      extensions: [],
      agents: [
        { ...base, distribution: { npx: { package: 'demo@1.0.0' } }, license: 'MIT', futureField: 1 },
        { id: 'no-dist', name: 'No dist' },
        { id: 'Bad Id', name: 'x', distribution: { npx: { package: 'x' } } },
        'garbage',
      ],
    })
    expect(parsed.entries.map(entry => entry.id)).toEqual(['demo'])
    expect(parsed.dropped).toHaveLength(3)
  })

  it('平台键与包名去版本号', () => {
    expect(acpRegistryPlatformKey('darwin', 'arm64')).toBe('darwin-aarch64')
    expect(acpRegistryPlatformKey('win32', 'x64')).toBe('windows-x86_64')
    expect(stripNpmPackageVersion('@a/b@1.0.0')).toBe('@a/b')
    expect(stripNpmPackageVersion('pi-acp@0.0.34')).toBe('pi-acp')
    expect(stripNpmPackageVersion('pi-acp')).toBe('pi-acp')
  })
})

describe('effectiveAgentConfig', () => {
  it('没有覆盖:全用 manifest,enabled 取传进来的缺省(探测到已安装)', () => {
    expect(effectiveAgentConfig(SEED, undefined, { enabled: true })).toEqual({
      id: 'claude-code',
      name: 'Claude Code',
      enabled: true,
      command: 'claude-agent-acp',
      args: [],
      promptTimeoutMs: 600000,
    })
    expect(effectiveAgentConfig(SEED).enabled).toBe(false)
  })

  it('覆盖只改它写了的格;环境变量按键合并', () => {
    const manifest: AcpAgentManifest = { ...SEED, launch: { command: 'claude-agent-acp', env: { A: '1', B: '2' } } }
    const effective = effectiveAgentConfig(manifest, {
      id: 'claude-code',
      enabled: false,
      args: ['--verbose'],
      env: { B: 'override' },
      idleTimeoutMs: 5,
    }, { enabled: true })
    expect(effective).toMatchObject({
      id: 'claude-code',
      name: 'Claude Code',
      enabled: false,
      command: 'claude-agent-acp',
      args: ['--verbose'],
      env: { A: '1', B: 'override' },
      idleTimeoutMs: 5,
      promptTimeoutMs: 600000,
    })
  })

  it('没有 launch 也没有覆盖命令:command 是空串(上榜但喂不了管家)', () => {
    expect(effectiveAgentConfig({ id: 'bin-only', name: 'Bin only' }).command).toBe('')
  })
})

describe('isSeedCopy', () => {
  const oldLiteral = {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Claude Code ACP-compatible local agent.',
    enabled: true,
    command: 'claude-agent-acp',
    args: [],
    permissionMode: 'allow' as const,
    maxBufferedUpdates: 1000,
  }

  it('A1 之前写回老盘的默认条目(id / 命令 / 参数全等)是拷贝', () => {
    expect(isSeedCopy(oldLiteral, SEED)).toBe(true)
  })

  it('命令或参数改过、显式关掉、复制自别的,都是用户的意思', () => {
    expect(isSeedCopy({ ...oldLiteral, command: '/opt/claude-agent-acp' }, SEED)).toBe(false)
    expect(isSeedCopy({ ...oldLiteral, args: ['--debug'] }, SEED)).toBe(false)
    expect(isSeedCopy({ ...oldLiteral, enabled: false }, SEED)).toBe(false)
    expect(isSeedCopy({ ...oldLiteral, id: 'other' }, SEED)).toBe(false)
    expect(isSeedCopy({ ...oldLiteral, basedOn: 'codex' }, SEED)).toBe(false)
  })
})

describe('覆盖条目新两格的校验', () => {
  it('basedOn 是 agent id,secretEnv 是环境变量名', () => {
    expect(describeAcpAgentConfigProblem({ basedOn: 'claude-code', secretEnv: ['API_KEY'] })).toBeUndefined()
    expect(describeAcpAgentConfigProblem({ basedOn: 'Claude Code' })).toMatch(/basedOn/)
    expect(describeAcpAgentConfigProblem({ secretEnv: ['OK', 'no way'] })).toMatch(/no way/)
  })

  it('版本比较', () => {
    expect(compareAcpAgentVersions('0.61.0', '0.60.9')).toBe(1)
    expect(compareAcpAgentVersions('1.2', '1.2.0')).toBe(0)
    expect(compareAcpAgentVersions('v1.0.0', '2.0')).toBe(-1)
    expect(compareAcpAgentVersions('unknown', '1.0')).toBeUndefined()
  })
})

describe('仓里的种子文件', () => {
  const seedDir = path.resolve(__dirname, '../../../../../resources/acp-agents')
  const files = readdirSync(seedDir).filter(name => name.endsWith('.json')).sort()

  it('第一批九台都在,每一份都过得了校验,文件名 = id', () => {
    expect(files.map(file => file.replace(/\.json$/, ''))).toEqual([
      'claude-code', 'codex', 'copilot', 'gemini', 'goose', 'kimi', 'opencode', 'pi', 'qwen-code',
    ])
    for (const file of files) {
      const parsed = parseAcpAgentManifest(JSON.parse(readFileSync(path.join(seedDir, file), 'utf8')))
      expect(parsed.ok, file).toBe(true)
      if (parsed.ok) expect(parsed.manifest.id).toBe(file.replace(/\.json$/, ''))
    }
  })
})
