import { registerBlock } from '../../registry'
import { Diff } from './Diff'

/**
 * 注册:diff 是 **object** —— 六轮定稿的檐是「类型词 `diff` + 文件路径 + ±统计色字」。
 *
 * 三格逐条落位:`id` = 固定词 `diff`(壳按 `.id` 压小写 mono 灰),`meta` = 文件路径
 * (markdown 围栏那个产地常常没有,那一格就空着),`stat` = 壳画的两枚色字
 * —— 它不是徽章:徽章是一件东西,而「+12 −3」是**读数**,定稿里它和文件路径同一行
 * 同一号字,只有颜色不同。
 *
 * 动作只有一个:复制原始 diff 文本(`copy.source`,取的是块自带的 `source` 原文,
 * 不是把 hunks 再序列化回去 —— 那会变成第二份真相)。「查看源码」不单列:
 * 这块屏幕上画的**就是**那段源码的结构化样子,再给一个源码开关是自己跟自己重复。
 *
 * `midway: 'hold'` / `settled: 'swap'` —— 半段 diff 的 hunk 头还没到,行号无从起算。流式期间它由
 * 增量层按 `code(closed:false)` 逐行长出来,闭合那一刻原位换装(§6),
 * 与表格同一条路。
 */
registerBlock({
  kind: 'diff',
  presentation: 'object',
  stream: { midway: 'hold', settled: 'swap', failure: 'source', identity: 'origin', geometry: 'flow' },
  Component: Diff,
  chrome: (model) => ({ id: 'diff', meta: model.file, stat: model.stat }),
  actions: (model) => [{ verb: 'copy', what: 'source', text: model.source }],
}, import.meta.hot)
