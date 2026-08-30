import { memo } from 'react'
import type { BlockModel } from '../model/blocks'
import { resolveBlock, type BlockCtx } from './registry'
import { BlockShell } from './shell/BlockShell'
// 注册 barrel:import 这个模块**就是**「这台上有哪些块」。放在这里而不是应用入口,
// 是因为解析发生在这里 —— 谁要查表,谁负责保证表是装好的。
import './index'

/**
 * 一个块的入口:**查表 → 进壳**。
 *
 * 消费方(段渲染)只认识 `BlockModel`,不认识任何具体的块 —— 它连
 * 「有没有代码块这种东西」都不知道。这一层是那条无知的边界。
 *
 * `memo` 是有依据的、不是撒胡椒面:块模型不可变(装配管线的产物),
 * 所以浅比就是准的 —— 引用没变 = 内容没变 = 不必重画。
 */
export const BlockView = memo(function BlockView({
  block,
  ctx,
}: {
  block: BlockModel
  ctx: BlockCtx
}) {
  return <BlockShell def={resolveBlock(block.kind)} model={block} ctx={ctx} />
})
