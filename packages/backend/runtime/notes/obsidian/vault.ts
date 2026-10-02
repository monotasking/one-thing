/**
 * 一个 Obsidian 库。
 *
 * ## 一条策略,三个后果
 *
 * **每个读方法先探活。** 活着 → 问 CLI,并把读到的配置写进快照;没活 → 读快照,
 * 用快照**复现**三条语义(日记路径 / 附件落点 / 链接文本);连快照都没有 → 抛
 * `NoteVaultUnavailable('no-snapshot')`。
 *
 * 为什么不是「没活就返回 undefined」:调用方(检索、附件、变量板)要么拿到一个
 * 诚实的答案,要么拿到一个诚实的拒绝。悄悄给一个猜的路径,用户的附件就落到了
 * 一个 Obsidian 不认的地方。
 *
 * **前台动作(建日记 / 建笔记 / 追加 / 打开)是另一类。** 它们由用户主动触发,
 * 所以允许拉起 app —— 但必须调用方显式说 `mayLaunch: true`。缺省 false。
 *
 * 缺省值往下**原样透传给 CLI**(2026-09-18 review 打回的第一条):从前这里查完
 * `isOpen` 就把 `{ mayLaunch: true }` 写死递下去,于是「`obsidian.json` 标着
 * `open:true`、但用户已经退出了 Obsidian」这一档(那个标是上次运行留下的)会
 * 在一次缺省的 `createDailyNote()` 上 spawn 一次、把 Obsidian 拉起来 —— 正是
 * 纪律 4 禁止的事。现在缺省走 `ObsidianCli.run` 自己那道探活闸,探不活抛
 * `system-not-running`;真要拉起就由调用方说 `mayLaunch: true`。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { BasenameIndex } from '../basename-index.js'
import { formatDailyDate } from '../daily-format.js'
import { buildLinkText, isMarkdownNote, resolveAttachmentFolder, toLinkPathStyle, uniqueAttachmentName } from '../link-format.js'
import { normalizeVaultRoot } from '../paths.js'
import {
  DEFAULT_NOTES_DAILY_FORMAT,
  NoteVaultUnavailable,
  type DailyNoteRef,
  type NoteForegroundOptions,
  type NoteHit,
  type NoteInit,
  type NoteLinkKind,
  type NoteLiveSearchOptions,
  type NoteReadOptions,
  type NoteVault,
  type NoteVaultUnavailableReason,
} from '../types.js'
import type { ObsidianCli } from './cli.js'
import type { ObsidianVaultRecord } from './registry.js'
import {
  attachmentPathScript,
  dailyNoteScript,
  dailyNotesOptionsScript,
  markdownLinkScript,
  resolveLinkScript,
  vaultConfigScript,
  type ObsidianDailyNotesOptions,
  type ObsidianVaultConfigRead,
} from './scripts.js'
import type { ObsidianVaultSnapshot, SnapshotStore } from './snapshot.js'

export const OBSIDIAN_SYSTEM_ID = 'obsidian'

export interface ObsidianVaultLogger {
  warn(message: string, fields?: Record<string, unknown>, error?: unknown): void
  debug(message: string, fields?: Record<string, unknown>): void
}

export interface ObsidianVaultOptions {
  record: ObsidianVaultRecord
  cli: ObsidianCli
  snapshots: SnapshotStore
  /** 名字。缺省 = 库根的最后一段。 */
  name?: string
  logger?: ObsidianVaultLogger
  now?: () => number
}

/**
 * 零命中时 `search:context` 的原话(2026-09-18 本机 1.13.7 实测)。
 *
 * 整段就这一句,不带 `Error:` 前缀 —— 与 `Vault not found.` 同一种说话方式,
 * 所以也要单独认一次。
 */
const NO_MATCHES = 'No matches found.'

/** `search:context format=json` 的返回形状。 */
interface ObsidianSearchHit {
  file?: unknown
  matches?: Array<{ line?: unknown; text?: unknown }>
}

export class ObsidianVault implements NoteVault {
  readonly id: string
  readonly name: string
  readonly root: string
  readonly system = OBSIDIAN_SYSTEM_ID

  /**
   * 最近一次读配置是降级读的吗。
   *
   * 它是**状态**而不是构造参数:同一个库在一分钟里可以从「Obsidian 活着」变成
   * 「用户退出了 Obsidian」。调用方读到的是最后一次真实观察的结果。
   */
  private lastDegraded: NoteVaultUnavailableReason | undefined
  private readonly index: BasenameIndex

  constructor(private readonly options: ObsidianVaultOptions) {
    this.id = options.record.id
    this.root = normalizeVaultRoot(options.record.path)
    this.name = options.name ?? path.basename(this.root) ?? options.record.id
    this.index = new BasenameIndex(this.root)
  }

  get degraded(): NoteVaultUnavailableReason | undefined {
    return this.lastDegraded
  }

  /** `obsidian.json` 说这个库开着。 */
  get isOpen(): boolean {
    return this.options.record.open
  }

  /**
   * **后台路径能不能问 CLI** —— 全类唯一的判据,六处读方法都问它。
   *
   * 两个条件的合取,缺一不可:库开着(不然发命令 = 弹出那个库的窗口)且 app
   * 活着(不然发命令 = 把 Obsidian 拉起来)。任何一条不成立都走降级路。
   */
  private async canQueryLive(): Promise<boolean> {
    if (!this.isOpen) return false
    return (await this.options.cli.isAlive()) === true
  }

  // ── 配置:一次读,两条路 ───────────────────────────────

  /**
   * 这个库的配置。活着问 CLI(顺手写快照),没活读快照,都没有就抛。
   *
   * 这是**全类唯一**的配置产地 —— 下面三条语义都从它出发,所以「活着的答案」与
   * 「降级的答案」不会各走各的。
   */
  private async config(options: NoteReadOptions = {}): Promise<ObsidianVaultSnapshot> {
    // `offline` 连探活都不做:探活是一次 socket 连接(便宜),但它之后那一步是
    // 一次 `spawn`,而 offline 的契约是「不出进程」。一句话判掉,不留缝。
    const live = options.offline === true ? false : await this.canQueryLive()
    if (live) {
      try {
        const snapshot = await this.captureSnapshot()
        this.lastDegraded = undefined
        return snapshot
      } catch (error) {
        // 活着但问不出来(eval 被禁、版本变了):退回快照,别把整条读路弄红。
        this.options.logger?.warn('reading obsidian config failed; falling back to the snapshot', { vaultId: this.id }, error)
      }
    }
    const snapshot = await this.options.snapshots.read(this.id)
    if (!snapshot) throw new NoteVaultUnavailable('no-snapshot', this.id)
    // offline 读不改 `degraded` —— 那一格说的是「Obsidian 现在怎么样」,而
    // offline 是**调用方自己**选的读法,与 app 的死活无关。
    if (options.offline !== true) {
      this.lastDegraded = await this.degradeReason()
    }
    return snapshot
  }

  /**
   * 这次为什么降级了。**库没开着排在最前面** —— 那是比「app 没跑」更具体的答案,
   * 而且它在 app 活着的时候也成立。
   */
  private async degradeReason(): Promise<NoteVaultUnavailableReason> {
    if (!this.isOpen) return 'vault-not-open'
    const alive = await this.options.cli.isAlive()
    return alive === null ? 'cli-not-registered' : 'system-not-running'
  }

  /** 问一遍 Obsidian 并落一份快照。只在确定「库开着 + app 活着」时调。 */
  private async captureSnapshot(): Promise<ObsidianVaultSnapshot> {
    const [vaultConfig, dailyOptions] = await Promise.all([
      this.options.cli.eval<ObsidianVaultConfigRead>(this.id, vaultConfigScript()),
      this.options.cli.eval<ObsidianDailyNotesOptions | null>(this.id, dailyNotesOptionsScript()),
    ])
    const snapshot: ObsidianVaultSnapshot = {
      dailyFolder: (dailyOptions?.folder ?? '').replace(/^\/+|\/+$/g, ''),
      dailyFormat: dailyOptions?.format || DEFAULT_NOTES_DAILY_FORMAT,
      dailyTemplate: dailyOptions?.template || undefined,
      attachmentFolderPath: vaultConfig.attachmentFolderPath ?? '',
      useMarkdownLinks: vaultConfig.useMarkdownLinks === true,
      newLinkFormat: vaultConfig.newLinkFormat ?? 'shortest',
      capturedAt: (this.options.now ?? Date.now)(),
    }
    await this.options.snapshots.write(this.id, snapshot)
    return snapshot
  }

  // ── 后台可读的四件 ────────────────────────────────────

  async dailyNote(date: Date = new Date(), options: NoteReadOptions = {}): Promise<DailyNoteRef> {
    const config = await this.config(options)
    const fileName = `${formatDailyDate(config.dailyFormat, date)}.md`
    const absolute = path.join(this.root, config.dailyFolder, fileName)
    return { path: absolute, exists: await pathExists(absolute) }
  }

  async attachmentPathFor(fileName: string, sourceDoc: string): Promise<string> {
    const relativeSource = this.toVaultRelative(sourceDoc)
    if (await this.canQueryLive()) {
      try {
        const relative = await this.options.cli.eval<string>(
          this.id,
          attachmentPathScript(fileName, relativeSource),
        )
        this.lastDegraded = undefined
        return path.join(this.root, relative)
      } catch (error) {
        this.options.logger?.warn('asking obsidian for the attachment path failed; computing it locally', { vaultId: this.id }, error)
      }
    }
    // 降级:按快照里的 `attachmentFolderPath` 复现同一套语义 + 同一套让名。
    const config = await this.config()
    const folder = resolveAttachmentFolder(config.attachmentFolderPath, relativeSource)
    const directory = path.join(this.root, folder)
    const existing = new Set(await listDirectoryNames(directory))
    return path.join(directory, uniqueAttachmentName(fileName, candidate => existing.has(candidate)))
  }

  async linkTextFor(target: string, sourceDoc: string, kind: NoteLinkKind): Promise<string> {
    const relativeTarget = this.toVaultRelative(target)
    const relativeSource = this.toVaultRelative(sourceDoc)
    if (await this.canQueryLive()) {
      try {
        const text = await this.options.cli.evalText(
          this.id,
          markdownLinkScript(relativeTarget, relativeSource),
        )
        if (text) {
          this.lastDegraded = undefined
          return kind === 'embed' && !text.startsWith('!') ? `!${text}` : text
        }
      } catch (error) {
        this.options.logger?.warn('asking obsidian for the link text failed; computing it locally', { vaultId: this.id }, error)
      }
    }
    const config = await this.config()
    return buildLinkText(relativeTarget, relativeSource, kind, {
      useMarkdownLinks: config.useMarkdownLinks,
      pathStyle: toLinkPathStyle(config.newLinkFormat),
    })
  }

  async resolveByName(name: string, sourceDoc: string): Promise<string | null> {
    if (await this.canQueryLive()) {
      try {
        const relative = await this.options.cli.evalText(
          this.id,
          resolveLinkScript(name, this.toVaultRelative(sourceDoc)),
        )
        this.lastDegraded = undefined
        return relative ? path.join(this.root, relative) : null
      } catch (error) {
        this.options.logger?.warn('asking obsidian to resolve a link failed; using the local index', { vaultId: this.id }, error)
      }
    }
    // 降级:自己的 basename 索引。比 metadataCache 差在不认别名,但比 null 强。
    return this.index.resolve(name, this.toVaultRelative(sourceDoc))
  }

  async listNotes(folder?: string): Promise<string[]> {
    if (await this.canQueryLive()) {
      try {
        const params = ['ext=md', ...(folder ? [`folder=${folder}`] : [])]
        const { stdout } = await this.options.cli.run(this.id, 'files', params)
        this.lastDegraded = undefined
        return stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
      } catch (error) {
        this.options.logger?.warn('listing files through obsidian failed; walking the folder', { vaultId: this.id }, error)
      }
    }
    // 索引收的是库里的所有文件(附件也要按名解析得出来),「只要笔记」在这里筛。
    const absolutes = (await this.index.all()).filter(isMarkdownNote)
    const relatives = absolutes.map(absolute => path.relative(this.root, absolute))
    return folder ? relatives.filter(relative => relative.startsWith(`${folder.replace(/\/+$/, '')}/`)) : relatives
  }

  /** 这个系统自己的检索。app 没跑就没有这条路(不拉起)。 */
  /**
   * 这个库自己的搜索(`search:context format=json`)。
   *
   * **两道闸,都在这一句里**(P5):
   *
   *  ① `canQueryLive()` —— 库开着 ∧ app 活着。不成立就抛 `NoteVaultUnavailable`
   *     并把**理由**交出去,而不是答一个空数组:对调用方来说「这个库里没有这个
   *     词」与「这个库这次没问成」是两句完全不同的话,后者要上屏说明。
   *     `cli.run` 那一侧只拦得住「app 没跑」(它探活),拦不住「库没开着」——
   *     而对一个没开的库发命令等于把那个库的窗口弹出来。
   *  ② `signal` 原样往下走 —— 换词那一下真把子进程杀掉。
   *
   * 一条命令都不会把 app 拉起来:`mayLaunch` 这里从来不给。
   */
  async liveSearch(query: string, options: NoteLiveSearchOptions = {}): Promise<NoteHit[]> {
    if (!(await this.canQueryLive())) {
      throw new NoteVaultUnavailable(await this.degradeReason(), this.id)
    }
    const params = [`query=${query}`, 'format=json']
    if (options.folder) params.push(`path=${options.folder}`)
    if (options.limit) params.push(`limit=${options.limit}`)
    const { stdout } = await this.options.cli.run(this.id, 'search:context', params, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    // **零命中时它不答 JSON,它答一句人话**(2026-09-18 真机读数,`gate:notes` ⑧
    // 第一次跑就撞上了:`No matches found.`)。它不以 `Error:` 开头,所以
    // `cli.run` 那道判错闸放它过来 —— 这是对的,零命中本来就不是错。认掉它是
    // 为了别让「这个库里没有这个词」走进下面那条 `JSON.parse` 的 catch:两者今天
    // 答案相同(空表),但一个是事实、一个是「我看不懂它说什么」,混在一起下次
    // 格式真变了就没人发现。
    if (stdout.trim() === NO_MATCHES) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch {
      return []
    }
    if (!Array.isArray(parsed)) return []
    return (parsed as ObsidianSearchHit[]).flatMap(hit => {
      if (typeof hit?.file !== 'string') return []
      return [{
        path: path.join(this.root, hit.file),
        matches: (Array.isArray(hit.matches) ? hit.matches : []).flatMap(match =>
          typeof match?.line === 'number' && typeof match?.text === 'string'
            ? [{ line: match.line, text: match.text }]
            : []),
      }]
    })
  }

  // ── 前台动作:允许拉起,但必须被明说 ────────────────────

  async createDailyNote(date: Date = new Date(), options: NoteForegroundOptions = {}): Promise<string> {
    this.assertForegroundAllowed(options)
    // 「今天」走 Obsidian 自己的 `getDailyNote()`:文件夹 / 格式 / 模板三件都按
    // 用户的设置,而且幂等(今日已存在时它返回那个文件)。
    if (isToday(date)) {
      const relative = await this.options.cli.evalText(this.id, dailyNoteScript(), this.launch(options))
      if (!relative) throw new NoteVaultUnavailable('no-snapshot', this.id, 'daily-notes plugin returned no path')
      return path.join(this.root, relative)
    }
    // 别的日子 Obsidian 的 CLI 没有对应动词 —— 按配置自己建(模板那一格就只能
    // 空着,这是诚实的降级而不是猜)。
    const config = await this.config()
    const target = path.join(this.root, config.dailyFolder, `${formatDailyDate(config.dailyFormat, date)}.md`)
    const relative = path.relative(this.root, target)
    await this.options.cli.run(this.id, 'create', [`path=${relative}`], this.launch(options))
    return target
  }

  async appendToDaily(content: string, options: NoteForegroundOptions = {}): Promise<void> {
    this.assertForegroundAllowed(options)
    await this.options.cli.run(this.id, 'daily:append', [`content=${escapeCliContent(content)}`], this.launch(options))
  }

  async createNote(rel: string, init: NoteInit = {}, options: NoteForegroundOptions = {}): Promise<string> {
    this.assertForegroundAllowed(options)
    const relative = this.toVaultRelative(rel)
    const params = [`path=${relative}`]
    if (init.content !== undefined) params.push(`content=${escapeCliContent(init.content)}`)
    if (init.template !== undefined) params.push(`template=${init.template}`)
    await this.options.cli.run(this.id, 'create', params, this.launch(options))
    return path.join(this.root, relative)
  }

  async openInApp(target: string, options: NoteForegroundOptions = {}): Promise<void> {
    this.assertForegroundAllowed(options)
    await this.options.cli.run(this.id, 'open', [`path=${this.toVaultRelative(target)}`], this.launch(options))
  }

  // ── 内务 ──────────────────────────────────────────────

  /**
   * 前台动作的两道闸合成一句:库没开着、调用方又没说可以拉起 → 拒绝。
   *
   * 「库没开着」在 Obsidian 那边等价于「这条命令会把它打开」,所以它与
   * 「app 整个没跑」是同一类事,只是粒度更细。
   */
  private assertForegroundAllowed(options: NoteForegroundOptions): void {
    if (options.mayLaunch === true) return
    if (!this.isOpen) throw new NoteVaultUnavailable('vault-not-open', this.id)
  }

  /**
   * 调用方的意愿**原样**往下走,不在这里放大。
   *
   * 写死 `{ mayLaunch: true }` 的那一版有一个哑火的组合:`open:true` 但用户已经
   * 退出了 Obsidian(那个标是上次运行留下的)—— `assertForegroundAllowed` 放行,
   * 然后 CLI 那道探活闸被 `mayLaunch:true` 绕过,于是缺省的一次 `createDailyNote()`
   * 把 Obsidian 拉了起来。缺省透传 `undefined` 之后,那一档由 `ObsidianCli.run`
   * 自己探活并抛 `system-not-running`。
   */
  private launch(options: NoteForegroundOptions): { mayLaunch?: boolean } {
    return { mayLaunch: options.mayLaunch === true }
  }

  /** 绝对路径 → vault 相对;已经是相对的原样返回(归一成 posix 分隔)。 */
  private toVaultRelative(value: string): string {
    const normalized = path.isAbsolute(value) ? path.relative(this.root, path.resolve(value)) : value
    return normalized.replace(/\\/g, '/').replace(/^\.\//, '')
  }
}

function isToday(date: Date): boolean {
  const now = new Date()
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
}

/** CLI 的 `content=` 值里 `\n` / `\t` 是**转义序列**,不是真的换行。 */
function escapeCliContent(content: string): string {
  return content.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function listDirectoryNames(directory: string): Promise<string[]> {
  try {
    return await fs.readdir(directory)
  } catch {
    return []
  }
}
