import { applyBatch, type LineEdit } from '@onething/core/text'
import type { ResourceEventFact, ResourcePort } from '../data/resource-port'

/**
 * `?todo-lab` 用的内存 `todo:` 端口:一份会话计划,读 `document`、做 `edit`,并能模拟
 * 「AI 在文件里勾掉一项」(外部改动,发 `changed{origin:'external'}`)。不碰任何真 store。
 */
export const LAB_PLAN_SESSION = 'lab'

export const LAB_PLAN = `# 修登录页
- [x] 读 \`auth.ts\` 找到回调
- [x] 复现 **401**
- [ ] 改成先刷新 token 再重试
- [ ] 补一条单测
- [ ] 跑 \`gate:connect\``

const LAB_NOTES: Record<string, { title: string; content: string }> = {
  inbox: { title: '收件箱', content: '# 收件箱\n- [ ] 回邮件\n- [x] 订周五的会议室\n- [ ] 看一眼 **CI** 为什么红' },
  reading: { title: '要读的', content: '# 要读的\n- [ ] [Typora 的实时预览](https://typora.io)\n- [ ] ProseMirror 的 `Decoration`' },
}

export class TodoLabPort implements ResourcePort {
  private content = LAB_PLAN
  private revision = 1
  private readonly notes = new Map(Object.entries(LAB_NOTES).map(([id, note]) => [id, { ...note }]))
  private nextNote = 1
  private readonly listeners = new Set<(fact: ResourceEventFact) => void>()
  private readonly ref = `todo:session/${LAB_PLAN_SESSION}`

  ready = async () => undefined

  read = async (ref: string) => {
    if (ref === 'todo:notes') {
      const notes = [...this.notes].map(([id, note]) => ({ ref: `todo:note/${id}`, id, title: note.title, updatedAt: 0, total: 0, done: 0 }))
      return { kind: 'ok' as const, value: { notes } }
    }
    const noteId = ref.startsWith('todo:note/') ? ref.slice('todo:note/'.length) : null
    const note = noteId ? this.notes.get(noteId) : undefined
    if (note) {
      return { kind: 'ok' as const, value: { exists: true, title: note.title, filePath: `/tmp/todo-lab/${noteId}.md`, content: note.content, revision: String(this.revision), updatedAt: 0, total: 0, done: 0 } }
    }
    if (ref !== this.ref) return { kind: 'ok' as const, value: { exists: false, title: '', filePath: '', content: '', revision: '0', updatedAt: 0, total: 0, done: 0 } }
    return {
      kind: 'ok' as const,
      value: { exists: true, title: '修登录页', filePath: '/tmp/todo-lab/plan.md', content: this.content, revision: String(this.revision), updatedAt: Date.now(), total: 0, done: 0 },
    }
  }

  do = async (ref: string, op: string, params?: Record<string, unknown>) => {
    const ok = (value: Record<string, unknown>) => ({ kind: 'ok' as const, text: JSON.stringify(value) })
    if (ref === 'todo:notes' && op === 'create') {
      const id = `lab-${this.nextNote++}`
      const title = String(params?.title ?? 'untitled')
      this.notes.set(id, { title, content: `# ${title}\n` })
      this.emitRef('todo:notes', 'created')
      return ok({ id })
    }
    const noteId = ref.startsWith('todo:note/') ? ref.slice('todo:note/'.length) : null
    const note = noteId ? this.notes.get(noteId) : undefined
    if (noteId && note && op === 'rename') {
      note.title = String(params?.title ?? note.title)
      this.emitRef(ref, 'changed')
      return ok({ id: noteId })
    }
    if (noteId && note && op === 'delete') {
      this.notes.delete(noteId)
      this.emitRef(ref, 'deleted')
      return ok({})
    }
    if (op !== 'edit') return { kind: 'invalid' as const, message: `lab port: ${op}` }
    const current = note ? note.content : ref === this.ref ? this.content : null
    if (current === null) return { kind: 'invalid' as const, message: `lab port: ${ref}` }
    const result = applyBatch(current.split('\n'), (params?.edits ?? []) as LineEdit[])
    if (!result.ok) return ok({ conflict: true, revision: String(this.revision) })
    if (note) note.content = result.lines.join('\n')
    else this.content = result.lines.join('\n')
    this.revision += 1
    this.emitRef(ref, 'changed', 'app')
    return ok({ conflict: false, revision: String(this.revision) })
  }

  onResourceEvent = (_prefix: string, callback: (fact: ResourceEventFact) => void) => {
    this.listeners.add(callback)
    return () => { this.listeners.delete(callback) }
  }

  /** 模拟 AI 勾掉第一条未完成的任务。 */
  checkNext(): void {
    const lines = this.content.split('\n')
    const index = lines.findIndex(line => /^\s*[-*+]\s+\[ \]/.test(line))
    if (index < 0) return
    lines[index] = lines[index].replace('[ ]', '[x]')
    this.content = lines.join('\n')
    this.revision += 1
    this.emit('external')
  }

  reset(): void {
    this.content = LAB_PLAN
    this.revision += 1
    this.emit('external')
  }

  private emit(origin: 'app' | 'external'): void {
    this.emitRef(this.ref, 'changed', origin)
  }

  private emitRef(ref: string, event: string, origin: 'app' | 'external' = 'app'): void {
    for (const listener of this.listeners) listener({ ref, event, payload: { origin } })
  }
}
