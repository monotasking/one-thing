/**
 * §3 内核 —— `Intent`(计划)与 `Decision`(授权结论)。
 *
 * 决定 A 的落点:每个工具都先说"我将要做什么",再动手。Intent 是那句话 ——
 * 具体到资源的效果清单 + 给人看的预览 + 一坨对系统不透明的 payload(apply 需要的
 * 中间产物,比如已经算好的 diff)。它**不是结果**,里面不该有任何已经发生的事。
 *
 * 审批因此天然发生在两阶段之间,而不是像今天那样靠 `beforeSideEffect` /
 * `approvedAnalysis` 两个回调缝在 execute 里面。
 *
 * `Decision` 放在这里而不是 ports.ts:它是贴在 Intent 上的东西(`approved`),
 * 放这儿两个文件的依赖就是单向的。
 */

import type { JsonObject } from '../json.js'
import type { Effect } from './effects.js'
import { policyOf } from './effects.js'

/** 授权结论。`ask` 是 Authorizer 内部的过程,`decide()` 落地时只剩这两种。 */
export type Decision =
  | { readonly kind: 'allow'; readonly asked?: boolean; readonly grantId?: string; readonly reason?: string }
  | {
      readonly kind: 'deny'
      /** 已经成文的完整措辞(给模型看的那一句)。 */
      readonly reason: string
      readonly asked?: boolean
      /**
       * **人**按了拒绝,而不是策略/拦截器挡下的。
       *
       * 这两件事在旧 IPC 契约里是两个不同的结果形状(`rejected: true` +
       * `rejectionReason` vs 一条普通 error),渲染器据此画的也是两张不同的卡。
       * 没有这一位,投影器只能去嗅 `reason` 的字符串开头 —— 那正是
       * `core/tools/abort.ts` 头注释里禁掉的那种判据。
       */
      readonly byUser?: boolean
      /** 人自己写的那句理由(`reason` 是把它包进成文措辞之后的结果)。 */
      readonly rejectionReason?: string
    }

export const Decision = {
  allow(init: { asked?: boolean; grantId?: string; reason?: string } = {}): Decision {
    return { kind: 'allow', ...init }
  },
  deny(
    reason: string,
    init: { asked?: boolean; byUser?: boolean; rejectionReason?: string } = {},
  ): Decision {
    return { kind: 'deny', reason, ...init }
  },
}

/** 给人看的预览。形状对齐 `core/tools/tool-effect.ts` 的 `ToolPreview`。 */
export interface Preview {
  readonly title: string
  readonly diff?: string
  readonly path?: string
  readonly additions?: number
  readonly deletions?: number
  readonly metadata?: JsonObject
}

export interface IntentInit<Payload> {
  readonly effects?: readonly Effect[]
  readonly preview?: Preview
  readonly payload: Payload
  /**
   * 这次不许静默放行。给 §10.2-③ 的用户设置用:`toolSettings[id].autoExecute
   * === false` 时由 Authorizer 装饰器打上这一位,工具自己永远不写它。
   */
  readonly alwaysAsk?: boolean
}

export class Intent<Payload = unknown> {
  readonly effects: readonly Effect[]
  readonly preview?: Preview
  readonly payload: Payload
  readonly alwaysAsk: boolean
  /** 授权之后才有值。`apply` 拿到的 Intent 一定带着它。 */
  readonly decision?: Decision

  private constructor(init: IntentInit<Payload>, decision?: Decision) {
    this.effects = Object.freeze([...(init.effects ?? [])])
    this.preview = init.preview
    this.payload = init.payload
    this.alwaysAsk = init.alwaysAsk === true
    this.decision = decision
  }

  /** 无副作用工具的计划。仍然要走完 authorize —— 恒 ask 的用户设置也管得住它。 */
  static none<P>(payload: P): Intent<P> {
    return new Intent<P>({ payload })
  }

  static of<P>(init: IntentInit<P>): Intent<P> {
    return new Intent<P>(init)
  }

  /** 贴上授权结论,返回新对象 —— Intent 是值,不可变。 */
  approved(decision: Decision): Intent<Payload> {
    return new Intent<Payload>(this, decision)
  }

  forceAsk(): Intent<Payload> {
    if (this.alwaysAsk) return this
    return new Intent<Payload>(
      { effects: this.effects, preview: this.preview, payload: this.payload, alwaysAsk: true },
      this.decision,
    )
  }

  get isSideEffectFree(): boolean {
    return this.effects.length === 0
  }

  /** 需不需要惊动人。全 `silent` 且没被强制 = 不需要。 */
  get requiresAuthorization(): boolean {
    return this.alwaysAsk || this.effects.some(effect => policyOf(effect) !== 'silent')
  }
}
