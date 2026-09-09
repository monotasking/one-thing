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
 * ── 第一批只有一条做法 ─────────────────────────────────────────────────────
 * `reveal`(在文件管理器里定位)。`createDirectory` / `rename` / `delete` 的效果落在
 * `file_write` / `file_destructive_edit` 那一族,它们要的不是多写三格自述,而是一次
 * 「资源面的写与 `files` 域的写是不是同一条规则书」的对表 —— 留账给 K3-c'。
 *
 * ── 没有 events,也没有 state ───────────────────────────────────────────────
 * §10.3 那张表要求 `opened` / `closed` / `deleted` 是三条通用名,但目录面板的开合
 * 是**壳**的事,由 `workbench` 那份自述发(K2b-2 已经在发);`dir` 自己没有实例
 * 生命周期 —— 一个目录不会被「打开」,被打开的是摆着它的那一格。所以这里是空表,
 * 而不是三条永远没有产地的事件名。
 *
 * 至于 `deleted`:目录被删是 `file_destructive_edit` 那条做法的后果,而那条做法归
 * K3-c'。删都还不能删,先发一条删除事件是在为一件做不到的事写自述。
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
  },
  events: {},
}
