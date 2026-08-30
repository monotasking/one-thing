import { registerBlock } from '../../registry'
import { List } from './List'

/** 注册:列表是 **flow**;`append` —— 项一条条长出来是它的常态。 */
registerBlock({
  kind: 'list',
  presentation: 'flow',
  streaming: 'append',
  Component: List,
})
