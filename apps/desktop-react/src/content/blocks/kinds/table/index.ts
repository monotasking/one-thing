import { completeTableTail } from '../../../markdown/table-tail'
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
 * ── 流式五问(R4a)────────────────────────────────────────────────────
 * `midway: 'hold'` —— 半张表不成形,合上之前它由围栏 / 段落代为呈现;
 * `settled: 'swap'` —— 合上那一刻原位换装成这个渲染器,换身份号、重挂,对的。
 *
 * `earlyForm` 是**从机制层收回来的那条政策**:从前 `upgradeTableTail` 写死在增量
 * 解析器里(它认识分隔行、认识 GFM 的列数规矩),于是「机制认识表」。现在表自己
 * 声明「把活尾巴补成这样,解析器就能提前一步认出我」,增量层只负责补一刀 → 重解析
 * → **末块真的是 table 才认**。补齐算法本身一个字没改(markdown/table-tail.ts),
 * 换的是它挂在谁身上。
 *
 * 它是 markdown 味的(分隔行是 GFM 的东西),而今天表的产地只有 markdown 一个;
 * 第二个产地(工具结果集)来的时候这一格该长出产地维度 —— 在此之前不假装已经有了。
 *
 * `geometry: 'flow'` 是 R4a 的**保行为等价**档:列宽锁定 / 骨架先立是 R4b 的事。
 */
registerBlock({
  kind: 'table',
  presentation: 'object',
  stream: {
    midway: 'hold',
    settled: 'swap',
    failure: 'source',
    identity: 'origin',
    geometry: 'flow',
    earlyForm: completeTableTail,
  },
  Component: Table,
  chrome: (model) => ({ title: model.caption }),
  actions: (model) => [
    { verb: 'copy', what: 'markdown', text: tableToMarkdown(model) },
    { verb: 'copy', what: 'csv', text: tableToCsv(model) },
  ],
}, import.meta.hot)
