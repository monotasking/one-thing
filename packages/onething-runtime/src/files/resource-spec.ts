/**
 * K3-c —— 目录这一 scheme 的自述(`docs/design/atom-2026-09.md` §9 K3 三样板之一:
 * 音乐 / 目录 / 会话)。
 *
 * 地址是 `dir:<绝对路径>` —— **与壳里那个 `dir` kind 是同一套地址**(K2b-1 把壳的
 * `files-root` 改名成 `dir` 就是为了这一刻;§7 盲点 2「两套地址」要的是同一套语法、
 * 同一张 scheme 表,不是两处各写一份差不多的)。`ResourceRef` 在第一个冒号处切,
 * 冒号右边随便有多少斜杠与冒号,所以 `dir:/Users/x/a:b` 是一个合法地址。
 *
 * ── 为什么住在 `files/` 而不是新开一棵 `resource/` 树 ──────────────────────────
 * I2(`packages/core/<d>/x.ts` 与 `packages/onething-runtime/src/<d>/x.ts` 不许同名
 * 并存)与 P3 那条「包按环境、包内按领域」:目录的读法与做法用的就是 `files/` 这一
 * 族既有的纯函数(`listOnethingDirectory` / `statOnethingPath`),自述与它们同一个
 * 领域、同一棵树。会话那份自述住在 `sessions/` 也是同一条(`wiring/resource/index.ts`
 * 的头注释写着这句)。
 *
 * ── 为什么没有「读文件内容」这条读法 ────────────────────────────────────────
 * 因为**读一个文件的内容是带效果的读**,而 `ReadSpec` 里结构性地没有 effects 这一格
 * (§2 不变量 1)。效果表里管这件事的是三类:`read`(沙箱内的普通读)、
 * `sensitive_file_read`(密钥 / 凭证那一族)、`external_directory`(沙箱外)——
 * 三类的差别只有**看过路径之后**才知道,而那正是「计划一次、授权一次」该干的事。
 * 所以文件内容归既有的 `read` 工具(它已经在跑那条管线),`dir` 只回答「这个目录里
 * 有什么」「这个路径是什么」——目录项的名字、大小、时刻不是文件内容。
 *
 * 这不是把一件事拆成两半:一个人问「这个目录里有什么」与问「这个文件写了什么」
 * 本来就是两件事,前者答得出的东西 `ls` 也答得出。
 *
 * ── 四条做法(K3-c' 把写面那三条补齐了)────────────────────────────────────
 * `reveal`(零效果,在文件管理器里定位)、`createDirectory`、`rename`、`delete`。
 * K3-c 当时把后三条留了账,理由是「它们要的不是多写三格自述,而是一次『资源面的写
 * 与 `files` 域的写是不是同一条规则书』的对表」——那次对表就是 K3-c':三条做法调的
 * 是 `files` 域调的**同一批纯函数**(`createOnethingDirectory` / `renameOnethingPath`
 * / `deleteOnethingPath`),越界文案是同一只错、同一句话,唯一有意分叉的一格
 * (`delete` 不递归)写在那条做法自己身上。
 *
 * ── 为什么仍然没有「新建文件」这条做法 ──────────────────────────────────────
 * 与「没有读文件内容」是同一条理由的另一半:**一个没有内容的文件不是任何人真的想要
 * 的东西**。`files.create` 在界面上是有用的(用户接着会在编辑器里打字),而在这条
 * 路上,调用方拿到一个空文件之后下一步一定是写内容,而写内容归 `write` / `edit`
 * 工具 —— 它们已经在跑那条管线,而且能报出 `file_edit` 与 `file_destructive_edit`
 * 的差别。在这里补一条 `create`,等于给每个调用方一条走一步就得换车的半截路。
 *
 * 目录不同:一个空目录**就是**目标本身(建一棵树、给下载分个格),它没有下一步。
 *
 * ── 三条事件,和 §10.3 那张通用名表 ────────────────────────────────────────
 * `created` / `renamed` / `deleted`。`deleted` 是 §10.3 的通用名之一;`opened` /
 * `closed` 这一 scheme 仍然一条不发 —— 目录面板的开合是**壳**的事,由 `workbench`
 * 那份自述发(K2b-2 已经在发),一个目录不会被「打开」,被打开的是摆着它的那一格。
 *
 * **每一条都发在这条做法作用的那个地址上**,不是发在「被改动的那个路径」上:
 * `rename` / `delete` 作用在目标自己身上(`dir:<目标>`),`createDirectory` 作用在
 * **父目录**身上(你是叫这个目录去生一个孩子),所以 `created` 发在父目录的地址上,
 * 载荷里带新目录的绝对路径。这条规则与会话那一 scheme 逐字同形(那边每一条也都发在
 * `session:<被作用的那条>` 上),而且它有一个实际好处:一个想知道「我这个目录里多了
 * 东西」的订阅者,订的就是这个目录的地址。
 *
 * 留账:`rename` / `delete` 之后**父目录的列表也变了**,而这两条事件发在目标身上,
 * 所以一个只订父目录的面板收不到它们。补法是再发一条父目录级的事件,但那要先有一个
 * 真的目录订阅者来定义「它想要什么粒度」——今天没有,先不猜。
 */

import type { JsonSchema, ResourceSpec } from '@onething/core/resource'

export const DIR_RESOURCE_SCHEME = 'dir'

/**
 * 一个目录项。**形照 `files.listDirectory` 的出参裁剪**(`FilesDirectoryEntry`):
 * 同一件事在两个出口不该长两个样子。
 *
 * 两处刻意不同,各有理由:
 *   · `type: 'file' | 'directory'` → `kind: 'file' | 'dir'` —— 与 scheme 同名,一份
 *     地址 `dir:<entry.path>` 指得到的正好是 `kind: 'dir'` 的那些项;
 *   · `mtimeMs` 一字不改 —— 单位写在名字里。叫它 `mtime` 而里面装毫秒,是下一个
 *     人拿它当秒用的那种 bug 的标准形状。
 *
 * **没有 `symlink` 这一格**:列目录用的是 `files` 那只共用的 `listOnethingDirectory`,
 * 它的判据是 `Dirent.isDirectory()` + `stat`(跟随链接),分不出软链接。自述里写一个
 * 实现产不出来的取值,就是一份说谎的自述 —— 要它得先改共用那只函数的出参,而那会
 * 当场改掉 `files.listDirectory` 的行为(留账)。
 */
const DIRECTORY_ENTRY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'The entry name, without any directory part.' },
    path: { type: 'string', description: 'Absolute path — address it as "dir:<path>".' },
    kind: { type: 'string', enum: ['file', 'dir'], description: 'What this entry is.' },
    size: { type: 'number', description: 'Size in bytes, when it could be stat-ed.' },
    mtimeMs: { type: 'number', description: 'Last modification time, epoch milliseconds.' },
  },
  required: ['name', 'path', 'kind'],
}

export const dirResourceSpec: ResourceSpec = {
  scheme: DIR_RESOURCE_SCHEME,
  title: 'Directories',
  reads: {
    /**
     * 列出这个目录里的东西。**一层,不递归** —— 与 `files.listDirectory` 逐字同义
     * (`node_modules` / `.git` 由那只共用函数自己跳过,目录在前、同类按名排序)。
     *
     * 递归遍历是另一件事(它有深度、有忽略规则、有量级),`files.list` 的检索面在做
     * 那件事;把两件事塞进一条读法,读表的人第一个问题就会是「不给参数是哪一种」。
     */
    list: {
      title: 'List what is directly inside this directory',
      query: { type: 'object', properties: {}, required: [] },
      result: {
        type: 'object',
        properties: { entries: { type: 'array', items: DIRECTORY_ENTRY_SCHEMA } },
        required: ['entries'],
      },
    },
    /**
     * 这个路径是什么。**地址是 `dir:` 但目标不必是目录** —— 一次 stat 的用处正是
     * 「先问问那是什么」,要求它先是个目录等于要求提问者先知道答案。
     */
    stat: {
      title: 'Read what this path is: file or directory, how big, when it changed',
      query: { type: 'object', properties: {}, required: [] },
      result: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The absolute path that was stat-ed.' },
          kind: { type: 'string', enum: ['file', 'dir'] },
          size: { type: 'number' },
          mtimeMs: { type: 'number' },
        },
        required: ['path', 'kind'],
      },
    },
  },
  ops: {
    /**
     * 在文件管理器里定位到它(macOS 的「在访达中显示」)。
     *
     * `effects: []` —— 它不改这台机器上的任何东西,也不读出任何内容:它把一扇已经
     * 属于这个用户的窗口挪到前面。空效果**不等于不留痕迹**:照样落 `tool/audit`。
     *
     * `home: 'core'` 而不是 `'shell'`:`home` 说的是「这一步由哪个进程执行」,而
     * 定位走的是主进程的 `shell.showItemInFolder`(`configureShellHost` 那只宿主口,
     * `files.reveal` 走的也是它)—— 它在 core 这一侧,不必绕一趟渲染进程。没有那只
     * 宿主口的进程(server / CLI)结构化降级,与 `files.reveal` 逐字同一句话。
     */
    reveal: {
      title: 'Show this path in the file manager',
      params: { type: 'object', properties: {}, required: [] },
      effects: [],
      home: 'core',
      entity: 'path',
      describe: () => 'show it in the file manager',
    },
    /**
     * 在这个目录里建一个子目录(K3-c')。
     *
     * 参数是**一段名字**,不是一条路径:地址已经说了在哪,再收一条路径就等于同一件
     * 事有两个产地,而 `{ name: '../../etc' }` 那种写法会让「地址说了算」这句话变成
     * 一句空话。实现那一侧因此只 `join` 不 `resolve`,并且当场拒掉带分隔符的名字。
     *
     * `file_write` 一格,不带 `file_destructive_edit`:`mkdir` 不递归、不覆盖 ——
     * 路径上已经有东西时它失败,而不是把那东西换掉。
     */
    createDirectory: {
      title: 'Create a directory inside this one',
      params: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The new directory name — one path segment. No "/", no "..".',
          },
        },
        required: ['name'],
      },
      effects: ['file_write'],
      home: 'core',
      entity: 'path',
      describe: params => `create the directory ${quoted(params, 'name')} inside it`,
    },
    /**
     * 改名 / 移动(同一件事:`rename(2)` 不区分它们,给一条新的绝对路径就行)。
     *
     * ## 两格效果是**上界**,真发出去的按参数分档
     *
     * `OpSpec.effects` 的语义是「这条做法**可能**做到什么」,而这条做法真会做到什么
     * 取决于新路径上有没有东西:空地上落一个名字只是 `file_write`,而落在一个已经
     * 存在的东西上会把它换掉,那是 `file_destructive_edit`。所以这里两格都列
     * (少列一格,管线的 `assertWithinOpEffects` 会在真要覆盖的那一次把调用判失败),
     * 而 provider 的 `plan` 在**看过目标之后**只报真的那一档 —— 与「读一个越界路径
     * 报 `external_directory` 而不是 `read`」是同一种按现场分档,所以它用不了
     * `planFromSpec`(那只函数照上界顶格造,自己不做任何判断)。
     */
    rename: {
      title: 'Rename or move this path',
      params: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description:
              'The new absolute path. Renaming and moving are the same thing — give the full destination path, not just a name.',
          },
        },
        required: ['to'],
      },
      effects: ['file_write', 'file_destructive_edit'],
      home: 'core',
      entity: 'path',
      describe: params => `rename it to ${quoted(params, 'to')}`,
    },
    /**
     * 删掉这个路径。**一个文件,或者一个空目录** —— 不递归。
     *
     * 这一格与 `files` 域有意分叉,而且只有这一格:界面上的删除
     * (`rpc/domains/files.ts` 的 `delete`)是 `fs.rm(recursive: true)`,因为那是一个
     * 人看着文件树、按下删除、并且知道自己删的是一棵树。这条路上不是 —— 这条路上的
     * 调用方可能是模型、插件、一段脚本,而「删一个空目录」的错删是可恢复的
     * (重建它),「删一棵树」的错删不是。要删一棵树的人有 `bash`,而且他会看见自己
     * 在写 `rm -rf`。
     *
     * 非空目录因此得到的是 `ENOTEMPTY` 那句原话(共用那只投影函数带出来的),
     * 那是一句准确的话:它说的正是「这里面还有东西」。
     */
    delete: {
      title: 'Delete this file, or this directory when it is empty',
      params: { type: 'object', properties: {}, required: [] },
      effects: ['file_destructive_edit'],
      home: 'core',
      entity: 'path',
      describe: () => 'delete it (a file, or an empty directory)',
    },
  },
  events: {
    /** 发在**父目录**的地址上(见文件头「三条事件」那一段),载荷是新目录的绝对路径。 */
    created: {
      title: 'A directory was created inside this one',
      payload: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path of the new directory.' } },
        required: ['path'],
      },
    },
    renamed: {
      title: 'This path was renamed or moved',
      payload: {
        type: 'object',
        properties: { path: { type: 'string', description: 'The new absolute path.' } },
        required: ['path'],
      },
    },
    /** §10.3 的通用名。发在被删掉的那个地址上 —— 到达时它已经不在了。 */
    deleted: {
      title: 'This path was deleted',
      payload: {
        type: 'object',
        properties: { path: { type: 'string', description: 'The absolute path that is now gone.' } },
        required: ['path'],
      },
    },
  },
}

/**
 * `describe` 收的是 `unknown`(内核不解释 params),而权限卡上那句话要带上人真正
 * 关心的那个值。拿不到就退成一句没有值的话 —— `describe` 不是校验者,它在参数被
 * 校验之前就可能被调到,炸在这里只会让一张本该出现的权限卡不出现。
 */
function quoted(params: unknown, key: string): string {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>)[key] : undefined
  return typeof value === 'string' && value.length > 0 ? JSON.stringify(value) : 'a new name'
}
