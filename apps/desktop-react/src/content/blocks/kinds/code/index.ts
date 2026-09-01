import { registerBlock } from '../../registry'
import { Code } from './Code'

/**
 * 注册:代码块是 **object** —— 六轮定稿的**檐卡**。
 *
 * 檐的两格按定稿逐字落位:左端 `id` = 语言(小写 mono 灰,由壳的 `.id` 统一压小写),
 * `meta` = **文件名位**。markdown 围栏没有文件名这回事,所以从这个产地来的代码块
 * 那一格是空的 —— 位子留着不是摆设:同一个 `code` 块从 read / bash 工具那个产地
 * 过来时带 `file`,同一个组件、同一条檐,那一格自然就有字了(铁律 1)。
 *
 * 动作只有一个:复制源码。下载 / 放大在词表里但还没有执行器(P3),声明了也不会
 * 露出 —— 壳会把它们筛掉,而不是画一个点了没反应的钮。
 *
 * `midway: 'grow'` —— 未闭合围栏(`closed:false`)逐行长出来是它的常态。
 * 没有 `loader`:代码块在库到之前有一个完全正确的样子(素文本),不该被骨架盖住
 * (理由写在 highlight.ts)。
 */
registerBlock({
  kind: 'code',
  presentation: 'object',
  stream: { midway: 'grow', settled: 'same', failure: 'source', identity: 'origin', geometry: 'flow' },
  Component: Code,
  chrome: (model) => ({ id: model.lang ?? undefined, meta: model.file }),
  actions: (model) => [{ verb: 'copy', what: 'source', text: model.source }],
}, import.meta.hot)
