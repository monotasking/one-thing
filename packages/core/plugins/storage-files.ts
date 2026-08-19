/**
 * F1 存储面:`api.storage.files` —— 受管文件树
 * (docs/design/plugin-knowledge-worker-capabilities-2026-08.md §1 F1)。
 *
 * 为什么需要它:`api.storage` 是**平面 JSON**(name 禁 `/`,值必须整个读进来再
 * 整个写回去)。后台知识工人要的是另外两种形状 —— `candidates/*.jsonl`(只追加,
 * 不重写)与 `wiki/**\/*.md`(目录树)。用平面 KV 表达追加写,等于每次追加都把
 * 整份账本读出来再写回去:一次崩溃丢的不是一行,是整本。
 *
 * 四条裁决:
 *
 *  1. **不开第二个坐标系。** 地址空间就是 `plugins/<id>/storage/` ——
 *     theme background 的 `storage:<relpath>` 早已把它定为插件文件资产的坐标系
 *     (`PLUGIN_SCRATCH_DIR_NAME`)。files 面是**同一个目录**的读写口,不是新地盘。
 *
 *  2. **路径判据复用现成的两份,不写第三份。** 整条相对路径过
 *     `describePluginRelativeAssetPathProblem`(webview / file-pick 同源:挡 scheme、
 *     反斜杠、`%2e%2e` 编码变体、控制字符、`..` 段、绝对路径),然后**逐段**过
 *     `assertSafePluginFileName`(挡 Windows 保留设备名、ADS 分隔符、尾点尾空格、
 *     NFC 归一化绕过、宿主保留名)。第三份遍历防护 = 第三处会漂的判据。
 *
 *  3. **`appendText` 是 O_APPEND 行语义,不是读-改-写。** 这是 jsonl 的命根:
 *     读-改-写的实现在"另一个写者刚追加了一行"时会把那一行吃掉,而且**零告警**。
 *     宿主用 `fs.appendFileSync`(内核层 O_APPEND:偏移量在写的那一刻取,不是在
 *     打开的那一刻),`writeText` 则是 tmp + rename 的原子替换 —— 两条路的失败
 *     形态都不是"半个文件"。
 *
 *  4. **刻意不给 watch / 锁 / 多写者协调原语。** 单一写者是插件自己的架构纪律
 *     (Actor 模型)。宿主提供协调原语等于在鼓励多写者:两个写者一旦存在,
 *     jsonl 的追加语义、配额记账、乃至"这份文件现在是什么"都同时失去定义。
 *     真需要多写者的那天,那是一个新原型,另立设计。
 *
 * 全部**值语义、无句柄**:每个方法收字符串、回字符串/结构体,可无损 RPC 化 ——
 * H 线(子进程 ext host)那天,这个面一个字不用改就能搬到 RPC 上。它同时是硬隔离
 * 的前置:今天插件在主进程裸 `require('fs')` 也能写,受管口是让"沙箱化那天不断"
 * 的唯一路径。
 */
import fs from 'fs'
import path from 'path'
import { describePluginRelativeAssetPathProblem } from './webview.js'
import { getCoreLogger } from '../logging/index.js'

const log = getCoreLogger('core.plugins')

import {
  assertSafePluginFileName,
  getCorePluginScratchDir,
  PluginStorageError,
  type CorePluginStorageWithMessageState,
} from './storage.js'
import { PLUGIN_PERMISSION_STORAGE_EXTERNAL_ROOT } from './sessions.js'

/* ── 受管常量 ─────────────────────────────────────────────────────────────── */

/**
 * 整棵 `plugins/<id>/storage/` 树的配额,默认 50MB。
 *
 * 记在**树**上而不是每文件上:memory 的 candidates 是很多小行,wiki 是很多小页,
 * 按文件设限对这两种形状都没有意义,能说明问题的只有"这个插件一共占了多少"。
 */
export const PLUGIN_FILES_DEFAULT_QUOTA_BYTES = 50 * 1024 * 1024

/**
 * 预警线。**写满才拒是太晚的通知**:candidates 的 append 一旦失败,记忆就断流了,
 * 而插件与用户都毫无察觉(盲点清单 #8)。9 成时先发事件,让插件有机会自己 GC
 * (老 candidates 归档压缩),而不是等宿主替它决定丢什么。
 */
export const PLUGIN_FILES_QUOTA_WARNING_RATIO = 0.9

/**
 * 预警事件名。投递名是 `plugin:<pluginId>:storage:quota-warning`
 * (宿主借 `emitPluginEvent` 以该插件的命名空间发出),插件用 `api.on` 订阅。
 *
 * 借插件自己的命名空间而不是开一个全局事件:配额是**每插件**的事实,
 * 一个全局事件会让每个插件都收到别人的水位。
 */
export const PLUGIN_FILES_QUOTA_WARNING_EVENT = 'storage:quota-warning'

/** 单个文本文件的读写上限。超了抛 `quota` —— 与整树配额同一个错误族。 */
export const PLUGIN_FILES_MAX_FILE_BYTES = 8 * 1024 * 1024

/* ── 用户指定根(第二根)的声明门 ─────────────────────────────────────────── */

/**
 * `storage:external-root` —— 插件读写**用户亲手指定的一个目录**。
 *
 * 常量的事实源在 `sessions.ts`(那是渲染层直接引的零依赖叶子,而本文件吃 `node:fs`
 * ——把 fs 拖进渲染包只为一句英文文案是不值的)。这里原样再导出,读这边代码的人
 * 不必跳文件。
 *
 * 为什么必须是一道独立的权限:家目录(`plugins/<id>/storage/`)是宿主发给插件的
 * 沙盒,卸载即回收,用户不必知道里面有什么;而外部根是**用户自己的文件**
 * (比如 `~/data/note` 下的 wiki),他会亲手编辑、会用别的工具打开、会 git 提交。
 * 把这两件事放进同一个无声的口子,等于让"给插件一块草稿纸"顺手变成"给插件
 * 我的笔记本"。
 *
 * 只开**一个**根(不是路径列表):一个根能表达 wiki 的全部需求,而 N 个根会立刻
 * 引出"哪个是默认""跨根移动怎么算"这些没有用例支撑的问题。
 */
export {
  PLUGIN_PERMISSION_STORAGE_EXTERNAL_ROOT,
  PLUGIN_STORAGE_EXTERNAL_ROOT_PERMISSION_NOTE,
} from './sessions.js'

/* ── 形状 ─────────────────────────────────────────────────────────────────── */

/**
 * 寻址的根。缺省 `home` = 插件家目录里的 `storage/`。
 *
 * 显式参数而不是"两套方法名"(`readText` / `readExternalText`):方法名分叉会让
 * 每加一个动词就要加两个 —— 而根只是一个坐标系选择,不是一种新能力。
 */
export type CorePluginFilesRoot = 'home' | 'external'

export interface CorePluginFilesOptions {
  root?: CorePluginFilesRoot
}

/**
 * 读面的选项 —— 多一条 `tailBytes`。
 *
 * 单独一个类型而不是往 `CorePluginFilesOptions` 上加字段:写面/删面收下一个
 * 只对读有意义的参数,只会让"传了没生效"变成一个合法的写法。
 */
export interface CorePluginFilesReadOptions extends CorePluginFilesOptions {
  /**
   * 只读**末尾这么多字节**(截断点落在多字节字符中间时,开头的半个字符会被丢掉)。
   *
   * 给的是超限文件的出路:超过 `PLUGIN_FILES_MAX_FILE_BYTES` 的文件整份读会抛
   * `quota`,带上 `tailBytes` 则照读不误 —— 追加型账本要的本来也只是尾巴。
   * 上限自身封顶(给再大也不会读超过 8MB)。
   */
  tailBytes?: number
}

export interface CorePluginFileEntry {
  /** 相对**根**的路径(不是绝对路径 —— 插件永远拿不到用户的目录结构)。 */
  path: string
  /** 最后一段的名字。 */
  name: string
  kind: 'file' | 'directory'
  /** 目录恒为 0。 */
  size: number
  modifiedAt: number
}

export interface CorePluginFilesUsage {
  /** 家目录 `storage/` 树的当前占用。外部根不计(那是用户的目录)。 */
  bytes: number
  quotaBytes: number
}

export interface CorePluginFiles {
  /**
   * 不存在 → undefined(与 `readJson` 的 fallback 语义同规:缺席不是错误)。
   * 超过单文件上限 → `quota`,除非带 `tailBytes` 只取尾巴。
   */
  readText(relPath: string, options?: CorePluginFilesReadOptions): string | undefined
  /** 原子替换(tmp + rename):中断留下的要么是旧内容要么是新内容,不会是半个。 */
  writeText(relPath: string, content: string, options?: CorePluginFilesOptions): void
  /** O_APPEND 追加。**不读、不改、不重写**,并发追加不互相吞行。 */
  appendText(relPath: string, content: string, options?: CorePluginFilesOptions): void
  /** 列一层(不递归)。目录不存在 → 空数组。 */
  list(relDir?: string, options?: CorePluginFilesOptions): CorePluginFileEntry[]
  exists(relPath: string, options?: CorePluginFilesOptions): boolean
  /** 删文件或空目录;不存在 = 无操作(幂等,重放安全)。 */
  remove(relPath: string, options?: CorePluginFilesOptions): void
  /** 配额观测面(插件可自查,测试也用它)。 */
  usage(): CorePluginFilesUsage
}

/**
 * 插件侧 `api.storage` 的完整面 = KV + 消息作用域状态 + **受管文件树**。
 *
 * 批 A 把 `files` 挂进了 api 对象却没挂进类型:于是插件作者写
 * `api.storage.files.appendText(...)` 时,运行期是对的、类型上却不存在 ——
 * 一个"实现已经有、契约还没承认"的缺口。合成的类型放在这里而不是 storage.ts,
 * 是因为依赖方向:storage-files 认识 storage,反过来不认识。
 */
export interface CorePluginStorageWithFiles extends CorePluginStorageWithMessageState {
  files: CorePluginFiles
}

export interface CreateCorePluginFilesOptions {
  pluginId: string
  /** 家目录根 `<store>/plugins/`;`storage/` 由本模块自己拼。 */
  homeRoot: string
  /** 整树配额,缺省 50MB(政策表可按插件放宽)。 */
  quotaBytes?: number
  /** manifest 是否声明了 `storage:external-root`。未声明 → 外部根一律结构化拒绝。 */
  externalRootDeclared?: boolean
  /**
   * 用户在插件设置里选的目录(`format: 'directory-pick'` 的那个字段)。
   * **每次调用现取**:用户随时可能改这个设置,缓存一份等于让改完之后的写还落在
   * 旧目录里,而界面显示的是新目录。
   */
  resolveExternalRoot?: () => string | undefined
  /** §7.4 拆除闩:卸载/停用完成后到的写 = warn + 静默丢弃(与 KV / message-state 同一条闩)。 */
  isDisposed?: () => boolean
  /** 越过预警线时回调一次(宿主把它翻译成插件命名空间的事件)。 */
  onQuotaWarning?: (usage: CorePluginFilesUsage) => void
}

/* ── 判据 ─────────────────────────────────────────────────────────────────── */

/**
 * 一条相对路径的判据 —— **两份现成判据的合取**,这里一行新逻辑都不写。
 *
 * 顺序有意义:先整条(挡 scheme / `%2e%2e` / `..` 段 / 绝对路径 / 反斜杠),
 * 再逐段(挡设备名 / ADS / 尾点 / 保留名)。反过来的话,`..` 会先被当成一个
 * 普通段名交给单段判据,而那份判据的报错说的是"不能是路径",人读了会更糊涂。
 */
export function describePluginFilesPathProblem(
  relPath: unknown,
  label = 'path',
): string | null {
  const problem = describePluginRelativeAssetPathProblem(relPath, label)
  if (problem) return problem
  for (const segment of (relPath as string).split('/')) {
    try {
      assertSafePluginFileName(segment)
    } catch (error) {
      return `${label} segment "${segment}": ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return null
}

function invalidName(message: string): PluginStorageError {
  return new PluginStorageError('invalid-name', message)
}

function ioError(message: string, cause: unknown): PluginStorageError {
  const nativeCode = (cause as { code?: string } | undefined)?.code
  return new PluginStorageError('io', nativeCode ? `${message} (${nativeCode})` : message, { cause })
}

/* ── 归因车道 ─────────────────────────────────────────────────────────────── */

/**
 * 一个存储错误是**谁的问题**。
 *
 * 同一个 code 在两个根上说的不是同一件事:家目录(`plugins/<id>/storage/`)是宿主
 * 发给插件的沙盒,那里的 `quota` / `invalid-name` / `io` 只可能是插件自己写出来的;
 * 而外部根是**用户亲手选的目录** —— 那里的 `io`(用户把文件 chmod 掉了)、
 * `quota`(用户手编到 9MB)、`invalid-name`(用户把 `index.md` 换成了一个目录)
 * 描述的是**用户文件此刻的状态**,不是插件的过错。
 *
 * 为什么非分不可(2026-08-12):注入面每 30s 读一次外部根,约 90 秒就能攒满三次
 * 失败把整个插件熔断 —— 用户动了自己的一个文件,插件就被宿主杀掉,而插件什么都
 * 没做错。按 code 一刀切豁免则会连"路径穿越"一起放走,那是必须记账的插件行为。
 *
 * 判定放在**抛错的这一侧**(只有这里知道寻址的是哪个根),`api-builder` 只读结论:
 * `user` 车道照抛不误(调用方必须知道),只是不进熔断账。
 */
export type CorePluginFilesFaultLane = 'plugin' | 'user'

/**
 * 挂在错误对象上的标记。`Symbol.for` 而不是普通字段:它不会被 `JSON.stringify` /
 * 日志序列化带出去,也不会和插件自己往 error 上挂的东西撞名。
 */
const FILES_FAULT_LANE = Symbol.for('onething.plugin.files.fault-lane')

/** 打标。**先到先得** —— 内层已经判过归属的错误,不该被外层的默认值盖掉。 */
function markFilesFault<E>(error: E, lane: CorePluginFilesFaultLane): E {
  if (!error || typeof error !== 'object') return error
  if (FILES_FAULT_LANE in (error as object)) return error
  Object.defineProperty(error, FILES_FAULT_LANE, { value: lane, configurable: true })
  return error
}

/** 读标。未标记 → `undefined`(调用方按既有规则处理,不猜)。 */
export function getPluginFilesFaultLane(error: unknown): CorePluginFilesFaultLane | undefined {
  if (!error || typeof error !== 'object') return undefined
  const lane = (error as Record<symbol, unknown>)[FILES_FAULT_LANE]
  return lane === 'plugin' || lane === 'user' ? lane : undefined
}

/**
 * `not-configured` 的两种真相(2026-08-12 审查第 7 条):
 *
 *  - `unconfigured`:**从没配置过**(或配置值不成形)。正确的出路是让用户去
 *    设置里选目录。
 *  - `unreachable`:**配置过但此刻够不着**(外接盘未挂载、目录被移动/换名)。
 *    此时诱导用户"重新选一个"是最坏的建议 —— 新根一开张记忆就分叉了。
 *
 * 同一个 code 走两条人话,靠这个标分流。机制与 fault-lane 同款(Symbol.for,
 * 不进序列化、不与插件自挂字段撞名)。
 */
export type CorePluginFilesRefusalKind = 'unconfigured' | 'unreachable'

const FILES_REFUSAL_KIND = Symbol.for('onething.plugin.files.refusal-kind')

function withRefusalKind<E>(error: E, kind: CorePluginFilesRefusalKind): E {
  if (!error || typeof error !== 'object') return error
  Object.defineProperty(error, FILES_REFUSAL_KIND, { value: kind, configurable: true })
  return error
}

/** 读标。未标记 → `undefined`(老错误/别处抛的 not-configured 按 unconfigured 的旧文案走)。 */
export function getPluginFilesRefusalKind(error: unknown): CorePluginFilesRefusalKind | undefined {
  if (!error || typeof error !== 'object') return undefined
  const kind = (error as Record<symbol, unknown>)[FILES_REFUSAL_KIND]
  return kind === 'unconfigured' || kind === 'unreachable' ? kind : undefined
}

/**
 * 插件侧过错的快捷抛法。**与根无关**:路径穿越、软链逃逸、未声明权限、参数写错 ——
 * 这些在用户的目录里也一样是插件的行为,不能借"外根 = 用户地盘"混过熔断账。
 */
function pluginFault<E>(error: E): E {
  return markFilesFault(error, 'plugin')
}

/**
 * 软链逃逸的复核 —— 字符串判据挡不住的那一半。
 *
 * `wiki/notes` 这个名字完全合法,但它可以是一条指向 `~/.ssh` 的软链:判据看的是
 * 声明,realpath 看的是磁盘上的事实。所以每次落地前都从**最深的已存在祖先**取
 * realpath 复核前缀 —— 只取已存在的那一段,是因为写新文件时目标本身还不存在,
 * 而 `realpathSync` 对不存在的路径直接抛。
 *
 * **"存在"必须用 `lstat` 判,不能用 `existsSync`**(2026-08-12 修):`existsSync`
 * 跟链,于是一条**悬空**软链(链在、目标不在)被读成"这一段还不存在",整段
 * realpath 复核就此跳过。而 `appendText` 的 `fs.appendFileSync` 在 open 的那一刻
 * 是**跟链**的,还带 O_CREAT —— 链指向 `~/.zshenv` 这种"今天不存在、父目录存在"
 * 的路径时,宿主就替插件在根**外面**创建并写入了那个文件。`lstat` 不跟链,悬空链
 * 因此会被当成"这一段存在"而进入复核。
 */
function assertResolvedInsideRoot(root: string, target: string): void {
  let realRoot: string
  try {
    realRoot = fs.realpathSync.native(root)
  } catch {
    // 根自己都还不存在(第一次写):没有可逃逸的软链,字符串判据已经够了。
    return
  }

  let probe = target
  let probeIsLink = false
  for (;;) {
    let stat: fs.Stats | undefined
    try {
      stat = fs.lstatSync(probe)
    } catch {
      stat = undefined
    }
    if (stat) {
      probeIsLink = stat.isSymbolicLink()
      break
    }
    const parent = path.dirname(probe)
    if (parent === probe) return
    probe = parent
  }

  let realProbe: string
  try {
    realProbe = fs.realpathSync.native(probe)
  } catch (error) {
    if (probeIsLink) {
      // 悬空链:目标今天不存在,所以"它在不在根内"这个问题现在没有答案 —— 而
      // 明天别人(用户、另一个程序、乃至这次写本身)就可能把它创建出来。判不了就拒。
      throw pluginFault(invalidName(
        'path goes through a dangling symlink whose target cannot be resolved '
        + '(a link that resolves to nothing today can resolve outside the root tomorrow)',
      ))
    }
    throw ioError(`Cannot resolve "${probe}"`, error)
  }
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) {
    throw pluginFault(invalidName(
      'path escapes the plugin storage root through a symlink '
      + '(the name is legal, the link is not)',
    ))
  }
}

/**
 * `tailBytes` 的判据 —— 超限文件的**唯一出路**。
 *
 * 8MB 是"一次读进内存"的上限,不该是"这个文件从此不可读"的判决:追加型账本迟早
 * 会长过它,用户手编的 wiki 页也可能长过它,而那一刻插件连自己写的东西都读不回来
 * (2026-08-12 修:写侧守门 + 读侧留出路,两条一起才消灭"可写不可读")。
 */
function normalizeTailBytes(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw pluginFault(invalidName('tailBytes must be a positive integer number of bytes'))
  }
  return Math.min(value, PLUGIN_FILES_MAX_FILE_BYTES)
}

/**
 * 读文件末尾 N 字节。截断点可能落在一个多字节字符中间,所以丢掉开头的续字节
 * (`10xxxxxx`)—— 否则返回值的第一个字符是 U+FFFD,而插件多半会把它当成正文。
 */
function readTailText(file: string, size: number, tailBytes: number): string {
  const start = Math.max(0, size - tailBytes)
  const length = size - start
  if (length <= 0) return ''
  const buffer = Buffer.allocUnsafe(length)
  const fd = fs.openSync(file, 'r')
  let read: number
  try {
    read = fs.readSync(fd, buffer, 0, length, start)
  } finally {
    fs.closeSync(fd)
  }
  let slice = buffer.subarray(0, read)
  if (start > 0) {
    let offset = 0
    while (offset < slice.length && (slice[offset]! & 0xc0) === 0x80) offset += 1
    slice = slice.subarray(offset)
  }
  return slice.toString('utf-8')
}

/* ── 实现 ─────────────────────────────────────────────────────────────────── */

function walkTreeBytes(dir: string): number {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += walkTreeBytes(full)
      continue
    }
    if (!entry.isFile()) continue
    try {
      total += fs.statSync(full).size
    } catch {
      // 扫描期间被删掉的文件不该让整轮记账失败。
    }
  }
  return total
}

export function createCorePluginFiles(options: CreateCorePluginFilesOptions): CorePluginFiles {
  const { pluginId, homeRoot } = options
  const quotaBytes = options.quotaBytes ?? PLUGIN_FILES_DEFAULT_QUOTA_BYTES
  const homeStorageRoot = getCorePluginScratchDir(homeRoot, pluginId)

  /**
   * 家目录树的字节数。首次用到时整树扫一次,之后按写/删的**实际文件尺寸**增量维护。
   *
   * 增量而不是每次重扫:candidates 的写是高频小写,每次重扫整棵 wiki 树会让
   * 追加一行的成本正比于长期记忆的总量 —— 越用越慢正是这个系统最不能有的性质。
   * 增量的前提正是 F1 的那条纪律:**单一写者**。别人在这棵树里乱写,记账当然会偏,
   * 而那本来就不是一个受支持的用法。
   */
  let cachedBytes: number | undefined
  let quotaWarned = false

  const totalBytes = (): number => {
    if (cachedBytes === undefined) cachedBytes = walkTreeBytes(homeStorageRoot)
    return cachedBytes
  }

  const usage = (): CorePluginFilesUsage => ({ bytes: totalBytes(), quotaBytes })

  const noteBytesDelta = (delta: number): void => {
    cachedBytes = Math.max(0, totalBytes() + delta)
    if (cachedBytes < quotaBytes * PLUGIN_FILES_QUOTA_WARNING_RATIO) {
      // 掉回线下就复位:插件 GC 完之后再逼近才算新的一次预警,
      // 否则一个插件一辈子只会收到一条预警。
      quotaWarned = false
      return
    }
    if (quotaWarned) return
    quotaWarned = true
    try {
      options.onQuotaWarning?.({ bytes: cachedBytes, quotaBytes })
    } catch (error) {
      log.error('quota warning handler failed', { pluginId }, error)
    }
  }

  let demolitionWarned = false
  const demolished = (): boolean => {
    if (!options.isDisposed?.()) return false
    if (!demolitionWarned) {
      demolitionWarned = true
      log.warn('ignoring file writes after teardown', { pluginId })
    }
    return true
  }

  /** 外部根:声明门 → 配置门 → 目录门。三道都给结构化错误,不假装成功。 */
  const externalRoot = (): string => {
    if (!options.externalRootDeclared) {
      // manifest 少写了一行 = 作者的问题,照记熔断账(与路径穿越同规)。
      throw pluginFault(new PluginStorageError(
        'not-declared',
        `Plugin "${pluginId}" must declare "${PLUGIN_PERMISSION_STORAGE_EXTERNAL_ROOT}" in `
        + 'contributes.permissions to address the external root',
      ))
    }
    const configured = options.resolveExternalRoot?.()
    if (typeof configured !== 'string' || !configured.trim()) {
      throw withRefusalKind(new PluginStorageError(
        'not-configured',
        `Plugin "${pluginId}" has no external folder selected yet (the user picks it in the plugin settings)`,
      ), 'unconfigured')
    }
    const resolved = path.resolve(configured.trim())
    if (!path.isAbsolute(resolved)) {
      throw withRefusalKind(
        new PluginStorageError('not-configured', `The external folder for "${pluginId}" must be an absolute path`),
        'unconfigured',
      )
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(resolved)
    } catch (error) {
      /**
       * **「配置过但现在够不着」≠「从没配置过」**(2026-08-12 审查第 7 条)。
       * 外接盘未挂载、目录被移动时走的是这一支 —— 把它说成"还没配置,请去
       * 设置里选一个"会诱导用户另选新目录,记忆从此分叉(新事实进新根,旧根
       * 挂载回来后静默回归)。code 维持 not-configured(下游 catch 口径不变、
       * 熔断豁免不变),但打上 kind 标让消息层分得开两种真相。
       */
      throw withRefusalKind(new PluginStorageError(
        'not-configured',
        `The external folder for "${pluginId}" does not exist: ${resolved}`,
        { cause: error },
      ), 'unreachable')
    }
    if (!stat.isDirectory()) {
      throw withRefusalKind(
        new PluginStorageError('not-configured', `The external folder for "${pluginId}" is not a directory: ${resolved}`),
        'unreachable',
      )
    }
    return resolved
  }

  const rootOf = (input?: CorePluginFilesOptions): { dir: string; metered: boolean } => {
    const root = input?.root ?? 'home'
    if (root === 'home') return { dir: homeStorageRoot, metered: true }
    if (root === 'external') {
      // **外部根不吃配额**:那是用户自己的目录,配额是宿主发的那块草稿纸的事。
      // 在用户的笔记本上记一本"你还能写多少"是越权的。
      return { dir: externalRoot(), metered: false }
    }
    throw pluginFault(invalidName(`Unknown storage root "${String(root)}" (use "home" or "external")`))
  }

  /** 相对路径 → 绝对路径。判据 + 软链复核都在这一道,别处不许再 join。 */
  const resolveIn = (
    relPath: unknown,
    input: CorePluginFilesOptions | undefined,
    label: string,
  ): { full: string; root: string; metered: boolean } => {
    const { dir, metered } = rootOf(input)
    const problem = describePluginFilesPathProblem(relPath, label)
    // 路径判据的失败是插件写错了地址,在用户的目录里也一样 —— 显式打 plugin 标,
    // 免得被"外根 = 用户地盘"的默认车道放走。
    if (problem) throw pluginFault(invalidName(problem))
    const full = path.join(dir, relPath as string)
    assertResolvedInsideRoot(dir, full)
    return { full, root: dir, metered }
  }

  /**
   * 这次调用寻址的是**谁的地盘**:家目录 = 宿主发的沙盒(出事算插件的),
   * 外部根 = 用户亲手选的目录(那里的文件状态不是插件能决定的)。
   *
   * 只作**默认值**:已经在里层判过归属的错误(路径穿越、未声明权限、参数写错)
   * 带着自己的标走完全程,`markFilesFault` 先到先得。
   */
  const laneOf = (input?: CorePluginFilesOptions): CorePluginFilesFaultLane =>
    (input?.root === 'external' ? 'user' : 'plugin')

  /** 每个动词的唯一归因落点。写在这里,六个动词就不必各自记得打标。 */
  const inLane = <T>(input: CorePluginFilesOptions | undefined, run: () => T): T => {
    try {
      return run()
    } catch (error) {
      throw markFilesFault(error, laneOf(input))
    }
  }

  const sizeOf = (file: string): number => {
    try {
      const stat = fs.statSync(file)
      return stat.isFile() ? stat.size : 0
    } catch {
      return 0
    }
  }

  const assertTextSize = (content: string, what: string): number => {
    if (typeof content !== 'string') {
      throw invalidName(`${what} content must be a string`)
    }
    const bytes = Buffer.byteLength(content, 'utf-8')
    if (bytes > PLUGIN_FILES_MAX_FILE_BYTES) {
      throw new PluginStorageError(
        'quota',
        `${what} is ${bytes} bytes, over the ${PLUGIN_FILES_MAX_FILE_BYTES}-byte per-file limit`,
      )
    }
    return bytes
  }

  const assertQuota = (nextTotal: number): void => {
    if (nextTotal <= quotaBytes) return
    throw new PluginStorageError(
      'quota',
      `Plugin "${pluginId}" storage would reach ${nextTotal} bytes, over its ${quotaBytes}-byte quota`,
    )
  }

  const ensureParent = (full: string): void => {
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true })
    } catch (error) {
      throw ioError(`Cannot create the directory for "${full}"`, error)
    }
  }

  return {
    readText(relPath: string, input?: CorePluginFilesReadOptions): string | undefined {
      return inLane(input, () => {
        const { full } = resolveIn(relPath, input, 'path')
        const tailBytes = normalizeTailBytes(input?.tailBytes)
        if (!fs.existsSync(full)) return undefined
        try {
          const stat = fs.statSync(full)
          if (!stat.isFile()) {
            throw invalidName(`"${relPath}" is a directory, not a file`)
          }
          // 尾读优先于上限:上限管的是"一次读进内存多少",而 tailBytes 已经把
          // 这件事封顶了 —— 再拿整份大小去拒,就又回到"可写不可读"。
          if (tailBytes !== undefined) return readTailText(full, stat.size, tailBytes)
          if (stat.size > PLUGIN_FILES_MAX_FILE_BYTES) {
            throw new PluginStorageError(
              'quota',
              `"${relPath}" is ${stat.size} bytes, over the ${PLUGIN_FILES_MAX_FILE_BYTES}-byte read limit`
              + ' — pass { tailBytes } to read the tail of an oversized file',
            )
          }
          return fs.readFileSync(full, 'utf-8')
        } catch (error) {
          if (error instanceof PluginStorageError) throw error
          throw ioError(`Cannot read "${relPath}" for "${pluginId}"`, error)
        }
      })
    },

    writeText(relPath: string, content: string, input?: CorePluginFilesOptions): void {
      if (demolished()) return
      inLane(input, () => {
        const { full, metered } = resolveIn(relPath, input, 'path')
        const nextBytes = assertTextSize(content, `"${relPath}"`)
        if (metered) assertQuota(totalBytes() - sizeOf(full) + nextBytes)
        ensureParent(full)

        // 原子替换:同目录 tmp + rename。跨目录 tmp 会撞 EXDEV,而 rename 之所以
        // 值得,正是因为它在同一个文件系统里是原子的。
        const tmp = `${full}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
        const previous = metered ? sizeOf(full) : 0
        try {
          fs.writeFileSync(tmp, content, 'utf-8')
          fs.renameSync(tmp, full)
        } catch (error) {
          try {
            fs.rmSync(tmp, { force: true })
          } catch {
            // 清不掉临时文件不该盖住真正的失败原因。
          }
          throw ioError(`Cannot write "${relPath}" for "${pluginId}"`, error)
        }
        if (metered) noteBytesDelta(nextBytes - previous)
      })
    },

    appendText(relPath: string, content: string, input?: CorePluginFilesOptions): void {
      if (demolished()) return
      inLane(input, () => {
        const { full, metered } = resolveIn(relPath, input, 'path')
        const nextBytes = assertTextSize(content, `"${relPath}" append`)
        // **累计**校验,不只是这一块(2026-08-12 修)。只看单块的话,一个只追加的
        // 账本会一路长过单文件上限,此后 readText 一律抛 quota —— 文件从此**可写
        // 不可读**,而写的那一侧毫无察觉。守门放在写侧:越线的那一笔当场被拒,
        // 插件还来得及归档/滚动到新文件。
        const existing = sizeOf(full)
        if (existing + nextBytes > PLUGIN_FILES_MAX_FILE_BYTES) {
          throw new PluginStorageError(
            'quota',
            `"${relPath}" is ${existing} bytes; appending ${nextBytes} more would cross the `
            + `${PLUGIN_FILES_MAX_FILE_BYTES}-byte per-file limit — archive this file or roll over to a new one`,
          )
        }
        if (metered) assertQuota(totalBytes() + nextBytes)
        ensureParent(full)
        try {
          // `appendFileSync` = open(O_APPEND) + write + close。偏移量在**写的那一刻**
          // 由内核取,所以两个写者交替追加时谁也吃不掉谁的行。绝不能改成
          // readFileSync + writeFileSync —— 那正是"吞行"的写法。
          fs.appendFileSync(full, content, { encoding: 'utf-8' })
        } catch (error) {
          throw ioError(`Cannot append to "${relPath}" for "${pluginId}"`, error)
        }
        if (metered) noteBytesDelta(nextBytes)
      })
    },

    list(relDir?: string, input?: CorePluginFilesOptions): CorePluginFileEntry[] {
      return inLane(input, () => {
        const { dir } = rootOf(input)
        let base = dir
        let prefix = ''
        if (relDir !== undefined && relDir !== '' && relDir !== '.') {
          const resolved = resolveIn(relDir, input, 'dir')
          base = resolved.full
          prefix = `${relDir}/`
        } else {
          assertResolvedInsideRoot(dir, dir)
        }

        let entries: fs.Dirent[]
        try {
          entries = fs.readdirSync(base, { withFileTypes: true })
        } catch {
          // 目录不存在 = 空,不是错误:插件第一次跑时 candidates/ 本来就还没有。
          return []
        }

        const result: CorePluginFileEntry[] = []
        for (const entry of entries) {
          // 软链一律不列:列出来插件就会去读它,而它可能指向根外面。
          if (entry.isSymbolicLink()) continue
          const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : null
          if (!kind) continue
          let size = 0
          let modifiedAt = 0
          try {
            const stat = fs.statSync(path.join(base, entry.name))
            size = kind === 'file' ? stat.size : 0
            modifiedAt = stat.mtimeMs
          } catch {
            continue
          }
          result.push({ path: `${prefix}${entry.name}`, name: entry.name, kind, size, modifiedAt })
        }
        return result.sort((a, b) => a.path.localeCompare(b.path))
      })
    },

    exists(relPath: string, input?: CorePluginFilesOptions): boolean {
      return inLane(input, () => {
        const { full } = resolveIn(relPath, input, 'path')
        return fs.existsSync(full)
      })
    },

    remove(relPath: string, input?: CorePluginFilesOptions): void {
      if (demolished()) return
      inLane(input, () => {
        const { full, metered } = resolveIn(relPath, input, 'path')
        if (!fs.existsSync(full)) return
        const freed = metered ? sizeOf(full) : 0
        try {
          const stat = fs.statSync(full)
          if (stat.isDirectory()) {
            // 只删**空**目录。递归删除是"一个路径错误 = 整棵 wiki 消失"的形状,
            // 而插件的删除动作没有任何撤销面。要清空,一层层来。
            fs.rmdirSync(full)
          } else {
            fs.rmSync(full, { force: true })
          }
        } catch (error) {
          throw ioError(`Cannot remove "${relPath}" for "${pluginId}"`, error)
        }
        if (metered && freed) noteBytesDelta(-freed)
      })
    },

    usage,
  }
}
