import { registerBlock } from '../../registry'
import { Divider } from './Divider'

/**
 * 注册:分隔线是 **flow** —— 纸上的一道排版记号,不进壳的物件框(没有檐、
 * 没有动作、不限高)。`streaming: 'atomic'`:`---` 要么整个在,要么还没到,
 * 没有「半条线」的中间态。
 */
registerBlock({
  kind: 'divider',
  presentation: 'flow',
  streaming: 'atomic',
  Component: Divider,
})
