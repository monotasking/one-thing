/**
 * R4 验收:插件数据目录与卸载生命周期。
 *
 * 拍板:数据作用域是**全局 per-plugin** —— `<store>/plugin-data/<pluginId>/`,
 * 一个插件一个目录。要按 agent 分,插件自己在目录里建子结构。
 *
 * 这一期的北极星是宪法第 6 条的数据侧:**插件的全部落盘足迹可枚举**,
 * 因此卸载与孤儿归档都不再需要手工脚本。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CorePluginManager,
  PLUGIN_DATA_LEGACY_BACKUP_DIR,
  PLUGIN_FILES_MAX_FILE_BYTES,
  PLUGIN_KV_FILE_NAME,
  PLUGIN_LEGACY_KV_FILE_NAME,
  PluginStorageError,
  archiveCorePluginData,
  assertSafePluginFileName,
  createCorePluginAPI,
  createCorePluginFiles,
  createCorePluginStorage,
  decidePluginOrphanArchive,
  getCorePluginScratchDir,
  disposeCorePluginState,
  findCorePluginDataOrphans,
  getCorePluginDataFootprint,
  restoreCorePluginDataArchive,
  scanPluginSourceEntries,
  type CorePluginDefinition,
  type CorePluginManagerHost,
  type CorePluginStateLike,
} from '@onething/core/plugins'

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'onething-plugin-data-'))
}

function silentLogger() {
  return { log: () => {}, error: () => {} }
}

describe('R4 storage surface — the api is a mediated channel, not raw fs', () => {
  it('creates the plugin directory on demand and round-trips JSON', () => {
    const root = tempRoot()
    try {
      const storage = createCorePluginStorage({ pluginId: 'notes', dataRoot: root })
      expect(storage.dir()).toBe(path.join(root, 'notes'))
      expect(fs.existsSync(storage.dir())).toBe(true)

      expect(storage.exists('index.json')).toBe(false)
      storage.writeJson('index.json', { entries: ['a'] })
      expect(storage.exists('index.json')).toBe(true)
      expect(storage.readJson('index.json')).toEqual({ entries: ['a'] })
      expect(storage.readJson('missing.json', { fallback: true })).toEqual({ fallback: true })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects every shape of path traversal', () => {
    const root = tempRoot()
    try {
      const storage = createCorePluginStorage({ pluginId: 'notes', dataRoot: root })
      for (const name of ['../escape.json', 'a/b.json', 'a\\b.json', '/etc/passwd', '..', '.', '__proto__', '']) {
        expect(() => storage.writeJson(name, {}), name).toThrow()
        expect(() => storage.readJson(name), name).toThrow()
        expect(() => storage.exists(name), name).toThrow()
      }
      // 一个文件都不该出现 —— 既没逃出去,也没顺手把数据目录建出来。
      expect(fs.readdirSync(root)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses non-serializable values (a Map would silently become {})', () => {
    const root = tempRoot()
    try {
      const storage = createCorePluginStorage({ pluginId: 'notes', dataRoot: root })
      expect(() => storage.writeJson('bad.json', { cache: new Map() })).toThrow(/JSON-serializable/)
      expect(() => storage.writeJson('bad.json', { cb: () => {} })).toThrow(/JSON-serializable/)
      expect(storage.exists('bad.json')).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reserves the host-owned names and rejects platform-hostile ones', () => {
    expect(assertSafePluginFileName('notes.json')).toBe('notes.json')
    expect(() => assertSafePluginFileName('../x')).toThrow()
    expect(() => assertSafePluginFileName(' padded')).toThrow()
    // api.store 的 KV 与归档目录:不保留的话两条通道会静默互相 clobber。
    expect(() => assertSafePluginFileName('kv.json')).toThrow(/reserved by the host/)
    expect(() => assertSafePluginFileName('KV.JSON')).toThrow(/reserved by the host/)
    expect(() => assertSafePluginFileName('legacy-backup')).toThrow(/reserved by the host/)
    // Windows:保留设备名(含带扩展名形态)、ADS 分隔符、尾点。
    for (const name of ['CON', 'con.json', 'NUL', 'COM1.json', 'LPT9', 'a.json:hidden', 'trailing.']) {
      expect(() => assertSafePluginFileName(name), name).toThrow()
    }
    expect(() => assertSafePluginFileName('x'.repeat(300))).toThrow(/exceeds/)
  })

  it('tags every failure with a code so plugins can separate fix-your-code errors and retry-later errors', () => {
    const root = tempRoot()
    try {
      const storage = createCorePluginStorage({ pluginId: 'notes', dataRoot: root })
      const nameError = (() => {
        try {
          storage.writeJson('../x', {})
        } catch (error) {
          return error as PluginStorageError
        }
        throw new Error('expected a throw')
      })()
      expect(nameError.name).toBe('PluginStorageError')
      expect(nameError.code).toBe('invalid-name')

      const shapeError = (() => {
        try {
          storage.writeJson('a.json', { m: new Map() })
        } catch (error) {
          return error as PluginStorageError
        }
        throw new Error('expected a throw')
      })()
      expect(shapeError.code).toBe('not-serializable')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not create the data directory just because something was read', () => {
    const root = tempRoot()
    try {
      const storage = createCorePluginStorage({ pluginId: 'notes', dataRoot: root })
      expect(storage.readJson('missing.json', { fallback: true })).toEqual({ fallback: true })
      expect(storage.exists('missing.json')).toBe(false)
      // 纯读一次就建一个空目录,会让它出现在足迹里、进而被孤儿扫描盯上。
      expect(fs.existsSync(path.join(root, 'notes'))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('quarantines a corrupt file and throws instead of handing back the fallback', () => {
    const root = tempRoot()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const storage = createCorePluginStorage({ pluginId: 'notes', dataRoot: root })
      storage.writeJson('a.json', { ok: true })
      fs.writeFileSync(path.join(root, 'notes', 'a.json'), '{"ok": tru', 'utf-8')

      // 返回 fallback 的话,插件通常会原样写回 —— 证据和数据一起没了。
      expect(() => storage.readJson('a.json', { ok: false })).toThrow(/not valid JSON/)
      expect(fs.existsSync(path.join(root, 'notes', 'a.json'))).toBe(false)
      const quarantined = fs.readdirSync(path.join(root, 'notes')).filter(name => name.includes('.corrupt-'))
      expect(quarantined).toHaveLength(1)
      expect(fs.readFileSync(path.join(root, 'notes', quarantined[0]), 'utf-8')).toContain('tru')
    } finally {
      errorSpy.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('R4 api.storage wiring — latch and breaker ledger', () => {
  function buildApi(
    root: string,
    pluginId = 'notes',
    extra: { files?: ReturnType<typeof createCorePluginFiles> } = {},
  ) {
    const failures: Array<{ scope: string; error: unknown }> = []
    const result = createCorePluginAPI<
      {
        storage: {
          dir(): string
          readJson<T = unknown>(name: string, fallback?: T): T | undefined
          writeJson(name: string, value: unknown): void
          exists(name: string): boolean
        }
      },
      { name: string },
      () => void,
      { name: string },
      object,
      () => string,
      () => void,
      () => void,
      () => [],
      object,
      object
    >({
      pluginId,
      store: {},
      storage: createCorePluginStorage({ pluginId, dataRoot: root }),
      ...(extra.files ? { files: extra.files } : {}),
      scheduler: {},
      logger: silentLogger(),
      onPluginFailure: ({ scope, error }) => failures.push({ scope, error }),
      host: {
        registerTool: () => {},
        subscribeEvent: () => () => {},
        steer: () => {},
        followUp: () => {},
        notify: () => {},
        registerPromptContextProvider: () => () => {},
        registerBeforeContextCompactHook: () => () => {},
        registerAfterAssistantResponseHook: () => () => {},
        registerSkillRoot: () => () => {},
      },
    })
    return { ...result, failures }
  }

  it('books a traversal attempt into the breaker ledger and still throws at the plugin', () => {
    const root = tempRoot()
    try {
      const { api, failures } = buildApi(root)
      expect(() => api.storage.writeJson('../escape.json', {})).toThrow()
      // 记账是为了熔断;继续抛是为了让插件当场知道自己写错了 —— 静默吞掉
      // 只会让它以为写成功了。
      expect(failures).toHaveLength(1)
      // 按操作分车道:单车道下 exists 的成功会不断清掉 writeJson 的连败。
      expect(failures[0].scope).toBe('storage.writeJson')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('not-configured is a state refusal: thrown to the plugin, never booked into the breaker', () => {
    const root = tempRoot()
    try {
      const { api, failures } = buildApi(root, 'notes', {
        files: createCorePluginFiles({
          pluginId: 'notes',
          homeRoot: path.join(root, 'storage'),
          externalRootDeclared: true,
        }),
      })
      // 未配置外部根:全新安装的正常状态。抛(调用方要知道),但不计数 ——
      // 否则"装了还没配置"攒几轮就把插件熔断了(2026-08-12 memory-wiki 真机事故)。
      const filesApi = (api.storage as unknown as {
        files: ReturnType<typeof createCorePluginFiles>
      }).files
      expect(() => filesApi.readText('index.md', { root: 'external' })).toThrow(/external folder/)
      expect(failures).toHaveLength(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * 外部根 = **用户的目录**。那里的文件状态由用户决定,不是插件的行为 ——
   * 而注入面每 30s 读一次,90 秒就能攒满三次把整个插件熔断。
   * `not-configured` 只是这一类里最先被抓到的一个,这里补齐其余三种。
   */
  describe('user-side file state on the external root is refused, never booked', () => {
    function buildExternal(root: string, external: string) {
      return buildApi(root, 'notes', {
        files: createCorePluginFiles({
          pluginId: 'notes',
          homeRoot: path.join(root, 'storage'),
          externalRootDeclared: true,
          resolveExternalRoot: () => external,
        }),
      })
    }
    function filesOf(api: unknown) {
      return (api as { storage: { files: ReturnType<typeof createCorePluginFiles> } }).storage.files
    }

    it('io: the user put a file where the plugin expects a folder', () => {
      const root = tempRoot()
      const external = tempRoot()
      try {
        const { api, failures } = buildExternal(root, external)
        fs.writeFileSync(path.join(external, 'wiki'), 'a file, not a folder', 'utf-8')

        let error: unknown
        try {
          filesOf(api).writeText('wiki/page.md', '# x', { root: 'external' })
        } catch (caught) {
          error = caught
        }
        expect((error as PluginStorageError).code).toBe('io')
        expect(failures).toHaveLength(0)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
        fs.rmSync(external, { recursive: true, force: true })
      }
    })

    it('quota: the user hand-edited a file past the per-file read limit', () => {
      const root = tempRoot()
      const external = tempRoot()
      try {
        const { api, failures } = buildExternal(root, external)
        fs.writeFileSync(path.join(external, 'big.md'), 'x'.repeat(PLUGIN_FILES_MAX_FILE_BYTES + 1))

        let error: unknown
        try {
          filesOf(api).readText('big.md', { root: 'external' })
        } catch (caught) {
          error = caught
        }
        expect((error as PluginStorageError).code).toBe('quota')
        expect(failures).toHaveLength(0)
        // 出路照样在:尾读不是失败,更不该记账。
        expect(filesOf(api).readText('big.md', { root: 'external', tailBytes: 3 })).toBe('xxx')
        expect(failures).toHaveLength(0)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
        fs.rmSync(external, { recursive: true, force: true })
      }
    })

    it('invalid-name: the user replaced index.md with a directory', () => {
      const root = tempRoot()
      const external = tempRoot()
      try {
        const { api, failures } = buildExternal(root, external)
        fs.mkdirSync(path.join(external, 'index.md'))

        let error: unknown
        try {
          filesOf(api).readText('index.md', { root: 'external' })
        } catch (caught) {
          error = caught
        }
        expect((error as PluginStorageError).code).toBe('invalid-name')
        expect(failures).toHaveLength(0)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
        fs.rmSync(external, { recursive: true, force: true })
      }
    })

    it('but the plugin\'s own behaviour still books, on either root', () => {
      const root = tempRoot()
      const external = tempRoot()
      try {
        const { api, failures } = buildExternal(root, external)

        // 家目录的路径穿越:既有判例,原样成立。
        expect(() => filesOf(api).writeText('../escape.md', 'x')).toThrow()
        expect(failures).toHaveLength(1)
        expect(failures[0].scope).toBe('storage.files.writeText')

        // 用户的目录里穿越**同样**是插件的行为 —— 车道按归属判,不是按根一刀切,
        // 否则 { root: 'external' } 就成了绕过熔断账的写法。
        expect(() => filesOf(api).writeText('../escape.md', 'x', { root: 'external' })).toThrow()
        expect(failures).toHaveLength(2)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
        fs.rmSync(external, { recursive: true, force: true })
      }
    })
  })

  it('no-ops every storage entry point after dispose', () => {
    const root = tempRoot()
    try {
      const { api, state } = buildApi(root)
      api.storage.writeJson('before.json', { ok: true })
      expect(api.storage.exists('before.json')).toBe(true)

      disposeCorePluginState(state)

      // 写面**抛**:静默 no-op 是"假装写成功了"。
      expect(() => api.storage.writeJson('after.json', { ok: true })).toThrow(/disposed/)
      expect(() => api.storage.dir()).toThrow(/disposed/)
      // 读面退化:teardown 竞速里的一次无害读取不该把插件炸掉。
      expect(api.storage.exists('before.json')).toBe(false)
      expect(api.storage.readJson('before.json', { fallback: true })).toEqual({ fallback: true })
      // 拆除之后的写入没有落盘 —— 否则就是一个没人能回收的孤儿文件。
      expect(fs.existsSync(path.join(root, 'notes', 'after.json'))).toBe(false)
      expect(fs.existsSync(path.join(root, 'notes', 'before.json'))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('R4 footprint and archiving', () => {
  it('enumerates the whole on-disk footprint of a plugin', () => {
    const root = tempRoot()
    try {
      const storage = createCorePluginStorage({ pluginId: 'notes', dataRoot: root })
      storage.writeJson('a.json', { x: 1 })
      storage.writeJson('b.json', { x: 2 })
      fs.writeFileSync(path.join(root, 'notes.json'), '{}', 'utf-8')

      expect(getCorePluginDataFootprint(root, 'notes')).toMatchObject({
        pluginId: 'notes',
        dataDirExists: true,
        entries: ['a.json', 'b.json'],
        legacyKvExists: true,
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('archives the directory and the stray legacy file together', () => {
    const root = tempRoot()
    try {
      const storage = createCorePluginStorage({ pluginId: 'notes', dataRoot: root })
      storage.writeJson('a.json', { x: 1 })
      fs.writeFileSync(path.join(root, 'notes.json'), JSON.stringify({ legacy: true }), 'utf-8')

      const result = archiveCorePluginData(root, 'notes', { now: new Date('2026-08-07T00:00:00') })
      expect(result.archived).toBe(true)
      expect(result.archivePath).toBe(path.join(root, PLUGIN_DATA_LEGACY_BACKUP_DIR, 'notes-2026-08-07'))
      expect(fs.existsSync(path.join(root, 'notes'))).toBe(false)
      expect(fs.existsSync(path.join(root, 'notes.json'))).toBe(false)
      expect(fs.readdirSync(result.archivePath!).sort()).toEqual(['a.json', PLUGIN_KV_FILE_NAME])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('never overwrites a previous archive from the same day', () => {
    const root = tempRoot()
    try {
      const now = new Date('2026-08-07T00:00:00')
      const write = (value: string): void => {
        createCorePluginStorage({ pluginId: 'notes', dataRoot: root }).writeJson('a.json', { value })
      }
      write('first')
      const first = archiveCorePluginData(root, 'notes', { now })
      write('second')
      const second = archiveCorePluginData(root, 'notes', { now })

      expect(second.archivePath).not.toBe(first.archivePath)
      // 归档的全部意义是"删之前留一份";覆盖上一份等于把它删了两次。
      expect(JSON.parse(fs.readFileSync(path.join(first.archivePath!, 'a.json'), 'utf-8'))).toEqual({ value: 'first' })
      expect(JSON.parse(fs.readFileSync(path.join(second.archivePath!, 'a.json'), 'utf-8'))).toEqual({ value: 'second' })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports an archive failure instead of throwing, leaving the data in place', () => {
    const root = tempRoot()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      createCorePluginStorage({ pluginId: 'notes', dataRoot: root }).writeJson('a.json', { x: 1 })
      // 归档落点被一个**文件**占住:rename 必失败。
      fs.mkdirSync(path.join(root, PLUGIN_DATA_LEGACY_BACKUP_DIR), { recursive: true })
      const target = path.join(root, PLUGIN_DATA_LEGACY_BACKUP_DIR, 'notes-2026-08-07')
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(path.join(target, 'occupied'), 'x', 'utf-8')
      // 同日第二个槽位也占住,逼它走到 rename 失败而不是换槽。
      fs.writeFileSync(path.join(root, PLUGIN_DATA_LEGACY_BACKUP_DIR, 'notes-2026-08-07-2'), 'x', 'utf-8')

      const result = archiveCorePluginData(root, 'notes', { now: new Date('2026-08-07T00:00:00') })
      if (!result.archived) {
        expect(result.error).toBeTruthy()
        // 原数据必须还在 —— 归档失败绝不能变成"数据没了"。
        expect(fs.existsSync(path.join(root, 'notes', 'a.json'))).toBe(true)
      } else {
        // 平台允许 rename 到第三个槽位时也可以接受,但数据必须完整搬走。
        expect(fs.existsSync(path.join(result.archivePath!, 'a.json'))).toBe(true)
      }
    } finally {
      error.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('R4 orphan archiving — failure protection (评审 critical)', () => {
  it('reports an unreadable plugins directory as untrusted rather than empty', () => {
    const pluginsDir = tempRoot()
    try {
      // 不存在 = 可信的空(还没建过插件目录)。
      const missing = scanPluginSourceEntries(path.join(pluginsDir, 'nope'))
      expect(missing).toMatchObject({ trusted: true, presentEntryNames: [] })

      // 是个文件而不是目录 = 不可信。
      const asFile = path.join(pluginsDir, 'as-file')
      fs.writeFileSync(asFile, 'x', 'utf-8')
      expect(scanPluginSourceEntries(asFile).trusted).toBe(false)
    } finally {
      fs.rmSync(pluginsDir, { recursive: true, force: true })
    }
  })

  it('counts a symlinked plugin as installed — the ln -s install path README teaches', () => {
    const pluginsDir = tempRoot()
    const source = tempRoot()
    try {
      fs.mkdirSync(path.join(source, 'notes'), { recursive: true })
      fs.symlinkSync(path.join(source, 'notes'), path.join(pluginsDir, 'notes'), 'dir')

      const scan = scanPluginSourceEntries(pluginsDir)
      expect(scan.trusted).toBe(true)
      // dirent.isDirectory() 对 symlink 是 false —— 漏掉它等于每轮都把它判孤儿。
      expect(scan.presentEntryNames).toEqual(['notes'])
      expect(findCorePluginDataOrphans(tempRoot(), scan.presentEntryNames)).toEqual([])
    } finally {
      fs.rmSync(pluginsDir, { recursive: true, force: true })
      fs.rmSync(source, { recursive: true, force: true })
    }
  })

  it('refuses to archive when the scan is untrusted, when nothing is installed, or past the limit', () => {
    const orphans = [{ pluginId: 'a', kind: 'directory' as const }]
    expect(decidePluginOrphanArchive({ orphans, scanTrusted: true, userPluginCount: 1 }).proceed).toBe(true)

    // 这三条各自都能让"一次 EACCES"变成"把所有插件数据搬走"。
    expect(decidePluginOrphanArchive({ orphans, scanTrusted: false, userPluginCount: 1 }))
      .toMatchObject({ proceed: false, reason: expect.stringContaining('could not be read') })
    expect(decidePluginOrphanArchive({ orphans, scanTrusted: true, userPluginCount: 0 }))
      .toMatchObject({ proceed: false, reason: expect.stringContaining('no user plugins') })
    expect(decidePluginOrphanArchive({
      orphans: ['a', 'b', 'c', 'd'].map(pluginId => ({ pluginId, kind: 'directory' as const })),
      scanTrusted: true,
      userPluginCount: 4,
    })).toMatchObject({ proceed: false, reason: expect.stringContaining('safety limit') })

    // 没有候选时永远放行(不需要做任何事)。
    expect(decidePluginOrphanArchive({ orphans: [], scanTrusted: false, userPluginCount: 0 }).proceed).toBe(true)
  })

  it('compares ownership case-insensitively and survives a malformed entry name', () => {
    const root = tempRoot()
    try {
      fs.mkdirSync(path.join(root, 'Notes'), { recursive: true })
      // 大小写不敏感的文件系统上 `Notes` 与 `notes` 是同一个目录。
      expect(findCorePluginDataOrphans(root, ['notes'])).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('R4 orphan detection', () => {
  it('finds directories and legacy files with no installed owner, skipping the backup dir', () => {
    const root = tempRoot()
    try {
      fs.mkdirSync(path.join(root, 'installed'), { recursive: true })
      fs.mkdirSync(path.join(root, 'ghost'), { recursive: true })
      fs.mkdirSync(path.join(root, PLUGIN_DATA_LEGACY_BACKUP_DIR, 'old-2026-01-01'), { recursive: true })
      fs.writeFileSync(path.join(root, 'ancient.json'), '{}', 'utf-8')
      fs.writeFileSync(path.join(root, 'installed.json'), '{}', 'utf-8')

      expect(findCorePluginDataOrphans(root, ['installed'])).toEqual([
        { pluginId: 'ancient', kind: 'legacy-kv' },
        { pluginId: 'ghost', kind: 'directory' },
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── 卸载全链(真 CorePluginManager) ──────────────

interface TestAPI { registerCommand(name: string): void }
type TestEntry = (api: TestAPI) => void
type TestDefinition = CorePluginDefinition<TestEntry>
interface TestCommand { name: string }
interface TestState extends CorePluginStateLike<TestCommand> {
  disposed?: boolean
}

describe('R4 archive atomicity (评审 major)', () => {
  it('keeps both KV files when the directory already has one', () => {
    const root = tempRoot()
    try {
      createCorePluginStorage({ pluginId: 'notes', dataRoot: root }).writeJson('a.json', { x: 1 })
      fs.writeFileSync(path.join(root, 'notes', PLUGIN_KV_FILE_NAME), JSON.stringify({ from: 'new' }), 'utf-8')
      fs.writeFileSync(path.join(root, 'notes.json'), JSON.stringify({ from: 'legacy' }), 'utf-8')

      const result = archiveCorePluginData(root, 'notes', { now: new Date('2026-08-07T00:00:00') })
      expect(result.archived).toBe(true)
      // 用旧文件压掉更新的那一份,等于安全网自己毁数据。
      expect(JSON.parse(fs.readFileSync(path.join(result.archivePath!, PLUGIN_KV_FILE_NAME), 'utf-8')))
        .toEqual({ from: 'new' })
      expect(JSON.parse(fs.readFileSync(path.join(result.archivePath!, PLUGIN_LEGACY_KV_FILE_NAME), 'utf-8')))
        .toEqual({ from: 'legacy' })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rolls the legacy merge back when the directory rename fails — no half-archive', () => {
    const root = tempRoot()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const realRename = fs.renameSync
    try {
      createCorePluginStorage({ pluginId: 'notes', dataRoot: root }).writeJson('a.json', { x: 1 })
      fs.writeFileSync(path.join(root, 'notes.json'), JSON.stringify({ from: 'legacy' }), 'utf-8')

      // 只让"整目录 rename"那一步失败,合并那一步照常。
      const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: string, to: string) => {
        if (to.includes(PLUGIN_DATA_LEGACY_BACKUP_DIR)) {
          const error = new Error('EXDEV: cross-device link not permitted') as Error & { code?: string }
          error.code = 'EXDEV'
          throw error
        }
        return realRename(from, to)
      }) as typeof fs.renameSync)

      const result = archiveCorePluginData(root, 'notes', { now: new Date('2026-08-07T00:00:00') })
      spy.mockRestore()

      expect(result.archived).toBe(false)
      // 跨卷是已裁决不做降级的场景,至少要把原因说清楚。
      expect(result.error).toContain('different volumes')
      // 回滚:遗留文件回到原位,数据目录完整,归档目录里没有半成品。
      expect(fs.existsSync(path.join(root, 'notes.json'))).toBe(true)
      expect(fs.existsSync(path.join(root, 'notes', 'a.json'))).toBe(true)
      expect(fs.existsSync(path.join(root, 'notes', PLUGIN_KV_FILE_NAME))).toBe(false)
    } finally {
      errorSpy.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores an archive back to the data directory', () => {
    const root = tempRoot()
    try {
      createCorePluginStorage({ pluginId: 'notes', dataRoot: root }).writeJson('a.json', { x: 1 })
      const archive = archiveCorePluginData(root, 'notes')
      expect(fs.existsSync(path.join(root, 'notes'))).toBe(false)

      expect(restoreCorePluginDataArchive(root, 'notes', archive.archivePath!)).toEqual({ restored: true })
      expect(JSON.parse(fs.readFileSync(path.join(root, 'notes', 'a.json'), 'utf-8'))).toEqual({ x: 1 })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('R4 uninstall lifecycle', () => {
  function buildManager(root: string, pluginsDir: string) {
    const settings: Record<string, Record<string, unknown>> = {
      enabled: { notes: true },
      config: { notes: { label: 'mine' } },
      health: { notes: { status: 'degraded' } },
    }
    const definitions: TestDefinition[] = [{
      id: 'notes',
      source: 'user',
      manifest: { name: 'Notes', version: '1.0.0' },
      dirPath: path.join(pluginsDir, 'notes'),
      entryPath: path.join(pluginsDir, 'notes', 'plugin-entry.js'),
      enabled: true,
      entry: api => api.registerCommand('/notes'),
    }]

    const host: CorePluginManagerHost<TestDefinition, TestEntry, TestAPI, TestState, TestCommand, { ready: true }> = {
      ensurePluginDirs() {},
      scanPlugins: () => definitions.filter(def => fs.existsSync(def.dirPath)),
      loadPluginEntry: async definition => definition.entry ?? null,
      createPluginAPI() {
        const state: TestState = { commands: new Map() }
        return {
          state,
          api: { registerCommand: name => void state.commands.set(name, { name }) },
        }
      },
      disposePlugin(state) {
        state.disposed = true
        state.commands.clear()
      },
      setPluginEnabled() {},
      archivePluginData: pluginId => archiveCorePluginData(root, pluginId),
      removePluginSource: definition => {
        fs.rmSync(definition.dirPath, { recursive: true, force: true })
        return { removed: true }
      },
      clearPluginSettings: pluginId => {
        for (const bucket of Object.values(settings)) delete bucket[pluginId]
      },
      restorePluginDataArchive: (pluginId, archivePath) =>
        restoreCorePluginDataArchive(root, pluginId, archivePath),
      getPluginSourceScan: () => scanPluginSourceEntries(pluginsDir),
      archiveOrphanPluginData: ({ knownPluginIds, scanTrusted, userPluginCount }) => {
        const orphans = findCorePluginDataOrphans(root, knownPluginIds)
        if (!decidePluginOrphanArchive({ orphans, scanTrusted, userPluginCount }).proceed) return []
        const archived: string[] = []
        for (const orphan of orphans) {
          if (archiveCorePluginData(root, orphan.pluginId).archived) archived.push(orphan.pluginId)
        }
        return archived
      },
    }
    const manager = new CorePluginManager<TestAPI, TestEntry, TestCommand, TestState, TestDefinition, { ready: true }>(
      host,
      silentLogger(),
    )
    return { manager, settings }
  }

  it('runs the whole chain: dispose → archive data → remove source → clear settings keys', async () => {
    const root = tempRoot()
    const pluginsDir = tempRoot()
    try {
      fs.mkdirSync(path.join(pluginsDir, 'notes'), { recursive: true })
      fs.writeFileSync(path.join(pluginsDir, 'notes', 'plugin-entry.js'), 'export default () => {}', 'utf-8')
      createCorePluginStorage({ pluginId: 'notes', dataRoot: root }).writeJson('a.json', { precious: true })

      const { manager, settings } = buildManager(root, pluginsDir)
      await manager.initialize({ ready: true })
      expect(manager.getPlugins()[0]).toMatchObject({ loaded: true })

      const result = await manager.uninstallPlugin('notes')
      expect(result.success).toBe(true)

      // 1) 数据在归档里,不是被删了。
      expect(fs.existsSync(path.join(root, 'notes'))).toBe(false)
      const archived = fs.readdirSync(path.join(root, PLUGIN_DATA_LEGACY_BACKUP_DIR))
      expect(archived).toHaveLength(1)
      expect(JSON.parse(fs.readFileSync(
        path.join(root, PLUGIN_DATA_LEGACY_BACKUP_DIR, archived[0], 'a.json'),
        'utf-8',
      ))).toEqual({ precious: true })
      // 2) 源目录没了。
      expect(fs.existsSync(path.join(pluginsDir, 'notes'))).toBe(false)
      // 3) plugin-settings 三键清干净。
      expect(settings.enabled.notes).toBeUndefined()
      expect(settings.config.notes).toBeUndefined()
      expect(settings.health.notes).toBeUndefined()
      // 4) 列表里没有它了。
      expect(manager.getPlugins()).toHaveLength(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(pluginsDir, { recursive: true, force: true })
    }
  })

  it('refuses to uninstall a built-in plugin', async () => {
    const root = tempRoot()
    const pluginsDir = tempRoot()
    try {
      const { manager } = buildManager(root, pluginsDir)
      ;(manager as unknown as { host: { scanPlugins(): TestDefinition[] } }).host.scanPlugins = () => [{
        id: 'log-monitor',
        source: 'builtin',
        manifest: { name: 'Log monitor', version: '1.0.0' },
        dirPath: 'builtin://log-monitor',
        entryPath: 'builtin://log-monitor/plugin-entry.js',
        enabled: true,
        entry: () => {},
      }]
      await manager.initialize({ ready: true })

      await expect(manager.uninstallPlugin('log-monitor')).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('built-in'),
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(pluginsDir, { recursive: true, force: true })
    }
  })

  it('does not delete the source directory when archiving failed', async () => {
    const root = tempRoot()
    const pluginsDir = tempRoot()
    try {
      fs.mkdirSync(path.join(pluginsDir, 'notes'), { recursive: true })
      fs.writeFileSync(path.join(pluginsDir, 'notes', 'plugin-entry.js'), 'export default () => {}', 'utf-8')
      createCorePluginStorage({ pluginId: 'notes', dataRoot: root }).writeJson('a.json', { precious: true })

      const { manager, settings } = buildManager(root, pluginsDir)
      ;(manager as unknown as { host: { archivePluginData(): unknown } }).host.archivePluginData = () => ({
        archived: false,
        error: 'disk full',
      })
      await manager.initialize({ ready: true })

      await expect(manager.uninstallPlugin('notes')).resolves.toMatchObject({ success: false, error: 'disk full' })
      // "代码没了数据还在"是最糟的中间态 —— 归档失败就整条流程停下。
      expect(fs.existsSync(path.join(pluginsDir, 'notes'))).toBe(true)
      expect(fs.existsSync(path.join(root, 'notes', 'a.json'))).toBe(true)
      expect(settings.enabled.notes).toBeDefined()
      expect(manager.getPlugins()[0].error).toContain('disk full')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(pluginsDir, { recursive: true, force: true })
    }
  })

  it('restores the archived data when removing the source directory fails', async () => {
    const root = tempRoot()
    const pluginsDir = tempRoot()
    try {
      fs.mkdirSync(path.join(pluginsDir, 'notes'), { recursive: true })
      fs.writeFileSync(path.join(pluginsDir, 'notes', 'plugin-entry.js'), 'export default () => {}', 'utf-8')
      createCorePluginStorage({ pluginId: 'notes', dataRoot: root }).writeJson('a.json', { precious: true })

      const { manager } = buildManager(root, pluginsDir)
      ;(manager as unknown as { host: { removePluginSource(): unknown } }).host.removePluginSource = () => ({
        removed: false,
        error: 'EPERM',
      })
      await manager.initialize({ ready: true })

      const result = await manager.uninstallPlugin('notes')
      expect(result.success).toBe(false)
      // 数据要么搬回原位,要么归档路径必须一路带到调用方(它会进 toast)。
      const restored = fs.existsSync(path.join(root, 'notes', 'a.json'))
      if (restored) {
        expect(result.error).toContain('restored')
      } else {
        expect(result.archivePath).toBeTruthy()
        expect(result.error).toContain(result.archivePath!)
      }
      expect(fs.existsSync(path.join(pluginsDir, 'notes'))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(pluginsDir, { recursive: true, force: true })
    }
  })

  it('leaves plugin data untouched when the plugins directory cannot be scanned', async () => {
    const root = tempRoot()
    const pluginsDir = tempRoot()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      createCorePluginStorage({ pluginId: 'notes', dataRoot: root }).writeJson('a.json', { precious: true })
      createCorePluginStorage({ pluginId: 'other', dataRoot: root }).writeJson('a.json', { precious: true })

      const { manager } = buildManager(root, pluginsDir)
      // 扫描不可信(EACCES/EIO/瞬断都长这样)—— 这一轮一个字节都不许动。
      ;(manager as unknown as { host: { getPluginSourceScan(): unknown } }).host.getPluginSourceScan = () => ({
        trusted: false,
        reason: 'EACCES',
        presentEntryNames: [],
      })
      await manager.initialize({ ready: true })

      expect(fs.existsSync(path.join(root, 'notes', 'a.json'))).toBe(true)
      expect(fs.existsSync(path.join(root, 'other', 'a.json'))).toBe(true)
      expect(fs.existsSync(path.join(root, PLUGIN_DATA_LEGACY_BACKUP_DIR))).toBe(false)
    } finally {
      warn.mockRestore()
      errorSpy.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(pluginsDir, { recursive: true, force: true })
    }
  })

  it('keeps data for a plugin whose source dir is present but unloadable', async () => {
    const root = tempRoot()
    const pluginsDir = tempRoot()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 源目录在,但 entry 缺失 —— definitions 里不会有它,可它显然还装着。
      fs.mkdirSync(path.join(pluginsDir, 'broken'), { recursive: true })
      fs.mkdirSync(path.join(pluginsDir, 'notes'), { recursive: true })
      fs.writeFileSync(path.join(pluginsDir, 'notes', 'plugin-entry.js'), 'export default () => {}', 'utf-8')
      createCorePluginStorage({ pluginId: 'broken', dataRoot: root }).writeJson('a.json', { precious: true })

      const { manager } = buildManager(root, pluginsDir)
      await manager.initialize({ ready: true })

      // 所有权判定看的是源目录是否存在,不是能不能加载。
      expect(fs.existsSync(path.join(root, 'broken', 'a.json'))).toBe(true)
    } finally {
      warn.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(pluginsDir, { recursive: true, force: true })
    }
  })

  it('archives orphaned data on refresh — the hand-deleted-folder path', async () => {
    const root = tempRoot()
    const pluginsDir = tempRoot()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      fs.mkdirSync(path.join(pluginsDir, 'notes'), { recursive: true })
      fs.writeFileSync(path.join(pluginsDir, 'notes', 'plugin-entry.js'), 'export default () => {}', 'utf-8')
      createCorePluginStorage({ pluginId: 'notes', dataRoot: root }).writeJson('a.json', { keep: true })
      createCorePluginStorage({ pluginId: 'ghost', dataRoot: root }).writeJson('a.json', { orphan: true })

      const { manager } = buildManager(root, pluginsDir)
      await manager.initialize({ ready: true })

      // 装着的插件不动;无主的被搬进归档。
      expect(fs.existsSync(path.join(root, 'notes', 'a.json'))).toBe(true)
      expect(fs.existsSync(path.join(root, 'ghost'))).toBe(false)
      const archived = fs.readdirSync(path.join(root, PLUGIN_DATA_LEGACY_BACKUP_DIR))
      expect(archived.some(name => name.startsWith('ghost-'))).toBe(true)
    } finally {
      warn.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(pluginsDir, { recursive: true, force: true })
    }
  })
})

/**
 * M1 / F1 —— 受管文件树接进既有拆除机制
 * (docs/design/plugin-knowledge-worker-capabilities-2026-08.md §1 F1 "拆除免费")。
 *
 * "免费"这个说法要有人验:files 面把数据落在 `plugins/<id>/storage/`,而归档搬的
 * 是整个家目录 —— 所以它**应该**天然被覆盖。应该不等于是,所以这里钉住它;
 * 同时钉住反过来的那一半:**卸载绝不动外部根**,那是用户自己的文件。
 */
describe('F1 files — teardown covers the storage tree and never the user folder', () => {
  it('archives the whole storage subtree along with the home directory', () => {
    const root = tempRoot()
    try {
      const files = createCorePluginFiles({ pluginId: 'memory', homeRoot: root })
      files.appendText('candidates/2026-08.jsonl', '{"a":1}\n')
      files.writeText('wiki/topics/cls.md', '# CLS\n')

      // 足迹是可枚举的:storage/ 就在家目录里,不是第二个地盘。
      expect(fs.existsSync(getCorePluginScratchDir(root, 'memory'))).toBe(true)

      const result = archiveCorePluginData(root, 'memory', { now: new Date('2026-08-12T00:00:00') })

      expect(result.archived).toBe(true)
      expect(fs.existsSync(path.join(root, 'memory'))).toBe(false)
      expect(
        fs.readFileSync(path.join(result.archivePath!, 'storage/candidates/2026-08.jsonl'), 'utf-8'),
      ).toBe('{"a":1}\n')
      expect(
        fs.readFileSync(path.join(result.archivePath!, 'storage/wiki/topics/cls.md'), 'utf-8'),
      ).toBe('# CLS\n')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves every byte of the external root alone when the plugin is torn down', () => {
    const root = tempRoot()
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-user-notes-'))
    try {
      const files = createCorePluginFiles({
        pluginId: 'memory',
        homeRoot: root,
        externalRootDeclared: true,
        resolveExternalRoot: () => external,
      })
      files.writeText('wiki/kept.md', '用户的笔记', { root: 'external' })
      files.writeText('scratch.md', 'plugin scratch')

      archiveCorePluginData(root, 'memory', { now: new Date('2026-08-12T00:00:00') })

      // 家目录被归档走了 —— 那是宿主发的草稿纸。
      expect(fs.existsSync(path.join(root, 'memory'))).toBe(false)
      // 外部根一个字节都没动 —— 卸载只该清"插件对它的授权",不该碰用户的文件。
      expect(fs.readFileSync(path.join(external, 'wiki/kept.md'), 'utf-8')).toBe('用户的笔记')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(external, { recursive: true, force: true })
    }
  })
})

/**
 * M1 / F1 —— `api.storage.files` 在 api-builder 上的宿主纪律:
 * 拆除闩 + 熔断分车道 + 错误继续抛(与 KV 逐条同规)。
 */
describe('F1 api.storage.files wiring — latch and breaker ledger', () => {
  function buildFilesApi(homeRoot: string, pluginId = 'memory') {
    const failures: Array<{ scope: string; error: unknown }> = []
    const gate = { disposed: false }
    const result = createCorePluginAPI<
      {
        storage: {
          files: {
            readText(relPath: string, options?: { root?: 'home' | 'external' }): string | undefined
            writeText(relPath: string, content: string, options?: { root?: 'home' | 'external' }): void
            appendText(relPath: string, content: string, options?: { root?: 'home' | 'external' }): void
            list(relDir?: string): Array<{ path: string }>
            exists(relPath: string): boolean
            remove(relPath: string): void
            usage(): { bytes: number; quotaBytes: number }
          }
        }
      },
      { name: string },
      () => void,
      { name: string },
      object,
      () => string,
      () => void,
      () => void,
      () => [],
      object,
      object
    >({
      pluginId,
      store: {},
      files: createCorePluginFiles({
        pluginId,
        homeRoot,
        isDisposed: () => gate.disposed,
      }),
      scheduler: {},
      logger: silentLogger(),
      onPluginFailure: ({ scope, error }) => failures.push({ scope, error }),
      host: {
        registerTool: () => {},
        subscribeEvent: () => () => {},
        steer: () => {},
        followUp: () => {},
        notify: () => {},
        registerPromptContextProvider: () => () => {},
        registerBeforeContextCompactHook: () => () => {},
        registerAfterAssistantResponseHook: () => () => {},
        registerSkillRoot: () => () => {},
      },
    })
    return { ...result, failures, gate }
  }

  it('round-trips all six verbs through the api surface', () => {
    const root = tempRoot()
    try {
      const { api } = buildFilesApi(root)
      expect(api.storage.files.exists('candidates/a.jsonl')).toBe(false)
      api.storage.files.appendText('candidates/a.jsonl', '{"n":1}\n')
      api.storage.files.appendText('candidates/a.jsonl', '{"n":2}\n')
      api.storage.files.writeText('wiki/a.md', '# a')

      expect(api.storage.files.readText('candidates/a.jsonl')).toBe('{"n":1}\n{"n":2}\n')
      expect(api.storage.files.list('wiki').map(entry => entry.path)).toEqual(['wiki/a.md'])
      expect(api.storage.files.usage().bytes).toBeGreaterThan(0)

      api.storage.files.remove('wiki/a.md')
      expect(api.storage.files.exists('wiki/a.md')).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('books a traversal attempt per verb and still throws at the plugin', () => {
    const root = tempRoot()
    try {
      const { api, failures } = buildFilesApi(root)
      expect(() => api.storage.files.writeText('../escape.md', 'x')).toThrow(PluginStorageError)
      expect(() => api.storage.files.appendText('../escape.md', 'x')).toThrow(PluginStorageError)

      // 按操作分车道:appendText 的连败不该被 writeText 的成功清掉。
      expect(failures.map(item => item.scope)).toEqual([
        'storage.files.writeText',
        'storage.files.appendText',
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects the external root when the manifest never declared it', () => {
    const root = tempRoot()
    try {
      const { api } = buildFilesApi(root)
      let error: unknown
      try {
        api.storage.files.readText('x.md', { root: 'external' })
      } catch (caught) {
        error = caught
      }
      expect((error as PluginStorageError).code).toBe('not-declared')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('degrades after dispose: writes throw, reads fall back, nothing resurrects the home directory', () => {
    const root = tempRoot()
    try {
      const { api, state, gate } = buildFilesApi(root)
      api.storage.files.writeText('a.md', 'v1')

      disposeCorePluginState(state)
      gate.disposed = true

      expect(() => api.storage.files.writeText('a.md', 'v2')).toThrow(PluginStorageError)
      expect(api.storage.files.readText('a.md')).toBeUndefined()
      expect(api.storage.files.list()).toEqual([])
      expect(api.storage.files.exists('a.md')).toBe(false)
      // 盘上那一份没被改动 —— 拆除只是让通道停用,不是让数据变形。
      expect(fs.readFileSync(path.join(getCorePluginScratchDir(root, 'memory'), 'a.md'), 'utf-8')).toBe('v1')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
