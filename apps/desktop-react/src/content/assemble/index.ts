import { perfSpan } from '../../services/perf'
import type { ProjectedMessage } from '../../data/chat-fold'
import { messageStamp } from '../../data/chat-materialize'
import type { SegmentModel } from '../model/segments'
import { anchorMessage } from './anchor'
import { groupNodes } from './group'
import { markdownToFrame } from './markdown'
import { presentToolCard } from './present'
import { presentResearchEpisode } from '../research/episode'

/**
 * 装配管线 —— **一条消息 → 一串段**(§2)。
 *
 * 五步纯函数,各住一个文件:① anchor(锚点归位)② group(归组)③ present
 * (工具呈现)④ markdown(文本→块)⑤ key(稳定 key,由渲染侧调用)。
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
  const segments: SegmentModel[] = []

  for (const node of groupNodes(anchorMessage(message))) {
    switch (node.node) {
      case 'reasoning':
        // 顶部推理与行内推理都是思考段 —— 它们的差别是**落点**(placement),
        // 而落点已经由锚点步兑现成了序列上的位置。到这一层就没有第二个问题了。
        segments.push({ kind: 'thinking', text: node.text, live: message.isStreaming === true })
        break
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
