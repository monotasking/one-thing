import type { ProjectedMessage } from '../../data/chat-fold'
import type { SegmentModel } from '../model/segments'
import { anchorMessage } from './anchor'
import { groupNodes } from './group'
import { markdownToFrame } from './markdown'
import { presentToolGroup, presentToolStep } from './present'

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

export function assembleMessage(message: ProjectedMessage): SegmentModel[] {
  const cached = CACHE.get(message)
  if (cached) return cached
  const segments = runPipeline(message)
  CACHE.set(message, segments)
  return segments
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
        const { blocks, offsets } = markdownToFrame(
          `${message.id}#${segments.length}`,
          node.text,
          message.isStreaming === true,
        )
        if (blocks.length > 0) segments.push({ kind: 'rich-text', blocks, offsets })
        break
      }
      case 'image':
        segments.push({ kind: 'image', blob: node.blob })
        break
      case 'tool':
        segments.push({ kind: 'tool', step: presentToolStep(node.call) })
        break
      case 'tool-group':
        segments.push({ kind: 'tool-group', group: presentToolGroup(node.calls) })
        break
      case 'research':
        // 检索段的模型由 P4 的归组步产出;归组步今天不产 research 节点,
        // 所以这一格走不到 —— 留着是为了 switch 穷尽,不是为了兜底。
        break
    }
  }

  return segments
}

export { segmentKey, blockKey } from './key'
