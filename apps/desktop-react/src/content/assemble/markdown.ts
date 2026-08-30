import type { BlockModel } from '../model/blocks'

/**
 * 管线第 ④ 步:**markdown 产地**(§2)。
 *
 * 一段文本进来,块序列出去。**只解析,不渲染** —— 这一步产出的是纯数据,谁来画
 * 由块注册表说了算。
 *
 * ── P0 是纯文本,而且这是裁量,不是偷懒 ────────────────────────────────
 * P0 的纪律是可感知行为零变化:今天屏幕上正文按纯文本画(`white-space: pre-wrap`
 * 保留换行),这一步就必须产出**一个** paragraph 块、里面**一个** text 行内节点,
 * 换行原样留在字符串里。真解析器(micromark/mdast)是 P1 的事,连同它的翻译表
 * (`markdown/to-blocks.ts`)、围栏路由与增量解析一起进来。
 *
 * 到那时这个函数不是被删,是被**降级为兜底**:解析器认不出来的整段,照样落回
 * 一个 paragraph —— 所以它今天的形状就是它将来的形状。
 */
export function plainTextToBlocks(text: string): BlockModel[] {
  if (!text) return []
  return [{ kind: 'paragraph', inline: [{ type: 'text', text }] }]
}
