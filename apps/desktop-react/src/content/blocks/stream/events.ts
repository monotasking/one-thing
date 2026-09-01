import type { BlockModel } from '../../model/blocks'

/**
 * **块流 IR —— 我们自己的词汇**(R4a,设计 §R4「IR 反转」条)。
 *
 * 从前块层的供货合同是「每帧一份重新推导的块列表」:块是一次性对象,身份靠渲染侧
 * 按源偏移现算,而「这一帧和上一帧是不是同一块」这个问题在**每一个消费者**那里各答
 * 一遍。六轮事故的宿主就是这种「各自对账」。
 *
 * 这里把它翻过来:**块层只吃一条单调的事件流**,而 markdown 解析器降级成这条流的
 * **生产者之一** —— HTML part / 图片 part / 工具卡 / 将来的 mermaid、公式走同一条 IR,
 * 加一种内容不再需要挤 micromark 扩展那一条门。
 *
 * ── 七个词,一个都不为某一型而设 ────────────────────────────────────────
 *
 * | 词 | 意思 | 谁能收 |
 * |---|---|---|
 * | `open` | 开一块,当场发终身身份号 | — |
 * | `append` | 末块**整行落定**了(提交,单调只增) | 开着的块 |
 * | `tail` | 活尾槽:半截的活行此刻长这样(**不是提交**) | 开着的末块 |
 * | `close` | 关块 —— 从此它的 model **永不再变** | 开着的块 |
 * | `retract` | 这块没长成(原位换装的前半拍) | 开着的**末**块 |
 * | `open-container` | 开容器,往栈上压一层 | — |
 * | `close-container` | 关容器,弹一层 | 栈顶 |
 *
 * ── 为什么有 `retract`(设计里只写了三操作 + 容器 + 尾槽)────────────────
 * 「表头段落在分隔行到齐那一刻变成表」这件事必须有一个词说得出来。没有它,生产者
 * 只能撒谎:先 `close` 再在同一个位置 `open` 另一种块 —— 而 `close` 的全部价值正是
 * 「从此不再变」这条承诺,用它去表达「这块作废了」等于把承诺作废。所以另立一个词,
 * 并且把它钉死在**末块**上:结构只在尾巴上收,前面提交过的一律不许动。
 *
 * ── 为什么 `tail` 不是 `append` ────────────────────────────────────────
 * 「结构只在行界变」这条不变式的兑现处就是这两个词的分家:一帧的文本结不结束在换行
 * 上由 provider 的分片说了算(table-tail 那条病历的根),所以**半截的行不许改结构**。
 * `tail` 只换开着那一块的**画面**,块的数目、身份、前面每一块的 model 一个字不动;
 * 只有 `append` 才动提交过的那一份。于是「这一帧结构变没变」= 「这一帧有没有 append」,
 * 是个可以逐帧数出来的数(见 `__tests__/block-stream.test.ts` 的行界断言)。
 *
 * ── 事件是数据 ────────────────────────────────────────────────────────
 * 没有函数指针、没有组件、没有 React。可序列化、可深比、可乱序重放(性质测试靠它)。
 */

/**
 * 终身身份号。
 *
 * **由生产者铸造、机器只搬运** —— 与后端 R1 那条「身份由引擎铸造」同款分工:
 * 两处各编一套号会把「对不上」搬到壳里重演一次。
 *
 * markdown 生产者铸的号是**产地派生**的(`${源偏移}:${kind}`),不是一个不透明计数器。
 * 理由是跨路一致:同一条消息会在四条路上被画出来 —— 直播、收尾、重折、冷加载 ——
 * 而计数器活在一台机器的实例里,重折换一台机器号就全变了,那一刻整条消息重挂
 * (今天按源偏移发 key 的写法反而没有这个病,不能为了「号更纯」把它换回去)。
 * 产地派生的号在四条路上逐字相同,而「同一个产地上换了型」由 kind 那一半负责换号
 * —— 换装本来就该重挂。
 */
export type BlockId = string

export interface BlockOpenEvent {
  op: 'open'
  id: BlockId
  kind: string
  /** 开的那一刻它已经有的样子(可能只有一行)。 */
  model: BlockModel
}

export interface BlockAppendEvent {
  op: 'append'
  id: BlockId
  /** 又落定了若干整行之后的那一份。**单调**:生产者保证它是更长的前缀。 */
  model: BlockModel
}

export interface BlockTailEvent {
  op: 'tail'
  id: BlockId
  /** 活尾槽此刻的样子 = 已提交的部分 + 半截的活行。下一次 `append` 一到就作废。 */
  model: BlockModel
}

export interface BlockCloseEvent {
  op: 'close'
  id: BlockId
}

export interface BlockRetractEvent {
  op: 'retract'
  id: BlockId
}

export interface ContainerOpenEvent {
  op: 'open-container'
  id: BlockId
  kind: string
}

export interface ContainerCloseEvent {
  op: 'close-container'
  id: BlockId
}

export type BlockEvent =
  | BlockOpenEvent
  | BlockAppendEvent
  | BlockTailEvent
  | BlockCloseEvent
  | BlockRetractEvent
  | ContainerOpenEvent
  | ContainerCloseEvent

/** 会动结构的那几个词 —— 「这一帧结构变没变」问的就是它。 */
const STRUCTURAL = new Set<BlockEvent['op']>([
  'open',
  'append',
  'close',
  'retract',
  'open-container',
  'close-container',
])

/**
 * 这条事件动没动结构。
 *
 * `tail` 不算:它只换开着那一块的画面。这个判据是行界断言的判据,写在这里而不是
 * 抄在测试里 —— 一份口径。
 */
export function isStructuralEvent(event: BlockEvent): boolean {
  return STRUCTURAL.has(event.op)
}
