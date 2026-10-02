export interface UserPrompt {
  id: string
  title: string
  body: string
  description?: string
  tags?: string[]
  createdAt: number
  updatedAt: number
}

export interface PromptCreateRequest {
  title: string
  body: string
  description?: string
  tags?: string[]
}

export interface PromptUpdateRequest {
  id: string
  title?: string
  body?: string
  description?: string
  tags?: string[]
}

export interface OnethingPromptsFile {
  prompts: UserPrompt[]
}

export interface OnethingPromptStoreAdapters {
  getPath: () => string
  readJson: <T>(path: string, fallback: T) => T
  writeJson: (path: string, value: OnethingPromptsFile) => void
  createId?: () => string
  now?: () => number
  warn?: (message: string, details?: unknown) => void
}

function normalizeTags(tags: string[] | undefined): string[] | undefined {
  const normalized = Array.from(new Set(
    (tags || [])
      .map(tag => tag.trim())
      .filter(Boolean),
  ))
  return normalized.length > 0 ? normalized : undefined
}

function numberOrNow(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function cleanPrompt(input: Partial<UserPrompt>, fallbackNow: number): UserPrompt | null {
  if (!input || typeof input !== 'object') return null
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!id) return null
  const title = typeof input.title === 'string' ? input.title.trim() : ''

  return {
    id,
    title: title || 'Untitled Prompt',
    body: typeof input.body === 'string' ? input.body : '',
    description: typeof input.description === 'string' ? input.description.trim() || undefined : undefined,
    tags: normalizeTags(Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === 'string') : undefined),
    createdAt: numberOrNow(input.createdAt, fallbackNow),
    updatedAt: numberOrNow(input.updatedAt, fallbackNow),
  }
}

export class OnethingPromptStore {
  private cache: OnethingPromptsFile | null = null
  private pathOverride: string | null = null

  constructor(private readonly adapters: OnethingPromptStoreAdapters) {}

  list(): UserPrompt[] {
    return [...this.getState().prompts].sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
        || b.updatedAt - a.updatedAt
    )
  }

  get(id: string): UserPrompt | undefined {
    return this.getState().prompts.find(prompt => prompt.id === id)
  }

  create(request: PromptCreateRequest): UserPrompt {
    const now = this.now()
    const prompt = cleanPrompt({
      id: this.createId(),
      title: request.title,
      body: request.body,
      description: request.description,
      tags: request.tags,
      createdAt: now,
      updatedAt: now,
    }, now)
    if (!prompt) throw new Error('Failed to create prompt')
    this.persist({ prompts: [...this.getState().prompts, prompt] })
    return prompt
  }

  update(request: PromptUpdateRequest): UserPrompt | undefined {
    const state = this.getState()
    const index = state.prompts.findIndex(prompt => prompt.id === request.id)
    if (index === -1) return undefined

    const current = state.prompts[index]
    const updated = cleanPrompt({
      ...current,
      title: request.title ?? current.title,
      body: request.body ?? current.body,
      description: request.description ?? current.description,
      tags: request.tags ?? current.tags,
      updatedAt: this.now(),
    }, this.now())
    if (!updated) return undefined

    const prompts = [...state.prompts]
    prompts[index] = updated
    this.persist({ prompts })
    return updated
  }

  delete(id: string): boolean {
    const state = this.getState()
    const next = state.prompts.filter(prompt => prompt.id !== id)
    if (next.length === state.prompts.length) return false
    this.persist({ prompts: next })
    return true
  }

  invalidate(): void {
    this.cache = null
  }

  setPathForTests(filePath: string | null): void {
    this.pathOverride = filePath
    this.invalidate()
  }

  private activePath(): string {
    return this.pathOverride || this.adapters.getPath()
  }

  private now(): number {
    return this.adapters.now?.() ?? Date.now()
  }

  private createId(): string {
    return this.adapters.createId?.() ?? crypto.randomUUID()
  }

  private getState(): OnethingPromptsFile {
    if (!this.cache) this.cache = this.loadFromDisk()
    return this.cache
  }

  private persist(state: OnethingPromptsFile): void {
    this.cache = state
    this.adapters.writeJson(this.activePath(), state)
  }

  private loadFromDisk(): OnethingPromptsFile {
    const raw = this.adapters.readJson<unknown>(this.activePath(), { prompts: [] })
    return this.parseFile(raw)
  }

  private parseFile(raw: unknown): OnethingPromptsFile {
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { prompts?: unknown }).prompts)) {
      this.adapters.warn?.('[prompts.store] persisted file failed schema validation, falling back to empty list')
      return { prompts: [] }
    }

    const now = this.now()
    const prompts = (raw as { prompts: unknown[] }).prompts
      .map(prompt => cleanPrompt(prompt as Partial<UserPrompt>, now))
      .filter((prompt): prompt is UserPrompt => Boolean(prompt))

    if (prompts.length !== (raw as { prompts: unknown[] }).prompts.length) {
      this.adapters.warn?.('[prompts.store] persisted file contained invalid prompts, dropping invalid entries')
    }

    return { prompts }
  }
}
import crypto from 'node:crypto'
