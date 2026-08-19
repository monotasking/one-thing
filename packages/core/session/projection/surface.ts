/**
 * `SurfaceIndex` —— 模型可见历史的**有序 eventSeq 数组**(§9.4,dsh surface 判例)。
 *
 * 它回答的只有一个问题:*到这一刻为止,模型可见历史上依次是哪些事件?*
 * 一个机制同时表达 compact / edit-resend / regenerate / delete / 工具结果剪枝 ——
 * 全部是"追加一条带 `surfaceOp: replace` 的新事件",被遮蔽的事件仍在日志里。
 *
 * 两个入口,结果必须相同(合同测试钉住):
 *  - `foldSurface(events)`:整份日志一次性折;
 *  - `push(event)`:活跃会话每来一条事件增量维护。
 *
 * **replace 的校验**是这个类存在的第二个理由:`{start,end}` 必须真的落在当前
 * surface 上,`sourceEventSeqs` 必须覆盖被遮蔽的那一段。dsh 原文点名这一条 ——
 * 回放时能校验"替换范围列全了没有",否则 compact 少写一个 seq 就变成静默的
 * 历史错乱(§7.1 B5 说的正是这种错乱)。
 */

import type { SessionLogEventRecord } from '../events/types.js'
import { isSessionSurfaceNodeType } from '../events/types.js'

export interface SurfaceViolation {
  eventSeq: number
  type: string
  reason:
    | 'replace-start-missing'
    | 'replace-end-missing'
    | 'replace-range-inverted'
    | 'source-seqs-incomplete'
}

export interface SurfaceSnapshot {
  /** 模型可见历史上的 eventSeq,升序即呈现序。 */
  order: number[]
  /** 被 replace 遮蔽掉的 eventSeq(仍在日志里,只是不在 surface 上)。 */
  shadowed: number[]
  violations: SurfaceViolation[]
}

export class SurfaceIndex {
  private order: number[] = []
  private readonly shadowed = new Set<number>()
  private readonly violations: SurfaceViolation[] = []

  push(event: SessionLogEventRecord): void {
    const op = event.surfaceOp
    const isNode = isSessionSurfaceNodeType(event.type)

    if (op === undefined) {
      // surface 事件没带 op 的兜底:节点类型按 append 处理(老写者/迁移脚本
      // 漏字段时,消息不至于凭空消失)。非节点类型什么都不做。
      if (isNode) this.order.push(event.seq)
      return
    }

    if (op === 'append') {
      if (isNode) this.order.push(event.seq)
      return
    }

    const at = this.applyReplace(event, op.start, op.end)
    if (isNode) {
      this.order.splice(at, 0, event.seq)
    }
  }

  /**
   * @returns 替换发生的插入位置(供节点类型插进去)。
   *
   * **按位置匹配,不按 seq 大小**:`order` 是**呈现序**,不是升序 —— compact
   * 之后那个节点的 seq 比它后面的邻居都大(它是后写的),`findIndex(seq >= start)`
   * 会一头撞在它身上。这条曾经让"压缩后再编辑"静默地什么都没遮蔽:
   * 校验报了 range-missing,而模型历史里旧的一问一答原封不动地留着。
   */
  private applyReplace(event: SessionLogEventRecord, start: number, end: number): number {
    const from = this.order.indexOf(start)
    if (from === -1) {
      // 整段都在 surface 之外:要么已经被遮蔽过,要么写错了。
      this.violations.push({ eventSeq: event.seq, type: event.type, reason: 'replace-start-missing' })
      return this.order.length
    }

    let to = this.order.indexOf(end)
    if (to === -1) {
      this.violations.push({ eventSeq: event.seq, type: event.type, reason: 'replace-end-missing' })
      to = from
    } else if (to < from) {
      this.violations.push({ eventSeq: event.seq, type: event.type, reason: 'replace-range-inverted' })
      to = from
    }

    const removed = this.order.slice(from, to + 1)
    for (const seq of removed) this.shadowed.add(seq)
    this.order.splice(from, removed.length)

    const declared = new Set(event.sourceEventSeqs ?? [])
    if (removed.some(seq => !declared.has(seq))) {
      this.violations.push({ eventSeq: event.seq, type: event.type, reason: 'source-seqs-incomplete' })
    }

    return from
  }

  isShadowed(eventSeq: number): boolean {
    return this.shadowed.has(eventSeq)
  }

  snapshot(): SurfaceSnapshot {
    return {
      order: [...this.order],
      shadowed: [...this.shadowed].sort((a, b) => a - b),
      violations: [...this.violations],
    }
  }

  /** 增量维护用:当前 surface 的最后一个节点(replace 的 `end` 常取它)。 */
  lastSeq(): number | undefined {
    return this.order.length > 0 ? this.order[this.order.length - 1] : undefined
  }

  /** 增量维护用:当前 surface 的第一个节点。 */
  firstSeq(): number | undefined {
    return this.order.length > 0 ? this.order[0] : undefined
  }
}

export function foldSurface(events: readonly SessionLogEventRecord[]): SurfaceSnapshot {
  const index = new SurfaceIndex()
  for (const event of events) index.push(event)
  return index.snapshot()
}
