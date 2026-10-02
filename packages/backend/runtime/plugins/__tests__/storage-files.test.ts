/**
 * M1 验收:`api.storage.files` 受管文件树
 * (docs/design/plugin-knowledge-worker-capabilities-2026-08.md §1 F1)。
 *
 * 每一组钉的都是一条**会静默坏掉**的性质:
 *  - 追加吃行(candidates 断流,零告警);
 *  - 原子写留半个文件(wiki 页损坏,下次读回来是残文);
 *  - 遍历/软链逃逸(受管口比裸 fs 还宽,H 线换成 RPC 时服务端照单全收) ——
 *    含**悬空**链:目标不存在的链曾被判成"这一段不存在"而跳过复核,
 *    而 append 的 open 是跟链 + O_CREAT 的,于是在根外面把目标创建了出来;
 *  - 追加与读取的上限不对称(只校验单块 → 文件一路长过上限 → 可写不可读);
 *  - 配额只在写满时才说话(记忆断流时才通知,已经晚了);
 *  - 外部根未声明/未配置时假装成功(插件以为写进了用户的笔记本)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PLUGIN_FILES_DEFAULT_QUOTA_BYTES,
  PLUGIN_FILES_MAX_FILE_BYTES,
  PLUGIN_PERMISSION_STORAGE_EXTERNAL_ROOT,
  PLUGIN_STORAGE_EXTERNAL_ROOT_PERMISSION_NOTE,
  PluginStorageError,
  createCorePluginFiles,
  describePluginFilesPathProblem,
  describePluginPermission,
  getCorePluginScratchDir,
  getPluginFilesRefusalKind,
  type CorePluginFilesUsage,
  type CreateCorePluginFilesOptions,
} from '@onething/backend/runtime/plugins/plugin-contract'

const PLUGIN_ID = 'memory'

function tempRoot(prefix = 'onething-plugin-files-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function makeFiles(overrides: Partial<CreateCorePluginFilesOptions> = {}) {
  const homeRoot = overrides.homeRoot ?? tempRoot()
  const files = createCorePluginFiles({
    pluginId: PLUGIN_ID,
    homeRoot,
    ...overrides,
  })
  return { files, homeRoot, scratch: getCorePluginScratchDir(homeRoot, PLUGIN_ID) }
}

describe('F1 files — six verbs over the plugin home tree', () => {
  it('round-trips text through nested directories that it creates on demand', () => {
    const { files, scratch } = makeFiles()

    expect(files.exists('wiki/topics/cls.md')).toBe(false)
    expect(files.readText('wiki/topics/cls.md')).toBeUndefined()

    files.writeText('wiki/topics/cls.md', '# CLS\n')

    expect(files.exists('wiki/topics/cls.md')).toBe(true)
    expect(files.readText('wiki/topics/cls.md')).toBe('# CLS\n')
    // 落点就是既有的坐标系,不是第二个目录。
    expect(fs.readFileSync(path.join(scratch, 'wiki/topics/cls.md'), 'utf-8')).toBe('# CLS\n')
  })

  it('lists one level, sorted, with kind/size, and reports an absent directory as empty', () => {
    const { files } = makeFiles()

    // 第一次跑时 candidates/ 本来就还不存在 —— 那是空,不是错误。
    expect(files.list('candidates')).toEqual([])

    files.appendText('candidates/2026-08.jsonl', '{"a":1}\n')
    files.writeText('candidates/index.json', '{}')
    files.writeText('candidates/archive/old.jsonl', 'x')

    const entries = files.list('candidates')
    expect(entries.map(entry => [entry.path, entry.kind])).toEqual([
      ['candidates/2026-08.jsonl', 'file'],
      ['candidates/archive', 'directory'],
      ['candidates/index.json', 'file'],
    ])
    expect(entries[0].size).toBe(Buffer.byteLength('{"a":1}\n'))
    expect(entries[1].size).toBe(0)
  })

  it('remove is idempotent, refuses to recurse, and frees quota', () => {
    const { files } = makeFiles()
    files.writeText('wiki/a.md', 'x'.repeat(100))

    const before = files.usage().bytes
    expect(before).toBe(100)

    // 不存在 = 无操作(重放安全:checkpoint 幂等的前提)。
    expect(() => files.remove('wiki/missing.md')).not.toThrow()

    // 非空目录不许删 —— 递归删除是"一个路径错误 = 整棵 wiki 消失"的形状。
    expect(() => files.remove('wiki')).toThrow(PluginStorageError)

    files.remove('wiki/a.md')
    expect(files.exists('wiki/a.md')).toBe(false)
    expect(files.usage().bytes).toBe(0)
    // 空了之后目录本身可以删。
    expect(() => files.remove('wiki')).not.toThrow()
  })
})

describe('F1 files — appendText is O_APPEND line semantics, not read-modify-write', () => {
  it('does not swallow lines written by another writer between two appends', () => {
    const { files, scratch } = makeFiles()
    const target = path.join(scratch, 'candidates/log.jsonl')

    files.appendText('candidates/log.jsonl', '{"n":1}\n')
    // 另一个写者(用户的编辑器、另一个进程)追加了一行。读-改-写的实现会把它吃掉,
    // 而且**零告警** —— 这正是 candidates 断流时最难查的那种形态。
    fs.appendFileSync(target, '{"n":"外部"}\n')
    files.appendText('candidates/log.jsonl', '{"n":2}\n')

    expect(files.readText('candidates/log.jsonl')).toBe(
      '{"n":1}\n{"n":"外部"}\n{"n":2}\n',
    )
  })

  it('keeps every line under a long interleave with a foreign writer', () => {
    const { files, scratch } = makeFiles()
    const target = path.join(scratch, 'candidates/log.jsonl')

    for (let index = 0; index < 200; index += 1) {
      files.appendText('candidates/log.jsonl', `ours-${index}\n`)
      fs.appendFileSync(target, `theirs-${index}\n`)
    }

    const lines = (files.readText('candidates/log.jsonl') ?? '').split('\n').filter(Boolean)
    expect(lines).toHaveLength(400)
    expect(lines[0]).toBe('ours-0')
    expect(lines[399]).toBe('theirs-199')
    // 一行都没被截断(读-改-写在竞态下会留下半行)。
    expect(lines.every(line => /^(ours|theirs)-\d+$/.test(line))).toBe(true)
  })

  it('survives concurrently scheduled appends without losing or interleaving a line', async () => {
    const { files } = makeFiles()

    await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        Promise.resolve().then(() => files.appendText('candidates/c.jsonl', `line-${index}\n`))),
    )

    const lines = (files.readText('candidates/c.jsonl') ?? '').split('\n').filter(Boolean)
    expect(lines).toHaveLength(60)
    expect(new Set(lines).size).toBe(60)
    expect(lines.every(line => /^line-\d+$/.test(line))).toBe(true)
  })
})

describe('F1 files — writeText is atomic (tmp + rename)', () => {
  it('leaves no temporary file behind and replaces content wholesale', () => {
    const { files, scratch } = makeFiles()

    files.writeText('wiki/page.md', 'v1')
    files.writeText('wiki/page.md', 'v2-longer')

    expect(files.readText('wiki/page.md')).toBe('v2-longer')
    const leftovers = fs.readdirSync(path.join(scratch, 'wiki')).filter(name => name.includes('.tmp-'))
    expect(leftovers).toEqual([])
  })

  it('accounts the replacement, not the sum, against the quota', () => {
    const { files } = makeFiles()
    files.writeText('wiki/page.md', 'x'.repeat(1000))
    expect(files.usage().bytes).toBe(1000)
    files.writeText('wiki/page.md', 'x'.repeat(10))
    expect(files.usage().bytes).toBe(10)
  })
})

describe('F1 files — path judgement is the two existing ones, and it holds', () => {
  const traversals = [
    '../../.ssh/id_rsa',
    '..',
    'wiki/../../escape.md',
    '/etc/passwd',
    'C:\\Windows\\system.ini',
    'wiki\\page.md',
    'wiki/%2e%2e/page.md',
    'file:///etc/passwd',
    'wiki//page.md',
    'wiki/./page.md',
    'wiki/CON.md',
    'wiki/page.md ',
    'wiki/page.',
    'wiki/pa:ge.md',
  ]

  it.each(traversals)('rejects %s at the judgement layer', candidate => {
    expect(describePluginFilesPathProblem(candidate)).toBeTruthy()
  })

  it.each(traversals)('rejects %s at every verb', candidate => {
    const { files } = makeFiles()
    expect(() => files.readText(candidate)).toThrow(PluginStorageError)
    expect(() => files.writeText(candidate, 'x')).toThrow(PluginStorageError)
    expect(() => files.appendText(candidate, 'x')).toThrow(PluginStorageError)
    expect(() => files.exists(candidate)).toThrow(PluginStorageError)
    expect(() => files.remove(candidate)).toThrow(PluginStorageError)
  })

  it('accepts ordinary nested paths', () => {
    expect(describePluginFilesPathProblem('wiki/topics/cls.md')).toBeNull()
    expect(describePluginFilesPathProblem('candidates/2026-08.jsonl')).toBeNull()
  })

  it('refuses a legal name that is a symlink out of the root', () => {
    const { files, scratch } = makeFiles()
    const outside = tempRoot('onething-plugin-outside-')
    fs.writeFileSync(path.join(outside, 'secret.md'), 'not yours')

    fs.mkdirSync(scratch, { recursive: true })
    fs.symlinkSync(outside, path.join(scratch, 'wiki'))

    // 名字完全合法,链才是问题 —— 字符串判据看的是声明,realpath 看的是磁盘。
    expect(describePluginFilesPathProblem('wiki/secret.md')).toBeNull()
    expect(() => files.readText('wiki/secret.md')).toThrow(/symlink/)
    expect(() => files.writeText('wiki/planted.md', 'x')).toThrow(/symlink/)
  })

  it('refuses a dangling symlink instead of creating its target outside the root', () => {
    const { files, scratch } = makeFiles()
    const outside = tempRoot('onething-plugin-outside-')
    // 目标**不存在**,但它的父目录存在 —— 这正是 O_CREAT 会替我们把它创建出来的形状
    // (真实世界的样子:一条指向 `~/.zshenv` 的失效链)。
    const planted = path.join(outside, 'zshenv')
    fs.mkdirSync(scratch, { recursive: true })
    fs.symlinkSync(planted, path.join(scratch, 'ledger.jsonl'))
    expect(fs.existsSync(planted)).toBe(false)

    // 旧实现:`existsSync` 跟链 → 悬空链被判"不存在" → 跳过 realpath 复核 →
    // `appendFileSync` 在 open 时跟链 + O_CREAT,于是在根外面创建并写入了 planted。
    expect(() => files.appendText('ledger.jsonl', 'pwned\n')).toThrow(/symlink/)
    expect(fs.existsSync(planted)).toBe(false)

    expect(() => files.writeText('ledger.jsonl', 'x')).toThrow(/symlink/)
    expect(() => files.readText('ledger.jsonl')).toThrow(/symlink/)
    expect(fs.existsSync(planted)).toBe(false)
  })

  it('refuses a dangling symlink that is a path component, not the leaf', () => {
    const { files, scratch } = makeFiles()
    const outside = tempRoot('onething-plugin-outside-')
    fs.mkdirSync(scratch, { recursive: true })
    fs.symlinkSync(path.join(outside, 'gone'), path.join(scratch, 'wiki'))

    expect(() => files.appendText('wiki/notes.md', 'x')).toThrow(/symlink/)
    expect(() => files.writeText('wiki/notes.md', 'x')).toThrow(/symlink/)
    expect(fs.existsSync(path.join(outside, 'gone'))).toBe(false)
  })

  it('refuses appending through a symlink whose target exists outside the root', () => {
    const { files, scratch } = makeFiles()
    const outside = tempRoot('onething-plugin-outside-')
    const victim = path.join(outside, 'zshenv')
    fs.writeFileSync(victim, '# mine\n')
    fs.mkdirSync(scratch, { recursive: true })
    fs.symlinkSync(victim, path.join(scratch, 'ledger.jsonl'))

    expect(() => files.appendText('ledger.jsonl', 'pwned\n')).toThrow(/symlink/)
    expect(fs.readFileSync(victim, 'utf-8')).toBe('# mine\n')
  })

  it('does not list symlinked entries (listing one invites reading it)', () => {
    const { files, scratch } = makeFiles()
    const outside = tempRoot('onething-plugin-outside-')
    fs.mkdirSync(scratch, { recursive: true })
    fs.writeFileSync(path.join(scratch, 'real.md'), 'ok')
    fs.symlinkSync(path.join(outside, 'anything'), path.join(scratch, 'linked.md'))

    expect(files.list().map(entry => entry.name)).toEqual(['real.md'])
  })
})

describe('F1 files — quota: warn at 90%, structured refusal at 100%', () => {
  it('fires the warning once when crossing the line, and again only after dropping below', () => {
    const warnings: CorePluginFilesUsage[] = []
    const { files } = makeFiles({
      quotaBytes: 1000,
      onQuotaWarning: usage => warnings.push({ ...usage }),
    })

    files.writeText('a.txt', 'x'.repeat(500))
    expect(warnings).toHaveLength(0)

    files.writeText('b.txt', 'x'.repeat(450))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toEqual({ bytes: 950, quotaBytes: 1000 })

    // 还在线上 → 不再重复吵。
    files.appendText('b.txt', 'x'.repeat(10))
    expect(warnings).toHaveLength(1)

    // 插件 GC 之后掉回线下,再逼近才算新的一次预警。
    files.remove('a.txt')
    files.writeText('c.txt', 'x'.repeat(500))
    expect(warnings).toHaveLength(2)
  })

  it('refuses the write that would cross the quota, with code "quota", and does not write', () => {
    const { files } = makeFiles({ quotaBytes: 1000 })
    files.writeText('a.txt', 'x'.repeat(900))

    let error: unknown
    try {
      files.writeText('b.txt', 'x'.repeat(200))
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(PluginStorageError)
    expect((error as PluginStorageError).code).toBe('quota')
    expect(files.exists('b.txt')).toBe(false)
    expect(files.usage().bytes).toBe(900)

    expect(() => files.appendText('a.txt', 'x'.repeat(200))).toThrow(PluginStorageError)
  })

  it('defaults to the managed 50MB constant', () => {
    const { files } = makeFiles()
    expect(files.usage().quotaBytes).toBe(PLUGIN_FILES_DEFAULT_QUOTA_BYTES)
    expect(PLUGIN_FILES_DEFAULT_QUOTA_BYTES).toBe(50 * 1024 * 1024)
  })

  it('counts pre-existing files on the first look (a restart does not reset the ledger)', () => {
    const homeRoot = tempRoot()
    const scratch = getCorePluginScratchDir(homeRoot, PLUGIN_ID)
    fs.mkdirSync(path.join(scratch, 'wiki'), { recursive: true })
    fs.writeFileSync(path.join(scratch, 'wiki/old.md'), 'x'.repeat(777))

    const { files } = makeFiles({ homeRoot })
    expect(files.usage().bytes).toBe(777)
  })
})

describe('F1 files — the per-file limit is guarded on the write side, not discovered on the read side', () => {
  it('refuses the append that would cross the per-file limit, and keeps the file readable', () => {
    const { files, scratch } = makeFiles()
    fs.mkdirSync(scratch, { recursive: true })
    const ledger = path.join(scratch, 'candidates.jsonl')
    fs.writeFileSync(ledger, 'x'.repeat(PLUGIN_FILES_MAX_FILE_BYTES - 10))

    // 线内的一笔照写。
    files.appendText('candidates.jsonl', 'x'.repeat(5))
    expect(fs.statSync(ledger).size).toBe(PLUGIN_FILES_MAX_FILE_BYTES - 5)

    let error: unknown
    try {
      files.appendText('candidates.jsonl', 'x'.repeat(20))
    } catch (caught) {
      error = caught
    }
    // 旧实现只校验这一块的大小(20 字节,远小于 8MB)→ 放行 → 文件越限 →
    // 此后 readText 永远抛 quota:可写不可读。
    expect(error).toBeInstanceOf(PluginStorageError)
    expect((error as PluginStorageError).code).toBe('quota')
    expect((error as Error).message).toMatch(/archive this file or roll over/)
    expect(fs.statSync(ledger).size).toBe(PLUGIN_FILES_MAX_FILE_BYTES - 5)
    expect(files.readText('candidates.jsonl')?.length).toBe(PLUGIN_FILES_MAX_FILE_BYTES - 5)
  })

  it('reads the tail of an already-oversized file (nothing is permanently unreadable)', () => {
    const { files, scratch } = makeFiles()
    fs.mkdirSync(scratch, { recursive: true })
    // 上限之外的历史文件:用户手编的,或旧版本一路追加出来的。
    fs.writeFileSync(
      path.join(scratch, 'big.jsonl'),
      'x'.repeat(PLUGIN_FILES_MAX_FILE_BYTES + 100) + 'TAIL',
    )

    // 整份读仍然拒绝(8MB 是"一次读进内存"的上限),但错误里写明了出路。
    expect(() => files.readText('big.jsonl')).toThrow(/tailBytes/)
    expect(files.readText('big.jsonl', { tailBytes: 4 })).toBe('TAIL')
  })

  it('never returns a half character when the cut lands mid-character', () => {
    const { files } = makeFiles()
    files.writeText('u.txt', 'a好') // 1 + 3 字节

    expect(files.readText('u.txt', { tailBytes: 3 })).toBe('好')
    // 切在"好"的中间:开头的续字节被丢掉,而不是回一个 U+FFFD。
    expect(files.readText('u.txt', { tailBytes: 2 })).toBe('')
    // 比文件还大的 tailBytes = 整份。
    expect(files.readText('u.txt', { tailBytes: 999 })).toBe('a好')
  })

  it('refuses a nonsense tailBytes instead of silently reading everything', () => {
    const { files } = makeFiles()
    files.writeText('u.txt', 'abc')
    for (const bad of [0, -1, 1.5, Number.NaN, '10']) {
      let error: unknown
      try {
        files.readText('u.txt', { tailBytes: bad as number })
      } catch (caught) {
        error = caught
      }
      expect((error as PluginStorageError | undefined)?.code).toBe('invalid-name')
    }
  })
})

describe('F1 files — the external root is a declared, user-chosen folder', () => {
  it('is disclosed in the permission vocabulary (the install page reads this table)', () => {
    expect(describePluginPermission(PLUGIN_PERMISSION_STORAGE_EXTERNAL_ROOT))
      .toContain(PLUGIN_STORAGE_EXTERNAL_ROOT_PERMISSION_NOTE)
    // "你选的"三个字是这条披露的重点。
    expect(PLUGIN_STORAGE_EXTERNAL_ROOT_PERMISSION_NOTE).toContain('you choose')
  })

  it('rejects with "not-declared" when the manifest never asked for it', () => {
    const external = tempRoot('onething-plugin-external-')
    const { files } = makeFiles({
      externalRootDeclared: false,
      resolveExternalRoot: () => external,
    })

    let error: unknown
    try {
      files.readText('wiki.md', { root: 'external' })
    } catch (caught) {
      error = caught
    }
    expect((error as PluginStorageError).code).toBe('not-declared')
    // 家目录照常可用 —— 拒的是那一个根,不是整条线。
    expect(() => files.writeText('home.md', 'ok')).not.toThrow()
  })

  it('rejects with "not-configured" when the user has not picked a folder yet', () => {
    const { files } = makeFiles({
      externalRootDeclared: true,
      resolveExternalRoot: () => undefined,
    })
    let error: unknown
    try {
      files.writeText('wiki.md', 'x', { root: 'external' })
    } catch (caught) {
      error = caught
    }
    expect((error as PluginStorageError).code).toBe('not-configured')
  })

  it('rejects with "not-configured" when the picked folder is gone or is a file', () => {
    const external = tempRoot('onething-plugin-external-')
    const filePath = path.join(external, 'a-file')
    fs.writeFileSync(filePath, 'x')

    const gone = makeFiles({
      externalRootDeclared: true,
      resolveExternalRoot: () => path.join(external, 'does-not-exist'),
    })
    expect(() => gone.files.exists('x.md', { root: 'external' })).toThrow(PluginStorageError)

    const notADir = makeFiles({
      externalRootDeclared: true,
      resolveExternalRoot: () => filePath,
    })
    expect(() => notADir.files.exists('x.md', { root: 'external' })).toThrow(/not a directory/)
  })

  it('tags not-configured with a refusal kind: unconfigured vs unreachable (审查第 7 条)', () => {
    const external = tempRoot('onething-plugin-external-')
    const filePath = path.join(external, 'a-file')
    fs.writeFileSync(filePath, 'x')

    const kindOf = (make: () => void): string | undefined => {
      try {
        make()
      } catch (error) {
        return getPluginFilesRefusalKind(error)
      }
      throw new Error('expected a throw')
    }

    // 从没配置:引导去设置里选。
    const unpicked = makeFiles({ externalRootDeclared: true, resolveExternalRoot: () => undefined })
    expect(kindOf(() => unpicked.files.exists('x.md', { root: 'external' }))).toBe('unconfigured')

    // 配置过但够不着(目录没了 / 被文件占位):绝不能翻译成"从没配置"——
    // 那会诱导用户另选新目录,记忆从此分叉。
    const gone = makeFiles({
      externalRootDeclared: true,
      resolveExternalRoot: () => path.join(external, 'does-not-exist'),
    })
    expect(kindOf(() => gone.files.exists('x.md', { root: 'external' }))).toBe('unreachable')

    const notADir = makeFiles({ externalRootDeclared: true, resolveExternalRoot: () => filePath })
    expect(kindOf(() => notADir.files.exists('x.md', { root: 'external' }))).toBe('unreachable')
  })

  it('reads and writes the user folder, applies the same path judgement, and does not meter it', () => {
    const external = tempRoot('onething-plugin-external-')
    const { files } = makeFiles({
      quotaBytes: 100,
      externalRootDeclared: true,
      resolveExternalRoot: () => external,
    })

    // 用户亲手写的文件读得到。
    fs.mkdirSync(path.join(external, 'wiki'), { recursive: true })
    fs.writeFileSync(path.join(external, 'wiki/by-hand.md'), '用户写的')
    expect(files.readText('wiki/by-hand.md', { root: 'external' })).toBe('用户写的')

    // 远超家目录配额,但外部根不吃配额 —— 那是用户自己的目录。
    files.writeText('wiki/big.md', 'x'.repeat(5000), { root: 'external' })
    expect(files.usage().bytes).toBe(0)
    expect(fs.readFileSync(path.join(external, 'wiki/big.md'), 'utf-8')).toHaveLength(5000)

    // 判据同源:相对根逐段校验,禁越出。
    expect(() => files.readText('../escape.md', { root: 'external' })).toThrow(PluginStorageError)
    expect(() => files.writeText('/etc/passwd', 'x', { root: 'external' })).toThrow(PluginStorageError)

    // 两个根互不串门。
    files.writeText('local.md', 'home')
    expect(files.exists('local.md', { root: 'external' })).toBe(false)
    expect(files.exists('wiki/big.md')).toBe(false)
  })

  it('re-reads the configured folder on every call (the user can change it any time)', () => {
    const first = tempRoot('onething-plugin-external-')
    const second = tempRoot('onething-plugin-external-')
    let current = first
    const { files } = makeFiles({
      externalRootDeclared: true,
      resolveExternalRoot: () => current,
    })

    files.writeText('note.md', 'in first', { root: 'external' })
    current = second
    files.writeText('note.md', 'in second', { root: 'external' })

    expect(fs.readFileSync(path.join(first, 'note.md'), 'utf-8')).toBe('in first')
    expect(fs.readFileSync(path.join(second, 'note.md'), 'utf-8')).toBe('in second')
  })

  it('rejects an unknown root name instead of silently falling back to home', () => {
    const { files } = makeFiles()
    expect(() => files.readText('a.md', { root: 'somewhere' as never })).toThrow(PluginStorageError)
  })
})

describe('F1 files — teardown latch', () => {
  it('drops late writes but keeps reads working, and never resurrects the home directory', () => {
    let disposed = false
    const { files, scratch } = makeFiles({ isDisposed: () => disposed })
    files.writeText('wiki/a.md', 'v1')

    disposed = true
    files.writeText('wiki/a.md', 'v2')
    files.appendText('wiki/a.md', 'v3')
    files.remove('wiki/a.md')

    expect(fs.readFileSync(path.join(scratch, 'wiki/a.md'), 'utf-8')).toBe('v1')
    expect(files.readText('wiki/a.md')).toBe('v1')
  })

  it('a late write on a fresh (never-created) tree does not create the directory', () => {
    const { files, scratch } = makeFiles({ isDisposed: () => true })
    files.writeText('wiki/a.md', 'x')
    expect(fs.existsSync(scratch)).toBe(false)
  })
})
