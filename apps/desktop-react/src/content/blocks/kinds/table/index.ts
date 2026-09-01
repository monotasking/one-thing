import { registerBlock } from '../../registry'
import { Table } from './Table'
import { tableToCsv, tableToMarkdown } from './serialize'

/**
 * 注册:表格是 **object**,檐按定稿是**窄檐** —— 中段是表题位,右端是动作。
 *
 * mdast 的表没有 caption,所以从 markdown 产地来的表**表题位是空的**;檐照样画,
 * 因为动作要有家(§4.1 那句「空 caption = 空左端,檐仍在」)。将来工具产地(比如一次
 * 查询的结果集)带着题目过来时,同一条檐上自然就有字了。
 *
 * 动作两个,都是复制:Markdown(贴回文档)与 CSV(贴进表格软件)。下载 CSV 在词表
 * 里但执行器要等 P3,壳会把它筛掉 —— 不画点了没反应的钮。
 *
 * `streaming: 'atomic'` —— 半张表不成形。流式期间它由增量层按 `code(closed:false)`
 * 逐行长出来,闭合那一刻原位换装成这个渲染器(§6)。
 */
registerBlock({
  kind: 'table',
  presentation: 'object',
  streaming: 'atomic',
  Component: Table,
  chrome: (model) => ({ title: model.caption }),
  actions: (model) => [
    { verb: 'copy', what: 'markdown', text: tableToMarkdown(model) },
    { verb: 'copy', what: 'csv', text: tableToCsv(model) },
  ],
}, import.meta.hot)
