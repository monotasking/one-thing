/**
 * 「改动」面 —— git 工作树这一 scheme 的自述
 * (`apps/desktop-react/docs/changes-panel-2026-09.md` §2.1;体例照同目录的
 * `resource-spec.ts`,那是 `docs/design/atom-2026-09.md` §9 K3 的三样板之一)。
 *
 * 地址是 `git:<绝对路径>` —— **仓库里的任何一个目录都行**,provider 自己
 * `rev-parse` 出根。这是刻意的:提问的人手里通常只有「我在哪」(一条会话的
 * 工作目录),要求他先说出仓库根,等于要求他先知道答案。
 *
 * ── 为什么住在 `files/` ─────────────────────────────────────────────────────
 * 与 `dirResourceSpec` 同一条(见那只文件的头):自述与它服务的那一族纯函数同一个
 * 领域、同一棵树,不新开一棵 `git/`。一个工作树此刻改了什么,是关于**这台机器上的
 * 文件**的一句话。
 *
 * ── 两条读法,零做法 ────────────────────────────────────────────────────────
 * `status`(整表)与 `diff`(一个文件的统一 diff)。**本单一格做法都没有** ——
 * stage / unstage / discard / commit 是写面,它们的效果类今天在效果表里没有对应的
 * 一行(`file_write` 说不准「改的是索引不是盘上的文件」),而给一批带副作用的做法
 * 挑一个凑合的效果类,等于让权限卡说一句不准确的话。写面是另一张拍点表(方案 §8)。
 *
 * 零做法的结果是这只 scheme 投影出去的 `git` 工具**只有两条分支**,效果并集是空 ——
 * 模型拿它比 `bash git status` 拿到的是结构化的表,而且不必过一次 `bash` 的权限。
 *
 * ── 为什么没有 `log` / `blame` / `show` ────────────────────────────────────
 * 不是划界,是**还没有消费者**。这一 scheme 的第一个消费者是「改动」面,它问的就是
 * 这两句话。多写一条读法要先回答「它的结果长什么样、谁在读」,而今天两个答案都没有
 * —— 加一条读法是「这只文件 + provider 各一格」,骨架不动(方案 §1 的陌生能力演练)。
 *
 * ── `diff` 的口径:相对 HEAD,暂存与未暂存合在一起 ─────────────────────────
 * 一个人问「我改了什么」,他心里的参照系是**上一次提交**,不是索引。分成「已暂存 /
 * 未暂存」两段是写面到来时才成立的区分(那时他要决定把哪一半提交);在只读这一单里
 * 分两段,等于让每个读者先学一遍 git 的索引模型才看得懂一块 diff(方案 §7 拍点 3)。
 *
 * `status` 那一侧仍然逐行带 `staged` / `unstaged` 两格 —— 那是**事实**(git 自己就是
 * 这么说的,`XY` 两个字母),不是口径。面板今天只用它上一个字母,写面到来时它已经在。
 *
 * ── `scope`:一份**可能只是一段**的改动表 ───────────────────────────────────
 * 地址常常是仓库的一个子目录(一条会话绑的工作目录就经常是 `repo/packages/foo`),
 * 而这个人被授权看见的也只有那一段。这时候 `status` 交出的是**那一段下面**的改动,
 * `scope` 说清楚是哪一段(`''` = 整仓)。
 *
 * 为什么不是「看不全就整个拒」:那会让一个只接入了子目录的人一条改动都读不到,
 * 而他对那个子目录的改动是有权看的 —— 「我只被允许看这一段」与「这里没有改动」
 * 必须分得开,所以它是一格**说出来的范围**,不是一次静默的少给。`files[].path`
 * 无论哪种情况都仍然是**仓库根相对**的(git 自己就是这么说的),`root` 也照旧是
 * 真正的仓根 —— 范围只影响「列了哪些行」,不影响任何一行的坐标。
 *
 * ── 「不是仓库」不是错 ──────────────────────────────────────────────────────
 * `{ repo: false }`。面板与模型都要拿它当**一种状态**:给一个不是仓库的目录开一格
 * 改动面是常事(主目录、下载目录),而一次异常会让调用方以为自己问错了。
 */

import type { JsonSchema, ResourceSpec } from '@onething/core/resource'

export const GIT_RESOURCE_SCHEME = 'git'

/**
 * 一块 diff 最多交出去多少字节,超过的部分**截到最后一个完整的行**并声明
 * `truncated: true`。
 *
 * 常量在这里(自述这一侧)而不是散在 provider 里,理由与「面板要把这个数字写进
 * 那行提示」是同一条:它是这条读法的**契约**的一部分 —— 读者看得见截断,也看得见
 * 是在哪一刀截的。1 MiB 是「一块人还看得下去的 diff」的上界:超过它的多半是一次
 * 重新生成的锁文件或一份压缩产物,而那种东西没有人在逐行读。
 */
export const GIT_DIFF_MAX_BYTES = 1024 * 1024

/**
 * 数未跟踪文件的行数,一次 `status` 最多**读**多少字节。
 *
 * git 自己不数未跟踪文件(它们还不在任何一块 diff 里),所以那几行的 `add` 是
 * provider 打开文件数换行数出来的。一个忘了写 `.gitignore` 的仓里,「未跟踪」可以是
 * 一整棵 `node_modules` 或一个 `dist/` —— 于是一次本该毫秒级的状态读会去读几百 MB,
 * 而换来的只是几个没有人在看的数字。
 *
 * 超过预算之后,余下那些行的 `add` / `del` **缺席**(不是零)—— 与「二进制文件的行数
 * 不适用」同一条:缺席说的是「这个数没算」,而一个假的零会被当成「这个文件没改动」。
 *
 * 预算只管**读进来的字节**:大于 `GIT_DIFF_MAX_BYTES` 的文件压根不读(直接答
 * `binary: true`),所以它不花预算。
 */
export const GIT_UNTRACKED_COUNT_BUDGET_BYTES = 32 * 1024 * 1024

/**
 * 一行改动。`path` 是**仓库根相对**路径 —— 与 git 自己说的一样,也与 `diff` 那条
 * 读法收的那一格是同一套坐标(两处各有一套坐标,是「同一个文件在两条读法里对不上」
 * 的标准形状)。
 *
 * `add` / `del` 缺席不写成 `0`:一个二进制文件的行数不是零,是**不适用**
 * (与 `dirResourceSpec` 的 `size` / `mtimeMs` 同一条 —— 缺席的格子不出现)。
 */
const CHANGED_FILE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Path relative to the repository root, as git itself says it.' },
    status: {
      type: 'string',
      enum: ['modified', 'added', 'deleted', 'renamed', 'copied', 'untracked', 'conflicted', 'typechange'],
      description: 'What happened to this file.',
    },
    staged: { type: 'boolean', description: 'Some of this change is in the index.' },
    unstaged: { type: 'boolean', description: 'Some of this change is only in the working tree.' },
    add: { type: 'number', description: 'Added lines. Absent for binary files.' },
    del: { type: 'number', description: 'Deleted lines. Absent for binary files.' },
    binary: { type: 'boolean', description: 'Line counts do not apply to this file.' },
    oldPath: { type: 'string', description: 'Where it came from — only for "renamed" and "copied".' },
  },
  required: ['path', 'status', 'staged', 'unstaged'],
}

export const gitResourceSpec: ResourceSpec = {
  scheme: GIT_RESOURCE_SCHEME,
  title: 'Git working trees',
  reads: {
    /**
     * 这个工作树此刻改了什么 —— 整表,一次问完。
     *
     * 它答的是 `git status` + `git diff --numstat` 两条命令合起来的那件事:哪些文件
     * 变了、每个变了多少行。分成两条读法会让每个调用方都得自己 join 一次,而这两
     * 句话没有人只要其中一半。
     */
    status: {
      title: 'Read everything that is uncommitted in this working tree',
      query: { type: 'object', properties: {}, required: [] },
      result: {
        type: 'object',
        properties: {
          repo: {
            type: 'boolean',
            description: 'False when this path is not inside a git repository — a state, not an error. Nothing else is present then.',
          },
          root: { type: 'string', description: 'Absolute path of the repository root.' },
          scope: {
            type: 'string',
            description:
              "Changes are listed only under this directory of the repository; '' means the whole tree. File paths stay relative to the repository root either way.",
          },
          branch: { type: 'string', description: 'Current branch name. Absent when HEAD is detached.' },
          head: { type: 'string', description: 'Short sha of HEAD. Absent in a repository with no commits yet.' },
          files: { type: 'array', items: CHANGED_FILE_SCHEMA },
          stat: {
            type: 'object',
            description: 'Totals over the files above.',
            properties: {
              add: { type: 'number' },
              del: { type: 'number' },
              files: { type: 'number' },
            },
            required: ['add', 'del', 'files'],
          },
        },
        required: ['repo'],
      },
    },
    /**
     * 一个文件的统一 diff,**相对 HEAD**(暂存 + 未暂存合在一起,口径见文件头)。
     *
     * `path` 收的是**仓库根相对**路径 —— `status` 交出来的那一格原样递回来。收一条
     * 绝对路径会让「地址里那个目录」与「这一格」两处都能说出目标在哪,而两个产地
     * 说的话不一致时没有人说得清该信谁。
     */
    diff: {
      title: 'Read the unified diff of one file against the last commit',
      query: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Repository-root-relative path, exactly as "status" gave it. Not absolute, no "..".',
          },
        },
        required: ['path'],
      },
      result: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The path that was diffed, repository-root-relative.' },
          text: { type: 'string', description: 'Unified diff as git prints it. Empty for a binary file.' },
          binary: { type: 'boolean', description: 'Git will not show this one as text.' },
          truncated: { type: 'boolean', description: 'The diff was cut at the last complete line before the size cap.' },
        },
        required: ['path', 'text', 'binary', 'truncated'],
      },
    },
  },
  /**
   * 本单零做法(理由在文件头)。这一格**必须在**且是个对象 —— 契约门查的是形状,
   * 而一份缺了 `ops` 的自述登记不进去。
   */
  ops: {},
  /**
   * 零事件:今天没有 fs watch,**发不出真话**。一个「工作树变了」的事件要么来自
   * 一只真的监视器,要么就是在猜;而订阅者收到一条猜出来的事实之后,会停止自己去问。
   */
  events: {},
}
