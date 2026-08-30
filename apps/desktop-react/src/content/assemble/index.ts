import type { ProjectedMessage } from '../../data/chat-fold'
import type { SegmentModel } from '../model/segments'
import { anchorMessage } from './anchor'
import { groupNodes } from './group'
import { plainTextToBlocks } from './markdown'
import { presentToolRow } from './present'

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
        // 顶部推理 = 思考段。行内推理(placement:'inline')在 P0 的锚点直通里
        // 不会出现 —— 它要等锚点真算法把 parts 织进来。
        segments.push({ kind: 'thinking', text: node.text, live: message.isStreaming === true })
        break
      case 'text': {
        const blocks = plainTextToBlocks(node.text)
        if (blocks.length > 0) segments.push({ kind: 'rich-text', blocks })
        break
      }
      case 'image':
        segments.push({ kind: 'image', blob: node.blob })
        break
      case 'tool':
        segments.push({ kind: 'tool', row: presentToolRow(node.call) })
        break
      case 'tool-group':
        segments.push({
          kind: 'tool-group',
          group: {
            rows: node.calls.map(presentToolRow),
            failed: node.calls.filter((call) => call.status === 'failed').length,
          },
        })
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
