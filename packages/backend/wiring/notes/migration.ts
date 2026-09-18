/**
 * 一次性**播种**:把「机器上已有的笔记库」变成 `settings.notes`(P1,§3.4)。
 *
 * ## 只播种,不删
 *
 * `user_note_dir` / `work_note_dir` 两个变量,这一单
 * **一个都不动**(P3 / P2 才删)。理由是可回退:播种完之后老读者照旧工作,新
 * 领域并行跑一段时间;真出事 `git revert` 就够,不需要把用户的数据倒回去。
 *
 * ## 规则(R7)
 *
 *  - `obsidian.json` 里每个库 → `vaults[id] = { enabled: true, skills: false }`;
 *  - 老两个变量的值:**是某个库的根或在它下面** → 那个库 `skills: true`;
 *    `user_note_dir` 那个再当 `primaryVaultId`;
 *  - **不是任何库** → 进 `folders`(它就是一个裸目录,FolderDriver 接着);
 *  - `settings.notes.dailyFormat` 缺席就落缺省(P2 之前这一格是从
 *    `general.dailyNotes.format` 搬来的;那五格已随 P2 删掉)。
 *
 * ## 幂等与安全
 *
 *  - 标记 `settings.notes.migratedAt`。有值 = 一次同步返回,不读盘不写盘。
 *  - 写之前把 `settings.json` 复制到 `<store>/backups/`(照
 *    `wiring/providers/space-config-migration.ts` 的 `backupsDir()` /
 *    `backupStamp()`)。
 *  - **失败不写标记**:下次启动重跑。把整次装配拖垮是更坏的结果,所以只记不抛。
 *  - 路径一律经宿主端口 `getOnethingStorePath()`,不走模块级根 —— 08-18 C1 事故
 *    (一条迁移单测清空了用户真实的 `oauth-tokens.json`)的判例。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AppSettings } from '@shared/ipc.js'
import type { NoteVaultPreference } from '@shared/ipc/settings.js'
import { isInsideRoot, ObsidianRegistry, type ObsidianVaultRecord } from '@onething/runtime/notes'
import { getOnethingStorePath } from '@onething/runtime/storage'
import { getPersistedSettings, savePersistedSettings } from '../../stores/settings.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('notes')

export type NotesMigrationOutcome =
  | 'already-migrated'
  | 'kept-existing-config'
  | 'seeded'
  | 'failed'

export interface NotesMigrationPorts {
  /** 名册读取。缺省 = 真的 `obsidian.json`。 */
  readObsidianVaults?: () => Promise<ObsidianVaultRecord[]>
  /** 老两个变量的值。缺省 = `<store>/variables.json`。 */
  readLegacyNoteDirs?: () => { userNoteDir?: string; workNoteDir?: string }
  now?: () => number
}

/**
 * 判据:这份 `notes` 是**用户自己配过**的吗。
 *
 * `mergeWithDefaults` 会给每一份设置补上一个空的 `notes`,所以「对象在不在」问
 * 不出答案 —— 要问的是「里面有没有东西」。三格任意一格非空 = 用户配过,播种就
 * 退让(只盖标记),绝不覆盖。
 */
function hasUserNotesConfig(settings: AppSettings): boolean {
  const notes = settings.notes
  if (!notes) return false
  return Object.keys(notes.vaults ?? {}).length > 0
    || (notes.folders?.length ?? 0) > 0
    || typeof notes.primaryVaultId === 'string'
}

export async function migrateNotesSettings(ports: NotesMigrationPorts = {}): Promise<NotesMigrationOutcome> {
  const now = ports.now ?? Date.now
  try {
    const settings = getPersistedSettings()
    if (typeof settings.notes?.migratedAt === 'number') return 'already-migrated'

    if (hasUserNotesConfig(settings)) {
      writeNotes(settings, { ...settings.notes!, migratedAt: now() }, now())
      log.info('notes settings already configured; only the migration marker was written')
      return 'kept-existing-config'
    }

    const vaults = await (ports.readObsidianVaults ?? readObsidianVaultsFromRegistry)()
    const legacy = (ports.readLegacyNoteDirs ?? readLegacyNoteDirsFromStore)()

    const seeded: Record<string, NoteVaultPreference> = {}
    for (const record of vaults) seeded[record.id] = { enabled: true, skills: false }

    const folders: string[] = []
    let primaryVaultId: string | undefined

    // user 先、work 后:两个都落在同一个库上时 primary 仍然是 user 那个。
    for (const [which, value] of [['user', legacy.userNoteDir], ['work', legacy.workNoteDir]] as const) {
      const directory = value?.trim()
      if (!directory) continue
      const owner = vaults.find(record => isInsideRoot(directory, record.path))
      if (owner) {
        seeded[owner.id] = { ...seeded[owner.id], enabled: true, skills: true }
        if (which === 'user') primaryVaultId ??= owner.id
        continue
      }
      // 不是任何库 → 它就是一个裸目录。只收绝对路径(与 `folders` 的归一同口径)。
      if (path.isAbsolute(directory) && !folders.includes(directory)) folders.push(directory)
    }

    const next = {
      // 系统级开关一格不种:缺席 = 开着,种一张「全 true」的表只是噪音。
      systems: settings.notes?.systems ?? {},
      vaults: seeded,
      folders,
      // P2 删了 `general.dailyNotes` 五格,于是这里只剩自己那一格(迁移跑过的
      // 机器上它已经是老值;没跑过的机器上老值随那五格一起没了 —— 零迁移,
      // `mergeWithDefaults` 白名单式重建自然丢掉旧键)。
      dailyFormat: settings.notes?.dailyFormat || 'YYYY-MM-DD',
      ...(primaryVaultId ? { primaryVaultId } : {}),
      ...(settings.notes?.attachmentDirectory ? { attachmentDirectory: settings.notes.attachmentDirectory } : {}),
      migratedAt: now(),
    }

    writeNotes(settings, next, now())
    log.info('notes settings seeded', {
      vaults: Object.keys(seeded).length,
      folders: folders.length,
      skills: Object.values(seeded).filter(entry => entry.skills === true).length,
      primaryVaultId: primaryVaultId ?? null,
    })
    return 'seeded'
  } catch (error) {
    // 失败不写标记 —— 下次启动重跑。
    log.error('notes settings migration failed, will retry next boot', {}, error)
    return 'failed'
  }
}

function writeNotes(settings: AppSettings, notes: AppSettings['notes'], stamp: number): void {
  backupSettingsFile(stamp)
  savePersistedSettings({ ...settings, notes })
}

// ── 缺省端口 ──────────────────────────────────────────

async function readObsidianVaultsFromRegistry(): Promise<ObsidianVaultRecord[]> {
  return (await new ObsidianRegistry({ logger: log }).read()).vaults
}

/**
 * 老两个变量住 `<store>/variables.json` 的全局层。
 *
 * 这里**直接读文件**而不是问变量系统:迁移排在 `initializeSettings` 之后、变量
 * 系统装配(第 830 步)之前,那时 `getVariablesStore()` 还没 initialize。读文件
 * 是这一刻唯一诚实的答案。
 */
function readLegacyNoteDirsFromStore(): { userNoteDir?: string; workNoteDir?: string } {
  const file = path.join(getOnethingStorePath(), 'variables.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>
    return {
      userNoteDir: readVariableValue(parsed, 'user_note_dir'),
      workNoteDir: readVariableValue(parsed, 'work_note_dir'),
    }
  } catch {
    return {}
  }
}

/**
 * `variables.json` 的两种历史形状都认:`{ name: "值" }` 与
 * `{ name: { value: "值" } }`。认错一种的代价是把一个本来该 `skills:true` 的
 * 库种成 false,用户看不出原因。
 */
function readVariableValue(parsed: Record<string, unknown>, name: string): string | undefined {
  for (const container of [parsed, parsed.global, parsed.variables]) {
    if (!container || typeof container !== 'object') continue
    const entry = (container as Record<string, unknown>)[name]
    if (typeof entry === 'string' && entry.trim() !== '') return entry
    if (entry && typeof entry === 'object') {
      const value = (entry as { value?: unknown }).value
      if (typeof value === 'string' && value.trim() !== '') return value
    }
  }
  return undefined
}

// ── 备份(照 space-config-migration) ──────────────────

function backupsDir(): string {
  return path.join(getOnethingStorePath(), 'backups')
}

/** ISO 时间戳做文件名:冒号在 Windows 上不能进路径,换成 `-`。 */
function backupStamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-')
}

function backupSettingsFile(now: number): string | undefined {
  const source = path.join(getOnethingStorePath(), 'settings.json')
  if (!fs.existsSync(source)) return undefined
  const dir = backupsDir()
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, `settings-before-notes-${backupStamp(now)}.json`)
  fs.copyFileSync(source, target)
  return target
}
