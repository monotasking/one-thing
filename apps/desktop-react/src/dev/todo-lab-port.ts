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

export class TodoLabPort implements ResourcePort {
  private content = LAB_PLAN
  private revision = 1
  private readonly listeners = new Set<(fact: ResourceEventFact) => void>()
  private readonly ref = `todo:session/${LAB_PLAN_SESSION}`

  ready = async () => undefined

  read = async (ref: string) => {
    if (ref !== this.ref) return { kind: 'ok' as const, value: { exists: false, title: '', filePath: '', content: '', revision: '0', updatedAt: 0, total: 0, done: 0 } }
    return {
      kind: 'ok' as const,
      value: { exists: true, title: '修登录页', filePath: '/tmp/todo-lab/plan.md', content: this.content, revision: String(this.revision), updatedAt: Date.now(), total: 0, done: 0 },
    }
  }

  do = async (ref: string, op: string, params?: Record<string, unknown>) => {
    if (ref !== this.ref || op !== 'edit') return { kind: 'invalid' as const, message: `lab port: ${op}` }
    const base = params?.baseRevision
    const result = applyBatch(this.content.split('\n'), (params?.edits ?? []) as LineEdit[])
    if (!result.ok) return { kind: 'ok' as const, text: JSON.stringify({ conflict: true, revision: String(this.revision) }) }
    this.content = result.lines.join('\n')
    this.revision += 1
    void base
    this.emit('app')
    return { kind: 'ok' as const, text: JSON.stringify({ conflict: false, revision: String(this.revision) }) }
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
    for (const listener of this.listeners) listener({ ref: this.ref, event: 'changed', payload: { origin } })
  }
}
