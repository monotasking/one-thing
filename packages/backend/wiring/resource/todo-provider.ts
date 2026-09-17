/**
 * 待办这一 scheme 的实现(自述在 `@onething/runtime/todo-plan/resource-spec`)。
 *
 * 与 `dir` / `music` 同形:自述在产品层,实现在装配层 —— 它要够得着这台后端的
 * `TodoPlanRuntime`(同一个 store 的自写缓存与同一个文件监听器)。
 *
 * ── 读 ──────────────────────────────────────────────────────────────────
 * 原文照交,不解析 markdown(渲染与编辑在壳里用消息那一份解析器做)。只算三样给读数用的:
 * 标题、任务总数、已完成数 —— 一条极小的行扫描,不参与渲染。
 *
 * ── 写:行编辑对账 ──────────────────────────────────────────────────────
 * `edit` 收一批 `LineEdit`。同一个文件上的读—对账—写串行(按路径一把异步锁),防的是
 * 这台后端自己两次提交交错;与 AI 写文件工具之间没有锁可加,靠的是对账:行号挪了按原文
 * 找回,找不回就整批不写,返回 `{ conflict: true }`,壳重读后原地替换。
 *
 * ── 效果按主体分档 ───────────────────────────────────────────────────────
 * 与 `session` provider 同一条判例:界面上那个人自己点的是零效果(照样落审计),
 * 其余主体按自述里的上界问。
 *
 * ── 事件 ────────────────────────────────────────────────────────────────
 * 订阅 `TodoPlanRuntime.onChanged`(不经过宿主端口,三个宿主行为一致):
 * 自己写的发 `origin: 'app'`,文件监听器看到的发 `origin: 'external'`。
 * 用户清单被外部改动时监听器分不出是哪一份,事件发在 `todo:notes` 上。
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { applyBatch, joinLines, splitLines, type LineEdit } from '@onething/core/text'
import { planFromSpec } from '@onething/core/resource'
import type { ResourceEventHub, ResourceProvider, ResourceReadContext, ResourceRef } from '@onething/core/resource'
import { Intent, textResult, type PlanContext, type Result, type RunContext } from '@onething/core/toolkit'
import type { OnethingTodoPlanStore, TodoPlanChangedPayload } from '@onething/runtime/todo-plan'
import { todoResourceSpec, TODO_RESOURCE_SCHEME } from '@onething/runtime/todo-plan/resource-spec'
import { getTodoPlanStore, onTodoPlanChanged, type TodoPlanChangeListener, type TodoPlanChangeOrigin } from '../todo-plan/store.js'

/**
 * provider 够到待办的两个口。缺省接当前装配的 `TodoPlanRuntime`;测试递一个临时目录上的真 store。
 * 读的是函数而不是 store 本身:待办目录是设置项,store 实例跟着装配走,晚一点取才对。
 */
export interface TodoProviderPorts {
  store(): OnethingTodoPlanStore
  onChanged(listener: TodoPlanChangeListener): () => void
}

const ASSEMBLED_PORTS: TodoProviderPorts = { store: getTodoPlanStore, onChanged: onTodoPlanChanged }

/** 地址指到的是哪一份文档。 */
export type TodoTarget =
  | { readonly kind: 'notes' }
  | { readonly kind: 'note'; readonly id: string }
  | { readonly kind: 'session'; readonly sessionId: string }

export type TodoOpPayload =
  | { readonly op: 'edit'; readonly target: TodoTarget; readonly edits: readonly LineEdit[] }
  | { readonly op: 'create'; readonly title: string }
  | { readonly op: 'rename'; readonly id: string; readonly title: string }
  | { readonly op: 'delete'; readonly id: string }
  | { readonly op: 'createPlan'; readonly sessionId: string; readonly text: string }

export class TodoRefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TodoRefError'
  }
}

export function parseTodoTarget(ref: ResourceRef | null): TodoTarget {
  const path = ref?.path ?? ''
  if (path === 'notes') return { kind: 'notes' }
  if (path.startsWith('note/') && path.length > 5) return { kind: 'note', id: path.slice(5) }
  if (path.startsWith('session/') && path.length > 8) return { kind: 'session', sessionId: path.slice(8) }
  throw new TodoRefError(`A todo address is "todo:notes", "todo:note/<id>" or "todo:session/<sessionId>" (got ${JSON.stringify(ref ? `${ref.scheme}:${ref.path}` : null)})`)
}

const TASK_LINE = /^\s*[-*+]\s+\[( |x|X)\]/

export function summarizeTodoMarkdown(content: string, fallbackTitle: string): { title: string; total: number; done: number } {
  let total = 0
  let done = 0
  let title = ''
  for (const line of splitLines(content)) {
    const task = line.match(TASK_LINE)
    if (task) {
      total += 1
      if (task[1] !== ' ') done += 1
    } else if (!title && /^#\s+\S/.test(line)) {
      title = line.replace(/^#\s+/, '').trim()
    }
  }
  return { title: title || fallbackTitle, total, done }
}

export function revisionOf(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 16)
}

function recordParam(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
}

function stringParam(params: unknown, key: string, op: string): string {
  const value = recordParam(params)[key]
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${op} needs a non-empty ${key}`)
  return value
}

function lineEditsParam(params: unknown): LineEdit[] {
  const raw = recordParam(params).edits
  if (!Array.isArray(raw) || raw.length === 0) throw new TypeError('edit needs a non-empty edits array')
  return raw.map((item, index) => {
    const edit = recordParam(item)
    const strings = (value: unknown, key: string): string[] => {
      if (!Array.isArray(value) || value.some(line => typeof line !== 'string')) {
        throw new TypeError(`edits[${index}].${key} must be an array of strings`)
      }
      return value as string[]
    }
    if (typeof edit.start !== 'number' || !Number.isInteger(edit.start) || edit.start < 0) {
      throw new TypeError(`edits[${index}].start must be a non-negative integer`)
    }
    if (edit.anchor !== undefined && typeof edit.anchor !== 'string') throw new TypeError(`edits[${index}].anchor must be a string`)
    return {
      start: edit.start,
      expect: strings(edit.expect, 'expect'),
      lines: strings(edit.lines, 'lines'),
      ...(typeof edit.anchor === 'string' ? { anchor: edit.anchor } : {}),
    }
  })
}

function formatTarget(target: TodoTarget): string {
  if (target.kind === 'notes') return 'notes'
  return target.kind === 'note' ? `note/${target.id}` : `session/${target.sessionId}`
}

export class TodoResourceProvider implements ResourceProvider<TodoOpPayload> {
  readonly spec = todoResourceSpec

  private hub: ResourceEventHub | undefined
  private unsubscribe: (() => void) | undefined
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly ports: TodoProviderPorts = ASSEMBLED_PORTS) {}

  attach(hub: ResourceEventHub): void {
    this.hub = hub
    this.unsubscribe?.()
    this.unsubscribe = this.ports.onChanged((payload, origin) => this.forward(payload, origin))
  }

  /** 退订文件变更(登记方在注销时调;`ResourceProvider` 没有 detach 钩子)。 */
  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.hub = undefined
  }

  async read(name: string, ref: ResourceRef | null, _query: unknown, _ctx: ResourceReadContext): Promise<unknown> {
    const target = parseTodoTarget(ref)
    switch (name) {
      case 'list':
        if (target.kind !== 'notes') throw new TodoRefError('list reads the address "todo:notes"')
        return this.list()
      case 'document':
        if (target.kind === 'notes') throw new TodoRefError('document reads "todo:note/<id>" or "todo:session/<sessionId>"')
        return this.document(target)
      default:
        throw new TypeError(`Todo resource has no read named ${JSON.stringify(name)}`)
    }
  }

  async plan(op: string, ref: ResourceRef | null, params: unknown, ctx: PlanContext): Promise<Intent<TodoOpPayload>> {
    const target = parseTodoTarget(ref)
    const byPrincipal = (payload: TodoOpPayload, title: string): Intent<TodoOpPayload> =>
      ctx.principal.kind === 'user'
        ? Intent.of({ effects: [], payload, preview: { title } })
        : planFromSpec<TodoOpPayload>(this.spec, op, ref, payload, { title })
    switch (op) {
      case 'edit': {
        if (target.kind === 'notes') throw new TodoRefError('edit acts on "todo:note/<id>" or "todo:session/<sessionId>"')
        return byPrincipal({ op, target, edits: lineEditsParam(params) }, `Edit ${formatTarget(target)}`)
      }
      case 'create': {
        if (target.kind !== 'notes') throw new TodoRefError('create acts on "todo:notes"')
        const title = stringParam(params, 'title', op)
        return byPrincipal({ op, title }, `Create the todo list ${title}`)
      }
      case 'rename': {
        if (target.kind !== 'note') throw new TodoRefError('rename acts on "todo:note/<id>"')
        const title = stringParam(params, 'title', op)
        return byPrincipal({ op, id: target.id, title }, `Rename the todo list to ${title}`)
      }
      case 'delete': {
        if (target.kind !== 'note') throw new TodoRefError('delete acts on "todo:note/<id>"')
        return byPrincipal({ op, id: target.id }, `Delete the todo list ${target.id}`)
      }
      case 'createPlan': {
        if (target.kind !== 'session') throw new TodoRefError('createPlan acts on "todo:session/<sessionId>"')
        const text = stringParam(params, 'text', op)
        return byPrincipal({ op, sessionId: target.sessionId, text }, 'Start the session plan')
      }
      default:
        throw new TypeError(`Todo resource has no op named ${JSON.stringify(op)}`)
    }
  }

  async apply(_op: string, intent: Intent<TodoOpPayload>, _ctx: RunContext): Promise<Result> {
    const payload = intent.payload
    switch (payload.op) {
      case 'edit': {
        const target = payload.target as Exclude<TodoTarget, { kind: 'notes' }>
        return this.withLock(this.filePathOf(target), async () => {
          const current = await this.document(target)
          if (!current.exists) return textResult(JSON.stringify({ conflict: true, reason: 'missing' }))
          const batch = applyBatch(splitLines(current.content), payload.edits)
          if (!batch.ok) return textResult(JSON.stringify({ conflict: true, revision: current.revision }))
          const content = joinLines(batch.lines)
          await this.ports.store().updateDocument(
            target.kind === 'note'
              ? { scope: 'user-note', id: target.id, content }
              : { scope: 'session-ai-todo', sessionId: target.sessionId, content },
          )
          return textResult(JSON.stringify({ conflict: false, revision: revisionOf(content) }))
        })
      }
      case 'create': {
        const document = await this.ports.store().createUserNote(payload.title, `# ${payload.title.trim()}\n\n- [ ] `)
        this.emit(`note/${document.id}`, 'created', {})
        return textResult(JSON.stringify({ ref: `${TODO_RESOURCE_SCHEME}:note/${document.id}`, id: document.id }))
      }
      case 'rename': {
        const document = await this.ports.store().renameUserNote(payload.id, payload.title)
        if (document.id !== payload.id) {
          this.emit(`note/${payload.id}`, 'deleted', {})
          this.emit(`note/${document.id}`, 'created', {})
        }
        return textResult(JSON.stringify({ ref: `${TODO_RESOURCE_SCHEME}:note/${document.id}`, id: document.id }))
      }
      case 'delete': {
        await this.ports.store().deleteUserNote(payload.id)
        this.emit(`note/${payload.id}`, 'deleted', {})
        return textResult(JSON.stringify({ deleted: true }))
      }
      case 'createPlan': {
        const target: TodoTarget = { kind: 'session', sessionId: payload.sessionId }
        return this.withLock(this.filePathOf(target), async () => {
          const current = await this.document(target)
          const line = `- [ ] ${payload.text.replace(/\n/g, ' ')}`
          const content = current.exists && current.content.trim()
            ? `${current.content.replace(/\n+$/, '')}\n${line}\n`
            : `# 计划\n\n${line}\n`
          await this.ports.store().updateDocument({ scope: 'session-ai-todo', sessionId: payload.sessionId, content })
          if (!current.exists) this.emit(`session/${payload.sessionId}`, 'created', {})
          return textResult(JSON.stringify({ conflict: false, revision: revisionOf(content) }))
        })
      }
    }
  }

  private filePathOf(target: Exclude<TodoTarget, { kind: 'notes' }>): string {
    const store = this.ports.store()
    return target.kind === 'note' ? store.userNoteFilePath(target.id) : store.sessionAiTodoPath(target.sessionId)
  }

  private async document(target: Exclude<TodoTarget, { kind: 'notes' }>) {
    const filePath = this.filePathOf(target)
    const fallback = target.kind === 'note' ? target.id.replace(/-/g, ' ') : 'AI Todo'
    const [content, stats] = await Promise.all([
      fs.readFile(filePath, 'utf-8').catch(() => null),
      fs.stat(filePath).catch(() => null),
    ])
    const text = content ?? ''
    const summary = summarizeTodoMarkdown(text, fallback)
    return {
      exists: content !== null,
      title: summary.title,
      filePath,
      content: text,
      revision: revisionOf(text),
      updatedAt: stats?.mtimeMs ?? 0,
      total: summary.total,
      done: summary.done,
    }
  }

  private async list() {
    const snapshot = await this.ports.store().readSnapshot({})
    return {
      notes: snapshot.userNotes.map(note => {
        const summary = summarizeTodoMarkdown(note.content, note.id.replace(/-/g, ' '))
        return {
          ref: `${TODO_RESOURCE_SCHEME}:note/${note.id}`,
          id: note.id,
          title: summary.title,
          updatedAt: note.updatedAt,
          total: summary.total,
          done: summary.done,
        }
      }),
    }
  }

  private withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const next = previous.then(work, work)
    const settled = next.catch(() => undefined)
    this.locks.set(key, settled)
    void settled.then(() => { if (this.locks.get(key) === settled) this.locks.delete(key) })
    return next
  }

  private forward(payload: TodoPlanChangedPayload, origin: TodoPlanChangeOrigin): void {
    if (payload.scope === 'session-ai-todo' && payload.sessionId) {
      this.emit(`session/${payload.sessionId}`, 'changed', { origin })
      return
    }
    if (payload.scope === 'global-user' || payload.scope === 'user-note') {
      if (payload.document) this.emit(`note/${payload.document.id}`, 'changed', { origin })
      this.emit('notes', 'changed', { origin })
      return
    }
    if (payload.scope === 'all') this.emit('notes', 'changed', { origin })
  }

  private emit(path: string, event: string, payload: Record<string, unknown>): void {
    this.hub?.emit({ scheme: TODO_RESOURCE_SCHEME, path }, event, payload)
  }
}
