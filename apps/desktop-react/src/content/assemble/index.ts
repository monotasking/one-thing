import { perfSpan } from '../../services/perf'
import type { ProjectedMessage } from '../../data/chat-fold'
import { messageStamp } from '../../data/chat-materialize'
import type { SegmentModel } from '../model/segments'
import { parseCompactMarker } from '../compact/marker'
import { anchorMessage } from './anchor'
import { groupNodes } from './group'
import { markdownToFrame } from './markdown'
import { presentToolCard } from './present'
import { textLatest, textPreview, textToFrame } from './text'
import { presentResearchEpisode } from '../research/episode'

/**
 * 装配管线 —— **一条消息 → 一串段**(§2)。
 *
 * 五步纯函数,各住一个文件:① anchor(锚点归位)② group(归组)③ present
 * (工具呈现)④ markdown(文本→块)⑤ key(稳定 key,由渲染侧调用),前面另有
 * 一步 ⓪ 分类(`compact/marker.ts`:这条消息自己说它是什么)。
 * 这个文件只负责把它们串起来,自己不做任何判断 —— 加一步 / 换一步的代价因此
 * 是「改一个文件」。
 *
 * 全程零 React、零 DOM:vitest 直测,jsdom 都不用起。
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
   * ── 第 ⓪ 步:**按内容自述分类**(U2)────────────────────────────────────
   *
   * 一次上下文压缩在账本上只是一条 system 消息,正文是后端写的一段 JSON。它不是
   * 「一段要读的字」——把它交给 markdown 那一步,屏幕上就是 09-08 事故里那坨原始
   * JSON。所以在跑节点循环**之前**先问一句「这条消息自己说它是什么」。
   *
   * 判据整件住在 `content/compact/marker.ts`(角色 + 正文里的 `type`),这里一个
   * 字段名都不出现:哪天后端多写一格,改那一处。认不出来(不是压缩标记、或者正文
   * 半途被截断解析不了)就返回 null,消息照常往下走 rich-text —— **降级是「照实
   * 把正文摆出来」**,不是吞掉这条消息。
   */
  const compact = parseCompactMarker(message)
  if (compact) return [{ kind: 'compact', marker: compact }]

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
   */
  const nodes = groupNodes(anchorMessage(message))
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    const isLastNode = index === nodes.length - 1
    switch (node.node) {
      case 'reasoning': {
        // 顶部推理与行内推理都是思考段 —— 它们的差别是**落点**(placement),
        // 而落点已经由锚点步兑现成了序列上的位置。到这一层就没有第二个问题了。
        //
        // **与下面 `text` 那一格逐字同形**(正本 `docs/thinking-stream-2026-09.md` §3):
        // 同样的身份(消息 id + 段序号)、同样把 `isStreaming` 传下去、同样由产地
        // 决定「哪一截已经定了」。差别只有一个:正文的切点问 markdown 语法,思考的
        // 切点只问换行。那条会话里 95.6% 的流式字符是思考(1,247,359 字),把它当
        // 一个字符串整段重画,就是 PerfHud 上每帧 100–136ms 的产地。
        const live = message.isStreaming === true
        const { blocks, tail } = textToFrame(`${message.id}#${segments.length}`, node.text, live)
        segments.push({
          kind: 'thinking',
          blocks,
          tail,
          /*
           * `live` = **这条消息**还在流。它是 R 线「块冻结」的判据(`textToFrame`
           * 拿它决定哪一截已经定了、可以停止重画),所以这一格**一个字都不许改**。
           */
          live,
          /*
           * `thinking` = **这一块思考**此刻还在进行(裁定 D,判据在上面那段注释里)。
           * 扫光、`data-live`、收起时显示最新一截还是 `preview`,三件都读它。
           */
          thinking: live && isLastNode,
          preview: textPreview(blocks, tail),
          /*
           * 收起且这块思考还在进行时那一行显示的**最新一截**(G 线 P1)。它与
           * `preview` 并排而不是二选一:两格说的是两个时刻的事实,而渲染层不许拿
           * 6 万字的串现切(代价与历史长度无关这件事由 `textLatest` 自己保证)。
           */
          latest: textLatest(blocks, tail),
        })
        break
      }
      case 'text': {
        // 活跃与否要传下去:流式那条路(稳定前缀 / 未闭合原子块 / 节拍)全靠它。
        // 缓存的身份带上段序号 —— 一条消息将来会有不止一段正文(锚点真算法进来之后)。
        const { blocks, offsets, ids } = markdownToFrame(
          `${message.id}#${segments.length}`,
          node.text,
          message.isStreaming === true,
        )
        if (blocks.length > 0) segments.push({ kind: 'rich-text', blocks, offsets, ids })
        break
      }
      case 'image':
        segments.push({ kind: 'image', blob: node.blob })
        break
      case 'tool-group':
        segments.push({ kind: 'tool-group', card: presentToolCard(node.calls) })
        break
      case 'research':
        segments.push({ kind: 'research', episode: presentResearchEpisode(node.calls) })
        break
    }
  }

  return segments
}

export { segmentKey, blockKey } from './key'
