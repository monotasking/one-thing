import { registerBlock } from '../../registry'
import { Heading } from './Heading'

/**
 * 注册:标题是 **flow** —— 纸上的一行字,不是一件东西(没有檐、没有边、不折叠)。
 * `midway: 'grow'`:一行标题一个字一个字长出来是它的常态。
 */
registerBlock({
  kind: 'heading',
  presentation: 'flow',
  stream: { midway: 'grow', settled: 'same', failure: 'source', identity: 'origin', geometry: 'flow' },
  Component: Heading,
}, import.meta.hot)
