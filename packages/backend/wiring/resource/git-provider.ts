/**
 * 「改动」面 —— git 工作树这一 scheme 的实现
 * (`apps/desktop-react/docs/changes-panel-2026-09.md` §2.2)。
 *
 * 自述在产品层(`@onething/runtime/files/git-resource-spec`),实现在这里 —— 与目录
 * 那一对同一个形状、同一条理由:只有装配层够得着脊柱(这里够的是沙箱端口)。
 *
 * ── 沙箱:与目录资源同一把尺子、同一序 ──────────────────────────────────────
 * `./path-guard.ts` 的 `resolveReadable` —— 那只文件是「改动」面这一单从
 * `dir-provider.ts` 里**搬**出来的,不是复制的一份。于是模型经 `read` 工具读一个
 * 路径、经 `dir` 列它的父目录、经 `git` 问它改了什么,判的是同一条边界。
 *
 * **根也要过一遍读根**,这是这只文件里唯一一句目录资源没有的判词:地址判的是
 * 「地址那个目录」,而 `rev-parse --show-toplevel` 出来的根可能在它上面很多层 ——
 * 一个被接入的子目录若不再判一次,就会把整个上级仓库的改动交出去(接入 `~/x/docs`
 * 的人没有同意把 `~/x` 的改动也交出来)。
 *
 * ── 零做法,所以 `plan` / `apply` 只有一句话 ────────────────────────────────
 * 自述里 `ops: {}`(理由写在自述的文件头:写面的效果类今天还不存在)。两只方法因此
 * 只剩那句 `default` —— 与 `dir-provider` 的 default 分支**逐字同一句话**:走不到,
 * 因为两条路都先查过名字在不在自述里;留一句诚实的错,而不是回 `undefined` 让调用方
 * 去猜。
 *
 * ── 沙箱判三次,不是两次 ────────────────────────────────────────────────────
 * `status` 判两处(地址、根),**收一格 `path` 的那两条**(`diff` / `file`)判**三处**:
 * 地址、根、以及 `path.join(root, path)` 那个**目标文件自己**。第三处不是多余的 ——
 * 少了它,`git:<仓库>` + `{path:'.env'}` 会把一份凭证文件的原文交出去,而同一个文件经
 * `read` 工具是拒的(敏感文件那一关)。「地址在界内」不蕴含「这个地址里的每一个文件都
 * 该被读出来」。`file` 交的是**原文**而不是一块 diff,所以这一关在它身上只会更要紧,
 * 判据却一个字都不用改 —— 两条读法调的是同一句 `resolveReadable`,同一个序:
 * **判在 git 跑起来之前**,一次被拒的读不该先把凭证读进这个进程的内存。
 *
 * 而**根过不了读根时不是整条拒**:会话绑的工作目录常常是仓库的一个子目录,那时
 * `status` 按地址那一段列并把范围说出来(`scope`)——判词写在 `readableRepoScope`
 * 上。`diff` / `file` 不必跟着改:它们的第三关已经把范围外的文件拒掉了。
 *
 * ── 跑 git 的五条公共纪律 ───────────────────────────────────────────────────
 * · `spawn` 不过 shell —— 路径里的空格、引号、`$` 不需要任何人转义;
 * · `-c core.quotepath=false` —— 中文文件名原样出来,不是 `\344\270\255`;
 * · **三格钉死的 gitconfig**(`diff.noprefix=false` / `diff.mnemonicPrefix=false` /
 *   `color.ui=never`)加 `diff` 自己那格 `--no-ext-diff`(为什么它不是第四格 `-c`,
 *   写在 `GIT_DIFF_ARGS` 上)—— 这几格用户都可能在自己的
 *   `~/.gitconfig` 里改过,而改过之后这只 provider 交出去的 diff 就不是解析器认得的
 *   那一种了(没有 `a/` `b/` 前缀、前缀变成 `i/` `w/`、整块 diff 由一个外部程序生成、
 *   文本里夹着 ANSI 转义)。**判据是「这块文本有人要拿去解析」**:一个人手敲的
 *   `git diff` 是给他自己看的,他改的那几格服务的是他的眼睛;这一条读法的读者是
 *   `parseUnifiedDiff` 与模型,它们要的是同一种形状;
 * · `--no-optional-locks` + `GIT_OPTIONAL_LOCKS=0` —— **读一次状态不许写盘**:
 *   `git status` 默认会顺手刷新索引(那是一次写),而一个面板每次刷新都动一下用户的
 *   `.git/index` 是它没有被授权做的事,还会和用户自己手里的 git 抢锁;
 * · `LC_ALL=C` —— 底下那层的话是拿来给人看的,但「不是仓库」这类判据要读它,
 *   而一句被本地化过的 stderr 是判不了的。
 *
 * ── 输出是**流式截断**的,不是「装得下就装、装不下就炸」 ────────────────────
 * 子进程的 stdout 边收边数,到上限就停止累计并 `kill()`(`overflow`)。所以一块
 * 300 MB 的 diff 既不会进内存,也不会变成一句 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`
 * ——**只有 `diff` 那条读法允许 overflow**(它的契约里本来就有 `truncated`),
 * `status` / `ls-files` / `rev-parse` 超限仍是失败:它们的输出是元数据,超限说明
 * 发生了这只 provider 没设想过的事,悄悄截一半元数据比报错危险得多。
 *
 * ── 三只具名错,和一个**不是**错的答案 ──────────────────────────────────────
 * `GitUnavailableError`(这台机器上没有 git)/ `GitOperationFailedError`(非零退出,
 * stderr 原话)/ `GitRefRequiredError`(地址缺席)。而**「不是仓库」不是错**,是
 * `{ repo: false }` —— 面板与模型都要拿它当一种状态(自述文件头那一段)。
 *
 * ── `attach` 收着不发 ───────────────────────────────────────────────────────
 * 自述里 `events: {}`:今天没有 fs watch,发不出真话。总线照收(provider 的寿命就是
 * 它的寿命),等真有一只监视器的那一天,发事件这一侧不必再改接线。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  GIT_DIFF_MAX_BYTES,
  GIT_FILE_MAX_BYTES,
  GIT_UNTRACKED_COUNT_BUDGET_BYTES,
  gitResourceSpec,
} from '@onething/runtime/files/git-resource-spec'
import type {
  ResourceEventHub,
  ResourceProvider,
  ResourceReadContext,
  ResourceRef,
} from '@onething/core/resource'
import type { Intent, PlanContext, Result, RunContext } from '@onething/core/toolkit'
import { getLogger } from '../logging/index.js'
import { DirOutsideSandboxError, resolveReadable } from './path-guard.js'

const log = getLogger('resource.git')

/** 这台机器上没有 git(`spawn` 答 ENOENT)。 */
export class GitUnavailableError extends Error {
  constructor(cause?: string) {
    super(`git is not available on this machine${cause ? `: ${cause}` : ''}`)
    this.name = 'GitUnavailableError'
  }
}

/**
 * git 说不。**stderr 原话带出来** —— 底下那层的措辞比这里能编的任何一句都准确,
 * 而一句被改写过的错误信息是搜不到的。
 */
export class GitOperationFailedError extends Error {
  readonly code: number
  readonly stderr: string

  constructor(args: readonly string[], code: number, stderr: string) {
    const detail = stderr.trim().split('\n')[0] ?? ''
    super(`git ${args.join(' ')} exited ${code}${detail ? `: ${detail}` : ''}`)
    this.name = 'GitOperationFailedError'
    this.code = code
    this.stderr = stderr
  }
}

/** 地址缺席时的那句话。两条读法都作用在**一个**工作树上。 */
export class GitRefRequiredError extends Error {
  constructor(member: string) {
    super(`${member} needs a working-tree address, e.g. "git:/Users/you/project"`)
    this.name = 'GitRefRequiredError'
  }
}

/** 一行改动。形状逐格对着自述的 `CHANGED_FILE_SCHEMA`。 */
export interface GitChangedFile {
  readonly path: string
  readonly status: GitFileStatus
  readonly staged: boolean
  readonly unstaged: boolean
  readonly add?: number
  readonly del?: number
  readonly binary?: boolean
  readonly oldPath?: string
}

/**
 * `file` 那条读法里**一个版本**的原文。形状逐格对着自述的 `FILE_TEXT_SCHEMA`。
 *
 * `bytes` 是**原始大小**,不是 `text` 的长度:截断过的那一版里两个数差着一个数量级,
 * 而读者要靠它才知道自己手上是个零头(自述那格常量上写着这句)。
 */
export interface GitFileText {
  readonly text: string
  readonly binary: boolean
  readonly truncated: boolean
  readonly bytes: number
}

/**
 * git 说「这一版不在 HEAD 里」的两句话,逐字取自它自己
 * (`path 'x' does not exist in 'HEAD'` / `path 'x' exists on disk, but not in 'HEAD'`)。
 *
 * 为什么认这两句而不是认那个 128:128 是 git 的通用失败码,一个坏掉的仓库、一个
 * 权限不足的 `.git`、一个写错的 revision 全都答 128。把它整个折成 `null` 等于把
 * 每一种失败都说成「这个文件是新增的」—— 于是一个真的故障会安静地变成一屏「整篇
 * 都是新增行」。**认不出的非零退出仍然是 `GitOperationFailedError`**。
 *
 * (`LC_ALL=C` 就是为了这两句读得准 —— 与 `toplevel()` 认「not a git repository」
 * 同一条理由、同一把尺子。)
 */
const PATH_NOT_IN_HEAD = /does not exist in 'HEAD'|exists on disk, but not in 'HEAD'/

export type GitFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'
  | 'typechange'

/** 一次子进程的结局。**非零退出不是异常** —— 有几条读法把它当答案读。 */
interface GitRun {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  /** 输出到上限就停止累计并把子进程杀了。允不允许它,由调用那条读法说了算。 */
  readonly overflow: boolean
}

/** 每一次调用都带的这几格,理由逐条写在文件头「五条公共纪律」。 */
const GIT_COMMON_ARGS = [
  '-c', 'core.quotepath=false',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.mnemonicPrefix=false',
  '-c', 'color.ui=never',
  '--no-optional-locks',
] as const

/**
 * 只有 `diff` 那两条调用带的一格:**关掉外部 diff 驱动**。
 *
 * 它是一个**子命令参数**,不是第四格 `-c`,而这不是风格问题:`-c diff.external=`
 * (把那格配置设成空串)实测**不等于关掉它** —— git 会拿着那个空串去 `exec`,答
 * `error: cannot run : No such file or directory` 然后 `fatal: external diff died`。
 * 一个用户在 `~/.gitconfig` 里配了 `diff.external` 的机器上,那种写法会把这条读法从
 * 「形状可能不对」变成「一条都读不出来」。`--no-ext-diff` 是 git 自己给的那把开关。
 *
 * 留账:`.gitattributes` 的 `textconv` 没关(`--no-textconv`)。它产出的仍是一块正常的
 * 统一 diff(只是内容被转换过),而且那是仓库作者**为了让这些文件读得懂**才配的 ——
 * 关掉它得先有人说「这条读法要的是原始字节」,今天没有人这么要求过。
 */
const GIT_DIFF_ARGS = ['--no-ext-diff'] as const

/**
 * 元数据那几条读法的上限(`status` / `ls-files` / `rev-parse`)。
 *
 * 超了是**失败**,不是截断(文件头最后一段)。16 MiB 对一份 porcelain 表是极宽的
 * ——几十万行改动才到得了 —— 所以摸到它意味着现场不是这只 provider 设想的那种。
 */
const GIT_METADATA_MAX_BYTES = 16 * 1024 * 1024

/** stderr 也要有上限:一个疯掉的子进程不该靠错误信息把内存吃光。 */
const GIT_STDERR_MAX_BYTES = 64 * 1024

/** `status --porcelain=v2` 的 `XY` 两个字母 → 自述那八个取值。 */
const STATUS_LETTERS: Record<string, GitFileStatus> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
  U: 'conflicted',
}

export class GitResourceProvider implements ResourceProvider<never> {
  readonly spec = gitResourceSpec

  private hub: ResourceEventHub | undefined

  /** 收着不发(文件头最后一段)。 */
  attach(hub: ResourceEventHub): void {
    this.hub = hub
  }

  async read(name: string, ref: ResourceRef | null, query: unknown, ctx: ResourceReadContext): Promise<unknown> {
    // ① 地址那个目录过读根;② rev-parse 出根;③ **根也过一遍读根**(文件头)。
    const address = resolveReadable(requireGitPath(ref, name), ctx.sandbox, ctx.sessionId)
    const cwd = await workingDirectoryOf(address)
    const toplevel = await this.toplevel(cwd, ctx)

    switch (name) {
      case 'status': {
        if (toplevel === null) return { repo: false }
        const { root, scope } = readableRepoScope(toplevel, cwd, ctx)
        return this.status(root, scope, ctx)
      }
      case 'diff': {
        /*
         * 不是仓库 → 这里**抛**,而 `status` 答 `{ repo: false }`。不是两套口径:
         * 「这个目录改了什么」对一个非仓库有答案(没改什么,因为它不归 git 管),
         * 而「这个文件相对上一次提交改了什么」没有 —— 那句话的参照系不存在。
         */
        if (toplevel === null) {
          throw new GitOperationFailedError(['rev-parse', '--show-toplevel'], 128, `${cwd}: not a git repository`)
        }
        /*
         * 根**照样判一次**(同一只判官),判不过也照样降级成一段范围 —— 但这条读法
         * 不用那个范围:它交出去的是**一个文件**,而那个文件由第三关说了算
         * (范围外的 `a.txt` 在下一行 `path.join` 之后就会被拒)。这里要根只为两件事:
         * 拼出绝对路径、当子进程的 `cwd`,两件都不把根本身交给任何人。
         */
        const { root } = readableRepoScope(toplevel, cwd, ctx)
        return this.diff(root, relativePathQuery(query, name), ctx)
      }
      case 'file': {
        /*
         * 与 `diff` 逐字同一支(连那句「不是仓库就抛」的理由都一样):「这个文件相对
         * 上一次提交的两个版本」对一个不归 git 管的目录没有答案,而 `status` 的
         * `{ repo: false }` 是一句**关于这个目录**的真话。
         */
        if (toplevel === null) {
          throw new GitOperationFailedError(['rev-parse', '--show-toplevel'], 128, `${cwd}: not a git repository`)
        }
        const { root } = readableRepoScope(toplevel, cwd, ctx)
        return this.file(root, relativePathQuery(query, name), ctx)
      }
      default:
        // 走不到:两条路(`ResourceTool` / `ResourceKernel.read`)都先查过读法名在不在
        // 自述里。留一句诚实的错,而不是回 `undefined` 让调用方去猜。
        return Promise.reject(new TypeError(`Git resource has no read named ${JSON.stringify(name)}`))
    }
  }

  /** 零做法(文件头)。两只方法因此只剩 `dir-provider` 那句 default。 */
  async plan(op: string, _ref: ResourceRef | null, _params: unknown, _ctx: PlanContext): Promise<Intent<never>> {
    throw new TypeError(`Git resource has no op named ${JSON.stringify(op)}`)
  }

  async apply(op: string, _intent: Intent<never>, _ctx: RunContext): Promise<Result> {
    throw new TypeError(`Git resource has no op named ${JSON.stringify(op)}`)
  }

  /** 仓库根,或者 `null` ——「这里不是仓库」是一个答案,不是一次失败。 */
  private async toplevel(cwd: string, ctx: ResourceReadContext): Promise<string | null> {
    const args = ['rev-parse', '--show-toplevel']
    const run = await this.run(args, cwd, ctx)
    if (run.code === 0) return run.stdout.trim()
    // git 对「不在仓库里」答 128 并把那句话写在 stderr 上(`LC_ALL=C` 就是为了这一句
    // 读得准)。别的 128 仍然是失败 —— 判据是那句话,不是那个数字。
    if (/not a git repository/i.test(run.stderr)) return null
    throw this.failed(args, run)
  }

  private async status(root: string, scope: string, ctx: ResourceReadContext): Promise<unknown> {
    // 范围外的行一行都不该进来,所以范围是**交给 git 的 pathspec**,不是拿到全表
    // 之后在这里 filter:后者要先让 git 去遍历那些这个人无权看见的目录,而那份
    // 输出已经进过这个进程的内存了。
    const within = scope ? ['--', scope] : []
    /*
     * `-uall` —— **未跟踪的目录要拆成文件**。缺省的 `-unormal` 把一棵新目录压成
     * 一行 `newdir/`,而那一行是个 dir:数不出行数(stat 到目录直接答缺席),
     * 点开它 `diff --no-index -- /dev/null newdir/` 当场失败。面板要的是「有哪些
     * 文件变了」,而一个目录不是一处改动。
     */
    const porcelain = await this.text(
      ['status', '--porcelain=v2', '-z', '--branch', '-uall', ...within],
      root,
      ctx,
    )
    const parsed = parsePorcelainV2(porcelain)

    /*
     * 行数从 `diff --numstat` 来,而**空仓退回 `--cached`**:一个还没有第一次提交的
     * 仓库里 `HEAD` 不存在,`diff HEAD` 会失败。判据取自刚刚那份 porcelain 的
     * `# branch.oid`(它对空仓答 `(initial)`)—— 同一件事读一次,不再多跑一个
     * `rev-parse` 去问第二遍。
     */
    const numstat = await this.text(
      parsed.head
        ? ['diff', 'HEAD', '--numstat', '-z', ...within]
        : ['diff', '--cached', '--numstat', '-z', ...within],
      root,
      ctx,
    )
    const counts = parseNumstat(numstat)

    /*
     * 数未跟踪文件的那本**预算账是一次读一本**(不是进程级):一次 `status` 的答案
     * 该只由这一次的现场决定,而不是由这个进程之前读过多少东西决定。
     *
     * 判官递的是**沙箱自己那只**,不是再 import 一份 `classifySensitiveFile` ——
     * 三关判「敏感」用的就是它,两只判官是「同一个文件在两处得到两个答案」的标准
     * 形状。`?? true` 那一格:没有沙箱就一律当敏感(缺席不是放行),它在这里其实
     * 走不到 —— `read()` 里的 `resolveReadable` 已经在没有沙箱时抛过了。
     */
    const countUntracked = createUntrackedLineCounter(target => ctx.sandbox?.isSensitive(target) ?? true)

    const files: GitChangedFile[] = []
    for (const entry of parsed.files) {
      // untracked 的行数 git 自己不数(它不在 diff 里),provider 自己读文件数换行。
      const count = entry.status === 'untracked'
        ? await countUntracked(path.join(root, entry.path))
        : counts.get(entry.path) ?? {}
      files.push({ ...entry, ...count })
    }

    return {
      repo: true,
      root,
      // **总是**交出去,空串也交:一个缺席的 `scope` 与 `''` 在读者眼里会是同一件
      // 事,而它们不是 —— 前者是「这份答案没说范围」,后者是「范围是整仓」。
      scope,
      ...(parsed.branch ? { branch: parsed.branch } : {}),
      ...(parsed.head ? { head: parsed.head } : {}),
      files,
      stat: {
        add: files.reduce((sum, file) => sum + (file.add ?? 0), 0),
        del: files.reduce((sum, file) => sum + (file.del ?? 0), 0),
        files: files.length,
      },
    }
  }

  private async diff(root: string, target: string, ctx: ResourceReadContext): Promise<unknown> {
    /*
     * **第三关:目标文件自己**(文件头「沙箱判三次」)。地址与根过了不代表这个文件
     * 该被读出来 —— `git:<仓库>` + `{path:'.env'}` 走到这里之前,三关里的「敏感」
     * 那一关一个字都没说过话,而同一个文件经 `read` 工具是拒的。
     *
     * 判在 `git` 跑起来**之前**:一次被拒的读不该先把凭证读进这个进程的内存。
     */
    const absolute = resolveReadable(path.join(root, target), ctx.sandbox, ctx.sessionId)
    /*
     * 「这个文件 git 认不认识」决定走哪条路,而判据是**索引**不是盘上有没有它:
     * 一个已经 `git rm --cached` 掉的文件盘上还在(untracked),一个 staged 的删除
     * 盘上已经没了却仍然在 `diff HEAD` 里有答案。所以两问都要:认识 → `diff HEAD`;
     * 不认识但盘上有 → `--no-index`;不认识盘上也没有 → 仍然走 `diff HEAD`
     * (那正是 staged 删除那一支,它的答案在 HEAD 与索引之间)。
     */
    const tracked = (await this.text(['ls-files', '-z', '--', target], root, ctx)).length > 0
    const onDisk = await fs.stat(absolute).then(() => true, () => false)

    let raw: string
    if (!tracked && onDisk) {
      // `--no-index` 有差异时**退出码 1**,那是成功不是失败(自述 §2.1 那一句)。
      // 递的是**根相对**路径(`cwd` 就是根),于是这一块 diff 的 `+++ b/…` 与 tracked
      // 那一支印出来的是同一行 —— 读它的人不该从路径形状上看出来后端走了哪条路。
      raw = await this.text(['diff', ...GIT_DIFF_ARGS, '--no-index', '--', '/dev/null', target], root, ctx, {
        okCodes: [0, 1],
        limit: GIT_DIFF_MAX_BYTES,
        allowOverflow: true,
      })
    } else {
      const hasHead = (await this.run(['rev-parse', '--verify', '--quiet', 'HEAD'], root, ctx)).code === 0
      raw = await this.text(
        hasHead
          ? ['diff', ...GIT_DIFF_ARGS, 'HEAD', '--', target]
          : ['diff', ...GIT_DIFF_ARGS, '--cached', '--', target],
        root,
        ctx,
        { limit: GIT_DIFF_MAX_BYTES, allowOverflow: true },
      )
    }

    // git 对二进制文件印的是一句话而不是一块 diff。那句话不是 diff,所以 `text` 是空的
    // ——把它当 diff 交出去,渲染那一侧会画出一张只有一行噪音的卡。
    if (/^Binary files .* differ$/m.test(raw)) {
      return { path: target, text: '', binary: true, truncated: false }
    }
    const cut = truncateToLastCompleteLine(raw, GIT_DIFF_MAX_BYTES)
    return { path: target, text: cut.text, binary: false, truncated: cut.truncated }
  }

  /**
   * 一个文件的两个版本的原文。**一个差异都不算** —— 算法在壳里,后端只交事实
   * (自述文件头「`diff` 与 `file` 为什么是两条」)。
   *
   * 两边各走各的路,而这不是重复:上一次提交那一版只有 git 说得出(盘上没有它),
   * 此刻这一版只有盘说得出(它可能还没进过任何一个 git 对象)。于是「不在」这件事
   * 也各有各的读法 —— `git show` 的一句 stderr,与 `fs.stat` 的一次 ENOENT。
   *
   * 两个 `null` 合起来就是这个文件发生了什么:都在 = 改过;只有 `work` = 新增 /
   * 未跟踪;只有 `head` = 删掉了。**重命名按新路径问**,答案是「只有 `work`」——
   * 这只函数不去猜旧路径,猜错的那一份会被整篇画成改动。
   */
  private async file(root: string, target: string, ctx: ResourceReadContext): Promise<unknown> {
    /*
     * **第三关:目标文件自己**,与 `diff` 同一句、同一序(文件头「沙箱判三次」)。
     * 判在两边任何一次读之前:这条读法交的是**原文**,被拒的那一份连打开都不该打开。
     */
    const absolute = resolveReadable(path.join(root, target), ctx.sandbox, ctx.sessionId)
    return {
      path: target,
      head: await this.headText(root, target, ctx),
      work: await workText(absolute),
    }
  }

  /** 上一次提交那一版。不在 HEAD(新增 / 未跟踪 / 空仓)= `null`。 */
  private async headText(root: string, target: string, ctx: ResourceReadContext): Promise<GitFileText | null> {
    /*
     * 空仓先判,而且判据是 `rev-parse` 不是一句 stderr:一个还没有第一次提交的仓库里
     * `HEAD` 根本不存在,git 对它说的是「invalid object name」——那与「这个文件不在
     * HEAD 里」是两句不同的话,靠认第三句 stderr 去合并它们,等于让这条读法的正确性
     * 挂在 git 的措辞上多一处。判据与 `diff` 那一支逐字相同。
     */
    const hasHead = (await this.run(['rev-parse', '--verify', '--quiet', 'HEAD'], root, ctx)).code === 0
    if (!hasHead) return null

    /*
     * **大小先问 `cat-file -s`,再读内容**,多花的这一次子进程买的是一句不会说谎的
     * `bytes`:`git show` 交出来的那一截可能是截断的(300 MB 的锁文件只会出来 1 MiB),
     * 而二进制那一版经 utf8 解码之后字节数已经不是原来那个数了(非法序列会变成替换
     * 字符)。两种情况下拿交出去的那一截去量,量到的都是「我给了你多少」,而 `bytes`
     * 要答的是「它有多大」。
     *
     * 顺带它也是**存在性那一问**:`cat-file` 与 `show` 对「不在 HEAD」说的是同一句话。
     */
    const sizeArgs = ['cat-file', '-s', `HEAD:${target}`]
    const sized = await this.run(sizeArgs, root, ctx)
    if (sized.code !== 0) {
      if (PATH_NOT_IN_HEAD.test(sized.stderr)) return null
      throw this.failed(sizeArgs, sized)
    }

    const showArgs = ['show', `HEAD:${target}`]
    const shown = await this.run(showArgs, root, ctx, GIT_FILE_MAX_BYTES)
    /*
     * **overflow 先判**(与 `text()` 那一句同一条理由):到了上限的子进程是被这只
     * provider 杀掉的,它的退出码必然不是 0,先判退出码只会把一次成功的截断报成失败。
     */
    if (!shown.overflow && shown.code !== 0) {
      if (PATH_NOT_IN_HEAD.test(shown.stderr)) return null
      throw this.failed(showArgs, shown)
    }
    // `cat-file -s` 印的就是一个十进制数;读不成数(它改了输出、或者这不是一个 blob)
    // 就退回量交出去的那一截 —— 交一个 `NaN` 出去会让每个读 `bytes` 的地方各自去兜底。
    const declared = Number.parseInt(sized.stdout.trim(), 10)
    const bytes = Number.isFinite(declared) ? declared : Buffer.byteLength(shown.stdout, 'utf8')
    return fileTextOf(shown.stdout, bytes)
  }

  /**
   * 非零退出 = 失败。要把非零当答案的那两处自己传 `okCodes`。
   *
   * `limit` / `allowOverflow` 是这条读法对「输出太大了怎么办」的声明:`diff` 说
   * 「截了也算数」(它的契约里有 `truncated`),别人说「那不该发生」。**overflow 先判**
   * ——被杀掉的子进程退出码必然不在 `okCodes` 里,先判退出码只会把一次成功的截断
   * 报成一次失败。
   */
  private async text(
    args: readonly string[],
    cwd: string,
    ctx: ResourceReadContext,
    options: { okCodes?: readonly number[]; limit?: number; allowOverflow?: boolean } = {},
  ): Promise<string> {
    const limit = options.limit ?? GIT_METADATA_MAX_BYTES
    const run = await this.run(args, cwd, ctx, limit)
    if (run.overflow) {
      if (options.allowOverflow) return run.stdout
      throw this.failed(args, {
        ...run,
        stderr: `output exceeded ${limit} bytes, which this read is not allowed to truncate`,
      })
    }
    if (!(options.okCodes ?? [0]).includes(run.code)) throw this.failed(args, run)
    return run.stdout
  }

  private failed(args: readonly string[], run: GitRun): GitOperationFailedError {
    // 失败处才落一行 warn(`log:gate`:零 `console.*`;成功的读一行都不写 —— 一个面板
    // 每次刷新都写日志,写的是噪音)。
    log.warn('git command failed', { args: args.join(' '), code: run.code, stderr: run.stderr.trim().slice(0, 400) })
    return new GitOperationFailedError(args, run.code, run.stderr)
  }

  private run(
    args: readonly string[],
    cwd: string,
    ctx: ResourceReadContext,
    limit: number = GIT_METADATA_MAX_BYTES,
  ): Promise<GitRun> {
    return runGit([...GIT_COMMON_ARGS, ...args], cwd, ctx.signal, limit)
  }
}

/**
 * 一次 git 调用。**非零退出 resolve 不 reject** —— 「不是仓库」「没有 HEAD」
 * 「`--no-index` 有差异」三处都要读那个数字,而把它包成异常再拆开是同一件事绕一圈。
 *
 * 真正 reject 的只有两种:这台机器上没有 git(ENOENT)、调用方中止了(AbortSignal)。
 * 「输出太大」不在其中 —— 它 resolve 成 `overflow: true`,由调用那条读法裁定
 * (文件头最后一段)。
 *
 * ## 为什么是 `spawn` 而不是 `execFile`
 *
 * `execFile` 的 `maxBuffer` 是一道**事后**的墙:超了它杀进程并把整次调用变成一句
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`,那份已经收到的输出连同它一起丢掉。而这条路上
 * 「收到前 1 MiB 就够了」是**正常**结局,不是异常 —— 一块 300 MB 的 diff 里,人要看的
 * 和模型读得下的都只有开头那一截。所以这里自己数字节:到上限就不再累计、`kill()`,
 * 内存里从头到尾只有那一截。
 */
function runGit(args: readonly string[], cwd: string, signal: AbortSignal, limit: number): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd,
      signal,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let overflow = false
    let settled = false

    child.stdout.on('data', (chunk: Buffer) => {
      if (overflow) return
      // 收**够**上限再多一个字节就停:`truncateToLastCompleteLine` 的判据是「大于上限」,
      // 刚好等于上限的一块 diff 是完整的,不该被说成截断过。
      if (outBytes + chunk.length > limit) {
        out.push(chunk.subarray(0, Math.max(0, limit + 1 - outBytes)))
        overflow = true
        // 杀掉它,而不是读完再扔:这条路的整个用处就是不把那几百 MB 读进来。
        child.kill()
        return
      }
      out.push(chunk)
      outBytes += chunk.length
    })

    child.stderr.on('data', (chunk: Buffer) => {
      if (errBytes >= GIT_STDERR_MAX_BYTES) return
      err.push(chunk)
      errBytes += chunk.length
    })

    child.on('error', error => {
      if (settled) return
      settled = true
      const failure = error as NodeJS.ErrnoException
      if (failure.code === 'ENOENT') {
        log.warn('git is not on PATH', { cwd })
        reject(new GitUnavailableError(failure.message))
        return
      }
      // 中止:原样抛。它不是 git 的答案,改写只会盖掉真相。
      reject(error)
    })

    child.on('close', code => {
      if (settled) return
      settled = true
      resolve({
        // 被信号杀掉时 `code` 是 null。`-1` 是「它没有自己走完」的记号,而在
        // overflow 那一支里没有人会去读它。
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        overflow,
      })
    })
  })
}

/**
 * 仓根过不过得了读根,以及**过不了时按哪一段列**。
 *
 * 会话绑的工作目录经常是仓库的一个子目录(`repo/packages/foo`),于是 `rev-parse`
 * 出来的根落在读根之外。以前这里整条读法拒 —— 而那是一句不准确的话:这个人对
 * **他被授权看见的那一段**的改动是有权看的,「我只能看这一段」与「这里没有改动」
 * 是两件事。所以降级成一段范围,并把范围**说出来**(`scope`)。
 *
 * 三条边界,写清楚免得它变成一个后门:
 *   · 只有 `outside` 这一种拒绝降级 —— `no-sandbox`(宿主缺能力)与 `sensitive`
 *     原样抛。它们说的都不是「你只能看一部分」;
 *   · 范围是**地址那个目录**,而它在进这只函数之前已经过完三关了(`read()` 第一行),
 *     所以降级永远不会给出比地址本身更宽的东西;
 *   · 算不出一条「地址在根底下」的相对路径(两边的真实路径不同源,比如一边过了
 *     `realpath` 一边没有)→ **把原来那句拒绝抛出去**。猜一个范围比拒绝危险。
 */
function readableRepoScope(
  toplevel: string,
  addressDir: string,
  ctx: ResourceReadContext,
): { root: string; scope: string } {
  try {
    return { root: resolveReadable(toplevel, ctx.sandbox, ctx.sessionId), scope: '' }
  } catch (error) {
    if (!(error instanceof DirOutsideSandboxError) || error.reason !== 'outside') throw error
    const relative = path.relative(toplevel, addressDir)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw error
    log.debug('repository root is outside the read roots; listing one directory of it', {
      root: toplevel,
      scope: relative,
    })
    // `root` 照旧是**真正的仓根**:每一行的 `path` 都是根相对的,少了它读者没法
    // 把一行改动对回盘上的文件。范围由 `scope` 说,不靠把根改小来暗示。
    return { root: toplevel, scope: relative }
  }
}

function requireGitPath(ref: ResourceRef | null, member: string): string {
  if (!ref || !ref.path) throw new GitRefRequiredError(member)
  return ref.path
}

/**
 * 子进程的 `cwd`。地址可以指到一个文件上(一条会话的 workdir 之外,也可能有人拿
 * 文件地址来问),而 `cwd` 只能是目录。
 *
 * 路径整个不存在时**当场说清楚**:不这么做的话,`execFile` 对一个不存在的 `cwd`
 * 答的也是 ENOENT,而那正是「这台机器上没有 git」的判据 —— 两件毫不相干的事会答出
 * 同一句话。
 */
async function workingDirectoryOf(target: string): Promise<string> {
  const stats = await fs.stat(target).catch(() => null)
  if (!stats) throw new GitOperationFailedError(['rev-parse'], 128, `${target}: no such path`)
  return stats.isDirectory() ? target : path.dirname(target)
}

/**
 * `diff` 的那一格 `path`:**仓库根相对**,不含 `..`。
 *
 * 绝对路径当场拒,而不是先解析再判沙箱:地址已经说了在哪个工作树里,这一格再收一条
 * 绝对路径就等于同一件事有两个产地(自述那条读法上写着这句)。`..` 同理 —— 它能走出
 * 这个仓库,而走出去之后 `git diff` 答的东西与这个地址无关。
 */
function relativePathQuery(query: unknown, member: string): string {
  const value = query && typeof query === 'object' ? (query as Record<string, unknown>).path : undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${member} needs a non-empty path`)
  }
  if (path.isAbsolute(value) || value.startsWith('~')) {
    throw new TypeError(
      `${member} needs a repository-root-relative path, exactly as "status" gave it (got ${JSON.stringify(value)})`,
    )
  }
  if (value.split(/[\\/]/).includes('..')) {
    throw new TypeError(`${member} needs a path inside this repository, without ".." (got ${JSON.stringify(value)})`)
  }
  return value
}

interface ParsedPorcelain {
  readonly branch?: string
  readonly head?: string
  readonly files: readonly GitChangedFile[]
}

/**
 * `status --porcelain=v2 -z --branch` 的四种行 + 两条表头。
 *
 * 为什么是 v2 而不是那份人人都在解析的 v1:v1 把 `XY` 与路径挤在固定列里,重命名那
 * 一行用 ` -> ` 分隔 —— 于是一个名字里带 ` -> ` 的文件会把解析器骗过去。v2 每条记录
 * 自带类型字母,`-z` 让路径以 NUL 收尾,两样合起来才是「文件名里可以有任何字符」。
 */
function parsePorcelainV2(raw: string): ParsedPorcelain {
  const records = raw.split('\0')
  const files: GitChangedFile[] = []
  let branch: string | undefined
  let head: string | undefined

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue

    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' ')
      const value = rest.join(' ')
      // detached 时 git 自己写 `(detached)` —— 那不是一个分支名,所以这一格缺席。
      if (key === 'branch.head' && value && value !== '(detached)') branch = value
      // 空仓答 `(initial)`:没有 HEAD,所以这一格缺席,而 `status` 拿它当「要不要退回
      // `--cached`」的判据。短 sha 取 7 位 —— 与 git 自己 `--short` 的缺省同长。
      if (key === 'branch.oid' && value && value !== '(initial)') head = value.slice(0, 7)
      continue
    }

    const kind = record[0]
    if (kind === '?') {
      files.push({ path: record.slice(2), status: 'untracked', staged: false, unstaged: true })
      continue
    }
    // `!` = ignored。缺省的 `status` 根本不列它们(要 `--ignored` 才有),认一行是为了
    // 万一有人加了那个参数时不会把它当成一条改动。
    if (kind === '!') continue

    const parts = record.split(' ')
    const xy = parts[1] ?? '..'
    if (kind === '1') {
      files.push(changedFile(xy, parts.slice(8).join(' ')))
      continue
    }
    if (kind === '2') {
      // `-z` 下重命名的**来源路径是下一条记录**(那正是 -z 的整个用处:两条路径各自
      // 以 NUL 收尾,名字里可以有制表符、换行、什么都行)。
      const to = parts.slice(9).join(' ')
      const from = records[index + 1] ?? ''
      index += 1
      files.push({ ...changedFile(xy, to), oldPath: from })
      continue
    }
    if (kind === 'u') {
      files.push({ path: parts.slice(10).join(' '), status: 'conflicted', staged: true, unstaged: true })
    }
  }

  return { ...(branch ? { branch } : {}), ...(head ? { head } : {}), files }
}

/**
 * `XY` 两个字母 → 一行。
 *
 * `staged` / `unstaged` 是**事实**(索引那一侧变了没有、工作树那一侧变了没有),而
 * `status` 那一格是给人看的一个字:**索引那一侧优先** —— 一个「暂存了新增、又接着
 * 改了两行」的文件,回答「它是什么」最有用的一句是「新增」。两格都在,要另一种读法
 * 的人读得出来。
 */
function changedFile(xy: string, filePath: string): GitChangedFile {
  const staged = xy[0] ?? '.'
  const unstaged = xy[1] ?? '.'
  const letter = staged !== '.' ? staged : unstaged
  return {
    path: filePath,
    status: STATUS_LETTERS[letter] ?? 'modified',
    staged: staged !== '.',
    unstaged: unstaged !== '.',
  }
}

/** 一个文件的增删行数。两格都缺席 = 数不出来(不是零)。 */
type GitLineCount = { add?: number; del?: number; binary?: boolean }

/**
 * `diff --numstat -z`:每条记录是 `<add>\t<del>\t<path>`,而**重命名那一条的路径是
 * 空的**,紧跟着两条记录分别是来源与目标(git 的 `-z` 就是这么说的)。二进制文件的
 * 两个数字是 `-`。
 */
function parseNumstat(raw: string): Map<string, GitLineCount> {
  const records = raw.split('\0')
  const counts = new Map<string, GitLineCount>()

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    const [add, del, inline] = record.split('\t')
    if (add === undefined || del === undefined) continue

    let target = inline ?? ''
    if (target === '') {
      // 空路径 = 重命名:来源在下一条,目标在再下一条。键取**目标**,与 porcelain v2
      // 的 `path` 是同一个(它给的也是新路径)。
      target = records[index + 2] ?? ''
      index += 2
    }
    if (!target) continue

    counts.set(
      target,
      add === '-' || del === '-'
        ? { binary: true }
        : { add: Number.parseInt(add, 10) || 0, del: Number.parseInt(del, 10) || 0 },
    )
  }
  return counts
}

/**
 * 造一本**数未跟踪文件行数**的预算账,交出一只「数一个文件」的函数。
 *
 * 为什么是一只带状态的闭包而不是一只纯函数:预算是**一次 `status` 里跨文件累计**的
 * 东西,而一只纯函数只看得见眼前这一个文件。做成参数(「已经花了多少」)则要求每个
 * 调用点自己把那个数传来传去 —— 那是同一份状态放在外面,而且第二个调用点一定会忘。
 *
 * 三条退场,`add` / `del` 一律**缺席**而不是零(「这个数没算」≠「这个文件没改动」):
 * 大于 `GIT_DIFF_MAX_BYTES`(读它只为数几个换行不值)或含 NUL(那就不是文本)→
 * `binary: true`;读不到(刚刚被删掉了、是个目录)→ 空;预算花完 → 空。
 *
 * **预算只算读进来的字节**:太大而没读的那些不花预算(它们连打开都没打开)。
 *
 * `isSensitive` 是**必填**的:一只数行数的计数器建不出来就说明没人给它判官,而
 * 「没有判官所以全都读」正是那种会活很久的静默授权洞。导出是为了让预算与判官都
 * 可注入 —— 用真的 32 MiB 去证预算那条路要在测试里造 32 MiB 文件,而那证的是磁盘
 * 不是判据。
 */
export function createUntrackedLineCounter(
  isSensitive: (absolute: string) => boolean,
  budgetBytes: number = GIT_UNTRACKED_COUNT_BUDGET_BYTES,
): (absolute: string) => Promise<GitLineCount> {
  let spent = 0
  return async (absolute: string): Promise<GitLineCount> => {
    /*
     * **「不给看」包括「不打开」**(2026-09-13 拍板)—— 与 `diff` 那一关同一句话、
     * 同一个判官。数行数只交出一个数字,不交内容,但要拿到那个数字得先把一份凭证
     * 文件整个读进这个进程的内存,而那正是敏感那一关要拦的事:一次拒绝的意思是
     * 「这个文件我们不碰」,不是「碰了但只说个数」。
     *
     * 判在预算与 `stat` **之前**:被拒的文件连一次 `stat` 都不该欠它,也不花预算。
     */
    if (isSensitive(absolute)) return {}
    if (spent >= budgetBytes) return {}

    const stats = await fs.stat(absolute).catch(() => null)
    if (!stats || !stats.isFile()) return {}
    if (stats.size > GIT_DIFF_MAX_BYTES) return { binary: true }

    const content = await fs.readFile(absolute).catch(() => null)
    if (!content) return {}
    spent += content.length
    if (content.includes(0)) return { binary: true }
    if (content.length === 0) return { add: 0, del: 0 }

    let lines = 0
    for (const byte of content) if (byte === 0x0a) lines += 1
    // 最后一行没有换行符时它仍然是一行 —— git 数的也是这个(它还会补一句
    // 「\ No newline at end of file」)。
    if (content[content.length - 1] !== 0x0a) lines += 1
    return { add: lines, del: 0 }
  }
}

/**
 * 截到 `maxBytes`,而且**截在最后一个完整的行上**。
 *
 * 按字节截而不是按字符:上限说的是字节(自述里那两个常量),而一块 diff 里的中文一个
 * 字三个字节。按字节切可能把一个字切成半个,于是最后回退到最后一个 `\n` —— 那半个
 * 字一定在最后一个换行之后,所以这一刀同时把它扔了。
 *
 * 上限是**参数**而不是那个常量:`diff` 与 `file` 的上界今天同值、说的却是两句不同的
 * 话(自述里 `GIT_FILE_MAX_BYTES` 上写着为什么它们不是同一格),把常量写死在这里等于
 * 让以后其中一格改数时这只函数悄悄按另一格截。
 */
function truncateToLastCompleteLine(raw: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(raw, 'utf8') <= maxBytes) return { text: raw, truncated: false }
  const head = Buffer.from(raw, 'utf8').subarray(0, maxBytes).toString('utf8')
  const lastBreak = head.lastIndexOf('\n')
  return { text: lastBreak >= 0 ? head.slice(0, lastBreak + 1) : '', truncated: true }
}

/**
 * 一段原文 + 它的真实字节数 → 自述那四格。
 *
 * **二进制那一档 `truncated` 是 `false`**:那一版的 `text` 空着不是因为被裁掉了,是
 * 因为它压根不是文本。两件事混成一格,读者会去画一句「内容过长,已截断」,而正确的
 * 那句话是「这是一个二进制文件」。`bytes` 两档都照实说。
 *
 * NUL 判二进制(与 `createUntrackedLineCounter` 同一条,也与 git 自己的判法同族):
 * `0x00` 是合法的单字节 utf8,所以它在解码之后仍然在字符串里 —— 这一句对着 `git show`
 * 解码出来的字符串与盘上那份 Buffer 解码出来的字符串都成立。
 */
function fileTextOf(raw: string, bytes: number): GitFileText {
  if (raw.includes('\0')) return { text: '', binary: true, truncated: false, bytes }
  const cut = truncateToLastCompleteLine(raw, GIT_FILE_MAX_BYTES)
  return { text: cut.text, binary: false, truncated: cut.truncated, bytes }
}

/**
 * 此刻盘上那一版。不在盘上(删掉了、或者那是个目录)= `null`。
 *
 * **超上限时只读开头那一截**,而且读的是 `GIT_FILE_MAX_BYTES + 1` 个字节:截断的判据
 * 是「大于上限」(刚好等于上限的一份原文是完整的,不该被说成截断过),读满上限就停会
 * 让一份 300 MB 的文件与一份恰好 1 MiB 的文件在判据眼里长得一模一样。多读的那一个
 * 字节就是它们的差。
 *
 * `bytes` 取 `stat` 的 `size` 而不是读回来那一截的长度 —— 与 head 那一侧
 * `cat-file -s` 同一条理由:`bytes` 答的是「它有多大」,不是「我给了你多少」。
 */
async function workText(absolute: string): Promise<GitFileText | null> {
  const stats = await fs.stat(absolute).catch(() => null)
  // 目录也答 `null`:`file` 收的那一格来自 `status`,而一个目录不是一处改动
  // (`-uall` 那条判词的另一半)。
  if (!stats || !stats.isFile()) return null

  const cap = GIT_FILE_MAX_BYTES + 1
  let content: Buffer | null
  if (stats.size <= cap) {
    content = await fs.readFile(absolute).catch(() => null)
  } else {
    content = await readFirstBytes(absolute, cap)
  }
  // 刚刚还在、这一刻读不到了(被删掉、权限变了):与「盘上没有它」同一个答案 ——
  // 编一个空文件出来会被整篇画成「删光了」。
  if (!content) return null

  return fileTextOf(content.toString('utf8'), stats.size)
}

/** 开头 `count` 个字节,读不到就 `null`。句柄自己收尸(整个用处就是不把那几百 MB 读进来)。 */
async function readFirstBytes(absolute: string, count: number): Promise<Buffer | null> {
  const handle = await fs.open(absolute, 'r').catch(() => null)
  if (!handle) return null
  try {
    const buffer = Buffer.alloc(count)
    const { bytesRead } = await handle.read(buffer, 0, count, 0)
    return buffer.subarray(0, bytesRead)
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}
