/**
 * 每日笔记这一类自己的**配置与今天那一条**。
 *
 * 设计:docs/design/search-index-2026-09.md §5.2b(`DailyNotesFeed`)/ §10 S3b 落地
 * 记录的留账 2(「今天那一条」索引答不出)。
 *
 * S5(2026-09-05)从 `providers.ts` 搬进来。搬的是三件**还活着**的东西:
 *
 *  ① `resolveDailyNoteSearchDirs` —— 索引侧 `DailyNotesFeed` 从这里认路;
 *  ② `resolveDailyTodayShortcut` —— 「打开今天 / 新建今天的日记」那一行。索引里
 *     只有盘上存在的文件,而这一条说的恰好是「今天那个文件在不在」——**不存在的
 *     文件没有文档**,索引在结构上答不出它;
 *  ③ `createDailyNote` —— ②里那条「新建」按下去之后真的建文件。
 *
 * 一起**没搬**的是旧扫描器 `searchDailyNotes` 与它私有的那套「从文件名反解日期」
 * (`parseDateFromPath` / `parseDateByFormat` / 候选封顶)——那件事 S3b 起由索引
 * 承担:投影器把文件名主干写进 `title`,索引与查询走同一只 `compositeAnalyzer`,
 * `2026-09-05` 切成 `2026` `09` `05`,于是 `2026-09-05` 与 `09-05` 都命中
 * (用例 `search/index/__tests__/daily-feed.test.ts`)。留一份反解器 = 留第二个
 * 「哪个文件算哪一天」的产地。
 *
 * 「今天那一条」的判定 `todayMatchesQuery`:空词恒真(所以空词的 daily 单类档
 * 照旧先给这一条),有词时按今天的 ISO 日期或那几个词根匹配。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { getSearchAdapters, type OnethingSearchProvidersAdapters } from '../providers.js'
import type { SearchServiceResult } from './scan-adapter.js'
import { expandPath, normalizeSearchQuery } from './text-match.js'

/**
 * 每日笔记那一路的结果。三格额外字段是**排序用的私料**(「新建那一条排最后」的闩,
 * 以及从前按 mtime / ctime 兜底次序留下的两格),不进契约层的 `SearchResult`。
 */
export interface DailySearchResult extends SearchServiceResult {
  fileMtime?: number
  fileCtime?: number
  isCreateShortcut?: boolean
}

interface DailyNoteProfile {
  vaultRoot: string
  searchDir: string
  format: string
  template?: string
  label: string
  source: 'obsidian' | 'folder'
}

const DEFAULT_DAILY_FORMAT = 'YYYY-MM-DD'
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const MONTH_SHORT_NAMES = MONTH_NAMES.map(name => name.slice(0, 3))
const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
]
const WEEKDAY_SHORT_NAMES = WEEKDAY_NAMES.map(name => name.slice(0, 3))
const DATE_FORMAT_TOKENS = ['YYYY', 'MMMM', 'MMM', 'dddd', 'ddd', 'YY', 'MM', 'M', 'DD', 'D']

function toIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 按用户配置的格式串排出「今天那个文件」的名字。 */
export function formatDailyDate(format: string, date: Date): string {
  const values: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    YY: String(date.getFullYear()).slice(-2),
    MMMM: MONTH_NAMES[date.getMonth()],
    MMM: MONTH_SHORT_NAMES[date.getMonth()],
    dddd: WEEKDAY_NAMES[date.getDay()],
    ddd: WEEKDAY_SHORT_NAMES[date.getDay()],
    MM: String(date.getMonth() + 1).padStart(2, '0'),
    M: String(date.getMonth() + 1),
    DD: String(date.getDate()).padStart(2, '0'),
    D: String(date.getDate()),
  }
  let output = ''
  for (let i = 0; i < format.length;) {
    const token = DATE_FORMAT_TOKENS.find(t => format.startsWith(t, i))
    if (token) {
      output += values[token]
      i += token.length
    } else {
      output += format[i]
      i += 1
    }
  }
  return output
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function findObsidianVaultRoot(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir)
  while (true) {
    if (await pathExists(path.join(current, '.obsidian'))) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

async function readObsidianDailyProfile(dir: string): Promise<DailyNoteProfile | null> {
  const vaultRoot = await findObsidianVaultRoot(dir)
  if (!vaultRoot) return null

  try {
    const raw = await fs.readFile(path.join(vaultRoot, '.obsidian', 'daily-notes.json'), 'utf-8')
    const config = JSON.parse(raw) as { folder?: string; format?: string; template?: string }
    const folder = config.folder?.trim()
    const searchDir = folder ? path.resolve(vaultRoot, folder) : vaultRoot
    return {
      vaultRoot,
      searchDir,
      format: config.format?.trim() || DEFAULT_DAILY_FORMAT,
      template: config.template?.trim(),
      label: folder ? `Obsidian Daily Notes/${folder}` : 'Obsidian Daily Notes',
      source: 'obsidian',
    }
  } catch {
    return {
      vaultRoot,
      searchDir: vaultRoot,
      format: DEFAULT_DAILY_FORMAT,
      label: 'Obsidian Daily Notes',
      source: 'obsidian',
    }
  }
}

/**
 * 笔记目录怎么算(设置里的自定义目录 / 个人笔记变量 / Obsidian 的
 * `daily-notes.json`)—— 这件事只在这一个函数里说。
 */
async function getDailyNoteProfiles(adapters: OnethingSearchProvidersAdapters): Promise<DailyNoteProfile[]> {
  const dailySettings = adapters.getSettings().general.dailyNotes
  if (dailySettings?.enabled === false) return []

  const profiles: DailyNoteProfile[] = []
  const seen = new Set<string>()

  async function add(profile: DailyNoteProfile | null): Promise<void> {
    if (!profile) return
    const key = `${profile.searchDir}:${profile.format}`
    if (seen.has(key)) return
    seen.add(key)
    profiles.push(profile)
  }

  const configuredDir = dailySettings?.directoryMode === 'custom'
    ? dailySettings.customDirectory
    : adapters.getVariablesStore().getUserNoteDir()
  const dailyRoot = configuredDir ? expandPath(configuredDir) : ''
  const dirs = dailyRoot ? [dailyRoot] : []

  if (dailySettings?.useObsidianConfig !== false) {
    for (const dir of dirs) {
      await add(await readObsidianDailyProfile(dir))
    }
  }

  if (profiles.some(profile => profile.source === 'obsidian')) {
    for (const dir of dirs) {
      const resolved = path.resolve(dir)
      if (profiles.some(p => p.searchDir === resolved)) continue
      await add({
        vaultRoot: resolved,
        searchDir: resolved,
        format: dailySettings?.format?.trim() || DEFAULT_DAILY_FORMAT,
        label: `${path.basename(resolved) || resolved} daily notes`,
        source: 'folder',
      })
    }
    return profiles
  }

  for (const dir of dirs) {
    const resolved = path.resolve(dir)
    if (profiles.some(p => resolved.startsWith(p.searchDir))) continue
    await add({
      vaultRoot: resolved,
      searchDir: resolved,
      format: dailySettings?.format?.trim() || DEFAULT_DAILY_FORMAT,
      label: `${path.basename(resolved) || resolved} daily notes`,
      source: 'folder',
    })
  }

  return profiles
}

function todayMatchesQuery(query: string, todayIso: string): boolean {
  const q = normalizeSearchQuery(query)
  if (!q) return true
  return todayIso.includes(q) || ['today', 'daily', 'diary', 'journal', 'note', '日记', '今天'].some(word => word.includes(q) || q.includes(word))
}

function resolveNoteFile(root: string, notePath: string): string {
  const withExtension = path.extname(notePath) ? notePath : `${notePath}.md`
  return path.resolve(root, withExtension)
}

async function readDailyTemplate(profile: DailyNoteProfile): Promise<string | null> {
  if (!profile.template) return null
  const templatePath = resolveNoteFile(profile.vaultRoot, profile.template)
  try {
    return await fs.readFile(templatePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * 每日笔记的搜索目录(索引侧的 `DailyNotesFeed` 从这里认路)。
 *
 * 它就是 `getDailyNoteProfiles` 那张表的 `searchDir` 一列去重之后的样子 —— **同一
 * 个产地**,索引不重新推一遍。同一个配置根可以答出两个目录(vault 的 daily 子目录
 * + vault 根),所以返回的是**一张表**。
 *
 * 关掉每日笔记(`dailyNotes.enabled === false`)或没配目录 → 空表 = 索引不装
 * 那一路 feed。
 */
export async function resolveDailyNoteSearchDirs(
  adapters?: OnethingSearchProvidersAdapters,
): Promise<string[]> {
  const profiles = await getDailyNoteProfiles(getSearchAdapters(adapters))
  return [...new Set(profiles.map(profile => profile.searchDir))]
}

export async function createDailyNote(
  filePath: string,
  adapters?: OnethingSearchProvidersAdapters,
): Promise<string> {
  const resolvedAdapters = getSearchAdapters(adapters)
  const profiles = await getDailyNoteProfiles(resolvedAdapters)
  const profile = profiles.find(p => filePath.startsWith(p.searchDir))
  const template = profile ? await readDailyTemplate(profile) : null
  const today = toIsoDate(new Date())
  const content = template ?? `# ${today}\n\n`

  await fs.mkdir(path.dirname(filePath), { recursive: true })
  try {
    await fs.writeFile(filePath, content, { encoding: 'utf-8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return filePath
}

/** 「今天那一条」——「打开今天」或「新建今天的日记」。 */
async function buildDailyTodayShortcut(
  profile: DailyNoteProfile,
  query: string,
  today: Date,
): Promise<DailySearchResult | undefined> {
  const todayIso = toIsoDate(today)
  if (!todayMatchesQuery(query, todayIso)) return undefined

  const todayRel = `${formatDailyDate(profile.format, today)}.md`
  const todayPath = path.resolve(profile.searchDir, todayRel)
  const todayExists = await pathExists(todayPath)
  const todayTitle = todayExists ? `Today: ${todayIso}` : `Create today's daily note: ${todayIso}`
  const todayResult: DailySearchResult = {
    id: `${todayExists ? 'daily' : 'daily-create'}:${todayPath}`,
    type: 'daily',
    title: todayTitle,
    subtitle: path.relative(profile.vaultRoot, todayPath) || path.basename(todayPath),
    detail: todayExists ? 'Open today' : `Create in ${profile.label}`,
    filePath: todayPath,
    timestamp: todayExists ? today.getTime() : 0,
    isCreateShortcut: !todayExists,
  }
  if (!todayExists) todayResult.actionId = `create-daily-note:${encodeURIComponent(todayPath)}`
  return todayResult
}

/**
 * 「今天那一条」的**唯一产地**,给索引型的 `daily` 能力用。
 *
 * 「第一把配置说了算」:判定不看 profile(`todayMatchesQuery` 只吃查询与日期),
 * 所以只有第一把 profile 出得来这一行。
 */
export async function resolveDailyTodayShortcut(
  query: string,
  adapters?: OnethingSearchProvidersAdapters,
  today: Date = new Date(),
): Promise<DailySearchResult | undefined> {
  const profiles = await getDailyNoteProfiles(getSearchAdapters(adapters))
  for (const profile of profiles) {
    const shortcut = await buildDailyTodayShortcut(profile, query, today)
    if (shortcut !== undefined) return shortcut
  }
  return undefined
}
