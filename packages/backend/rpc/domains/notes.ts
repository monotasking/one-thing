/**
 * notes(笔记库)域 —— P4,`docs/design/notes-obsidian-cli-2026-09.md` §4.6。
 *
 * ## 这个域只做投影
 *
 * 三条路的**判据一条都不住在这里**:库表由 `backend.notes`(P1 的子系统)问
 * 驱动要,系统状态由驱动自己答(`NotesSubsystem.systemState`),开关值从
 * `settings.notes` 读。这里做的是把三样拼成一份屏幕要的形状。
 *
 * **写面不在这里**:改一格开关走既有的 `settings.saveSettings`(整份写回)。
 * 给同一份设置开第二条写路 = 第二个产地。
 *
 * ## 一条 CLI 命令都不发(`openInApp` 除外)
 *
 * 纪律 4(正本 §3.1 末):后台路径永不把 Obsidian 拉起来。所以:
 *  · `list` / `refresh` 走的是「读一次 `obsidian.json` + 试连一次 socket」,
 *    两样都不是命令;
 *  · **`openInApp` 是这个域里唯一带 `mayLaunch: true` 的一条** —— 它是用户
 *    按下去的。这一条在 `__tests__/notes-domain.test.ts` 里有反证:任何别的
 *    路径带上 `mayLaunch` 就红。
 *
 * ## 不可信宿主 = 空表,而且**连名册都不读**
 *
 * 笔记库是**这台机器上的用户自己的文件**。一台夹紧的宿主(远程 / 多租户的
 * `server:start`)上,调用方是另一个人。判据是 `isHostLocallyTrusted()` ——
 * 与 `rpc/sandbox.ts` 的 `confined`、`search` 域的分叉同一个谓词。
 *
 * 在这一档下答的是一份**四格全空**的回执:`systems` 空表
 * 让壳落到「没有找到 Obsidian」那一句(契约里写着「缺席 = 这个系统没有状态
 * 可说」),而**这条路上一次文件读、一次 socket 连接都不发生** —— 子系统那一侧
 * 还有同一条守卫,这里这一道是「别做那件事」,那一道是「做了也拿不到」。
 */
import type { RpcRouteHandlers } from '../registry.js'
import type {
  NoteSystemStatusDto,
  NoteVaultDto,
  NotesListResponse,
  NotesOpenInAppRequest,
  NotesOpenInAppResponse,
  NotesRoutes,
} from '@shared/ipc/notes.js'
import type { AppSettings } from '@shared/ipc.js'
import { NoteVaultUnavailable, type NoteVault } from '@onething/runtime/notes'
import { getNotesSubsystem, type NotesInventory } from '../../wiring/notes/index.js'
import { getSettings } from '../../stores/settings.js'
import { isHostLocallyTrusted } from '../../server/host-trust.js'
import { getLogger } from '../../wiring/logging/index.js'

const log = getLogger('rpc.notes')

const EMPTY: NotesListResponse = { systems: {}, vaults: [], folders: [], dailyFormat: '' }

/**
 * 库表 + 设置里那三格 → 屏幕要的一行。**纯函数、导出**,所以「缺席算什么」
 * 可以逐条单测,而不必起一台 backend。
 *
 * 三处「缺席算什么」逐字照 `settings.notes` 的契约:
 *  · `enabled` 缺席 = **开**(R7:迁移把全部库种成开着,新出现的库也该默认在册);
 *  · `skills` 缺席 = **关**(把别人的库当技能来源是一个要人点头的决定);
 *  · `open` 缺席 = **true** —— 那是「这个系统没有开不开这回事」(目录库),
 *    不是「它关着」。
 */
export function toVaultDto(vault: NoteVault, notes: AppSettings['notes']): NoteVaultDto {
  const preference = notes?.vaults?.[vault.id]
  return {
    id: vault.id,
    name: vault.name,
    root: vault.root,
    system: vault.system,
    open: vault.isOpen !== false,
    enabled: preference?.enabled !== false,
    skills: preference?.skills === true,
    primary: notes?.primaryVaultId === vault.id,
  }
}

/** 子系统的答案 + 设置 → 一份回执。纯函数。 */
export function toListResponse(
  inventory: NotesInventory,
  settings: Pick<AppSettings, 'notes'>,
): NotesListResponse {
  const systems: Record<string, NoteSystemStatusDto> = {}
  for (const [id, state] of Object.entries(inventory.systems)) {
    // 「用户要不要用它」缺席算开 —— 与 `settings.notes.systems` 的契约逐字一致。
    systems[id] = { state, enabled: settings.notes?.systems?.[id]?.enabled !== false }
  }
  return {
    systems,
    vaults: inventory.vaults.map(vault => toVaultDto(vault, settings.notes)),
    folders: settings.notes?.folders ?? [],
    dailyFormat: settings.notes?.dailyFormat ?? '',
  }
}

async function list(): Promise<NotesListResponse> {
  if (!isHostLocallyTrusted()) return EMPTY
  const settings = getSettings()
  return toListResponse(await getNotesSubsystem().inventory(settings), settings)
}

export const notesRpcHandlers: RpcRouteHandlers<NotesRoutes> = {
  async list() {
    return await list()
  },

  /**
   * 先让子系统重问一遍驱动,再答同一份。
   *
   * 为什么要这一条而 `list` 不顺手做:`list` 每次进设置页都会发,而 `refresh`
   * 会**换掉在册的那张表**(消费方 —— 检索、附件、技能根 —— 读的就是它)。
   * 「看一眼」不该有副作用;「我刚在 Obsidian 里新建了一个库」才该有。
   */
  async refresh() {
    if (!isHostLocallyTrusted()) return EMPTY
    await getNotesSubsystem().refresh(getSettings())
    return await list()
  },

  /**
   * 在原生 app 里打开。**这个域里唯一的前台动作**,也是唯一带 `mayLaunch` 的
   * 一条(判词在文件头)。
   *
   * 它问的是**在册的**那张表(`registry.vault`),不是名册全貌:一个被用户关掉
   * 的库不该因为它还在 `obsidian.json` 里就被打开。
   */
  async openInApp(request: NotesOpenInAppRequest): Promise<NotesOpenInAppResponse> {
    if (!isHostLocallyTrusted()) return { ok: false, reason: 'not-found' }
    const vault = getNotesSubsystem().registry.vault(request.vaultId)
    if (vault === null) return { ok: false, reason: 'not-found' }
    // 「这个系统没有『在 app 里打开』这件事」与「打不开」是两句话。
    if (typeof vault.openInApp !== 'function') return { ok: false, reason: 'unsupported' }
    /*
     * **没给 path = 做不到**(P5,2026-09-18 真机读数)。P4 这一行写的是
     * 「缺席 = 把库本身唤到前台」,做法是把库根递下去;真机上那条命令是
     * `open path=`,而 Obsidian CLI 答 `Missing required parameter: file or path`
     * —— 它整张动词表里没有「只把某个库调到前台」这件事。
     *
     * 所以这里当场答 `unsupported`,而不是发一条必然失败的命令:失败与
     * 「这件事做不到」是两句话,而后者调用方(设置页)得先知道才画得对按钮。
     */
    if (request.path === undefined) return { ok: false, reason: 'unsupported' }
    try {
      await vault.openInApp(request.path, { mayLaunch: true })
      return { ok: true }
    } catch (error) {
      if (error instanceof NoteVaultUnavailable) return { ok: false, reason: error.reason }
      log.warn('opening a note in its app failed', { vaultId: request.vaultId }, error)
      return { ok: false, reason: 'failed' }
    }
  },
}
