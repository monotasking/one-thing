import { perfSpan } from '../../services/perf'
import type { ProjectedMessage } from '../../data/chat-fold'
import { messageStamp } from '../../data/chat-materialize'
import type { SegmentModel } from '../model/segments'
// 段表装好(副作用 import):生产者住在各自的 kind 文件里,这一行之后表上才有它们。
import '../segments'
import { claimSegment, segmentDefForNode } from '../segments/registry'
import { anchorMessage } from './anchor'
import { groupNodes } from './group'

/**
 * 装配管线 —— **一条消息 → 一串段**(§2)。
 *
 * 五步纯函数,各住一个文件:① anchor(锚点归位)② group(归组)③ present
 * (工具呈现)④ markdown(文本→块)⑤ key(稳定 key,由渲染侧调用),前面另有
 * 一步 ⓪ 认领(这条消息自己说它整条是什么)。
 * 这个文件只负责把它们串起来,自己不做任何判断 —— 加一步 / 换一步的代价因此
 * 是「改一个文件」。
 *
 * ── 谁生产哪一段:段表说了算(G 线 P3,正本 `docs/stream-geometry-2026-09.md` §20)──
 * 从前这里有一个按节点种的 `switch`,每一种段怎么从节点算出来都写在这个文件里 ——
 * 加一种段就要改装配。今天第 ⓪ 步是 `claimSegment(message)`(按注册序问,第一个
 * 认领的赢),循环体是 `segmentDefForNode(node).produce(node, ctx)`,`null` 不推。
 * ③ present / ④ markdown / 思考的 `textToFrame` 仍是那几个纯函数,只是**调用它们的
 * 那一行**搬进了各自的 `content/segments/kinds/*.ts`。这个文件里不出现任何一种段的名字。
 *
 * ── 仍然零 render ─────────────────────────────────────────────────────
 * 上面那行 `import '../segments'` 会把 kind 文件、连带它们的组件模块一起拉进来 ——
 * 装配的**模块图**从此不再是零 React。但装配**本身一次 `render` 都不做**:`produce`
 * 与 `claim` 只算数据,组件只在 `SegmentView` 渲染那一刻被读。vitest 照旧直测,
 * jsdom 照旧不用起。
 *
 * ── 按消息引用 memo ──────────────────────────────────────────────────
 * 折叠器保证消息对象**不可变、变则换引用**(chat-fold 的 appendTail 走的是整份
 * 复制),所以「引用没变 = 装配结果没变」是一条硬判据,不是启发式 —— 与主仓 F 线
 * 物化缓存那份 memo 同款。用 `WeakMap`:消息被折叠器换掉之后,这条缓存跟着被
 * 回收,不需要任何失效逻辑。
 *
 * 非活跃消息因此零重算;活跃消息每来一帧换一次引用、重算一次 —— 那正是 §6 的
 * 增量要接的地方(P1)。
 */

const CACHE = new WeakMap<ProjectedMessage, SegmentModel[]>()

/**
 * ── 第二层:按**身份章**索引的 LRU(09-03)────────────────────────────────
 *
 * 上面那张 WeakMap 的键是消息**对象**,而换一次会话折叠器整份换掉(新 state、
 * 新节点、新成品对象),于是它整片 miss —— 「切回刚才那条会话」要把整篇 markdown
 * 重新解析一遍。dev profile 读数:一次常规档切换里 `MessageRow2` total 47.9ms,
 * 其中 47ms 是 `assembleMessage → markdownToFrame → fromMarkdown`。
 *
 * 章由 `data/chat-materialize` 打:`<消息 id>@<节点 rev>@<blob 世代>`,三段都有
 * 唯一产地(见那个文件里 `messageStamp` 的注)。**同章 = 同内容**,所以复用是
 * 判据不是启发式;活消息(经 `mergeWater` 造出的新对象)拿不到章,永远走全算。
 *
 * 为什么不能也用 WeakMap:那正是第一层,它按对象活;这一层要活过换会话,
 * 所以键必须是字符串,也因此必须自己封顶 —— `LRU_CAPACITY` 条(≈ 几本会话的
 * 消息数),插入序即淘汰序(Map 保证),满了从最旧那头丢。
 */
const LRU_CAPACITY = 2000
const LRU = new Map<string, SegmentModel[]>()

export function assembleMessage(message: ProjectedMessage): SegmentModel[] {
  const cached = CACHE.get(message)
  if (cached) return cached
  const stamp = messageStamp(message)
  if (stamp !== undefined) {
    const reused = LRU.get(stamp)
    if (reused) {
      // 命中即**提到队尾**(删了再插):LRU 的「最近用过」只有这一种写法。
      LRU.delete(stamp)
      LRU.set(stamp, reused)
      CACHE.set(message, reused)
      return reused
    }
  }
  // 打点埋在 **memo miss 那一路**:命中缓存的那条路是一次 WeakMap 查表,量它没有意义,
  // 而且活跃消息每帧都走这里 —— 「装配到底花了多少」正是要问的那个数。
  const segments = perfSpan('assemble', () => runPipeline(message))
  CACHE.set(message, segments)
  if (stamp !== undefined) {
    LRU.set(stamp, segments)
    if (LRU.size > LRU_CAPACITY) {
      const oldest = LRU.keys().next()
      if (!oldest.done) LRU.delete(oldest.value)
    }
  }
  return segments
}

/** 测试口:清掉那张按章索引的表(WeakMap 那层跟着消息对象自己走,不必清)。 */
export function __resetAssembleCacheForTests(): void {
  LRU.clear()
}

/*
 * 模块级可变状态 = 配一段 HMR 退役(09-01 立法)。热更换掉的是**装配管线本身**,
 * 旧成品还留在表里就等于「新代码 + 旧产物」同屏。复用上面那一口拆卸,不写第二套。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => __resetAssembleCacheForTests())
}

function runPipeline(message: ProjectedMessage): SegmentModel[] {
  /*
   * ── 第 ⓪ 步:**这条消息自述它整条是什么**(U2)──────────────────────────
   *
   * 一次上下文压缩在账本上只是一条 system 消息,正文是后端写的一段 JSON —— 交给
   * 节点循环就是 09-08 事故里那坨原始 JSON。所以在跑节点循环**之前**先问一句。
   * 谁认、凭什么认,住在认领它的那个 kind 文件里(今天是 `segments/kinds/compact.ts`),
   * 这里一个字段名都不出现;没人认领就回 null,消息照常往下走 —— **降级是「照实把
   * 正文摆出来」**,不是吞掉这条消息。
   */
  const claimed = claimSegment(message)
  if (claimed) return [claimed]

  const segments: SegmentModel[] = []

  /*
   * ── 为什么这里要一个下标(P1b 裁定 D,2026-09-21)────────────────────────
   * 思考段要答一句 P1 答不出来的话:**这一块思考本身还在不在进行**。用户原话
   * 「think 区域的流式动画效果在这块思考结束后应该停止」—— 从前那格 `live` 说的是
   * 「**这条消息**还在流」,于是模型早已经转去写正文、工具也跑完了,上面那块思考
   * 仍然在扫光。
   *
   * 判据是**「它是不是序列上的最后一件」**,不是账本上的 `part.ended`。后者今天
   * 到不了这一层:`packages/core/session/projection/reducer.ts` 的 `assistant/part-end`
   * 确实在 part 上写了 `ended`,但 `materializeContentParts` 交出去的那一份把这一格
   * 丢掉了;而顶部推理(`message.reasoning`)在投影里压根就是一整串合并好的字,
   * **没有 part 身份**可言。所以判据取「序列上还有没有别的东西排在它后面」——
   * 后面一旦长出任何东西(正文的第一个块、一张工具卡、下一段推理),这一块思考
   * 就再也不会有新字了。要让它精确到 part,得先把 `ended` 一路带到壳,那是另一批。
   *
   * 下标由这里算、经 `ProduceCtx.isLast` 递给每一个 `produce`:「序列上最后一件」是
   * **序列**的事实,只有循环看得见整条序列;读不读它是那一型自己的事。
   */
  const nodes = groupNodes(anchorMessage(message))
  // 这条消息还在不在流 —— 一条消息一个值,循环外算一次,逐节点递同一个。
  const live = message.isStreaming === true
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    const segment = segmentDefForNode(node).produce(node, {
      /*
       * 缓存身份 = 消息 id + **已经出厂的段数**(不是节点下标):一个空正文节点不成段,
       * 它后面那一段的身份因此不挪位 —— 与 P3 之前逐字相同,`textToFrame` /
       * `markdownToFrame` 的缓存车道一条都不换。
       */
      id: `${message.id}#${segments.length}`,
      live,
      isLast: index === nodes.length - 1,
    })
    if (segment) segments.push(segment)
  }

  return segments
}

export { segmentKey, blockKey } from './key'
