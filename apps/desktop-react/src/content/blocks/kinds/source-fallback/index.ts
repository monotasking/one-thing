import { registerBlock } from '../../registry'
import { SourceFallback } from './SourceFallback'

/**
 * 注册:兜底块是 **object** —— 它是一件东西(有檐、能横滚、能折叠)。
 *
 * 檐左端摆 `reason`(小写 mono 灰),右端只有一个动作:复制源码。这就是
 * 「什么都没画出来」时人真正需要的两件事:知道为什么、能把它捞走。
 *
 * `streaming: 'atomic'` —— 兜底的源码不该半成品显示:它已经是失败态了,
 * 再逐帧长出来只会让人以为还在加载。
 */
registerBlock({
  kind: 'source-fallback',
  presentation: 'object',
  streaming: 'atomic',
  Component: SourceFallback,
  chrome: (model) => ({ id: model.reason }),
  actions: (model) => [{ verb: 'copy', what: 'source', text: model.source }],
})
