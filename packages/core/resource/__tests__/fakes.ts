/**
 * K1 的假件:**一个 core 从没听说过的命名空间**,叫 `demo`。
 *
 * 它与 `stranger.test.ts` 的 `mail` 是两码事:那一份是「陌生能力演练」的题面(只
 * 登记、不执行),这一份是三只 K1 测试共用的**实现**,所以它有 provider、有可脚本
 * 化的 plan / apply,而且刻意把每一种反常都留了一个开关(报越界效果、`when` 关掉、
 * 家在壳里)。
 *
 * 端口全部复用 `../../toolkit/__tests__/fakes.ts` —— 那份文件的存在理由正是这个:
 * 「假 RunContext 能不能单测任何工具」。K1 是它的第一个外部使用者,复用而不是再写
 * 一份,是为了让「资源工具就是一只普通工具」这句话在测试里也成立。
 */

import { Intent } from '../../toolkit/intent.js'
import { textResult, type Result } from '../../toolkit/result.js'
import type { PlanContext, RunContext } from '../../toolkit/run-context.js'
import type { Scene } from '../../toolkit/spec.js'
import type { ResourceProvider, ResourceReadContext } from '../provider.js'
import type { ResourceEventHub } from '../events.js'
import type { ResourceRef } from '../ref.js'
import type { ResourceSpec } from '../spec.js'

/** 一个 core 从没听说过的命名空间。它只活在测试里。 */
export const DEMO_SCHEME = 'demo'

export function demoSpec(overrides: Partial<ResourceSpec> = {}): ResourceSpec {
  return {
    scheme: DEMO_SCHEME,
    title: 'Demo things',
    reads: {
      get: {
        title: 'Read one thing',
        query: { type: 'object', properties: {}, required: [] },
        result: { type: 'object' },
      },
      list: {
        title: 'List things',
        query: {
          type: 'object',
          properties: { limit: { type: 'number', description: 'How many' } },
          required: [],
        },
        result: { type: 'array' },
      },
    },
    ops: {
      rename: {
        title: 'Rename one thing',
        params: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        effects: [],
        home: 'core',
      },
      wipe: {
        title: 'Wipe one thing',
        params: { type: 'object', properties: {}, required: [] },
        effects: ['file_write'],
        home: 'core',
      },
      hidden: {
        title: 'Only in a scene that never happens',
        params: { type: 'object', properties: {}, required: [] },
        effects: [],
        home: 'core',
        when: () => false,
      },
      focus: {
        title: 'Focus it in the window',
        params: { type: 'object', properties: {}, required: [] },
        effects: [],
        home: 'shell',
      },
    },
    events: {
      renamed: { title: 'It was renamed', payload: { type: 'object' } },
    },
    ...overrides,
  }
}

export interface DemoProviderOptions {
  readonly spec?: ResourceSpec
  readonly read?: (name: string, ref: ResourceRef | null, query: unknown, ctx: ResourceReadContext) => Promise<unknown>
  readonly plan?: (op: string, ref: ResourceRef | null, params: unknown, ctx: PlanContext) => Promise<Intent<unknown>>
  readonly apply?: (op: string, intent: Intent<unknown>, ctx: RunContext) => Promise<Result>
  readonly visible?: boolean
}

export class DemoProvider implements ResourceProvider<unknown> {
  readonly spec: ResourceSpec
  readonly calls: string[] = []
  hub: ResourceEventHub | undefined

  private readonly options: DemoProviderOptions

  constructor(options: DemoProviderOptions = {}) {
    this.options = options
    this.spec = options.spec ?? demoSpec()
  }

  attach(hub: ResourceEventHub): void {
    this.hub = hub
  }

  async read(name: string, ref: ResourceRef | null, query: unknown, ctx: ResourceReadContext): Promise<unknown> {
    this.calls.push(`read:${name}`)
    if (this.options.read) return this.options.read(name, ref, query, ctx)
    return { name, ref: ref ? ref.path : null, query }
  }

  async plan(op: string, ref: ResourceRef | null, params: unknown, ctx: PlanContext): Promise<Intent<unknown>> {
    this.calls.push(`plan:${op}`)
    if (this.options.plan) return this.options.plan(op, ref, params, ctx)
    return Intent.of({ effects: [], payload: { op, params } })
  }

  async apply(op: string, intent: Intent<unknown>, ctx: RunContext): Promise<Result> {
    this.calls.push(`apply:${op}`)
    if (this.options.apply) return this.options.apply(op, intent, ctx)
    return textResult(`applied ${op}`)
  }

  visibleIn(_scene: Scene): boolean {
    return this.options.visible ?? true
  }
}
