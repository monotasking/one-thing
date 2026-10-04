/**
 * 笔记领域的对象与端口(`docs/design/notes-obsidian-cli-2026-09.md` §3.1)。
 *
 * 这个文件里**不出现任何一个笔记系统的名字** —— Obsidian 也好、Logseq 也好,
 * 它们都只是「一个实现了 `NoteVault` 的驱动」。消费方拿到的永远是
 * `NoteVault` / `NoteSystemRegistry`,所以加一种笔记系统不改这里。
 *
 * `system` 字段是**给人看的**(UI 徽标、日志、变量板),消费方不许 `switch` 它:
 * 真要按系统分叉,说明那件事该进 `NoteVault` 当一个方法。
 */

// ============================================================================
// 进程端口(宿主注入)—— 领域自己不认识 child_process
// ============================================================================

export interface NoteProcessResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface NoteProcessRunOptions {
  command: string
  args: string[]
  timeoutMs?: number
  env?: Record<string, string | undefined>
  /**
   * **换词即 kill**(P5)。已经 abort 的信号进来 = 一次 `spawn` 都不发生;
   * 跑到一半 abort = 与 `NoteProcessHandle.kill()` 同一条路(SIGTERM → 1s →
   * SIGKILL),`done` 以 `NoteProcessAborted` 落定。
   *
   * 它与 `timeoutMs` 是两件事:预算说的是「这条命令最多值多少时间」,信号说的是
   * 「问这句话的人已经不想知道答案了」。两者都到时先到的那一个说了算。
   */
  signal?: AbortSignal
}

export interface NoteProcessHandle {
  /** 子进程退出时落定。 */
  done: Promise<NoteProcessResult>
  kill(): void
}

export interface NoteProcessRunner {
  run(options: NoteProcessRunOptions): Promise<NoteProcessResult>
  spawn(options: NoteProcessRunOptions): NoteProcessHandle
}

/**
 * 「那个 app 现在活着吗」。
 *
 * 判据由实现自己定(今天 Obsidian 是「能不能连上它的 unix socket」)。领域只
 * 要一个布尔:活着才许发命令,不活就走快照 —— 这条纪律的存在理由是 Obsidian
 * CLI「app 没跑时第一条命令会把 app 拉起来」,后台路径绝不许干这件事。
 *
 * `isAlive()` 答 `null` = **这个平台上还没有探活手段**(今天的 Windows)。调用
 * 方必须把 `null` 当「不确定」处理,而不是当 `true` —— 不确定时后台仍然不发。
 */
export interface NoteLivenessProbe {
  isAlive(): Promise<boolean | null>
}

// ============================================================================
// 领域对象
// ============================================================================

/** 「今天那本日记」——路径永远算得出来,存在与否是另一格。 */
export interface DailyNoteRef {
  /** 绝对路径。 */
  path: string
  exists: boolean
}

export interface NoteHit {
  /** 绝对路径。 */
  path: string
  matches: Array<{ line: number; text: string }>
}

/** 链接的两种形态:`[[x]]` / `![[x]]`(或 md 的 `[x](y)` / `![x](y)`)。 */
export type NoteLinkKind = 'link' | 'embed'

/**
 * 一个笔记库。
 *
 * **前台动作与后台读取的分界**:`dailyNote` / `attachmentPathFor` /
 * `linkTextFor` / `resolveByName` / `listNotes` 是后台可以随便调的(它们在 app
 * 没跑时走快照);`createDailyNote` / `createNote` / `appendToDaily` /
 * `openInApp` 是**用户主动动作**,只有调用方显式给 `mayLaunch` 才允许把 app
 * 拉起来。
 */
export interface NoteVault {
  readonly id: string
  readonly name: string
  /** 绝对路径,已归一(无尾斜杠)。 */
  readonly root: string
  /** 只给 UI / 日志 / 变量看。消费方不许按它分叉。 */
  readonly system: string
  /**
   * 这一份是**降级态**读出来的(app 没跑、只有快照)。调用方可以如实告诉用户
   * 「这是上次看到的配置」,而不是假装什么都正常。
   */
  readonly degraded?: NoteVaultUnavailableReason
  /**
   * 这个库此刻在它自己的 app 里**开着**吗。
   *
   * **缺席 = 这个系统没有「打开 / 没打开」这个概念**(目录库就是这一档:一个
   * 文件夹永远在那儿),不是 `false`。今天唯一的读者是设置页 —— 它要把
   * 「未在 app 里打开」如实写在那一行上,而不是把那一行从表里抹掉。
   *
   * 消费方不许拿它当「能不能发命令」的判据:那一句是每个库自己的
   * `canQueryLive`(库开着 ∧ app 活着),两个条件,住在实现里。
   */
  readonly isOpen?: boolean

  dailyNote(date?: Date, options?: NoteReadOptions): Promise<DailyNoteRef>
  createDailyNote(date?: Date, options?: NoteForegroundOptions): Promise<string>
  appendToDaily(content: string, options?: NoteForegroundOptions): Promise<void>
  createNote(rel: string, init: NoteInit, options?: NoteForegroundOptions): Promise<string>

  /** 给 `sourceDoc`(vault 相对路径)配一个附件落点,返回绝对路径。 */
  attachmentPathFor(fileName: string, sourceDoc: string): Promise<string>
  /** `target` 与 `sourceDoc` 都是 vault 相对路径。 */
  linkTextFor(target: string, sourceDoc: string, kind: NoteLinkKind): Promise<string>
  /** 按 basename / wikilink 规则解析,返回绝对路径或 `null`。 */
  resolveByName(name: string, sourceDoc: string): Promise<string | null>
  /** vault 相对路径清单(md 文件)。 */
  listNotes(folder?: string): Promise<string[]>

  /** 这个系统自己的检索。没有就不给这个方法。 */
  liveSearch?(query: string, options?: NoteLiveSearchOptions): Promise<NoteHit[]>
  /** 在原生 app 里打开。没有就不给这个方法。 */
  openInApp?(path: string, options?: NoteForegroundOptions): Promise<void>
}

export interface NoteInit {
  content?: string
  /** 模板文件的 vault 相对路径(某些系统支持)。 */
  template?: string
}

/**
 * 「这次读不许出进程」。
 *
 * 变量板每回合都渲染一次,提示词路径上起一个子进程 = 给每一轮对话加一次进程
 * 启动。`offline: true` 的读法只用本地已有的东西(快照 / 本地计算);答不出来
 * 就抛 `NoteVaultUnavailable`,由调用方把那一格省掉 —— **省掉比编一个强**。
 */
export interface NoteReadOptions {
  offline?: boolean
}

export interface NoteForegroundOptions {
  /**
   * 允许这次调用把原生 app 拉起来 / 对一个没打开的库发命令。
   * **缺省 false** —— 后台路径拿缺省值就是安全的。
   */
  mayLaunch?: boolean
}

export interface NoteLiveSearchOptions {
  folder?: string
  limit?: number
  /**
   * **换词即 kill**(P5 接上了)。这一格一路透传到 `NoteProcessRunner.run` ——
   * abort 那一下真的把子进程杀掉,而不是让它跑完再把答案丢掉。
   *
   * 检索那一侧递进来的是「这一发的信号」与「这一库的预算」合成的一个
   * (`AbortSignal.any([ctx.signal, AbortSignal.timeout(budget)])`),所以
   * 「用户换了词」与「这个库太慢了」走的是同一条取消路,而不是两套。
   */
  signal?: AbortSignal
}

export interface NoteSystemDriver {
  readonly id: string
  /** 按配置产出这个系统今天在册的库。失败不抛,返回空表并自己记日志。 */
  discover(config: NotesConfig): Promise<NoteVault[]>
  /**
   * **这个系统此刻什么状态** —— 驱动自述,没有这回事的就不给这个方法。
   *
   * 它必须是**只读**的:允许读自己的名册、探一次活,**不许发任何命令**
   * (发命令 = 把那台 app 拉起来,纪律 4)。
   *
   * 缺席不是「不知道」,是「这个问题对我不成立」:目录驱动没有 app,一个文件夹
   * 没有「装没装 / 跑没跑」可言,所以 `FolderDriver` 不实现它,它也就不会出现在
   * `notes.list` 的 `systems` 表里。
   */
  state?(): Promise<NoteSystemState>
}

// ============================================================================
// 配置(`settings.notes` 的领域投影 —— 领域不认识 `AppSettings`)
// ============================================================================

export interface NoteSystemPreference {
  enabled?: boolean
}

export interface NoteVaultPreference {
  enabled?: boolean
  skills?: boolean
}

export interface NotesConfig {
  /**
   * 每种笔记系统一行总开关,**键 = 驱动自己的 id**。缺席 = 开着。
   *
   * 这里是一张表而不是一格 `obsidian`:领域配置里出现一个驱动的名字,就等于
   * 「加一种笔记系统要改 core」。驱动自己读自己那一行(`config.systems[this.id]`),
   * 这个文件一个笔记系统的名字都不认识。
   */
  systems: Record<string, NoteSystemPreference>
  vaults: Record<string, NoteVaultPreference>
  primaryVaultId?: string
  /** 绝对路径。 */
  folders: string[]
  dailyFormat: string
  attachmentDirectory?: string
}

export const DEFAULT_NOTES_DAILY_FORMAT = 'YYYY-MM-DD'

export function createEmptyNotesConfig(): NotesConfig {
  return { systems: {}, vaults: {}, folders: [], dailyFormat: DEFAULT_NOTES_DAILY_FORMAT }
}

/** 这个驱动开着吗。**缺席 = 开着** —— 名册与开关是两件事。 */
export function isNoteSystemEnabled(config: NotesConfig, driverId: string): boolean {
  return config.systems[driverId]?.enabled !== false
}

// ============================================================================
// 错误
// ============================================================================

/**
 * 一个**有 app 的**笔记系统此刻的状态(P4:设置页那一句状态话的判据)。
 *
 * 没有 app 的系统(目录库)压根不答这个问题 —— 「状态」是关于那台 app 的,
 * 一个文件夹没有状态可言。所以答这句话的是**驱动自己**,不是这张表。
 */
export type NoteSystemState =
  /** app 活着,命令发得出去。 */
  | 'running'
  /** app 没跑。后台只读快照,前台动作会把它拉起来。 */
  | 'not-running'
  /** 那条命令行通道没开(或这个平台上探不出来)。 */
  | 'cli-not-registered'
  /** 这台机器上压根没有这个系统。 */
  | 'not-installed'

export type NoteVaultUnavailableReason =
  /** 那个系统的 app 没在跑,而这条路不许把它拉起来。 */
  | 'system-not-running'
  /** 库本身没打开(粒度更细的同一件事):对它发命令等于打开它。 */
  | 'vault-not-open'
  /** 这个平台上没有探活手段(今天的 Windows)—— 不确定,所以后台不发。 */
  | 'cli-not-registered'
  /** 从来没读到过这个库的配置,连降级都降不了。 */
  | 'no-snapshot'

/**
 * 这个库现在答不了。
 *
 * `reason` 是**代码**不是句子(与 `search.status.vectorErrorKind` 同一条判例,
 * R12):后端只说发生了什么,人话由壳的字典画。
 */
export class NoteVaultUnavailable extends Error {
  readonly reason: NoteVaultUnavailableReason
  readonly vaultId: string

  constructor(reason: NoteVaultUnavailableReason, vaultId: string, detail?: string) {
    super(`[notes] vault "${vaultId}" is unavailable: ${reason}${detail ? ` (${detail})` : ''}`)
    this.name = 'NoteVaultUnavailable'
    this.reason = reason
    this.vaultId = vaultId
  }
}
