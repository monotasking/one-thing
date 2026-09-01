import type { BlockModel } from '../../model/blocks'
import { isStructuralEvent, type BlockEvent, type BlockId } from './events'

/**
 * **块流机器 —— 纯机制,零型特例**(R4a,设计 §R4「机制与政策分离」条)。
 *
 * 它只会做一件事:把一串 `BlockEvent` 应用到一棵树上,并且**当场执法**。它不认识
 * 段落、不认识表、不认识 markdown;`kind` 对它就是一个字符串,`model` 对它就是一坨
 * 不透明的数据。六轮事故的元凶(政策渗进机制)在这里没有落脚点 —— 这个文件里
 * 没有一处 `if (kind === …)`,静态门盯着这一条(见 `__tests__/block-stream.test.ts`)。
 *
 * ── 五条法(dev 抛,生产计数)────────────────────────────────────────────
 *
 *  L1 **同号不共存**:树上同一时刻不许有两个同号的块。
 *  L2 **关了就不再变**:`close` 过的块收到 `append`/`tail`/`retract` 一律违法。
 *  L3 **结构只在尾巴上收**:`retract` 只许作用于**开着的末块**(容器栈当前层的末位;
 *     栈顶容器自己也算 —— 它没长成时先弹栈,再从父层摘掉)。
 *  L4 **收得到人**:`append`/`tail`/`close`/`retract` 的目标必须存在且开着。
 *  L5 **容器成对**:`close-container` 只关栈顶,栈空时关容器违法。
 *
 * **永不 throw**(设计审查条 13:不变式违反 = 自愈 + 计数,不是让屏幕白掉)——
 * dev 也算在这一侧,理由见下面 `ENFORCE` 的注。违法的那条事件被丢掉,`violations`
 * 加一;只有测试里直接抛,因为反证要的是红。
 *
 * ── L1 为什么不是「身份永不复生」 ────────────────────────────────────────
 * 那条更硬的法写出来过,当天就被一个**真实**场景推翻:早成形认领是可逆的 ——
 * `|h|\n|-` 认成表(段落被 `retract`),下一帧模型写了个 `|-x`,分隔行当场不合法,
 * 同一个产地又变回段落。这不是「理论不可能」,是模型写错字的常态。所以复生**合法**,
 * 只是记一笔 `revivals`(设计审查条 13 的可见面口径);真正不许发生的是「同一时刻
 * 树上有两个同号」—— 那才是身份系统坏掉。
 *
 * ── 为什么是一个类 ────────────────────────────────────────────────────
 * 它有状态(这条消息这一段此刻的树),而要测的恰恰是**跨帧行为**。状态藏在模块里,
 * 用例之间就会互相污染。生产侧按 `(messageId, 段序号)` 各持有一台(见
 * markdown/block-stream.ts),没有模块级单例 —— R2 审查条 4 的同一条法。
 */

/** 屏幕上那棵树的一个节点。**只读快照**:每次结构或画面变化换一份引用。 */
export interface BlockNode {
  readonly id: BlockId
  readonly kind: string
  /**
   * 此刻画的那一份 = 活尾槽 ?? 已提交。**容器缺席** —— 容器没有自己的内容,
   * 它的内容就是它的孩子(怎么把孩子折成一份画得出的东西,由那一型的注册契约说,
   * 机制不问)。
   *
   * 没变的块**逐帧是同一个对象** —— `BlockView` 的 memo 是浅比,这一条就是
   * 「块树操作代价 O(变化行数)」在渲染侧的兑现处。
   */
  readonly model?: BlockModel
  readonly closed: boolean
  /** 容器才有。叶子块缺席(不是空数组 —— 空数组会让「容器」和「空容器」分不开)。 */
  readonly children?: readonly BlockNode[]
}

interface Rec {
  id: BlockId
  kind: string
  /** 已提交的那一份(只有 `append` 动它)。容器没有。 */
  committed?: BlockModel
  /** 活尾槽(半截的活行)。`append` 一到就清。 */
  tail?: BlockModel
  closed: boolean
  container: boolean
  children: Rec[]
}

/**
 * **只有测试里抛**,dev 与生产一律计数自愈。
 *
 * 写过一版「dev 也抛」,想了想撤掉:dev 是**用户在用的那台**(`npm run dev` 跑的是
 * 真会话),而这几条法里有一条是新长出来的岗哨 —— 「关过的块又变了」会照出存量的
 * 「流式 ≠ 冷加载」分歧。让它在用户面前把屏幕炸掉,等于用一条新守卫制造一次新事故。
 * 生产态永不 throw 是设计审查条 13 的原话,这里把 dev 也算进「生产态」那一侧:
 * 抛只发生在**要红的地方**(vitest 的反证、门的反证),别处一律 `violations` 加一。
 */
const ENFORCE = (() => {
  try {
    return import.meta.env?.MODE === 'test'
  } catch {
    return false
  }
})()

export class BlockStreamMachine {
  private roots: Rec[] = []
  /** 容器栈。栈顶就是「末块该往哪儿开」的答案 —— 单调流长出一棵树靠它。 */
  private stack: Rec[] = []
  /** 树上此刻活着的号 —— L1 与 O(1) 寻人共用一份。 */
  private readonly live = new Map<BlockId, Rec>()
  /** 退役过的号(只为数复生,不为拦)。 */
  private readonly retired = new Set<BlockId>()
  private snapshotCache?: readonly BlockNode[]

  /** 「理论不可能」的计数器(生产态可见面挂通知中心诊断区,依赖 C1 拍板)。 */
  violations = 0
  /** 退役过的号又回来了几次(早成形认领可逆,合法但值得看见)。 */
  revivals = 0
  /** 最近一次 `applyAll` 里动过结构的事件条数 —— 行界断言与读数量它。 */
  lastStructuralOps = 0

  applyAll(events: readonly BlockEvent[]): void {
    let structural = 0
    for (const event of events) {
      if (this.apply(event) && isStructuralEvent(event)) structural += 1
    }
    this.lastStructuralOps = structural
  }

  /** 应用一条。返回是否真的被应用(违法的那条丢掉)。 */
  apply(event: BlockEvent): boolean {
    switch (event.op) {
      case 'open':
      case 'open-container': {
        if (this.live.has(event.id)) return this.illegal(`同号共存:${event.id}`)
        if (this.retired.has(event.id)) this.revivals += 1
        const rec: Rec = {
          id: event.id,
          kind: event.kind,
          ...(event.op === 'open' ? { committed: event.model } : {}),
          closed: false,
          container: event.op === 'open-container',
          children: [],
        }
        this.live.set(event.id, rec)
        this.currentList().push(rec)
        if (rec.container) this.stack.push(rec)
        return this.changed()
      }

      case 'append': {
        const rec = this.openLeaf(event.id)
        if (!rec) return false
        rec.committed = event.model
        // 提交一到,活尾槽当场作废:它说的是「还没落定的那半行」,而那半行刚落定。
        rec.tail = undefined
        return this.changed()
      }

      case 'tail': {
        const rec = this.openLeaf(event.id)
        if (!rec) return false
        rec.tail = event.model
        return this.changed()
      }

      case 'close': {
        const rec = this.find(event.id)
        if (!rec) return this.illegal(`关一块不存在的:${event.id}`)
        if (rec.closed) return this.illegal(`重复关块:${event.id}`)
        // 关块把活尾槽收进提交:关的那一刻屏幕上画的就是最终的那一份。
        if (rec.tail !== undefined) {
          rec.committed = rec.tail
          rec.tail = undefined
        }
        rec.closed = true
        return this.changed()
      }

      case 'retract': {
        /*
         * 撤回**栈顶容器自己**也走这条:它没长成的时候,先把它从栈上弹下来,
         * 再从父层的名单里摘掉 —— 「这个容器不算数了」和「这块不算数了」是同一件事,
         * 不该有第二个词。弹栈之后 `currentList()` 自然指向父层,下面那段一个字不改。
         */
        if (this.stack[this.stack.length - 1]?.id === event.id) this.stack.pop()
        const list = this.currentList()
        const last = list[list.length - 1]
        if (!last || last.id !== event.id) {
          return this.illegal(`撤回的不是末块:${event.id}`)
        }
        if (last.closed) return this.illegal(`撤回已关的块:${event.id}`)
        list.pop()
        this.forget(last)
        return this.changed()
      }

      case 'close-container': {
        const top = this.stack[this.stack.length - 1]
        if (!top) return this.illegal('容器栈是空的,关不了')
        if (top.id !== event.id) return this.illegal(`关的不是栈顶容器:${event.id}`)
        this.stack.pop()
        top.closed = true
        return this.changed()
      }
    }
  }

  /**
   * 此刻那棵树。**没变就是同一个引用** —— 上层拿它当 memo 的键。
   */
  snapshot(): readonly BlockNode[] {
    if (!this.snapshotCache) this.snapshotCache = this.roots.map(toNode)
    return this.snapshotCache
  }

  /** 还开着的那些块(尾巴那一段)。收尾时逐个 `close` 用得上。 */
  openIds(): BlockId[] {
    const out: BlockId[] = []
    walk(this.roots, (rec) => {
      if (!rec.closed) out.push(rec.id)
    })
    return out
  }

  has(id: BlockId): boolean {
    return this.find(id) !== undefined
  }

  private currentList(): Rec[] {
    const top = this.stack[this.stack.length - 1]
    return top ? top.children : this.roots
  }

  private openLeaf(id: BlockId): Rec | undefined {
    const rec = this.find(id)
    if (!rec) {
      this.illegal(`收不到人:${id}`)
      return undefined
    }
    if (rec.closed) {
      this.illegal(`关了的块还在长:${id}`)
      return undefined
    }
    return rec
  }

  private find(id: BlockId): Rec | undefined {
    return this.live.get(id)
  }

  /** 撤回的那一支整个退役(容器连着它的孩子)。 */
  private forget(rec: Rec): void {
    this.live.delete(rec.id)
    this.retired.add(rec.id)
    if (rec.container) for (const child of rec.children) this.forget(child)
  }

  private changed(): true {
    this.snapshotCache = undefined
    return true
  }

  private illegal(why: string): false {
    this.violations += 1
    if (ENFORCE) throw new Error(`[block-stream] 违法事件:${why}`)
    return false
  }
}

function toNode(rec: Rec): BlockNode {
  return rec.container
    ? { id: rec.id, kind: rec.kind, closed: rec.closed, children: rec.children.map(toNode) }
    : { id: rec.id, kind: rec.kind, model: rec.tail ?? rec.committed, closed: rec.closed }
}

function walk(list: readonly Rec[], visit: (rec: Rec) => void): void {
  for (const rec of list) {
    visit(rec)
    if (rec.container) walk(rec.children, visit)
  }
}
