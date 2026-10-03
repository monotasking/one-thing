/**
 * ACP 计划 → 待办域的投影(A2-b,方案 `docs/design/acp-integration-2026-09.md` §3.3 / §11.6)。
 *
 * agent 推的 `plan` / `plan_update` / `plan_removed` 已由 reducer 折进 `AcpSessionState.plan`
 * (`acp/session-state.ts`)。这里订会话状态,把那一格**写进待办域**的 `session-ai-todo`
 * 作用域 —— 与本地引擎的 AI 待办同一个 store、同一个接口(`updateDocument({ scope:
 * 'session-ai-todo', sessionId, content })`,即 `todo:` 资源的 `edit` / `createPlan` 写的那一口),
 * 于是待办面板、`todo:` 资源事件、文件监听器全都照旧,壳不新建计划面板。
 *
 * ── 形状 ────────────────────────────────────────────────────────────────
 *  - `items`:逐条一行任务。`completed` = `- [x]`,其余 `- [ ]`,进行中的那条尾巴标「进行中」,
 *    高优先级加粗;标题 `# 计划`(与 `todo:` 资源 `createPlan` 起的那一份同一个头)。
 *  - `markdown`:整段原样。
 *  - `file`:读那个文件的正文;读不到就写一行指向它的说明(不静默丢)。
 *
 * ── 身份 ────────────────────────────────────────────────────────────────
 *  - reducer 没变就原样返回同一只 `plan` 对象;别的格(用量、命令表)变了会换状态表,但 `plan`
 *    还是那一只 —— 于是按 `plan` 的对象身份判「计划没变」,一次都不写。渲染出来的正文与上一次
 *    写进去的逐字相同也不写。
 *  - `plan_removed` → 清空(删掉这条会话的 AI 待办文件,发一条变更)。**只清自己写过的**:
 *    agent 会话换了一条(新开 / 恢复失败改开)时那张新状态表生来没有计划,那不是「agent 说删」,
 *    不动文件。
 *  - 同一条会话的写串行(一条 promise 链),两次 `plan_update` 挨得很近也按到达顺序落盘。
 *
 * 在 `AcpSubsystem` 里构造时订、`dispose()` 时退(实例字段,无模块级状态)。
 */
import fs from 'node:fs/promises'
import type { AcpSessionState } from '@shared/contracts/acp'
import type { OnethingTodoPlanStore } from '@onething/backend/todo-plan'
import { getLogger } from '@onething/backend/logging/configure-logging'
import type { AcpSessionStateProjection } from './subsystem.js'

const log = getLogger('app.acp.plan')

type AcpPlan = NonNullable<AcpSessionState['plan']>

/** 投影够得着的待办 store 面(`OnethingTodoPlanStore` 的子集;测试递临时目录上的真 store)。 */
export type AcpPlanTodoStore = Pick<OnethingTodoPlanStore, 'updateDocument' | 'deleteSessionAiTodo' | 'notifyChanged'>

export interface AcpPlanProjectionPorts {
  /** 晚取:store 跟着装配走,构造点比它早。 */
  store(): AcpPlanTodoStore
  /** `file` 形读正文;缺席 = `fs.readFile(path, 'utf-8')`。 */
  readFile?(path: string): Promise<string>
}

export const ACP_PLAN_HEADING = '# 计划'

function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim()
}

/** `items` 形 → 待办 markdown。空表 = 空串(调用方当作「没有计划」)。 */
export function renderAcpPlanItems(entries: Extract<AcpPlan, { kind: 'items' }>['entries']): string {
  const lines = entries
    .map(entry => {
      const text = oneLine(entry.content)
      if (!text) return undefined
      const body = entry.priority === 'high' ? `**${text}**` : text
      const mark = entry.status === 'completed' ? 'x' : ' '
      const tail = entry.status === 'in_progress' ? ' _(进行中)_' : ''
      return `- [${mark}] ${body}${tail}`
    })
    .filter((line): line is string => Boolean(line))
  if (lines.length === 0) return ''
  return `${ACP_PLAN_HEADING}\n\n${lines.join('\n')}\n`
}

function withTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

interface Tracked {
  acpSessionId: string | undefined
  plan: AcpPlan | undefined
}

export class AcpPlanProjection implements AcpSessionStateProjection {
  readonly label = 'acpPlanProjection'
  private readonly tracked = new Map<string, Tracked>()
  /** 每条会话上一次写进去的正文;不在表里 = 这条会话的 AI 待办不是我们写的(或已清掉)。 */
  private readonly written = new Map<string, string>()
  private readonly chains = new Map<string, Promise<void>>()
  private disposed = false

  constructor(private readonly ports: AcpPlanProjectionPorts) {}

  observe(state: AcpSessionState): void {
    if (this.disposed) return
    const sessionId = state.localSessionId
    const previous = this.tracked.get(sessionId)
    const plan = state.plan
    if (previous && previous.acpSessionId === state.acpSessionId && previous.plan === plan) return

    const sameAgentSession = previous !== undefined && previous.acpSessionId === state.acpSessionId
    const entry: Tracked = { acpSessionId: state.acpSessionId, plan }
    this.tracked.set(sessionId, entry)

    if (!plan) {
      // 只有「同一条 agent 会话里,原来有计划、现在没了」才是 agent 说删;换了 agent 会话不算。
      if (sameAgentSession && previous?.plan) this.enqueue(sessionId, () => this.clear(sessionId))
      return
    }
    this.enqueue(sessionId, () => this.project(sessionId, plan, entry))
  }

  /** 等所有在途的写落地(测试与收尾用)。 */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()])
  }

  dispose(): void {
    this.disposed = true
  }

  private enqueue(sessionId: string, work: () => Promise<void>): void {
    const previous = this.chains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(work).catch(error => log.warn('acp plan projection failed', { sessionId }, error))
    this.chains.set(sessionId, next)
    void next.then(() => { if (this.chains.get(sessionId) === next) this.chains.delete(sessionId) })
  }

  private async render(plan: AcpPlan): Promise<string> {
    if (plan.kind === 'items') return renderAcpPlanItems(plan.entries)
    if (plan.kind === 'markdown') return plan.markdown.trim() ? withTrailingNewline(plan.markdown) : ''
    try {
      const text = await (this.ports.readFile ?? (path => fs.readFile(path, 'utf-8')))(plan.path)
      if (text.trim()) return withTrailingNewline(text)
    } catch (error) {
      log.warn('acp plan file unreadable', { path: plan.path }, error)
    }
    return `${ACP_PLAN_HEADING}\n\n计划文件:\`${plan.path}\`(读不到正文)\n`
  }

  private async project(sessionId: string, plan: AcpPlan, entry: Tracked): Promise<void> {
    const content = await this.render(plan)
    // 渲染途中又来了一版:这一版作废,交给后面那一趟。
    if (this.tracked.get(sessionId) !== entry) return
    if (!content) {
      await this.clear(sessionId)
      return
    }
    if (content === this.written.get(sessionId)) return
    await this.ports.store().updateDocument({ scope: 'session-ai-todo', sessionId, content })
    this.written.set(sessionId, content)
  }

  private async clear(sessionId: string): Promise<void> {
    if (!this.written.has(sessionId)) return
    const store = this.ports.store()
    await store.deleteSessionAiTodo(sessionId)
    store.notifyChanged({ scope: 'session-ai-todo', sessionId })
    this.written.delete(sessionId)
  }
}
