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
   * **P5 接;今天不生效。** 这一格已经在契约上,但没有实现:`NoteProcessRunner`
   * 今天没有 abort 入口(`run` 只有 `timeoutMs`),所以中途取消一次 `search:context`
   * 做不到。留着它是为了调用方现在就能写对,而不是等 P5 再改签名。
   */
  signal?: AbortSignal
}

export interface NoteSystemDriver {
  readonly id: string
  /** 按配置产出这个系统今天在册的库。失败不抛,返回空表并自己记日志。 */
  discover(config: NotesConfig): Promise<NoteVault[]>
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
