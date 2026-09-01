import { registerBlock } from '../../registry'
import { Paragraph } from './Paragraph'

/**
 * 注册:段落是 **flow** —— 纸上的一段字,不进壳的物件框(没有檐、没有边、
 * 不横滚、不限高)。壳照样给它错误边界,所以一段正文画抛了也只塌那一段。
 *
 * `midway: 'grow'`:段落可以半成品渲染(文本一个字一个字追加就是它的常态)。
 */
registerBlock({
  kind: 'paragraph',
  presentation: 'flow',
  stream: { midway: 'grow', settled: 'same', failure: 'source', identity: 'origin', geometry: 'flow' },
  Component: Paragraph,
}, import.meta.hot)
