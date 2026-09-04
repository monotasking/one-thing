/**
 * Search providers — each produces results for a category
 */

import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs/promises'
import {
  executeOnethingSearch,
} from './search-runtime.js'
import type { OnethingSearchRuntimeAdapters } from './search-runtime.js'
import type { OnethingSearchCategory } from './ipc-operations.js'

type SearchCategory = OnethingSearchCategory

export interface OnethingSearchResult {
  id: string
  type: 'chat' | 'message' | 'action' | 'file' | 'daily' | 'prompt'
  title: string
  subtitle?: string
  detail?: string
  sessionId?: string
  messageId?: string
  actionId?: string
  filePath?: string
  timestamp?: number
  shortcut?: string
  matchRanges?: Array<{ start: number; end: number }>
}

type SearchResult = OnethingSearchResult

export interface OnethingSearchSessionMeta {
  id: string
  name?: string
  previewText?: string
  isArchived?: boolean
  updatedAt: number
}

export interface OnethingSearchMessage {
  id: string
  role?: string
  content?: unknown
  timestamp?: number
}

/**
 * `getSession` 的返回:搜索只从会话上要**空间语境**(工作目录),不要消息。
 * 消息一律走 `iterateSessionMessages`(P0.2 区 ②;P0.4 起是必填端口,raw 回落已删)。
 */
export interface OnethingSearchSession {
  workingDirectory?: string
}

export interface OnethingSearchPrompt {
  id: string
  title: string
  description?: string
  body: string
  tags?: string[]
  updatedAt: number
}

export interface OnethingSearchVariablesStore {
  getUserNoteDir(): string | undefined
  getWorkNoteDir(): string | undefined
}

export interface OnethingDailyNoteSettings {
  enabled?: boolean
  directoryMode?: 'personal' | 'custom' | string
  customDirectory?: string
  useObsidianConfig?: boolean
  format?: string
}

export interface OnethingSearchSettings {
  general: {
    dailyNotes?: OnethingDailyNoteSettings
  }
}

export interface OnethingSearchListFilesOptions {
  cwd: string
  glob?: string[]
  hidden?: boolean
  noIgnore?: boolean
}

export interface OnethingSearchProvidersAdapters {
  getSessionsList(): OnethingSearchSessionMeta[]
  /**
   * 全库消息搜索按会话取消息。**raw 语义**:不进 LRU、不 sanitize、不回写
   * (一次搜索翻 N 间会话,走 `getSession` 会把整个会话库灌进 LRU)。宿主接
   * `sessionReads.iterateMessagesRaw`。
   */
  iterateSessionMessages(sessionId: string): Iterable<OnethingSearchMessage>
  getSession(sessionId: string): OnethingSearchSession | undefined
  getCurrentSessionId(): string | undefined
  getSettings(): OnethingSearchSettings
  getVariablesStore(): OnethingSearchVariablesStore
  /** 用户配置的「接入目录」;缺席/空数组 = 搜索根与没有这个功能时一致。 */
  getConnectedDirectories?(): string[]
  listFiles(options: OnethingSearchListFilesOptions): AsyncIterable<string>
  listPrompts(): OnethingSearchPrompt[]
}


let configuredAdapters: OnethingSearchProvidersAdapters | undefined

export function configureOnethingSearchProviders(adapters: OnethingSearchProvidersAdapters): void {
  configuredAdapters = adapters
}

function getSearchAdapters(adapters?: OnethingSearchProvidersAdapters): OnethingSearchProvidersAdapters {
  const resolved = adapters ?? configuredAdapters
  if (!resolved) throw new Error('Onething search providers are not configured')
  return resolved
}

export function createOnethingSearchProviders(adapters: OnethingSearchProvidersAdapters): {
  createDailyNote(filePath: string): Promise<string>
  executeSearch(query: string, category: SearchCategory, limit?: number): Promise<SearchResult[]>
} {
  return {
    createDailyNote: filePath => createDailyNote(filePath, adapters),
    executeSearch: (query, category, limit) => executeSearch(query, category, limit, adapters),
  }
}

// ---------------------------------------------------------------------------
// Actions registry
// ---------------------------------------------------------------------------

export interface ActionDefinition {
  id: string
  name: string
  keywords?: string[]
  shortcut?: string
}

const ACTIONS: ActionDefinition[] = [
  { id: 'new-chat', name: 'New Chat', keywords: ['chat', 'conversation', 'create'], shortcut: '⌘N' },
  { id: 'open-settings', name: 'Open Settings', keywords: ['preferences', 'config'], shortcut: '⌘,' },
  { id: 'toggle-sidebar', name: 'Toggle Sidebar', keywords: ['panel', 'nav'], shortcut: '⌘B' },
  { id: 'toggle-inspector', name: 'Toggle Inspector', keywords: ['details', 'debug', 'steps'] },
  { id: 'close-chat', name: 'Close Chat', keywords: ['delete', 'remove'] },
  { id: 'focus-input', name: 'Focus Input', keywords: ['composer', 'prompt', 'message'] },
]

// ---------------------------------------------------------------------------
// Search functions
// ---------------------------------------------------------------------------

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/^>/, '').replace(/^\//, '').trim()
}

function scoreText(text: string | undefined, query: string): number {
  if (!query) return 1
  const value = (text || '').toLowerCase()
  if (!value) return 0
  if (value === query) return 100
  if (value.startsWith(query)) return 80
  const idx = value.indexOf(query)
  if (idx >= 0) return 60 - Math.min(idx, 40)
  return 0
}

function matchRanges(text: string, query: string): Array<{ start: number; end: number }> | undefined {
  if (!query) return undefined
  const idx = text.toLowerCase().indexOf(query)
  return idx >= 0 ? [{ start: idx, end: idx + query.length }] : undefined
}

function searchChats(query: string, limit: number, adapters: OnethingSearchProvidersAdapters): SearchResult[] {
  const sessions = adapters.getSessionsList()
  const q = normalizeQuery(query)

  const matched = sessions
    .filter(s => !s.isArchived)
    .map(s => ({
      session: s,
      score: Math.max(scoreText(s.name, q), scoreText(s.previewText, q) * 0.8),
    }))
    .filter(item => !q || item.score > 0)
    .sort((a, b) => (b.score - a.score) || (b.session.updatedAt - a.session.updatedAt))
    .slice(0, limit)

  return matched.map(({ session: s }) => ({
    id: `chat:${s.id}`,
    type: 'chat' as const,
    title: s.name || 'New Chat',
    subtitle: s.previewText,
    sessionId: s.id,
    timestamp: s.updatedAt,
    matchRanges: matchRanges(s.name || 'New Chat', q),
  }))
}

function searchMessages(query: string, limit: number, adapters: OnethingSearchProvidersAdapters): SearchResult[] {
  if (!query.trim()) return []

  const sessions = adapters.getSessionsList()
  const q = normalizeQuery(query)
  if (!q) return []
  const results: SearchResult[] = []

  for (const meta of sessions) {
    if (results.length >= limit) break
    if (meta.isArchived) continue

    const messages = adapters.iterateSessionMessages(meta.id)
    if (!messages) continue

    for (const msg of messages) {
      if (results.length >= limit) break
      const content = typeof msg.content === 'string' ? msg.content : ''
      const idx = content.toLowerCase().indexOf(q)
      if (idx === -1) continue

      const start = Math.max(0, idx - 30)
      const end = Math.min(content.length, idx + q.length + 50)
      const leading = start > 0 ? '...' : ''
      const snippet = (start > 0 ? '...' : '')
        + content.slice(start, end)
        + (end < content.length ? '...' : '')

      results.push({
        id: `msg:${meta.id}:${msg.id}`,
        type: 'message',
        title: snippet,
        subtitle: meta.name || 'New Chat',
        detail: msg.role === 'user' ? 'User message' : 'Assistant message',
        sessionId: meta.id,
        messageId: msg.id,
        timestamp: msg.timestamp ?? meta.updatedAt,
        matchRanges: [{ start: leading.length + idx - start, end: leading.length + idx - start + q.length }],
      })
    }
  }
  return results
}

function searchActions(query: string, limit: number): SearchResult[] {
  const q = normalizeQuery(query)
  return ACTIONS
    .map(a => ({
      action: a,
      score: Math.max(scoreText(a.name, q), ...(a.keywords || []).map(k => scoreText(k, q) * 0.75)),
    }))
    .filter(item => !q || item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ action }) => ({
      id: `action:${action.id}`,
      type: 'action' as const,
      title: action.name,
      subtitle: action.keywords?.slice(0, 3).join(' · '),
      actionId: action.id,
      shortcut: action.shortcut,
      matchRanges: matchRanges(action.name, q),
    }))
}

function createPromptTitleFromQuery(query: string): string {
  const q = query.trim()
    .replace(/^>/, '')
    .replace(/^\//, '')
    .trim()
    .replace(/^create\s+prompt\s*/i, '')
    .replace(/^new\s+prompt\s*/i, '')
    .trim()
  return q || 'Untitled Prompt'
}

function searchPrompts(
  query: string,
  limit: number,
  adapters: OnethingSearchProvidersAdapters,
  includeCreateShortcut = true,
): SearchResult[] {
  const q = normalizeQuery(query)
  const prompts = adapters.listPrompts()
  const matched = prompts
    .map(prompt => {
      const searchable = [
        prompt.title,
        prompt.description,
        prompt.body,
        ...(prompt.tags || []),
      ]
      return {
        prompt,
        score: Math.max(
          scoreText(prompt.title, q),
          scoreText(prompt.description, q) * 0.8,
          scoreText((prompt.tags || []).join(' '), q) * 0.7,
          scoreText(prompt.body, q) * 0.45,
        ),
        searchable: searchable.join(' '),
      }
    })
    .filter(item => !q || item.score > 0 || item.searchable.toLowerCase().includes(q))
    .sort((a, b) => (b.score - a.score) || (b.prompt.updatedAt - a.prompt.updatedAt))
    .slice(0, Math.max(0, includeCreateShortcut ? limit - 1 : limit))
    .map(({ prompt }) => ({
      id: `prompt:${prompt.id}`,
      type: 'prompt' as const,
      title: prompt.title,
      subtitle: prompt.description || prompt.body.slice(0, 90),
      detail: (prompt.tags || []).join(' · ') || 'Prompt',
      actionId: `insert-prompt:${prompt.id}`,
      timestamp: prompt.updatedAt,
      matchRanges: matchRanges(prompt.title, q),
    }))

  const wantsCreate = q && (
    matched.length === 0 ||
    q.startsWith('create prompt') ||
    q.startsWith('new prompt')
  )
  if (includeCreateShortcut && wantsCreate) {
    const title = createPromptTitleFromQuery(query)
    matched.unshift({
      id: `prompt-create:${encodeURIComponent(title)}`,
      type: 'prompt',
      title: `Create prompt "${title}"`,
      subtitle: 'Save a reusable prompt snippet',
      detail: 'Prompt',
      actionId: `create-prompt:${encodeURIComponent(title)}`,
      timestamp: Date.now(),
      matchRanges: matchRanges(title, q),
    })
  }

  return matched.slice(0, limit)
}

// ---------------------------------------------------------------------------
// File search
// ---------------------------------------------------------------------------

function expandPath(p: string): string {
  if (p.startsWith('~')) return p.replace('~', os.homedir())
  return p
}

function getSearchDirs(adapters: OnethingSearchProvidersAdapters): string[] {
  const seen = new Set<string>()
  const dirs: string[] = []

  function add(p: string | undefined | null) {
    if (!p) return
    const expanded = expandPath(p)
    if (!seen.has(expanded)) {
      seen.add(expanded)
      dirs.push(expanded)
    }
  }

  // Session workdir
  const sid = adapters.getCurrentSessionId()
  if (sid) {
    const session = adapters.getSession(sid)
    add(session?.workingDirectory)
  }

  // Global note dirs
  const store = adapters.getVariablesStore()
  add(store.getUserNoteDir())
  add(store.getWorkNoteDir())

  // 接入目录。`add` 自带去重,所以与会话工作目录/笔记根重合时不会搜两遍。
  for (const dir of adapters.getConnectedDirectories?.() ?? []) {
    add(dir)
  }

  return dirs
}

async function searchFiles(
  query: string,
  limit: number,
  adapters: OnethingSearchProvidersAdapters,
): Promise<SearchResult[]> {
  const dirs = getSearchDirs(adapters)
  if (dirs.length === 0) return []

  const q = normalizeQuery(query)
  if (!q) return []
  const results: SearchResult[] = []

  for (const cwd of dirs) {
    if (results.length >= limit) break
    try {
      for await (const relPath of adapters.listFiles({ cwd, hidden: false, noIgnore: true })) {
        if (results.length >= limit) break
        // Match against full relative path (covers both filename and directory)
        if (!relPath.toLowerCase().includes(q)) continue

        const absPath = path.join(cwd, relPath)
        const dirLabel = path.basename(cwd)
        results.push({
          id: `file:${absPath}`,
          type: 'file',
          title: path.basename(relPath),
          subtitle: `${dirLabel}/${relPath}`,
          detail: cwd,
          filePath: absPath,
          matchRanges: matchRanges(path.basename(relPath), q),
        })
      }
    } catch {
      // directory may not exist
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Daily note search
// ---------------------------------------------------------------------------

interface DailyNoteProfile {
  vaultRoot: string
  searchDir: string
  format: string
  template?: string
  label: string
  source: 'obsidian' | 'folder'
}

interface DailySearchResult extends SearchResult {
  fileMtime?: number
  fileCtime?: number
  isCreateShortcut?: boolean
}

const DEFAULT_DAILY_FORMAT = 'YYYY-MM-DD'
const DAILY_SEARCH_CANDIDATE_LIMIT = 1000
const COMMON_DAILY_FORMATS = [
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'YYYY/MM/YYYY-MM-DD',
  'YYYY/MM-MMMM/YYYY-MM-DD',
  'YYYYMMDD',
  'YYYY.MM.DD',
  'YYYY_MM_DD',
  'DD-MM-YYYY',
  'MM-DD-YYYY',
]
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

function localDateFromParts(year: number, month: number, day: number): Date | null {
  const date = new Date(year, month - 1, day)
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) return null
  return date
}

function toIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatDailyDate(format: string, date: Date): string {
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

function stripMarkdownExtension(filePath: string): string {
  return filePath.replace(/\.md$/i, '')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseDateByFormat(relWithoutExt: string, format: string): Date | null {
  const groups: string[] = []
  let pattern = ''

  for (let i = 0; i < format.length;) {
    const token = DATE_FORMAT_TOKENS.find(t => format.startsWith(t, i))
    if (token) {
      if (token === 'ddd' || token === 'dddd') {
        pattern += token === 'dddd' ? `(?:${WEEKDAY_NAMES.join('|')})` : `(?:${WEEKDAY_SHORT_NAMES.join('|')})`
      } else {
        groups.push(token)
        pattern += token === 'YYYY' ? '(\\d{4})'
          : token === 'YY' ? '(\\d{2})'
            : token === 'MMMM' ? `(${MONTH_NAMES.join('|')})`
              : token === 'MMM' ? `(${MONTH_SHORT_NAMES.join('|')})`
                : '(\\d{1,2})'
      }
      i += token.length
      continue
    }
    pattern += format[i] === '/' ? '[\\\\/]' : escapeRegExp(format[i])
    i += 1
  }

  const match = relWithoutExt.match(new RegExp(`^${pattern}$`, 'i'))
  if (!match) return null

  let year = 0
  let month = 0
  let day = 0
  groups.forEach((token, index) => {
    const value = Number(match[index + 1])
    if (token === 'YYYY') year = value
    else if (token === 'YY') year = value >= 70 ? 1900 + value : 2000 + value
    else if (token === 'MM' || token === 'M') month = value
    else if (token === 'MMMM') month = MONTH_NAMES.findIndex(name => name.toLowerCase() === match[index + 1].toLowerCase()) + 1
    else if (token === 'MMM') month = MONTH_SHORT_NAMES.findIndex(name => name.toLowerCase() === match[index + 1].toLowerCase()) + 1
    else if (token === 'DD' || token === 'D') day = value
  })

  if (!year || !month || !day) return null
  return localDateFromParts(year, month, day)
}

function parseDateFromPath(relPath: string, preferredFormat?: string): Date | null {
  const relWithoutExt = stripMarkdownExtension(relPath).split(path.sep).join('/')
  if (preferredFormat) {
    const parsed = parseDateByFormat(relWithoutExt, preferredFormat)
    if (parsed) return parsed
  }

  for (const format of COMMON_DAILY_FORMATS) {
    const parsed = parseDateByFormat(relWithoutExt, format)
    if (parsed) return parsed
  }

  const compact = relWithoutExt.match(/(?:^|[^\d])(\d{4})(\d{2})(\d{2})(?:$|[^\d])/)
  if (compact) return localDateFromParts(Number(compact[1]), Number(compact[2]), Number(compact[3]))

  const ymd = relWithoutExt.match(/(?:^|[^\d])(\d{4})[-_.](\d{1,2})[-_.](\d{1,2})(?:$|[^\d])/)
  if (ymd) return localDateFromParts(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]))

  return null
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

async function getDailyNoteProfiles(adapters: OnethingSearchProvidersAdapters): Promise<DailyNoteProfile[]> {
  const dailySettings = adapters.getSettings().general.dailyNotes
  if (dailySettings?.enabled === false) return []

  const profiles: DailyNoteProfile[] = []
  const seen = new Set<string>()

  async function add(profile: DailyNoteProfile | null) {
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
  const q = normalizeQuery(query)
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

async function searchDailyNotes(
  query: string,
  limit: number,
  adapters: OnethingSearchProvidersAdapters,
): Promise<SearchResult[]> {
  const profiles = await getDailyNoteProfiles(adapters)
  const q = normalizeQuery(query)
  const results: DailySearchResult[] = []
  const seen = new Set<string>()
  const today = new Date()
  const todayIso = toIsoDate(today)
  let hasTodayShortcut = false

  for (const profile of profiles) {
    const todayRel = `${formatDailyDate(profile.format, today)}.md`
    const todayPath = path.resolve(profile.searchDir, todayRel)
    const todayExists = await pathExists(todayPath)
    if (!hasTodayShortcut && todayMatchesQuery(query, todayIso)) {
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
      results.push(todayResult)
      seen.add(todayPath)
      hasTodayShortcut = true
    }

    try {
      let matchedCandidates = 0
      for await (const relPath of adapters.listFiles({ cwd: profile.searchDir, glob: ['**/*.md'], hidden: false, noIgnore: true })) {
        if (matchedCandidates >= DAILY_SEARCH_CANDIDATE_LIMIT) break
        const absPath = path.resolve(profile.searchDir, relPath)
        if (seen.has(absPath)) continue

        const date = parseDateFromPath(relPath, profile.format)
        if (!date) continue
        matchedCandidates += 1

        const iso = toIsoDate(date)
        const title = `${iso} · ${path.basename(relPath, '.md')}`
        const searchable = `${iso} ${relPath}`.toLowerCase()
        if (q && !searchable.includes(q)) continue
        const stats = await fs.stat(absPath).catch(() => null)

        seen.add(absPath)
        results.push({
          id: `daily:${absPath}`,
          type: 'daily',
          title,
          subtitle: path.relative(profile.vaultRoot, absPath) || relPath,
          detail: profile.source === 'obsidian' ? 'Obsidian daily note' : 'Daily note',
          filePath: absPath,
          timestamp: date.getTime(),
          fileMtime: stats?.mtimeMs,
          fileCtime: stats?.ctimeMs,
          matchRanges: matchRanges(title, q),
        })
      }
    } catch {
      // directory may not exist yet; the create-today result above still works
    }
  }

  return results
    .sort((a, b) => {
      if (q && a.isCreateShortcut !== b.isCreateShortcut) return a.isCreateShortcut ? 1 : -1
      return (b.timestamp ?? 0) - (a.timestamp ?? 0)
        || (b.fileMtime ?? 0) - (a.fileMtime ?? 0)
        || (b.fileCtime ?? 0) - (a.fileCtime ?? 0)
        || a.title.localeCompare(b.title)
    })
    .slice(0, limit)
}

// ---------------------------------------------------------------------------
// Unified search
// ---------------------------------------------------------------------------

/**
 * 六路扫描器的**唯一入口对象**。
 *
 * 从前它是 `executeSearch` 里的一个内联字面量;S2(检索重建,
 * `docs/design/search-index-2026-09.md` §10 S2)把它提成命名产物,因为
 * `search/capabilities/` 下那六个能力要**逐字调用同一批函数** —— 能力包装期
 * 的判据是「行为零变化」,新旧两条路必须落到同一份实现上,而不是各自再写一遍
 * 匹配与排序。旧路 `executeSearch` 与新路 `SearchService` 于是共用这一个对象。
 */
export function createOnethingSearchRuntimeAdapters(
  adapters: OnethingSearchProvidersAdapters,
): OnethingSearchRuntimeAdapters<SearchResult> {
  return {
    searchChats: (searchQuery, searchLimit) => searchChats(searchQuery, searchLimit, adapters),
    searchMessages: (searchQuery, searchLimit) => searchMessages(searchQuery, searchLimit, adapters),
    searchActions,
    searchPrompts: (searchQuery, searchLimit, includeCreateShortcut) =>
      searchPrompts(searchQuery, searchLimit, adapters, includeCreateShortcut),
    searchFiles: (searchQuery, searchLimit) => searchFiles(searchQuery, searchLimit, adapters),
    searchDailyNotes: (searchQuery, searchLimit) => searchDailyNotes(searchQuery, searchLimit, adapters),
  }
}

export async function executeSearch(
  query: string,
  category: SearchCategory,
  limit = 20,
  adapters?: OnethingSearchProvidersAdapters,
): Promise<SearchResult[]> {
  const resolvedAdapters = getSearchAdapters(adapters)
  return executeOnethingSearch<SearchResult>(
    query,
    category,
    limit,
    createOnethingSearchRuntimeAdapters(resolvedAdapters),
  )
}
