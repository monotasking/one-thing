/**
 * 内核单测用的内存端口与脚本化工具(尺子⑤:不起引擎、不起 store、不起 Electron)。
 *
 * 这个文件本身不是测试 —— 它是"假 RunContext 能不能单测任何工具"这句话的实物
 * 证明:整套端口加起来不到 100 行,R1 的家族基类测试直接复用。
 */

import { Decision, Intent } from '../intent.js'
import type { EffectClass } from '../effects.js'
import type { ObservedEvent, ToolLifecycleEvent } from '../events.js'
import type { Job, JobEvent, JobOwner, JobRegistry, JobSpec, JobStatus } from '../job.js'
import type { Outcome } from '../outcome.js'
import type { Authorizer, Interceptor, Observer, ValidationResult, Validator } from '../ports.js'
import type { Result } from '../result.js'
import { textResult } from '../result.js'
import type { Invocation, PlanContext, RunContext } from '../run-context.js'
import type { JsonSchema, PrepareEnv, Scene, ToolBudgetHint, ToolSpec } from '../spec.js'
import { Tool } from '../tool.js'

export function makeInvocation(overrides: Partial<Invocation> = {}): Invocation {
  return {
    callId: 'call-1',
    toolId: 'fake',
    input: {},
    sessionId: 'session-1',
    messageId: 'message-1',
    principal: { kind: 'user', userId: 'local' },
    ...overrides,
  }
}

export interface ScriptedToolOptions {
  id?: string
  effects?: readonly EffectClass[]
  budget?: ToolBudgetHint
  visible?: boolean
  prepare?: (env: PrepareEnv) => Promise<void> | void
  plan?: (input: unknown, ctx: PlanContext) => Promise<Intent<unknown>>
  apply?: (intent: Intent<unknown>, ctx: RunContext) => Promise<Result>
}

export class ScriptedTool extends Tool {
  readonly spec: ToolSpec
  private readonly options: ScriptedToolOptions

  constructor(options: ScriptedToolOptions = {}) {
    super()
    this.options = options
    this.spec = {
      id: options.id ?? 'fake',
      title: 'Fake tool',
      description: 'A tool that does whatever the test told it to.',
      input: { type: 'object' },
      effects: options.effects ?? [],
      presentation: { kind: 'text', shell: 'default' },
      concurrency: 'parallel',
      budget: options.budget,
    }
  }

  async prepare(env: PrepareEnv): Promise<void> {
    await this.options.prepare?.(env)
  }

  visibleIn(_scene: Scene): boolean {
    return this.options.visible ?? true
  }

  async plan(input: unknown, ctx: PlanContext): Promise<Intent<unknown>> {
    if (this.options.plan) return await this.options.plan(input, ctx)
    return Intent.none({ input })
  }

  async apply(intent: Intent<unknown>, ctx: RunContext): Promise<Result> {
    if (this.options.apply) return await this.options.apply(intent, ctx)
    return textResult('ok')
  }
}

export const passthroughValidator: Validator = {
  parse<T>(_schema: JsonSchema, input: unknown): ValidationResult<T> {
    return { ok: true, value: input as T }
  },
}

/** 只接受带某个键的对象 —— 用来验证"拦截器改出来的非法参数照样被挡"。 */
export function validatorRequiring(key: string): Validator {
  return {
    parse<T>(_schema: JsonSchema, input: unknown): ValidationResult<T> {
      if (input && typeof input === 'object' && key in input) return { ok: true, value: input as T }
      return { ok: false, message: `${key} is required` }
    },
  }
}

export function rejectingValidator(message: string): Validator {
  return {
    parse<T>(): ValidationResult<T> {
      return { ok: false, message }
    },
  }
}

export const allowAuthorizer: Authorizer = {
  async decide() {
    return Decision.allow()
  },
}

export function denyingAuthorizer(reason: string): Authorizer {
  return {
    async decide() {
      return Decision.deny(reason)
    },
  }
}

/** 只在 Intent 被强制 ask 时拒绝 —— 用来验证 withUserToolSettings 装饰器真的生效。 */
export const askAwareAuthorizer: Authorizer = {
  async decide(intent) {
    return intent.alwaysAsk ? Decision.deny('User requires manual approval', { asked: true }) : Decision.allow()
  },
}

export class RecordingObserver implements Observer {
  readonly events: Array<{ invocation: Invocation; event: ObservedEvent }> = []

  on(invocation: Invocation, event: ObservedEvent): void {
    this.events.push({ invocation, event })
  }

  types(): string[] {
    return this.events.map(entry => entry.event.type)
  }

  /** 只看工具自己发的那些。 */
  toolEventTypes(): string[] {
    return this.events.map(entry => entry.event.type).filter(type => type !== 'lifecycle')
  }

  lifecyclePhases(): string[] {
    return this.events
      .map(entry => entry.event)
      .filter((event): event is ToolLifecycleEvent => event.type === 'lifecycle')
      .map(event => event.phase)
  }
}

export function blockingInterceptor(reason: string): Interceptor {
  return {
    beforePlan: () => ({ block: true, reason }),
    afterApply: (outcome: Outcome) => outcome,
  }
}

export class MemoryJob implements Job {
  status: JobStatus = 'running'
  private readonly queue: JobEvent[] = []

  constructor(readonly id: string, readonly owner: JobOwner, readonly label?: string) {}

  push(event: JobEvent): void {
    this.queue.push(event)
  }

  async *events(): AsyncIterable<JobEvent> {
    for (const event of this.queue) yield event
  }

  async kill(): Promise<void> {
    this.status = 'killed'
  }
}

export class InMemoryJobRegistry implements JobRegistry {
  readonly jobs: MemoryJob[] = []

  spawn(spec: JobSpec): Job {
    const job = new MemoryJob(`job-${this.jobs.length + 1}`, spec.owner, spec.label)
    this.jobs.push(job)
    return job
  }

  get(id: string): Job | undefined {
    return this.jobs.find(job => job.id === id)
  }

  list(owner?: Partial<JobOwner>): readonly Job[] {
    return this.jobs.filter(job => {
      if (owner?.sessionId && job.owner.sessionId !== owner.sessionId) return false
      if (owner?.toolCallId && job.owner.toolCallId !== owner.toolCallId) return false
      return true
    })
  }
}
