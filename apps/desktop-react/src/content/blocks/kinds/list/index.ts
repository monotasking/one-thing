import { registerBlock } from '../../registry'
import { List } from './List'

/**
 * 注册:列表是 **flow**;`midway: 'grow'` —— 项一条条长出来是它的常态。
 *
 * 留账(R4b):与引用同一格 —— 项内的子块今天仍住在 model 里(`items:
 * BlockModel[][]`),没走容器栈。
 */
registerBlock({
  kind: 'list',
  presentation: 'flow',
  stream: { midway: 'grow', settled: 'same', failure: 'source', identity: 'origin', geometry: 'flow' },
  Component: List,
}, import.meta.hot)
