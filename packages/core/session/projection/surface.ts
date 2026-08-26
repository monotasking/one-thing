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

/**
 * 一条事件在 surface 上代表**哪条消息**(不代表任何消息的返回 undefined)。
 *
 * 批 P-b:这是写读两侧共用的**唯一**一份判定 —— 写侧
 * (`backend/session/event-surface.ts`)从前自己抄了一份同名函数,两份判定各自
 * 演化就是"切点落在对面不认得的格上"那类静默错乱的温床。判定只此一处,
 * 与 `isSessionSurfaceNodeType` 同源。
 */
export function surfaceMessageIdOf(event: SessionLogEventRecord): string | undefined {
  switch (event.type) {
    case 'user/message':
    case 'system/message':
    case 'message/imported':
    case 'user/message-edited':
      return event.data.message.id
    case 'run/start':
      return event.data.assistantMessageId
    case 'session/compacted':
      return event.data.messageId
    default:
      return undefined
  }
}

export interface SurfaceViolation {
  eventSeq: number
  type: string
  reason:
    | 'replace-start-missing'
    | 'replace-end-missing'
    | 'replace-range-inverted'
    | 'source-seqs-incomplete'
    /**
     * F3(§13.2):一次**成功**的压缩落在 surface 上却什么都没遮蔽。
     *
     * 写侧(`event-translator.ts` 的 `sessionCompacted`)按
     * `order.indexOf(throughSeq)` 找切点,找不到就 `covered = []` —— replace
     * 静默退化成 append。后果不是"少遮了一段",是**整份历史多出被压掉的那一段**:
     * 模型同时看到摘要和原文,预算翻倍而两边的账都是绿的。
     *
     * 读侧认得出来:completed 的压缩 + `append` + surface 上本来有东西 = 那次
     * 切点没解出来。失败的压缩本来就该 append(它不遮蔽任何东西),不算。
     */
    | 'compact-anchor-unresolved'
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
  /** 消息 id → 它在 surface 上那一格的 eventSeq(压缩锚点的第二步解析用)。 */
  private readonly seqByMessageId = new Map<string, number>()
  /**
   * surface 上**代表一条消息**的那些格(`surfaceMessageIdOf` 认得的)。
   *
   * 批 6a 尾款:`sourceEventSeqs` 的完整性只对这些格问责 —— 见
   * `declaredMessageGap`。
   */
  private readonly messageNodeSeqs = new Set<number>()

  push(event: SessionLogEventRecord): void {
    const op = event.surfaceOp
    const isNode = isSessionSurfaceNodeType(event.type)
    if (isNode) {
      const messageId = surfaceMessageIdOf(event)
      if (messageId) {
        this.seqByMessageId.set(messageId, event.seq)
        this.messageNodeSeqs.add(event.seq)
      }
    }

    if (op === undefined) {
      // surface 事件没带 op 的兜底:节点类型按 append 处理(老写者/迁移脚本
      // 漏字段时,消息不至于凭空消失)。非节点类型什么都不做。
      if (isNode) this.order.push(event.seq)
      return
    }

    if (op === 'append') {
      // F3 + 批 P-b:写侧当时解不出切点写成了 append,读侧**再解一次** ——
      // 整份日志在手,写侧当时缺的那一段可能就在眼前(半截 run 开头的日志被
      // `message/imported` 补齐之后正是这种局面)。解得出就照压缩语义遮蔽,
      // 解不出才落 F3 那条 violation。
      const anchor = this.resolveCompactAnchorIndex(event)
      if (anchor !== undefined) {
        this.shadowCompact(event, anchor)
        if (isNode) this.order.splice(0, 0, event.seq)
        return
      }
      this.checkCompactAnchor(event)
      if (isNode) this.order.push(event.seq)
      return
    }

    const at = this.applyReplace(event, op.start, op.end)
    if (isNode) {
      this.order.splice(at, 0, event.seq)
    }
  }

  /**
   * 一次**成功**的压缩在 surface 上遮蔽的是哪一格为止 —— 返回 `order` 上的下标。
   *
   * 批 P-b:唯一的解析依据是 **`data.compactedThroughMessageId`** —— 它是压缩自己
   * 说的那句话("历史被压到这条消息为止"),而这句话的语义本来就是**从 surface 头
   * 一直遮到它(含)**;写侧写的也正是 `order.slice(0, at+1)`。正常写下来的日志两种
   * 说法逐字相同(`surfaceOp.start` 就是当时的 `order[0]`),只有日志被**事后改过
   * 头部**时才分岔,这时按语义解才是对的。
   *
   * **不**拿 `surfaceOp` 反推锚点:没有 `compactedThroughMessageId` 的压缩(全量压缩
   * 或老写者)只有一句语法上的 replace,读侧只能逐字照办 —— 那种日志里"压缩节点插在
   * 中间"是合法形状。
   *
   * 解不出(没这一格 / 那条消息不在这份 surface 上)返回 undefined:调用方回到逐字
   * 照办的老路,行为与修复前一致。失败的压缩没有落点可言,照旧 append。
   */
  private resolveCompactAnchorIndex(event: SessionLogEventRecord): number | undefined {
    if (event.type !== 'session/compacted') return undefined
    if ((event.data.status ?? 'completed') !== 'completed') return undefined
    if (this.order.length === 0) return undefined
    const throughId = event.data.compactedThroughMessageId
    if (throughId === undefined) return undefined
    const seq = this.seqByMessageId.get(throughId)
    if (seq === undefined) return undefined
    const at = this.order.indexOf(seq)
    return at === -1 ? undefined : at
  }

  /**
   * 从 surface 头遮到 `to`(含)。
   *
   * `sourceEventSeqs` 的"列全没有"只校验**写侧声明的那一段**:声明区之前的头部是
   * 写侧当时看不见的节点(真机 46dcec05:压缩落账在前、迁移把 43 条
   * `message/imported` 补到头部在后),它们不在 `sourceEventSeqs` 里是应该的。
   */
  private shadowCompact(event: SessionLogEventRecord, to: number): void {
    const removed = this.order.slice(0, to + 1)
    for (const seq of removed) this.shadowed.add(seq)
    this.order.splice(0, removed.length)
    if (this.declaredMessageGap(event, removed)) {
      this.violations.push({ eventSeq: event.seq, type: event.type, reason: 'source-seqs-incomplete' })
    }
  }

  /**
   * 被遮蔽的那一段里,**代表消息的那些格**有没有从 `sourceEventSeqs` 里漏掉。
   *
   * 批 6a 尾款(§15.21):问责范围是**消息节点**,不是所有 surface 格。
   * `tool/result` 在 surface 上占一格却不物化成一条历史消息
   * (`surfaceMessageIdOf` 认不出它),而写侧的活 surface 索引根本看不见它 ——
   * 那两条 `tool/result` 走的是 `appendSessionLogEvent` 而不是
   * `appendSurfaceAwareEvent`,于是同进程内落的 `tool/result` 永远进不了
   * `sourceEventSeqs`。真机 `ec2437ff` 的 `session/compacted@6068` 就是这么红的:
   * 遮蔽 257 格、声明 173 个,差的 84 格**全是** `tool/result`。
   *
   * 那不是历史错乱:`shadowCompact` 用 `order.slice(0, to+1)` 整段遮全,模型
   * 既没多看也没少看 —— 是一条**记账完整性**的抱怨。真正会变成静默历史错乱的
   * 只有消息节点漏声明(§7.1 B5),所以校验只对它们问责。
   *
   * `declaredFrom` 的口径不变:只校验写侧声明的那一段(见 `shadowCompact` 注释)。
   */
  private declaredMessageGap(event: SessionLogEventRecord, removed: readonly number[]): boolean {
    const declared = new Set(event.sourceEventSeqs ?? [])
    const messages = removed.filter(seq => this.messageNodeSeqs.has(seq))
    const declaredFrom = messages.findIndex(seq => declared.has(seq))
    if (declaredFrom === -1) return false
    return messages.slice(declaredFrom).some(seq => !declared.has(seq))
  }

  /**
   * F3:一次成功的压缩以 `append` 落账 = 切点没解出来(见 `SurfaceViolation`)。
   *
   * 空 surface 上的压缩不算(那是迁移/老会话的第一条事件,本来就没得遮)。
   */
  private checkCompactAnchor(event: SessionLogEventRecord): void {
    if (event.type !== 'session/compacted') return
    if ((event.data.status ?? 'completed') !== 'completed') return
    if (this.order.length === 0) return
    this.violations.push({ eventSeq: event.seq, type: event.type, reason: 'compact-anchor-unresolved' })
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
    // 批 P-b:压缩这一类 replace 的语义不是"替换声明的那一段",是**从 surface 头
    // 遮到锚点** —— 写侧写的就是 `order.slice(0, at+1)`。正常写下来的日志两种说法
    // 逐字相同(`start` 就是当时的 `order[0]`),只有日志被**事后改过头部**时才分岔:
    // 真机 46dcec05 在压缩落账(08-21)之后才被迁移补进 43 条 `message/imported`,
    // 于是 `start` 落在第 43 格上,前面 43 条早该被摘掉的老消息永远留在了模型历史里
    // (投影 227 条 / 真相 114 条,请求预算真的翻了倍)。按语义解,老文件当场自愈。
    const anchor = this.resolveCompactAnchorIndex(event)
    if (anchor !== undefined) {
      // **只许长,不许缩**:写侧当年解不出锚点时会退化成"遮蔽整条 surface"
      // (`at = order.length - 1`),那份声明比锚点走得更远 —— 真机 fd899977 的
      // 压缩声明的是 [61..458] 而锚点那条消息是迁移后才补到第 14 格的,只按锚点
      // 遮就会把 400 多格原文放回模型历史里。两种说法取并集才两头都对。
      this.shadowCompact(event, Math.max(anchor, this.order.indexOf(end)))
      return 0
    }

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

    // 批 6a 尾款:只对**消息节点**问责(理由见 `declaredMessageGap`);这条路上
    // 不放过头部(声明区的口径只属于压缩那一路)。
    const declared = new Set(event.sourceEventSeqs ?? [])
    if (removed.some(seq => this.messageNodeSeqs.has(seq) && !declared.has(seq))) {
      this.violations.push({ eventSeq: event.seq, type: event.type, reason: 'source-seqs-incomplete' })
    }

    return from
  }

  isShadowed(eventSeq: number): boolean {
    return this.shadowed.has(eventSeq)
  }

  /**
   * 到此刻为止被遮蔽了多少格。
   *
   * 批 P-b:`sessions:verify` 靠"压缩前后这个数有没有涨"判"这次压缩到底遮住了
   * 什么" —— 一次成功的压缩遮蔽 0 格就是静默漏遮(A 类失配的形状)。
   * 不用 `snapshot()` 是因为逐条判要跑几千次,而它每次都复制三个数组。
   */
  shadowedCount(): number {
    return this.shadowed.size
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
