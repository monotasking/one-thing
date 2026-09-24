import { createElement } from 'react'
import { presentResearchEpisode } from '../../research/episode'
import { ResearchSegment } from '../../research/ResearchSegment'
import { registerSegment, type NodeOf, type SegmentOf, type SegmentViewProps } from '../registry'

/**
 * 检索段 —— 消费 `research` 节点(web 族连着来的一串调用,归组步折的)。
 */
function produce(node: NodeOf<'research'>): SegmentOf<'research'> {
  return { kind: 'research', episode: presentResearchEpisode(node.calls) }
}

/**
 * 适配:不产 DOM。段 key 兼作检索段的身份 —— 消息尾来源条按同一个字符串点名
 * (`research/reveal.ts`),两处都走 `segmentKey`,不各拼一遍。
 */
function ResearchView({ model, segmentKey, ctx }: SegmentViewProps<SegmentOf<'research'>>) {
  return createElement(ResearchSegment, { episode: model.episode, id: segmentKey, ctx })
}

/*
 * 几何:`grow` —— 流式期间来源在长;`user-only` —— 只有人亲手收起才变矮。
 * 不算正文:「它上网找了一圈」不是一句回话。
 */
registerSegment({
  kind: 'research',
  node: 'research',
  produce,
  View: ResearchView,
  geometry: { liveForm: 'grow', settle: 'same-height', shrink: 'user-only' },
}, import.meta.hot)
