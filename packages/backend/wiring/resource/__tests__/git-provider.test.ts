/**
 * 「改动」面 —— git 这一 scheme 的 provider
 * (`apps/desktop-react/docs/changes-panel-2026-09.md` §2.3)。
 *
 * 跑的是**真 git**(`mkdtemp` 里一个真仓库、真提交、真改动)与**真判据**(沙箱那三只
 * 函数、敏感文件分类器都是产品层那一份),假的只有「沙箱根在哪」—— 因为那正是这只
 * 测试要摆布的那一格。照 `dir-provider.test.ts` 的夹具法。
 *
 * 为什么不拿一份写死的 `git status` 输出喂给解析器:porcelain v2 的 `-z` 里重命名
 * 那一条**跨两条记录**、numstat 的重命名那一条**路径是空的**,两处都是「以为自己
 * 懂了」最容易写错的地方,而一份手写的样本会连同误解一起被冻住。
 *
 * 证的十句话:
 *   ① 六种状态一次问全(modified / added-staged / deleted / renamed / untracked /
 *      binary),每行的 `status / staged / unstaged / add / del / binary / oldPath`
 *      与 `stat` 合计;
 *   ② `diff` 对 modified 的文本含 `@@`、对 untracked 含 `+++ b/`、对 binary 是
 *      `binary: true` 且文本为空;
 *   ③ 子目录地址 rev-parse 到根;
 *   ④ **根也过一遍读根**(反证①)—— 判出来的是一段**范围**,不是整仓;
 *   ⑤ 非仓库目录 `{ repo: false }`,**不是错**(反证②:改成抛,这一条红);
 *   ⑥ 越界 / 敏感 / 没有沙箱三关照拒(共用 `path-guard` 那只错);
 *   ⑦ `PATH=''` → `GitUnavailableError`(与「git 说了不」分得开);
 *   ⑧ 2 MiB 的文件 → `truncated: true`,而且**截在一个完整的行上**;
 *   ⑨ `diff` 那一格 `path` 的形状:绝对路径 / `..` / 空 一律 TypeError;
 *   ⑩ 零做法:任何 op 抛 TypeError;守卫对 `git` 与对 `dir` 同一条;spec 过契约门;
 *   ⑪ **`diff` 的目标文件自己也过三关** —— `{path:'.env'}` 拒 `sensitive`(反证④);
 *      仓内指向沙箱外的符号链接照实记(判据是词法的,见那一例);
 *   ⑫ 未跟踪的**新目录**拆成一行一个文件(`-uall`,反证⑤);
 *   ⑬ 6 MiB 的单文件改动 → `truncated` 且**不抛**(流式截断,反证⑥);
 *   ⑭ 用户 gitconfig 里 `diff.noprefix = true` 也改不动这块 diff 的形状(反证⑦);
 *   ⑮ 数未跟踪行数的**预算**花完之后,余下的 `add` 缺席(反证⑧);
 *   ⑯ 未跟踪的敏感文件**连打开都不打开**:`status` 里有它那一行,`add` 缺席,
 *      `diff` 仍拒 —— 「不给看」包括「不打开」(反证⑨);
 *   ⑰ **仓根在读根之外时按地址那一段列**,`scope` 说出是哪一段;范围外的文件
 *      `diff` 仍拒(反证⑩)。
 *
 * **这只测试把 `GIT_CONFIG_GLOBAL` 指向 `/dev/null`**:provider 跑 git 时铺的是
 * `process.env`,而跑测试这台机器上的全局 gitconfig(`diff.noprefix`、
 * `status.renames`、一把 alias)会改掉输出的形状。要么让测试跟着每台机器变,要么
 * 把那一格钉住 —— 钉住的那一份才是在量这只 provider。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PlanContext, RunContext, SandboxPolicy } from '@onething/core/toolkit'
import { assertResourceSpec } from '@onething/core/resource'
import type { ResourceReadContext } from '@onething/core/resource'
import { ResourceEventHub } from '@onething/core/resource'
import { isCorePathContained, resolveCoreToolPath } from '@onething/runtime/tools/sandbox'
import { classifySensitiveFile } from '@onething/runtime/tools/sensitive-files'
import { gitResourceSpec } from '@onething/runtime/files/git-resource-spec'
import {
  createUntrackedLineCounter,
  GitOperationFailedError,
  GitResourceProvider,
  GitUnavailableError,
} from '../git-provider.js'
import { DirOutsideSandboxError } from '../path-guard.js'
import { createLocalOnlyReadGuard } from '../read-guard.js'

let root: string
let repo: string
let plain: string
let bigRepo: string
let dirRepo: string
let budgetDir: string
let scopeRepo: string

const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL
const previousSystemConfig = process.env.GIT_CONFIG_SYSTEM

/** 建仓那几步自己也要与这台机器的 gitconfig 无关(见文件头)。 */
function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
    stdio: 'pipe',
  })
}

/** PNG 的前十六个字节 —— 真的二进制,不是「一个叫 .png 的文本文件」。 */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_SYSTEM = '/dev/null'

  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onething-git-resource-')))
  repo = path.join(root, 'repo')
  plain = path.join(root, 'plain')
  bigRepo = path.join(root, 'big')
  dirRepo = path.join(root, 'dirs')
  budgetDir = path.join(root, 'budget')
  scopeRepo = path.join(root, 'scoped')

  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  fs.mkdirSync(plain, { recursive: true })
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n')

  // ── 一次提交,六种状态 ───────────────────────────────────────────────────
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'one\ntwo\nthree\n')
  fs.writeFileSync(path.join(repo, 'deleted.txt'), 'a\nb\nc\n')
  fs.writeFileSync(path.join(repo, 'old.txt'), 'same\n')
  fs.writeFileSync(path.join(repo, 'logo.png'), PNG_BYTES)
  git(repo, ['-c', 'init.defaultBranch=main', 'init', '-q', '.'])
  git(repo, ['add', 'src/a.txt', 'deleted.txt', 'old.txt', 'logo.png'])
  git(repo, ['commit', '-qm', 'first'])

  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'one\nTWO\nthree\nfour\n')  // modified: +2 −1
  fs.writeFileSync(path.join(repo, 'added.txt'), 'x\ny\n')                      // added(staged): +2
  git(repo, ['add', 'added.txt'])
  fs.rmSync(path.join(repo, 'deleted.txt'))                                     // deleted: −3
  git(repo, ['mv', 'old.txt', 'new.txt'])                                       // renamed: 0/0
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'u1\nu2\nu3\n')            // untracked: +3
  fs.writeFileSync(path.join(repo, 'logo.png'), Buffer.concat([PNG_BYTES, PNG_BYTES]))  // binary

  // ── 截断那一条自己一棵树:2 MiB 的一个文件会把上面那六行的读数搅乱 ────────
  fs.mkdirSync(bigRepo, { recursive: true })
  git(bigRepo, ['-c', 'init.defaultBranch=main', 'init', '-q', '.'])
  fs.writeFileSync(path.join(bigRepo, 'seed.txt'), 'seed\n')
  git(bigRepo, ['add', 'seed.txt'])
  git(bigRepo, ['commit', '-qm', 'first'])
  fs.writeFileSync(path.join(bigRepo, 'huge.txt'), `${'x'.repeat(63)}\n`.repeat(32_768))
  // ⑬:6 MiB —— 旧的 4 MiB `maxBuffer` 会在这里抛,流式截断不会。
  fs.writeFileSync(path.join(bigRepo, 'giant.txt'), `${'y'.repeat(63)}\n`.repeat(98_304))
  // ⑪b:一条指向**沙箱外**的符号链接,住在这棵没有 status 断言的树上。
  fs.mkdirSync(path.join(root, 'outside-secret'), { recursive: true })
  fs.writeFileSync(path.join(root, 'outside-secret', 'creds.txt'), 'TOPSECRET\n')
  fs.symlinkSync(path.join(root, 'outside-secret', 'creds.txt'), path.join(bigRepo, 'link.txt'))

  // ── 未跟踪的新目录(`-uall`)+ 一条指向沙箱外的符号链接 ──────────────────
  fs.mkdirSync(path.join(dirRepo, 'newdir'), { recursive: true })
  git(dirRepo, ['-c', 'init.defaultBranch=main', 'init', '-q', '.'])
  fs.writeFileSync(path.join(dirRepo, 'seed.txt'), 'seed\n')
  git(dirRepo, ['add', 'seed.txt'])
  git(dirRepo, ['commit', '-qm', 'first'])
  fs.writeFileSync(path.join(dirRepo, 'newdir', 'a.ts'), 'a1\n')
  fs.writeFileSync(path.join(dirRepo, 'newdir', 'b.ts'), 'b1\nb2\n')

  // ⑰:一棵仓,根与子目录各有一处改动 —— 沙箱只给子目录。
  fs.mkdirSync(path.join(scopeRepo, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(scopeRepo, 'a.txt'), 'a1\n')
  fs.writeFileSync(path.join(scopeRepo, 'sub', 'b.txt'), 'b1\n')
  git(scopeRepo, ['-c', 'init.defaultBranch=main', 'init', '-q', '.'])
  git(scopeRepo, ['add', '-A'])
  git(scopeRepo, ['commit', '-qm', 'first'])
  fs.writeFileSync(path.join(scopeRepo, 'a.txt'), 'a1\na2\n')
  fs.writeFileSync(path.join(scopeRepo, 'sub', 'b.txt'), 'b1\nb2\n')

  // ⑮:三只 1 MiB 的未跟踪文件,配一本小预算。
  fs.mkdirSync(budgetDir, { recursive: true })
  for (const name of ['one.txt', 'two.txt', 'three.txt']) {
    fs.writeFileSync(path.join(budgetDir, name), `${'z'.repeat(1023)}\n`.repeat(1024))
  }
})

afterAll(() => {
  if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig
  if (previousSystemConfig === undefined) delete process.env.GIT_CONFIG_SYSTEM
  else process.env.GIT_CONFIG_SYSTEM = previousSystemConfig
  fs.rmSync(root, { recursive: true, force: true })
})

/** 沙箱:**产品层那三只函数**,只把根换成临时目录(与 `dir-provider.test.ts` 逐字同形)。 */
function sandboxAt(boundary: string, readRoots: readonly string[] = []): SandboxPolicy {
  const inside = (rootPath: string, target: string) => isCorePathContained(rootPath, target)
  return {
    root: () => boundary,
    resolve: target => resolveCoreToolPath(target, { workingDirectory: boundary }),
    contains: target => inside(boundary, target),
    readable: target => inside(boundary, target) || readRoots.some(rootPath => inside(rootPath, target)),
    isSensitive: target => classifySensitiveFile(target).sensitive,
  }
}

function readContext(sandbox?: SandboxPolicy): ResourceReadContext {
  return {
    principal: { kind: 'user', userId: 'local' },
    sessionId: 'test-session',
    signal: new AbortController().signal,
    ...(sandbox ? { sandbox } : {}),
    now: () => 1_700_000_000_000,
  }
}

interface StatusView {
  repo: boolean
  root?: string
  scope?: string
  branch?: string
  head?: string
  files?: Array<{
    path: string
    status: string
    staged: boolean
    unstaged: boolean
    add?: number
    del?: number
    binary?: boolean
    oldPath?: string
  }>
  stat?: { add: number; del: number; files: number }
}

interface DiffView {
  path: string
  text: string
  binary: boolean
  truncated: boolean
}

describe('git provider(「改动」面)', () => {
  const provider = new GitResourceProvider()

  const status = async (target: string, sandbox: SandboxPolicy = sandboxAt(root)): Promise<StatusView> =>
    (await provider.read('status', { scheme: 'git', path: target }, {}, readContext(sandbox))) as StatusView

  const diff = async (target: string, filePath: string): Promise<DiffView> =>
    (await provider.read(
      'diff',
      { scheme: 'git', path: target },
      { path: filePath },
      readContext(sandboxAt(root)),
    )) as DiffView

  it('① 六种状态一次问全,每行的读数与 stat 合计都对得上', async () => {
    const view = await status(repo)

    expect(view.repo).toBe(true)
    expect(view.root).toBe(repo)
    // 根在读根之内 → 整仓,范围是空串(而不是缺席,见⑰)。
    expect(view.scope).toBe('')
    expect(view.branch).toBe('main')
    expect(view.head).toHaveLength(7)

    const byPath = new Map((view.files ?? []).map(file => [file.path, file]))
    /*
     * `.env` 在里面,而这是**照实记**的一格:沙箱那三关判的是**地址**(问到 `.env`
     * 头上会被拒,见⑥),不是这张表里的每一行 —— 一个改过的 `.env` 本来就是这个人
     * 自己工作树里的一处改动,`dir` 的 `list` 也照样列得出它(那只测试的① 断言里就
     * 有)。要让它不出现,得是一条关于「改动面要不要替用户藏东西」的裁定,不是这只
     * provider 偷偷加一句 filter —— 藏掉之后 `stat` 的合计会与 `git` 自己说的对不上。
     */
    expect([...byPath.keys()].sort()).toEqual([
      '.env',
      'added.txt',
      'deleted.txt',
      'logo.png',
      'new.txt',
      'src/a.txt',
      'untracked.txt',
    ])

    // 改过的:工作树那一侧变了,索引那一侧没有。
    expect(byPath.get('src/a.txt')).toMatchObject({
      status: 'modified', staged: false, unstaged: true, add: 2, del: 1,
    })
    // 新增并**暂存**:索引那一侧变了。
    expect(byPath.get('added.txt')).toMatchObject({
      status: 'added', staged: true, unstaged: false, add: 2, del: 0,
    })
    expect(byPath.get('deleted.txt')).toMatchObject({
      status: 'deleted', staged: false, unstaged: true, add: 0, del: 3,
    })
    // 重命名带来源。`-z` 下它跨两条记录 —— 这一格就是在钉那件事。
    expect(byPath.get('new.txt')).toMatchObject({
      status: 'renamed', staged: true, unstaged: false, oldPath: 'old.txt', add: 0, del: 0,
    })
    // untracked 的行数 git 不数,provider 自己读文件数出来的。
    expect(byPath.get('untracked.txt')).toMatchObject({
      status: 'untracked', staged: false, unstaged: true, add: 3, del: 0,
    })
    // 二进制:两格行数**缺席**,不是零。
    expect(byPath.get('logo.png')).toMatchObject({ status: 'modified', binary: true })
    expect(byPath.get('logo.png')?.add).toBeUndefined()
    expect(byPath.get('logo.png')?.del).toBeUndefined()

    // `.env` 有行,但它**不贡献行数** —— 计数器不打开敏感文件(见⑯)。
    expect(view.stat).toEqual({ add: 7, del: 4, files: 7 })
  })

  it('② diff:modified 含 @@,untracked 含 +++ b/,binary 是一格状态不是一块文本', async () => {
    const modified = await diff(repo, 'src/a.txt')
    expect(modified.text).toContain('@@')
    expect(modified.text).toContain('+four')
    expect(modified.binary).toBe(false)
    expect(modified.truncated).toBe(false)

    // **反证③ 的那一条**:untracked 走 `--no-index`,退出码 1 是成功。改成 `diff HEAD`
    // 这一条当场红(git 对一个它还不认识的文件什么都不印)。
    const untracked = await diff(repo, 'untracked.txt')
    expect(untracked.text).toContain('+++ b/untracked.txt')
    expect(untracked.text).toContain('+u1')

    // 已经暂存的新增走的是 `diff HEAD`(它在索引里),照样有 diff。
    expect((await diff(repo, 'added.txt')).text).toContain('+x')
    // 删掉的那个盘上已经没有了,答案在 HEAD 与索引之间。
    expect((await diff(repo, 'deleted.txt')).text).toContain('-a')

    const binary = await diff(repo, 'logo.png')
    expect(binary).toEqual({ path: 'logo.png', text: '', binary: true, truncated: false })
  })

  it('③ 子目录地址 rev-parse 到根 —— 提问的人不必先知道根在哪', async () => {
    const view = await status(path.join(repo, 'src'))
    expect(view.root).toBe(repo)
    expect(view.files?.length).toBe(7)

    // 文件地址也行:`cwd` 取它的父目录。
    expect((await status(path.join(repo, 'src', 'a.txt'))).root).toBe(repo)
  })

  it('④ 根也过一遍读根 —— 判出来的是**范围**,不是整仓(反证①)', async () => {
    // 读根只到 `repo/src` —— 真装配里这正是「用户接了一个子目录进来」的形状。
    const sandbox = sandboxAt(path.join(repo, 'src'))
    expect(sandbox.readable(path.join(repo, 'src'))).toBe(true)
    expect(sandbox.readable(repo)).toBe(false)

    const view = await status(path.join(repo, 'src'), sandbox)
    /*
     * 整仓有 7 行(①),这里只剩 1 行 —— 那 1 与 7 的差就是「根被判过」的读数。
     * 根不判的话这条读法会把整个上级仓库的改动交出去,而接入 `repo/src` 的人
     * 没有同意过那件事。
     */
    expect(view.scope).toBe('src')
    expect((view.files ?? []).map(file => file.path)).toEqual(['src/a.txt'])
    expect(view.root).toBe(repo)
  })

  it('⑤ 不是仓库不是错,是 { repo: false }(反证②)', async () => {
    expect(await status(plain)).toEqual({ repo: false })

    // 而同一个目录上问 `diff` 是**抛** —— 那句话的参照系不存在。
    await expect(provider.read('diff', { scheme: 'git', path: plain }, { path: 'x.txt' }, readContext(sandboxAt(root))))
      .rejects.toThrowError(GitOperationFailedError)
  })

  it('⑥ 三关照拒:越界 / 敏感 / 没有沙箱,共用 path-guard 那只错', async () => {
    await expect(status(root, sandboxAt(path.join(repo, 'src'))))
      .rejects.toThrowError(DirOutsideSandboxError)

    await expect(status(path.join(repo, '.env')))
      .rejects.toMatchObject({ name: 'DirOutsideSandboxError', reason: 'sensitive' })

    await expect(provider.read('status', { scheme: 'git', path: repo }, {}, readContext()))
      .rejects.toMatchObject({ name: 'DirOutsideSandboxError', reason: 'no-sandbox' })

    // 地址缺席那一句。
    await expect(provider.read('status', null, {}, readContext(sandboxAt(root))))
      .rejects.toMatchObject({ name: 'GitRefRequiredError' })

    // 路径整个不在:说「没有这条路径」,而不是与「这台机器上没有 git」共用一句话。
    await expect(status(path.join(root, 'nowhere')))
      .rejects.toThrowError(GitOperationFailedError)
  })

  it('⑦ PATH 里没有 git → GitUnavailableError,与「git 说了不」分得开', async () => {
    const previousPath = process.env.PATH
    process.env.PATH = ''
    try {
      await expect(status(repo)).rejects.toThrowError(GitUnavailableError)
    } finally {
      process.env.PATH = previousPath
    }
  })

  it('⑧ 2 MiB 的文件:truncated,而且截在一个完整的行上', async () => {
    const view = (await provider.read(
      'diff',
      { scheme: 'git', path: bigRepo },
      { path: 'huge.txt' },
      readContext(sandboxAt(root)),
    )) as DiffView

    expect(view.truncated).toBe(true)
    expect(view.binary).toBe(false)
    expect(Buffer.byteLength(view.text, 'utf8')).toBeLessThanOrEqual(1024 * 1024)
    // 最后一行是完整的 —— 半行 diff 喂给解析器画出来的是一张骗人的卡。
    expect(view.text.endsWith('\n')).toBe(true)
    expect(view.text).toContain(`+${'x'.repeat(63)}`)
  })

  it('⑨ diff 那一格 path 的形状:绝对 / .. / 空 一律拒', async () => {
    for (const bad of ['', path.join(repo, 'src', 'a.txt'), '../outside.txt', 'src/../../x', '~/x']) {
      await expect(provider.read('diff', { scheme: 'git', path: repo }, { path: bad }, readContext(sandboxAt(root))))
        .rejects.toThrowError(TypeError)
    }
  })

  it('⑪ diff 的目标文件自己也过三关:.env 拒 sensitive(反证④)', async () => {
    // `status` 照旧把 `.env` 列出来(那是 git 的真话,见①),而**把它的原文交出来**
    // 是另一件事 —— 同一个文件经 `read` 工具是拒的。
    await expect(diff(repo, '.env'))
      .rejects.toMatchObject({ name: 'DirOutsideSandboxError', reason: 'sensitive' })

    // 前提:这一条读得到别的文件,所以上面拒的不是「整个仓都读不了」。
    expect((await diff(repo, 'src/a.txt')).text).toContain('@@')
  })

  it('⑪b 仓内指向沙箱外的符号链接:判据是**词法**的,拒不出来 —— 而 git 自己不跟随它', async () => {
    // 链接住在 `bigRepo`(那棵树上没有任何 `status` 断言),所以这一例不会把
    // 别的用例的文件表搅乱 —— 用例之间不许靠「谁先跑」说话。
    const secret = path.join(root, 'outside-secret', 'creds.txt')

    // 沙箱根收到 `bigRepo` —— 链接指向的地方在界外。
    const sandbox = sandboxAt(bigRepo)
    expect(sandbox.readable(secret)).toBe(false)
    /*
     * 而这一条**读得过**:`resolveCoreToolPath` / `isCorePathContained` 是**词法**判据
     * (`path.resolve`,不走 `realpath`),所以 `bigRepo/link.txt` 在界内。这不是这只
     * provider 的一格判断 —— `read` 工具与 `dir` 资源判的是同一只函数、同一个答案,
     * 补它要改产品层那两只共用函数(留账)。
     */
    const view = (await provider.read(
      'diff',
      { scheme: 'git', path: bigRepo },
      { path: 'link.txt' },
      readContext(sandbox),
    )) as DiffView

    /*
     * **界外那个文件的内容没有出来**,而挡住它的是 git 不是沙箱:git 把符号链接当
     * 链接(mode 120000),diff 的正文是**链接指向的那条路径**,不是它指的那份内容。
     * 这一格照实记:今天的实际保护来自这一条,而不是来自三关。
     */
    expect(view.text).toContain('mode 120000')
    expect(view.text).toContain(`+${secret}`)
    expect(view.text).not.toContain('TOPSECRET')
  })

  it('⑫ 未跟踪的新目录拆成一行一个文件(-uall,反证⑤)', async () => {
    const view = await status(dirRepo, sandboxAt(root))
    const byPath = new Map((view.files ?? []).map(file => [file.path, file]))

    // 缺省的 `-unormal` 在这里只会给一行 `newdir/`,而那一行数不出行数、点开就失败。
    expect([...byPath.keys()].sort()).toEqual(['newdir/a.ts', 'newdir/b.ts'])
    expect(byPath.get('newdir/a.ts')).toMatchObject({ status: 'untracked', add: 1, del: 0 })
    expect(byPath.get('newdir/b.ts')).toMatchObject({ status: 'untracked', add: 2, del: 0 })
    expect(view.stat).toEqual({ add: 3, del: 0, files: 2 })

    // 而且点得开 —— 这正是 `-uall` 要保住的那一步。
    expect((await diff(dirRepo, 'newdir/b.ts')).text).toContain('+b2')
  })

  it('⑬ 6 MiB 的单文件改动:流式截断,不抛(反证⑥)', async () => {
    const view = (await provider.read(
      'diff',
      { scheme: 'git', path: bigRepo },
      { path: 'giant.txt' },
      readContext(sandboxAt(root)),
    )) as DiffView

    expect(view.truncated).toBe(true)
    expect(view.binary).toBe(false)
    expect(Buffer.byteLength(view.text, 'utf8')).toBeLessThanOrEqual(1024 * 1024)
    expect(view.text.endsWith('\n')).toBe(true)
  })

  it('⑭ 用户 gitconfig 里 diff.noprefix = true,这块 diff 的形状一个字不变(反证⑦)', async () => {
    const config = path.join(root, 'hostile.gitconfig')
    // `external = /bin/echo` 是这份配置里最凶的一格:它让 git 把整块 diff 交给一个
    // 外部程序生成。`-c diff.external=` 关不掉它(git 会去 exec 那个空串),
    // `--no-ext-diff` 才关得掉 —— 见 `GIT_DIFF_ARGS` 上那段。
    fs.writeFileSync(
      config,
      '[diff]\n\texternal = /bin/echo\n\tnoprefix = true\n\tmnemonicPrefix = true\n[color]\n\tui = always\n',
    )
    const previous = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = config
    try {
      // 先证这份配置真的会咬人:同一台 git、同一个仓,手敲那条命令印出来的是 `+++ src/a.txt`。
      const bare = execFileSync('git', ['diff', 'HEAD', '--', 'src/a.txt'], {
        cwd: repo,
        env: { ...process.env, GIT_CONFIG_SYSTEM: '/dev/null' },
        encoding: 'utf8',
      })
      // 那份配置真的会咬人:外部驱动接管之后印出来的连 diff 都不是。
      expect(bare).not.toContain('+++ b/src/a.txt')
      expect(bare).not.toContain('@@')

      // 而这条读法钉住了那四格。
      const view = await diff(repo, 'src/a.txt')
      expect(view.text).toContain('+++ b/src/a.txt')
      // `color.ui = always` 也进不来:文本里没有 ANSI 转义。
      expect(view.text).not.toContain('\u001b[')
    } finally {
      process.env.GIT_CONFIG_GLOBAL = previous
    }
  })

  it('⑮ 数未跟踪行数的预算花完之后,余下的 add 缺席(反证⑧)', async () => {
    // 预算 1.5 MiB,三只 1 MiB 的文件:第一只数得出,第二只把账花超(它是在花超**之前**
    // 开始数的,所以它也数得出),第三只一个字节都不读。
    const count = createUntrackedLineCounter(() => false, 1536 * 1024)
    const one = await count(path.join(budgetDir, 'one.txt'))
    const two = await count(path.join(budgetDir, 'two.txt'))
    const three = await count(path.join(budgetDir, 'three.txt'))

    expect(one).toEqual({ add: 1024, del: 0 })
    expect(two).toEqual({ add: 1024, del: 0 })
    // 缺席,不是零 ——「这个数没算」与「这个文件没改动」不是同一件事。
    expect(three).toEqual({})
    expect(three.add).toBeUndefined()

    // 缺省预算下三只都数得出 —— 上面那条拒的是预算,不是这几个文件。
    const roomy = createUntrackedLineCounter(() => false)
    expect(await roomy(path.join(budgetDir, 'three.txt'))).toEqual({ add: 1024, del: 0 })
  })

  it('⑯ 未跟踪的敏感文件:有那一行,但 add 缺席,而且 diff 仍拒(反证⑨)', async () => {
    const view = await status(repo)
    const secret = (view.files ?? []).find(file => file.path === '.env')

    /*
     * **它在表里**:`status` 说的是 git 的真话,一个改过的 `.env` 就是这个人工作树里
     * 的一处改动,藏掉它会让 `stat` 的合计与 git 自己说的对不上(①那条判词)。
     */
    expect(secret).toMatchObject({ status: 'untracked', staged: false, unstaged: true })
    /*
     * **而那个数字没有** —— 拿到它得先把这份凭证整个读进内存,那正是「不给看」要拦的
     * 事。缺席不是零:零会被读成「这个文件是空的」。
     */
    expect(secret?.add).toBeUndefined()
    expect(secret?.del).toBeUndefined()
    // 同一条判词的另一半:内容更不给。
    await expect(diff(repo, '.env'))
      .rejects.toMatchObject({ name: 'DirOutsideSandboxError', reason: 'sensitive' })

    // 前提:同一张表里不敏感的未跟踪文件照样数得出 —— 上面缺席的不是「未跟踪都不数」。
    const plain = (view.files ?? []).find(file => file.path === 'untracked.txt')
    expect(plain?.add).toBe(3)
  })

  it('⑰ 仓根在读根之外:按地址那一段列并说出 scope,范围外的文件仍拒(反证⑩)', async () => {
    // 读根只到 `scoped/sub` —— 真装配里这正是「会话绑的工作目录是仓的一个子目录」。
    const sub = path.join(scopeRepo, 'sub')
    const sandbox = sandboxAt(sub)
    expect(sandbox.readable(sub)).toBe(true)
    expect(sandbox.readable(scopeRepo)).toBe(false)

    const view = await status(sub, sandbox)

    // **不是整条拒**:他对这一段的改动是有权看的。
    expect(view.repo).toBe(true)
    // 根照旧是真正的仓根 —— 每一行的 path 都是根相对的,少了它对不回盘上的文件。
    expect(view.root).toBe(scopeRepo)
    expect(view.scope).toBe('sub')
    expect((view.files ?? []).map(file => file.path)).toEqual(['sub/b.txt'])
    expect(view.files?.[0]).toMatchObject({ status: 'modified', add: 1, del: 0 })
    expect(view.stat).toEqual({ add: 1, del: 0, files: 1 })

    // 范围外那个文件 `status` 没列,`diff` 也读不到(第三关拦的)。
    await expect(provider.read('diff', { scheme: 'git', path: sub }, { path: 'a.txt' }, readContext(sandbox)))
      .rejects.toMatchObject({ name: 'DirOutsideSandboxError', reason: 'outside' })
    // 而范围内那个读得到 —— 上面拒的不是「这个仓一块 diff 都读不出来」。
    const inside = (await provider.read(
      'diff',
      { scheme: 'git', path: sub },
      { path: 'sub/b.txt' },
      readContext(sandbox),
    )) as DiffView
    expect(inside.text).toContain('+b2')
  })

  it('⑩ 零做法:任何 op 抛;认不出的读法抛;attach 收着不发', async () => {
    await expect(provider.plan('stage', { scheme: 'git', path: repo }, {}, {} as PlanContext))
      .rejects.toThrowError(TypeError)
    await expect(provider.apply('stage', {} as never, {} as RunContext))
      .rejects.toThrowError(TypeError)
    await expect(provider.read('log', { scheme: 'git', path: repo }, {}, readContext(sandboxAt(root))))
      .rejects.toThrowError(TypeError)

    // 总线收下了,但这一 scheme 今天一条事件都不发(没有 watch,发不出真话)。
    const hub = new ResourceEventHub()
    const seen: unknown[] = []
    hub.watch('git:', fact => seen.push(fact))
    provider.attach(hub)
    await status(repo)
    expect(seen).toEqual([])
  })
})

describe('git 的自述与守卫', () => {
  it('spec 过契约门,而且零做法零事件', () => {
    expect(() => { assertResourceSpec(gitResourceSpec) }).not.toThrow()
    expect(Object.keys(gitResourceSpec.ops)).toEqual([])
    expect(Object.keys(gitResourceSpec.events)).toEqual([])
    expect(Object.keys(gitResourceSpec.reads).sort()).toEqual(['diff', 'status'])
  })

  it('读守卫对 git 与对 dir 同一条:本机可信放行,不可信拒', async () => {
    const ref = { scheme: 'git', path: '/tmp/project' }
    const principal = { kind: 'user', userId: 'local' } as const

    const trusted = createLocalOnlyReadGuard({ schemes: ['dir', 'git'], isTrusted: () => true })
    expect(await trusted.decide(ref, 'status', principal)).toEqual({ kind: 'allow' })

    const untrusted = createLocalOnlyReadGuard({ schemes: ['dir', 'git'], isTrusted: () => false })
    const verdict = await untrusted.decide(ref, 'status', principal)
    expect(verdict.kind).toBe('deny')
    expect(verdict.kind === 'deny' && verdict.reason).toContain('local-only')
  })
})
