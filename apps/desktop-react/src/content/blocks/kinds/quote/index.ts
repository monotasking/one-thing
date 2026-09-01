import { registerBlock } from '../../registry'
import { Quote } from './Quote'

/**
 * 注册:引用是 **flow** —— 它是纸上的一段字,不是一件东西。
 * `midway: 'grow'`:里面装的多半是段落,一个字一个字长出来是常态。
 *
 * 留账(R4b):引用**今天仍以自持嵌套的 model 到达**(`blocks: BlockModel[]`),
 * 没走块流的容器栈 —— 机制层的容器已经在(machine.ts),但把 markdown 的嵌套型
 * 迁进去要改 to-blocks 的产出形,属可感知的行为风险,不在「保行为等价」这一期。
 */
registerBlock({
  kind: 'quote',
  presentation: 'flow',
  stream: { midway: 'grow', settled: 'same', failure: 'source', identity: 'origin', geometry: 'flow' },
  Component: Quote,
}, import.meta.hot)
