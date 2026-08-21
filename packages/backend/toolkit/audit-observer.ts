/**
 * R2a —— `AuditProjector`(设计文档 §5)。生命周期事件 → 一条可落盘的审计记录。
 *
 * 审计要能回答的是**"打算做什么 vs 实际做了什么"**,而这三条证词
 * (`planned` / `decided` / `finished`)是 Runner 独发的 —— 工具伪造不了它们
 * (`RunContext.emit` 在类型上与运行时都挡掉 lifecycle)。一份工具自己写的证词不叫
 * 审计,所以这个投影器**只读 lifecycle**,一条工具事件都不看。
 *
 * 落到哪儿由宿主决定:R2b 会把 sink 接到 events.jsonl(`app/session/events` 那条
 * 七事件流)与评估轨迹。这里只定形状与时机,不认识 fs。
 */

import type {
  Decision,
  EffectClass,
  Intent,
  Invocation,
  ObservedEvent,
  Observer,
  Outcome,
} from '@onething/core/toolkit'

/** 一次调用在审计里的样子。刻意扁平:它要能直接变成一行 JSONL。 */
export interface ToolAuditRecord {
  readonly callId: string
  readonly toolId: string
  readonly sessionId: string
  readonly messageId?: string
  /** 计划里报的效果类(去重)。资源级细节不进审计索引 —— 它们在 preview 里。 */
  readonly effects: readonly EffectClass[]
  /** 效果条数(与 `effects` 不同:同一类可以有多条,资源不同)。 */
  readonly effectCount: number
  readonly previewTitle?: string
  readonly decision?: Decision['kind']
  /** 人被问过没有。`decided` 里带的那一位。 */
  readonly asked?: boolean
  readonly outcome: Outcome['kind']
  /** 拦截器动过手的话,是谁。 */
  readonly intercepted?: { readonly action: 'rewrite' | 'block'; readonly by?: readonly string[] }
  readonly at: number
}

export type ToolAuditSink = (record: ToolAuditRecord) => void

interface PendingAudit {
  intent?: Intent
  decision?: Decision
  intercepted?: { action: 'rewrite' | 'block'; by?: readonly string[] }
}

export interface AuditProjectorOptions {
  readonly now?: () => number
}

export class AuditProjector implements Observer {
  private readonly sink: ToolAuditSink
  private readonly now: () => number
  /**
   * 按 callId 攒。用 Map 而不是单个字段:一个 Observer 实例会被同一回合里**并行**
   * 跑着的多个工具共用(`ToolExecutionScheduler` 允许 parallel 档同时在飞),
   * 一个字段会让两次调用的证词互相覆盖。
   */
  private readonly pending = new Map<string, PendingAudit>()

  constructor(sink: ToolAuditSink, options: AuditProjectorOptions = {}) {
    this.sink = sink
    this.now = options.now ?? (() => Date.now())
  }

  on(invocation: Invocation, event: ObservedEvent): void {
    if (event.type !== 'lifecycle') return

    const key = invocation.callId
    switch (event.phase) {
      case 'intercepted':
        this.entry(key).intercepted = { action: event.action, by: event.by }
        return
      case 'planned':
        this.entry(key).intent = event.intent
        return
      case 'decided':
        this.entry(key).decision = event.decision
        return
      case 'finished': {
        const entry = this.pending.get(key)
        this.pending.delete(key)
        this.emit(invocation, entry, event.outcome)
        return
      }
    }
  }

  private entry(callId: string): PendingAudit {
    const existing = this.pending.get(callId)
    if (existing) return existing
    const created: PendingAudit = {}
    this.pending.set(callId, created)
    return created
  }

  private emit(invocation: Invocation, entry: PendingAudit | undefined, outcome: Outcome): void {
    const effects = entry?.intent?.effects ?? []
    const record: ToolAuditRecord = {
      callId: invocation.callId,
      toolId: invocation.toolId,
      sessionId: invocation.sessionId,
      messageId: invocation.messageId,
      effects: [...new Set(effects.map(effect => effect.kind))],
      effectCount: effects.length,
      previewTitle: entry?.intent?.preview?.title,
      decision: entry?.decision?.kind,
      asked: entry?.decision?.asked,
      outcome: outcome.kind,
      ...(entry?.intercepted ? { intercepted: entry.intercepted } : {}),
      at: this.now(),
    }
    try {
      this.sink(record)
    } catch {
      // 审计写失败不该把一次成功的调用变成失败 —— 它是旁观者(Runner 那边也这么挡)。
    }
  }
}

/** 组合多个观察者成一个。Runner 只收一个 `Observer` 端口。 */
export function combineObservers(...observers: readonly Observer[]): Observer {
  return {
    on(invocation, event) {
      for (const observer of observers) {
        try {
          observer.on(invocation, event)
        } catch {
          // 一个坏掉的投影器不该拖垮另一个。
        }
      }
    },
  }
}
