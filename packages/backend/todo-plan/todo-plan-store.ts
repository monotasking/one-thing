import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

export type TodoPlanScope = 'user-note' | 'session-ai-todo'

export interface TodoPlanContext {
  sessionId?: string
}

export interface TodoPlanDocument {
  id: string
  scope: TodoPlanScope
  title: string
  role: 'user' | 'assistant' | 'plan'
  filePath: string
  content: string
  updatedAt: number
  totalTasks: number
}

export interface TodoPlanSnapshot {
  directory: string
  userNotes: TodoPlanDocument[]
  sessionAiTodo?: TodoPlanDocument
  /** The session this snapshot was read for, after the host resolved it. */
  sessionId?: string
}

export interface TodoPlanChangedPayload extends TodoPlanContext {
  scope: TodoPlanScope | 'global-user' | 'all'
  document?: TodoPlanDocument
}

export interface TodoPlanUpdateRequest extends TodoPlanContext {
  scope: TodoPlanScope
  id?: string
  content: string
}

export interface OnethingTodoPlanStoreOptions {
  getConfiguredDirectory?: () => string | undefined
  getDefaultStorePath: () => string
  notifyChanged?: (payload: TodoPlanChangedPayload) => void
  revealDirectory?: (directory: string) => Promise<unknown> | unknown
}

const USER_NOTES_DIR = 'user-notes'
const SESSIONS_DIR = 'sessions'
const AI_TODO_FILE = 'ai-todo.md'

/**
 * Session ids and note ids arrive over IPC and are pasted straight into a file
 * path, so they must be a single ordinary path segment. '..', a separator or an
 * absolute path would escape the todo directory — and the permission policy
 * trusts that these files stay inside it.
 */
function assertPathSegment(value: string, label: string): string {
  const trimmed = value.trim()
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0') ||
    path.isAbsolute(trimmed) ||
    path.basename(trimmed) !== trimmed
  ) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`)
  }
  return trimmed
}

function countTasks(content: string): number {
  return content.split('\n').filter(line => /^\s*[-*]\s+\[[ xX]]\s+/.test(line)).length
}

function safeSlug(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 44)
  return slug || 'todo'
}

function titleFromContent(content: string, fallback: string): string {
  const heading = content.split('\n').map(line => line.trim()).find(line => line.startsWith('# '))
  return heading ? heading.replace(/^#\s+/, '').trim() || fallback : fallback
}

function hasSubstantiveMarkdownContent(content: string): boolean {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^#{1,6}\s+/.test(line) && !/^-{3,}$/.test(line))
    .join('\n')
    .trim().length > 0
}

async function readDocument(filePath: string, fallback = ''): Promise<{ content: string; updatedAt: number }> {
  try {
    const [content, stats] = await Promise.all([
      fs.readFile(filePath, 'utf-8'),
      fs.stat(filePath),
    ])
    return { content, updatedAt: stats.mtimeMs }
  } catch {
    return { content: fallback, updatedAt: 0 }
  }
}

async function writeFileEnsured(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
}

// A write the store performs itself already broadcasts through notifyChanged.
// The file watcher would see that same write land on disk and broadcast a second
// time, so self-writes are remembered and skipped by the watcher — **by content, not
// by time**. The old rule skipped every change to that path for 2 seconds after our
// own write, which swallowed a real external write (an AI tool, another editor) that
// landed inside the window; the UI then kept the stale copy and its next edit wrote
// the stale lines back into the file (09-17, reproduced on a real machine). The window
// below only bounds how long a memo is kept, it no longer decides anything.
const SELF_WRITE_TTL_MS = 10_000

/** Directory lookup is a pure query; it does not require opening a writable store. */
export function resolveOnethingTodoPlanDirectory(storePath: string, configuredDirectory?: string): string {
  const configured = configuredDirectory?.trim()
  if (!configured) return path.join(storePath, 'todo-plan')
  return configured === '~' || configured.startsWith('~/')
    ? path.join(os.homedir(), configured.slice(2))
    : configured
}

export class OnethingTodoPlanStore {
  /** `content: null` = we deleted it (the echo is "the file is gone"). */
  private readonly selfWrites = new Map<string, { content: string | null; at: number }>()

  constructor(private readonly options: OnethingTodoPlanStoreOptions) {}

  private markSelfWrite(filePath: string, content: string | null): void {
    const now = Date.now()
    for (const [key, memo] of this.selfWrites) {
      if (now - memo.at > SELF_WRITE_TTL_MS) this.selfWrites.delete(key)
    }
    this.selfWrites.set(path.resolve(filePath), { content, at: now })
  }

  /** The file on disk is still exactly what we last wrote there (so the watcher event is our own echo). */
  wasSelfWrite(filePath: string): boolean {
    const key = path.resolve(filePath)
    const memo = this.selfWrites.get(key)
    if (!memo) return false
    if (Date.now() - memo.at > SELF_WRITE_TTL_MS) {
      this.selfWrites.delete(key)
      return false
    }
    try {
      return readFileSync(key, 'utf8') === memo.content
    } catch {
      // Unreadable = absent: that is our echo only if what we did was delete it.
      return memo.content === null
    }
  }

  private async writeOwn(filePath: string, content: string): Promise<void> {
    this.markSelfWrite(filePath, content)
    await writeFileEnsured(filePath, content)
  }

  private async unlinkOwn(filePath: string): Promise<void> {
    this.markSelfWrite(filePath, null)
    await fs.unlink(filePath).catch(() => {})
  }

  getDirectory(): string {
    return resolveOnethingTodoPlanDirectory(this.options.getDefaultStorePath(), this.options.getConfiguredDirectory?.())
  }

  async readSnapshot(context: TodoPlanContext = {}): Promise<TodoPlanSnapshot> {
    const directory = this.getDirectory()
    await this.ensureDefaultUserNote()

    const userDirectory = path.join(directory, USER_NOTES_DIR)
    const entries = await fs.readdir(userDirectory, { withFileTypes: true }).catch(() => [])
    const userNotes = await Promise.all(
      entries
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(entry => {
          const id = entry.name.replace(/\.md$/i, '')
          return this.toDocument({
            id,
            scope: 'user-note',
            role: 'user',
            title: id.replace(/-/g, ' '),
            filePath: path.join(userDirectory, entry.name),
          })
        }),
    )

    const sessionAiTodo = await this.readSessionAiTodo(context.sessionId)

    return {
      directory,
      userNotes,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(sessionAiTodo ? { sessionAiTodo } : {}),
    }
  }

  async createUserNote(title: string, content?: string): Promise<TodoPlanDocument> {
    const cleanTitle = title.trim() || 'Untitled Todo'
    const base = safeSlug(cleanTitle)
    let id = base
    let index = 2
    while (true) {
      try {
        await fs.access(this.userNotePath(id))
        id = `${base}-${index}`
        index += 1
      } catch {
        break
      }
    }

    const filePath = this.userNotePath(id)
    await this.writeOwn(filePath, content ?? `# ${cleanTitle}\n\n`)
    const document = await this.toDocument({ id, scope: 'user-note', role: 'user', title: cleanTitle, filePath })
    this.notifyChanged({ scope: 'global-user', document })
    return document
  }

  async updateDocument(request: TodoPlanUpdateRequest): Promise<TodoPlanDocument> {
    let filePath: string
    let id: string
    let role: TodoPlanDocument['role']
    let title: string

    if (request.scope === 'user-note') {
      if (!request.id) throw new Error('id is required for user-note updates')
      id = request.id
      filePath = this.userNotePath(id)
      role = 'user'
      title = id.replace(/-/g, ' ')
    } else if (request.scope === 'session-ai-todo') {
      if (!request.sessionId) throw new Error('sessionId is required for session-ai-todo updates')
      id = 'session-ai-todo'
      filePath = this.sessionAiTodoPath(request.sessionId)
      role = 'assistant'
      title = 'AI Todo'
      const exists = Boolean(await fs.stat(filePath).catch(() => null))
      if (!exists && !hasSubstantiveMarkdownContent(request.content)) {
        throw new Error('session-ai-todo content is empty; it is created only after there is real AI todo content')
      }
    } else {
      throw new Error(`Unsupported todo/plan scope: ${request.scope}`)
    }

    await this.writeOwn(filePath, request.content)
    const document = await this.toDocument({ id, scope: request.scope, role, title, filePath })
    this.notifyChanged({
      scope: request.scope === 'user-note' ? 'global-user' : request.scope,
      sessionId: request.sessionId,
      document,
    })
    return document
  }

  async renameUserNote(id: string, title: string): Promise<TodoPlanDocument> {
    const currentPath = this.userNotePath(id)
    const nextTitle = title.trim() || 'Untitled Todo'
    let nextId = safeSlug(nextTitle)
    let index = 2
    while (nextId !== id) {
      try {
        await fs.access(this.userNotePath(nextId))
        nextId = `${safeSlug(nextTitle)}-${index}`
        index += 1
      } catch {
        break
      }
    }

    const content = (await readDocument(currentPath)).content
    const withoutHeading = content.replace(/^# .*(\r?\n|$)/, '')
    const nextContent = `# ${nextTitle}\n${withoutHeading.startsWith('\n') ? withoutHeading : `\n${withoutHeading}`}`
    const nextPath = this.userNotePath(nextId)
    await this.writeOwn(nextPath, nextContent)
    if (nextId !== id) await this.unlinkOwn(currentPath)

    const document = await this.toDocument({ id: nextId, scope: 'user-note', role: 'user', title: nextTitle, filePath: nextPath })
    this.notifyChanged({ scope: 'global-user', document })
    return document
  }

  async deleteUserNote(id: string): Promise<void> {
    await this.unlinkOwn(this.userNotePath(id))
    await this.ensureDefaultUserNote()
    this.notifyChanged({ scope: 'global-user' })
  }

  // The AI todo is keyed by session, so it dies with the session. Without this
  // every deleted session would leave its todo behind forever.
  async deleteSessionAiTodo(sessionId: string): Promise<void> {
    if (!sessionId) return
    const directory = path.dirname(this.sessionAiTodoPath(sessionId))
    this.markSelfWrite(this.sessionAiTodoPath(sessionId), null)
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
  }

  async revealDirectory(): Promise<void> {
    const directory = this.getDirectory()
    await fs.mkdir(directory, { recursive: true })
    if (!this.options.revealDirectory) {
      throw new Error('Opening the todo plan directory requires the desktop app')
    }
    await this.options.revealDirectory(directory)
  }

  notifyChanged(payload: TodoPlanChangedPayload): void {
    this.options.notifyChanged?.(payload)
  }

  /** 一份用户清单的文件路径(`id` 经过与其余入口同一只路径段校验)。给 `todo:` 资源按地址读写用。 */
  userNoteFilePath(id: string): string {
    return this.userNotePath(id)
  }

  private userNotePath(id: string): string {
    return path.join(this.userNotesDirectory(), `${assertPathSegment(id, 'note id')}.md`)
  }

  // The AI todo is per-session: the session id is the whole key. There is no
  // fallback bucket — without a session there is no AI todo to read or write.
  sessionAiTodoPath(sessionId: string): string {
    return path.join(this.sessionsDirectory(), assertPathSegment(sessionId, 'sessionId'), AI_TODO_FILE)
  }

  sessionsDirectory(): string {
    return path.join(this.getDirectory(), SESSIONS_DIR)
  }

  userNotesDirectory(): string {
    return path.join(this.getDirectory(), USER_NOTES_DIR)
  }

  /**
   * The directories the AI may write with the ordinary write/edit tools.
   *
   * Deliberately the two managed subdirectories rather than the todo root: the
   * root comes from a free-text setting, so keeping the root out of this list
   * bounds the damage of a careless value to directories the app created.
   */
  writableDirectories(): string[] {
    return [this.sessionsDirectory(), this.userNotesDirectory()]
  }

  private async toDocument(input: {
    id: string
    scope: TodoPlanDocument['scope']
    role: TodoPlanDocument['role']
    title: string
    filePath: string
    fallback?: string
  }): Promise<TodoPlanDocument> {
    const { content, updatedAt } = await readDocument(input.filePath, input.fallback || '')
    return {
      id: input.id,
      scope: input.scope,
      title: titleFromContent(content, input.title),
      role: input.role,
      filePath: input.filePath,
      content,
      updatedAt,
      totalTasks: countTasks(content),
    }
  }

  private async ensureDefaultUserNote(): Promise<void> {
    const directory = path.join(this.getDirectory(), USER_NOTES_DIR)
    await fs.mkdir(directory, { recursive: true })
    const entries = await fs.readdir(directory).catch(() => [])
    if (entries.some(entry => entry.toLowerCase().endsWith('.md'))) return
    await this.writeOwn(
      path.join(directory, 'user-todo-1.md'),
      '# User Todo 1\n\n- [ ] Add the first user task\n',
    )
  }

  private async readSessionAiTodo(sessionId?: string): Promise<TodoPlanDocument | undefined> {
    if (!sessionId) return undefined
    const filePath = this.sessionAiTodoPath(sessionId)
    try {
      await fs.access(filePath)
    } catch {
      return undefined
    }
    return this.toDocument({
      id: 'session-ai-todo',
      scope: 'session-ai-todo',
      role: 'assistant',
      title: 'AI Todo',
      filePath,
    })
  }
}
