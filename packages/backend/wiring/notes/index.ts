/**
 * 笔记领域的接线(P1,`docs/design/notes-obsidian-cli-2026-09.md` §3)。
 *
 * 这个文件就是「加一种笔记系统 = 一个目录 + **一行注册**」里的那一行住的地方。
 * 它做四件事:
 *  ① 造一台 `NoteSystemRegistry`,把驱动按**优先级顺序**注册进去
 *     (Obsidian 在前 —— 同一个目录两边都认时,能问 app 的那个更准);
 *  ② 用宿主的真件喂给 Obsidian 驱动:进程 runner、socket 探针、快照库指向
 *     `<store>/notes/obsidian`;
 *  ③ 按 `getSettings().notes` 跑一次 `refresh`,并订「设置刚保存过」——
 *     **settings 域一个字都不知道有 notes 这回事**(与 `wiring/search/index.ts`
 *     的 `watchSettingsChanged` 同一条判例:串联,不占槽);
 *  ④ 返回**一个** disposer,装配层 `own()` 它。
 *
 * ## 为什么不可信宿主下是空表,以及**什么时候问这个问题**
 *
 * 笔记库是**这台机器上的用户自己的文件**。一台夹紧的宿主(远程 / 多租户的
 * `server:start`)上,调用方是另一个人,把本机 Obsidian 的六个库交出去是越权。
 * 判据是 `isHostLocallyTrusted()` —— 与 `rpc/sandbox.ts` 的 `confined` 同一个
 * 谓词。
 *
 * **这个问题在每次 `refresh` 时问,不在装配时问一次**(2026-09-18 review 打回
 * 的第三条)。理由是时序:`server:start` 装配时 host 表的 `localTrust` 是
 * `null`,它要到 `apps/server/src/main.ts` 决定绑回环之后才
 * `configureHostLocalTrust({origin:'loopback-server'})` —— 装配期算一次的话,
 * server 与 CLI daemon 上**永远**是空表,而且是静默的,与正本「server / CLI
 * 同码」直接相悖。
 *
 * 驱动**在构造时就注册**(注册本身不发任何命令、不读任何文件),不可信那一档
 * 由 `refresh` 走 `registry.clear()` 表达。两种「空」对消费方是同一个可观察
 * 状态,所以没人需要认识第二种。
 */

import {
  FolderDriver,
  NoteSystemRegistry,
  ObsidianCli,
  ObsidianDriver,
  ObsidianRegistry,
  FileSnapshotStore,
  createNodeProcessRunner,
  createSocketLivenessProbe,
  type NoteSystemDriver,
  type NoteSystemState,
  type NoteVault,
  type NotesConfig,
} from '@onething/runtime/notes'
import type { AppSettings } from '@shared/ipc.js'
import * as os from 'node:os'
import * as path from 'node:path'
import { getOnethingStorePath } from '@onething/runtime/storage'
import {
  configureSettingsEventBroadcaster,
  getSettingsEventBroadcaster,
  type SettingsEvent,
  type SettingsEventBroadcaster,
} from '../settings/events.js'
import { getSettings } from '../../stores/settings.js'
import { isHostLocallyTrusted } from '../../server/host-trust.js'
import { getCurrentBackend, getCurrentBackendSafe } from '../../current.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('notes')

/**
 * Obsidian CLI 的传输(§1:`lsof -U -c Obsidian` 实测)。
 *
 * **Windows 的对应物没有查到公开读数** —— Obsidian 的文档只说「app 没跑时第一条
 * 命令会启动它」,没说传输是什么。所以 win32 返回 `null`,探针答「不确定」,
 * 后台路径一条命令都不发。猜一个 `\\.\pipe\…` 写死的代价是**猜错就等于后台把
 * Obsidian 拉起来**,正是本领域第一条纪律禁止的事。见报告「留账」。
 */
export function obsidianSocketPath(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string | null {
  if (platform === 'win32') return null
  return path.join(home, '.obsidian-cli.sock')
}

/**
 * `settings.notes` → 领域配置。
 *
 * 领域不认识 `AppSettings`(它住产品层,契约层的形状不该穿进去),所以投影住
 * 装配层这一侧。缺席那一半由 `mergeWithDefaults` 补过了,这里只做一次形状转换。
 */
export function toNotesConfig(settings: AppSettings): NotesConfig {
  const notes = settings.notes
  return {
    systems: notes?.systems ?? {},
    vaults: notes?.vaults ?? {},
    primaryVaultId: notes?.primaryVaultId,
    folders: notes?.folders ?? [],
    dailyFormat: notes?.dailyFormat || 'YYYY-MM-DD',
    attachmentDirectory:
      notes?.attachmentDirectory
      // P3 之前两格并存:笔记自己那格缺席时回落到编辑器那格(老用户设过的值)。
      || settings.general?.editor?.markdownNoteAttachmentDirectory
      || undefined,
  }
}

export interface BootstrapNotesOptions {
  /** 覆盖 store 根(测试)。缺省经宿主端口 `getOnethingStorePath()`。 */
  storePath?: string
  /** 覆盖信任判据(测试)。 */
  isLocallyTrusted?: () => boolean
}

/**
 * 笔记子系统 —— 挂在 `OnethingBackend` 实例上的那只对象(形状照
 * `backend.mcp` / `backend.acp`:一个 `registry` 字段 + `refresh` + `dispose`)。
 *
 * 宿主拿得到它,所以「我刚刚才声明可信」这种时序事件有地方说 —— 那正是
 * `server:start` 需要的那一句。
 */
export interface NotesSubsystem {
  readonly registry: NoteSystemRegistry
  /**
   * 重新问一遍所有驱动。设置改了、或者宿主的信任状态刚变了,都走这一条。
   *
   * `settings` 缺席 = 读当前设置缓存。宿主那一侧(`apps/server/src/main.ts`)
   * 因此不用为了喊一声而多 import 一个 store。
   */
  refresh(settings?: AppSettings): Promise<void>
  /**
   * **名册的全貌** —— 设置页要的那一份(P4)。
   *
   * 与 `registry.vaults()` 的差别只有一句:那一份是**在册的**(用户关掉的库不在
   * 里面,消费方本来就不该看见它们);这一份是**名册里的全部**,因为一个关掉的
   * 库必须画得出来才关得回来。做法是拿一份「偏好全清空」的配置再问一遍驱动
   * (判词在 `NoteSystemRegistry.discoverAll` 上),**不为它开新端口**。
   *
   * `systems` 只收**答得出那句自述的**驱动(`NoteSystemDriver.state?`);目录驱动
   * 不实现它,所以它不在里面 —— 一个文件夹没有「在不在跑」这回事。**这里没有
   * 一张按驱动 id 列的名单**:加一种笔记系统仍然只是一个目录 + 一行注册。
   *
   * 不可信宿主答**两个空格**,与 `refresh` 那一档同一条理由(见文件头)。
   * **一条 CLI 命令都不发**:读一次名册 + 试连一次 socket,两样都不会把 app
   * 拉起来。
   */
  inventory(settings?: AppSettings): Promise<NotesInventory>
  /**
   * 单问一个系统此刻的状态。答 `undefined` = 不在册,或这个驱动没有 app 可问。
   *
   * 问的是**驱动自己**(它构造时就拿着自己的名册与命令行口),所以调用方不必、
   * 也不许再 new 一台探针出来 —— 那就是第二份判据。
   */
  systemState(driverId: string): Promise<NoteSystemState | undefined>
  /**
   * 「库表刚重算过」。返回退订(P2)。
   *
   * **为什么消费方订这一条,而不是各自订 `settings:changed`**:库表是这个域的
   * **产物**,不是设置的一个投影 —— 谁算得出它只有这一个地方。检索那一侧要是
   * 自己去订设置、再自己读 `vaults()`,两条链就都在「设置刚变」这一刻醒来,
   * 而谁先跑完是 `configureSettingsEventBroadcaster` 串联顺序的副产品:notes 先
   * 注册(装配第 860 行)、search 后注册(第 1009 行),串联是「先跑上一位」,
   * 于是 search 的监听跑在 notes 的 `refresh` **发起之后、落定之前**(那是个
   * `void` 的异步),读到的是上一份库表。订产物就没有这个缝。
   *
   * 每次 `refresh` 落定都喊一声(包括「不可信 → 清空」那一档),**哪怕表没变**:
   * 「变没变」是消费方自己的判据(检索那一侧按 id+root+dailyFolder 逐项比,
   * 没变就不换 Worker),这里不替它判。
   */
  onRefreshed(listener: (vaults: NoteVault[]) => void): () => void
  dispose(): void
}

/** `inventory()` 的答案。 */
export interface NotesInventory {
  /** 名册里的**全部**库(含被关掉的)。顺序 = 注册顺序 × 驱动自己的顺序。 */
  vaults: NoteVault[]
  /** 有 app 的那些系统此刻的状态,键 = 驱动 id。 */
  systems: Record<string, NoteSystemState>
}

/**
 * 起笔记领域。返回的 disposer 由 `backend.ts` 的 `own()` 接住。
 *
 * **第一次 `refresh` 是异步的、不阻塞装配**:它要读 `obsidian.json`(一次文件
 * 读),而装配链上没人等着用库表。失败只记 warn —— 没装 Obsidian 是一种完全
 * 正常的机器状态。
 */
export function createNotesSubsystem(options: BootstrapNotesOptions = {}): NotesSubsystem {
  const registry = new NoteSystemRegistry(log)
  const trusted = options.isLocallyTrusted ?? isHostLocallyTrusted

  // **注册在构造时,一次**:注册本身不读盘、不发命令,所以它不需要等信任。
  // 信任是 `refresh` 每次问的问题(见文件头)。
  const storePath = options.storePath ?? getOnethingStorePath()
  registry.register(new ObsidianDriver({
    registry: new ObsidianRegistry({ logger: log }),
    cli: new ObsidianCli({
      runner: createNodeProcessRunner(),
      probe: createSocketLivenessProbe(obsidianSocketPath()),
    }),
    snapshots: new FileSnapshotStore(path.join(storePath, 'notes', 'obsidian'), log),
    logger: log,
  }))
  // 目录驱动排在后面:同一个根两边都认时 Obsidian 赢(先认领先得)。
  registry.register(new FolderDriver())

  const listeners = new Set<(vaults: NoteVault[]) => void>()
  const announce = (vaults: NoteVault[]): void => {
    for (const listener of listeners) {
      try {
        listener(vaults)
      } catch (error) {
        log.warn('a note-vault listener failed', {}, error)
      }
    }
  }

  const refresh = async (settings?: AppSettings): Promise<void> => {
    if (!trusted()) {
      // 夹紧的宿主:表清空。**不是「不注册驱动」** —— 信任会变(server 在
      // listen 时才声明),所以这一档必须是可逆的。
      registry.clear()
      log.debug('notes: host is not locally trusted; the vault table stays empty')
      announce([])
      return
    }
    const vaults = await registry.refresh(toNotesConfig(settings ?? getSettings()))
    log.debug('note vaults refreshed', { count: vaults.length })
    announce(vaults)
  }

  /**
   * 问一个驱动它自己那句自述。**这里没有任何一个驱动的名字** —— 有没有状态
   * 可说是驱动自己声明的(`NoteSystemDriver.state?`),不是装配层的一张名单。
   */
  const askDriverState = async (driver: NoteSystemDriver): Promise<NoteSystemState | undefined> => {
    if (driver.state === undefined) return undefined
    try {
      return await driver.state()
    } catch (error) {
      // 问不出状态不该让整块设置面塌掉:答「没装」是这一档最保守的话
      // (屏上那一句只说「没有找到」,不会把人支去做任何事)。
      log.warn('resolving a note-system state failed', { system: driver.id }, error)
      return 'not-installed'
    }
  }

  const systemState = async (driverId: string): Promise<NoteSystemState | undefined> => {
    if (!trusted()) return undefined
    const driver = registry.driver(driverId)
    return driver === null ? undefined : await askDriverState(driver)
  }

  const inventory = async (settings?: AppSettings): Promise<NotesInventory> => {
    if (!trusted()) return { vaults: [], systems: {} }
    const config = toNotesConfig(settings ?? getSettings())
    // 「偏好全清空」= 不筛。判词在 `discoverAll` 上。
    const vaults = await registry.discoverAll({ ...config, systems: {}, vaults: {} })
    const systems: Record<string, NoteSystemState> = {}
    // 遍历**在册的驱动**,答得出的才进表 —— 不遍历任何一张写死的名单。
    for (const driver of registry.registeredDrivers()) {
      const state = await askDriverState(driver)
      if (state !== undefined) systems[driver.id] = state
    }
    return { vaults, systems }
  }

  const unwatchSettings = watchSettingsChanged(event => {
    void refresh(event.settings).catch((error: unknown) => {
      log.warn('refreshing note vaults after a settings change failed', {}, error)
    })
  })

  return {
    registry,
    refresh,
    inventory,
    systemState,
    onRefreshed(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      unwatchSettings()
      listeners.clear()
    },
  }
}

/**
 * 装配入口。`backend.ts` 里紧挨 `bootstrapProjectDirs` 之后一行。
 *
 * 子系统挂在**实例**上(装配把 `adopt` 拿到的子系统放进 `parts.notes`),不占
 * 模块槽 —— `assembly:gate` 的那条纪律:新的装配期状态住实例并被 `own()`,不住
 * 新的模块级 `let`。`adopt` 是个回调而不是「把 backend 传进来」:这个文件不该
 * 认识 `OnethingBackend`(那是一条反向的边),它只需要交出一个句柄。
 *
 * 那一格由 `backend.dispose()` 统一清(它删掉 `parts` 的每一格),所以这里的
 * disposer 只解自己的订阅。
 */
export function bootstrapNotes(
  adopt: (subsystem: NotesSubsystem) => void,
  options: BootstrapNotesOptions = {},
): () => void {
  const subsystem = createNotesSubsystem(options)
  adopt(subsystem)
  void subsystem.refresh(getSettings()).catch((error: unknown) => {
    log.warn('the first note-vault discovery failed', {}, error)
  })
  log.info('notes subsystem bootstrapped', {
    drivers: subsystem.registry.registeredDriverIds().join(',') || '(none)',
  })
  return () => subsystem.dispose()
}

/**
 * 进程访问器 —— 与既有的 121 个 `getXxx()` 同一族:读**当前实例**,未装配抛
 * `BackendNotAssembledError('notes')`。
 */
export function getNoteSystemRegistry(): NoteSystemRegistry {
  return getCurrentBackend('notes').notes.registry
}

/**
 * 整只子系统(P4:`notes` RPC 域要的是 `inventory` 与 `registry` 两样)。
 *
 * 与上面那只同族、同一条时序(读当前实例,未装配抛)。域拿整只而不是拿
 * `registry`,是因为「名册的全貌」与「系统状态」这两句话的产地在子系统上,
 * 不在注册表上 —— 注册表只认识**在册的**那一份。
 */
export function getNotesSubsystem(): NotesSubsystem {
  return getCurrentBackend('notes').notes
}

/**
 * 笔记子系统,**没有就 `null`**(与 `getCurrentBackendSafe()` 同一族)。
 *
 * 谁需要这一只:检索的装配要订「库表刚重算过」,而它也跑在**没有真 backend** 的
 * 那些单测里(装配用例自己造 `workerData`,一台 backend 都不装)。`notes` 那一格
 * 是句柄上的 getter,没填就抛 —— 「有就用,没有就算了」的问法只能包一层。
 */
export function getNotesSubsystemSafe(): NotesSubsystem | null {
  const handle = getCurrentBackendSafe()
  if (handle === null) return null
  try {
    return handle.notes
  } catch {
    return null
  }
}

/**
 * 在册的笔记库,**没有子系统就是空表**。检索的取材面(`wiring/search/adapters.ts`)
 * 与授权面都从这里晚绑定地现取 —— 库表会变,任何一份快照都会过期。
 */
export function noteVaultsNow(): NoteVault[] {
  return getNotesSubsystemSafe()?.registry.vaults() ?? []
}

/** 主库,没有就 `null`(「今天那一条」问的就是它)。 */
export function primaryNoteVaultNow(): NoteVault | null {
  return getNotesSubsystemSafe()?.registry.primaryVault() ?? null
}

/**
 * 订「设置刚保存过」。做法与 `wiring/search/index.ts` 的同名函数逐字同源
 * (串联不占槽 + 身份守卫的还原),理由写在那边。
 */
function watchSettingsChanged(listener: (event: SettingsEvent) => void): () => void {
  const previous = getSettingsEventBroadcaster()
  const ours: SettingsEventBroadcaster = event => {
    previous?.(event)
    try {
      listener(event)
    } catch (error) {
      log.warn('settings-changed listener failed', { err: error })
    }
  }
  configureSettingsEventBroadcaster(ours)
  return () => {
    if (getSettingsEventBroadcaster() !== ours) return
    configureSettingsEventBroadcaster(previous)
  }
}

export { NoteSystemRegistry } from '@onething/runtime/notes'
export type { NoteVault, NotesConfig } from '@onething/runtime/notes'
