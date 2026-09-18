import { describe, expect, it } from 'vitest'
import { CLI_FIXTURES, createFakeRunner, createProbe } from '../../__tests__/fixtures.js'
import { ObsidianCli, ObsidianCliError, parseEvalJson, parseEvalText, resolveObsidianExecutable } from '../cli.js'
import { NoteVaultUnavailable } from '../../types.js'
import { vaultConfigScript } from '../scripts.js'

function cli(options: { alive?: boolean | null; outputs?: string[]; timeoutOnCall?: number } = {}) {
  const runner = createFakeRunner({ outputs: options.outputs, timeoutOnCall: options.timeoutOnCall })
  return {
    runner,
    instance: new ObsidianCli({
      runner,
      // `?? true` 会把显式的 `null`(平台没有探活手段)吃掉 —— 那正是要测的那一档。
      probe: createProbe('alive' in options ? (options.alive as boolean | null) : true),
      executable: 'obsidian',
    }),
  }
}

describe('ObsidianCli:真实 stdout 的判错', () => {
  it('首行以 Error: 开头 → 结构化错误(退出码仍然是 0)', async () => {
    const { instance } = cli({ outputs: [CLI_FIXTURES.fileNotFound] })
    await expect(instance.run('v1', 'file', ['path=nope/nope.md']))
      .rejects.toThrowError(ObsidianCliError)
    await expect(instance.run('v1', 'file', ['path=nope/nope.md']))
      .rejects.toThrowError(/File "nope\/nope\.md" not found/)
  })

  it('daily:path 的 Folder not found 也是首行 Error:', async () => {
    const { instance } = cli({ outputs: [CLI_FIXTURES.folderNotFound] })
    await expect(instance.run('v1', 'daily:path')).rejects.toThrowError(ObsidianCliError)
  })

  it('`Vault not found.` 不带 Error: 前缀,单独认', async () => {
    const { instance } = cli({ outputs: [CLI_FIXTURES.vaultNotFound] })
    await expect(instance.run('v1', 'vault', ['info=path']))
      .rejects.toThrowError(NoteVaultUnavailable)
  })

  it('正常输出剥掉尾部换行', async () => {
    const { instance } = cli({ outputs: [CLI_FIXTURES.dailyPath] })
    const result = await instance.run('v1', 'daily:path')
    expect(result.stdout).toBe('2026-09-08.md')
    expect(result.firstLine).toBe('2026-09-08.md')
  })
})

describe('ObsidianCli:取消(P5)', () => {
  it('signal 原样递给 runner —— 这一层不解释它', async () => {
    const { runner, instance } = cli({ outputs: [CLI_FIXTURES.searchContext] })
    const controller = new AbortController()
    await instance.run('v1', 'search:context', ['query=x', 'format=json'], { signal: controller.signal })
    expect(runner.calls[0].signal).toBe(controller.signal)
  })

  it('已经取消了 → **一次 spawn 都不发生**,答的是那句取消', async () => {
    const { runner, instance } = cli({ outputs: [CLI_FIXTURES.searchContext] })
    const controller = new AbortController()
    controller.abort()
    await expect(instance.run('v1', 'search:context', [], { signal: controller.signal }))
      .rejects.toThrowError(/aborted by the caller/)
    // 探活过了、命令递下去了,但子进程没起来 —— 这正是「换词即 kill」在最省的那一档。
    expect(runner.kills).toBe(1)
  })

  it('不给 signal 的调用一格都不多发(缺省路逐字不变)', async () => {
    const { runner, instance } = cli({ outputs: [CLI_FIXTURES.dailyPath] })
    await instance.run('v1', 'daily:path')
    expect(runner.calls[0].signal).toBeUndefined()
  })
})

describe('ObsidianCli:argv 与超时', () => {
  it('vault=<id> 永远是 argv[0]', async () => {
    const { runner, instance } = cli({ outputs: [CLI_FIXTURES.dailyPath] })
    await instance.run('dd1b25cb57b3f0ce', 'daily:path')
    expect(runner.calls[0].args[0]).toBe('vault=dd1b25cb57b3f0ce')
    expect(runner.calls[0].args[1]).toBe('daily:path')
  })

  it('参数走 argv,不拼 shell 字符串(空格原样进一个 argv)', async () => {
    const { runner, instance } = cli({ outputs: [CLI_FIXTURES.dailyPath] })
    await instance.run('v1', 'create', ['path=My Notes/a b.md'])
    expect(runner.calls[0].args).toEqual(['vault=v1', 'create', 'path=My Notes/a b.md'])
  })

  it('每条命令带 10s 预算;超时 → kill 被调用且拒绝', async () => {
    const { runner, instance } = cli({ outputs: [''], timeoutOnCall: 0 })
    await expect(instance.run('v1', 'files')).rejects.toThrowError(/did not finish within/)
    expect(runner.kills).toBe(1)
    expect(runner.calls[0].timeoutMs).toBe(10_000)
  })
})

describe('ObsidianCli:探活是发命令的前提', () => {
  /**
   * **反证**:把 `ObsidianCli.run` 里 `if (options.mayLaunch !== true) { … }` 那一段
   * 挖掉,这条就红 —— `calls.length` 会变成 1。那正是「后台把 Obsidian 拉起来」
   * 的那一次调用。
   */
  it('探针说不活 + mayLaunch:false → 一次 spawn 都没发生', async () => {
    const { runner, instance } = cli({ alive: false, outputs: [CLI_FIXTURES.dailyPath] })
    await expect(instance.run('v1', 'daily:path')).rejects.toThrowError(NoteVaultUnavailable)
    expect(runner.calls).toHaveLength(0)
  })

  it('探针答 null(平台没有探活手段)也拦下,理由码是 cli-not-registered', async () => {
    const { runner, instance } = cli({ alive: null, outputs: [CLI_FIXTURES.dailyPath] })
    await expect(instance.run('v1', 'daily:path')).rejects.toMatchObject({ reason: 'cli-not-registered' })
    expect(runner.calls).toHaveLength(0)
  })

  it('mayLaunch:true 时**不探活**直接发(前台动作)', async () => {
    const { runner, instance } = cli({ alive: false, outputs: [CLI_FIXTURES.dailyPath] })
    await instance.run('v1', 'open', ['path=a.md'], { mayLaunch: true })
    expect(runner.calls).toHaveLength(1)
  })
})

describe('eval 的两种返回', () => {
  it('JSON 形:剥 `=> ` 之后 parse', async () => {
    const { instance } = cli({ outputs: [CLI_FIXTURES.vaultConfig] })
    await expect(instance.eval('v1', vaultConfigScript())).resolves.toEqual({
      attachmentFolderPath: 'attatch',
      useMarkdownLinks: false,
      newLinkFormat: 'shortest',
    })
  })

  it('daily-notes options 夹具', async () => {
    const { instance } = cli({ outputs: [CLI_FIXTURES.dailyOptions] })
    await expect(instance.eval('v1', 'x')).resolves.toEqual({ format: 'YYYY-MM-DD-dddd', folder: 'daily' })
  })

  it('裸串形:`=> [[00.00 JDex]]` 不是 JSON,走 evalText', async () => {
    const { instance } = cli({ outputs: [CLI_FIXTURES.markdownLink] })
    await expect(instance.evalText('v1', 'x')).resolves.toBe('[[00.00 JDex]]')
    // 同一段走 eval(JSON)必须红 —— 两个方法的分工不是装饰。
    const json = cli({ outputs: [CLI_FIXTURES.markdownLink] })
    await expect(json.instance.eval('v1', 'x')).rejects.toThrowError(ObsidianCliError)
  })

  /**
   * **反证**:把 `stripEvalArrow` 里 `text.startsWith('=>') ? text.slice(2)…`
   * 那一句挖成 `return text`,这两条都红 —— 第一条 parse 不了 `=> {...}`,
   * 第二条会把 `=> ` 当成链接文本的一部分。
   */
  it('剥前缀是必须的,而且无前缀时也要能 parse(§1 ④ 的版本容错)', () => {
    expect(parseEvalJson('=> {"a":1}')).toEqual({ a: 1 })
    expect(parseEvalJson('{"a":1}')).toEqual({ a: 1 })
    expect(parseEvalText('=> [[x]]')).toBe('[[x]]')
    expect(parseEvalText('=> null')).toBeNull()
    expect(parseEvalText('')).toBeNull()
  })

  it('eval 抛错时 CLI 说的仍然是首行 Error:', async () => {
    const { instance } = cli({ outputs: ['Error: app is not defined\n'] })
    await expect(instance.eval('v1', 'x')).rejects.toThrowError(/app is not defined/)
  })
})

describe('可执行名', () => {
  it('mac/linux = obsidian,win = obsidian.exe,环境变量可覆盖', () => {
    expect(resolveObsidianExecutable({}, 'darwin')).toBe('obsidian')
    expect(resolveObsidianExecutable({}, 'linux')).toBe('obsidian')
    expect(resolveObsidianExecutable({}, 'win32')).toBe('obsidian.exe')
    expect(resolveObsidianExecutable({ ONETHING_OBSIDIAN_CLI: '/opt/o' }, 'darwin')).toBe('/opt/o')
  })
})
