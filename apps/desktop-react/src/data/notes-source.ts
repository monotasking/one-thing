import { createMutation, createQuery, type Mutation } from './kernel'
import { notesPort } from './notes-port'
import { notify } from '../services/notify'
import { t } from '../i18n'
import type { AppSettings, NotesSettings } from '@shared/ipc/settings'
import type { NoteSystemState, NotesListResponse } from '@shared/ipc/notes'

/**
 * 设置页「笔记」那一页的取数与五条写路(P4,正本
 * `docs/design/notes-obsidian-cli-2026-09.md` §3.3 / §4.6)。
 *
 * ── 一格读,五条写 ───────────────────────────────────────────────────────
 * | 要什么 | 产地 |
 * | --- | --- |
 * | 名册 + 系统状态 + 目录表 | `notesListQuery`(`notes.list`) |
 * | 改任何一格开关 | 五条 mutation,**全部经 `settings.saveSettings` 整份写回** |
 *
 * 读与写走的是两个域,这不是分裂:`settings.notes` 是**用户的决定**(写得动),
 * 而「Obsidian 在不在跑」「名册里有哪几个库」是**这台机器此刻的事实**(只读)。
 * 把事实塞进设置里就等于把一份会自己变的东西落盘。
 *
 * ── 五条写路共用一只工厂 ─────────────────────────────────────────────────
 * 每一条都是同一套四步:乐观补丁 → 当场读一份新的当底本 → 合一格 → 整份写回 →
 * `settle` 里 `invalidate()` 对账。差别只有「合哪一格」那一句,所以它是
 * `notesWrite` 的参数(与 `theme-settings-source` 的 `themeWrite` 同体例)。
 *
 * **当场读一份新的**那一句不是仪式:缓存里那份可能已经旧了(别的面刚改过主题、
 * 刚存过一把 key),拿它写回去等于把别人那一格抹掉。**而且这五条只碰
 * `settings.notes`** —— 反证在 `__tests__/notes-settings.test.tsx`:写回去那一份
 * 与读进来那一份**除了 `notes` 逐键相同**。
 */

/** 缺省的一份笔记设置 —— 后端答的那份里 `notes` 缺席时用它当底本。 */
const EMPTY_NOTES: NotesSettings = {
  systems: {},
  vaults: {},
  folders: [],
  dailyFormat: '',
}

export const notesListQuery = createQuery<NotesListResponse>('notes.list', async () => {
  const port = await notesPort()
  await port.ready()
  return await port.list()
})

/**
 * 「这个系统此刻什么状态」。**缺席 = `not-installed`** —— 契约里写着
 * 「`systems` 里没有这一行 = 这个系统在这台机器上没有状态可说」,而夹紧的宿主
 * 答的正是一张空表。两种情形屏幕上说的是同一句话(「没有找到 Obsidian」),
 * 所以壳不需要认识第二种。
 */
export function systemStateOf(
  data: NotesListResponse | undefined,
  systemId: string,
): NoteSystemState {
  return data?.systems?.[systemId]?.state ?? 'not-installed'
}

/**
 * 「用户要不要用这个系统」。**缺席 = 开**(与 `settings.notes.systems` 的契约
 * 逐字一致)——「名册里没有这一行」与「关掉了」是两件事。
 *
 * 它与 `systemStateOf` 是同一行上的两格:那一格是**机器的事实**(只读),
 * 这一格是**用户的决定**(写得动)。
 */
export function systemEnabledOf(
  data: NotesListResponse | undefined,
  systemId: string,
): boolean {
  return data?.systems?.[systemId]?.enabled !== false
}

/** 这一页此刻在画哪一档。`data` 缺席且没出错 = 还在问。 */
export type NotesPhase = 'loading' | 'ready' | 'error'

export function notesPhaseOf(
  data: NotesListResponse | undefined,
  error: string | undefined,
): NotesPhase {
  // **有数就不算 loading,哪怕正在重量**(同 `storagePhaseOf`):一个每次重拉都
  // 翻回「正在读取…」的页会在屏上闪,而它上一秒说的话此刻并没有变假。
  if (data !== undefined) return 'ready'
  return error === undefined ? 'loading' : 'error'
}

/** 整份设置 → 这一页要改的那一格(缺席补一份空的)。纯函数。 */
export function notesOf(settings: Pick<AppSettings, 'notes'>): NotesSettings {
  return settings.notes ?? EMPTY_NOTES
}

/** 一条写路:合哪一格由调用方说。 */
type NotesPatch<I> = (notes: NotesSettings, input: I) => NotesSettings

function notesWrite<I>(
  name: string,
  patch: NotesPatch<I>,
  /** 屏上的乐观补丁(可选):同一格在本地先翻过去,失败由 kernel 回滚。 */
  optimistic?: (data: NotesListResponse, input: I) => NotesListResponse,
): Mutation<I, void> {
  return createMutation<I, void>(name, {
    optimistic: optimistic === undefined
      ? undefined
      : (input) => notesListQuery.patch((prev) => (prev ? optimistic(prev, input) : prev)),
    run: async (input) => {
      const port = await notesPort()
      const current = await port.readSettings()
      if (!current.success || !current.settings) {
        throw new Error(current.error || t('notes.saveFailed'))
      }
      const response = await port.saveSettings({
        ...current.settings,
        notes: patch(notesOf(current.settings), input),
      })
      if (!response.success) throw new Error(response.error || t('notes.saveFailed'))
    },
    onError: (error) => {
      notify({
        level: 'error',
        source: 'settings.notes',
        title: t('notes.saveFailed'),
        body: error.message,
        detail: error.message,
      })
    },
    // 后端订着 `settings:changed` 重问驱动(`wiring/notes/index.ts`),所以写完
    // 之后名册可能真的变了(关掉一个系统 = 它的库整批退场)。对一次账。
    settle: () => notesListQuery.invalidate(),
  })
}

/** 「使用 Obsidian 的库」那一格总开关(键 = 驱动 id,契约层不点名字)。 */
export const setNoteSystemEnabledMutation: Mutation<{ systemId: string; enabled: boolean }, void> =
  notesWrite(
    'notes.setSystemEnabled',
    (notes, { systemId, enabled }) => ({
      ...notes,
      systems: { ...notes.systems, [systemId]: { ...notes.systems?.[systemId], enabled } },
    }),
  )

/** 一行的「启用」。 */
export const setVaultEnabledMutation: Mutation<{ vaultId: string; enabled: boolean }, void> =
  notesWrite(
    'notes.setVaultEnabled',
    (notes, { vaultId, enabled }) => ({
      ...notes,
      vaults: { ...notes.vaults, [vaultId]: { ...notes.vaults?.[vaultId], enabled } },
    }),
    (data, { vaultId, enabled }) => ({
      ...data,
      vaults: data.vaults.map((v) => (v.id === vaultId ? { ...v, enabled } : v)),
    }),
  )

/** 一行的「技能来源」。 */
export const setVaultSkillsMutation: Mutation<{ vaultId: string; skills: boolean }, void> =
  notesWrite(
    'notes.setVaultSkills',
    (notes, { vaultId, skills }) => ({
      ...notes,
      vaults: { ...notes.vaults, [vaultId]: { ...notes.vaults?.[vaultId], skills } },
    }),
    (data, { vaultId, skills }) => ({
      ...data,
      vaults: data.vaults.map((v) => (v.id === vaultId ? { ...v, skills } : v)),
    }),
  )

/** 「主库」那一列单选。**一次只有一个** —— 乐观补丁把别人那一格一起翻掉。 */
export const setPrimaryVaultMutation: Mutation<string, void> = notesWrite<string>(
  'notes.setPrimaryVault',
  (notes, primaryVaultId) => ({ ...notes, primaryVaultId }),
  (data, primaryVaultId) => ({
    ...data,
    vaults: data.vaults.map((v) => ({ ...v, primary: v.id === primaryVaultId })),
  }),
)

/** 目录表(增 / 删同一条写路:屏上收到的永远是**整张新表**)。 */
export const setNoteFoldersMutation: Mutation<string[], void> = notesWrite<string[]>(
  'notes.setFolders',
  (notes, folders) => ({ ...notes, folders }),
  (data, folders) => ({ ...data, folders }),
)

/** 「日记文件名格式」。空 → 写空字符串,由后端那一侧回落到缺省(`toNotesConfig`)。 */
export const setDailyFormatMutation: Mutation<string, void> = notesWrite<string>(
  'notes.setDailyFormat',
  (notes, dailyFormat) => ({ ...notes, dailyFormat }),
)

/**
 * **别的面 / 别的客户端改了设置,这一页要跟着变。**
 *
 * 订阅挂在这只 `start()` 上而不是组件里:这一页可能同时挂着好几份(设置页在
 * 架子里开着、又被抬上舞台),而订阅只该有一条。幂等 —— 再调一次什么都不做。
 * (与 `theme-settings-source.startThemeSettingsSource` 逐字同体例。)
 */
let unsubscribe: (() => void) | undefined
let starting: Promise<void> | undefined

export function startNotesSource(): Promise<void> {
  starting ??= (async () => {
    const port = await notesPort()
    await port.ready()
    unsubscribe?.()
    unsubscribe = port.onSettingsChanged(() => {
      void notesListQuery.invalidate()
    })
  })().catch(() => {
    // 连不上就没有推送面 —— 这一页照旧可读可写(那两条各自有自己的错处理),
    // 只是听不见别人改。静默是对的:这里没有一句话是用户此刻在等的。
  })
  return starting
}

/** 测试用:把模块级的一次性状态清干净。**本模块唯一的一口拆卸**。 */
export function resetNotesSourceForTest(): void {
  unsubscribe?.()
  unsubscribe = undefined
  starting = undefined
  notesListQuery.reset()
  setNoteSystemEnabledMutation.reset()
  setVaultEnabledMutation.reset()
  setVaultSkillsMutation.reset()
  setPrimaryVaultMutation.reset()
  setNoteFoldersMutation.reset()
  setDailyFormatMutation.reset()
}

/**
 * **HMR 退役**(壳规范「模块级副作用必须配 HMR dispose」,09-01 立法)。
 * 退役**复用这只模块已有的那一口拆卸**,不写第二套。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetNotesSourceForTest()
  })
}
