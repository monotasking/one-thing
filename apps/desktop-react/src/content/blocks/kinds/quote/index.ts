import { registerBlock } from '../../registry'
import { Quote } from './Quote'

/**
 * 注册:引用是 **flow** —— 它是纸上的一段字,不是一件东西。
 * `append`:里面装的多半是段落,一个字一个字长出来是常态。
 */
registerBlock({
  kind: 'quote',
  presentation: 'flow',
  streaming: 'append',
  Component: Quote,
})
