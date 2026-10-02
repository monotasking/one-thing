/**
 * S1 单测的手写语料:30 条中英混合短句。
 *
 * 与 S0 那份真库脱敏语料(2000 条,`__tests__/fixtures/`)是两件东西 —— 这一份小、
 * 手写、每一条都为某个断言存在(相邻的正反例、全角、camel、大小写、词序),
 * 所以它不依赖 S0 是否已经到货。
 *
 * 能力 id 一律取中性名(alpha / beta):core 目录里不许出现任何真实能力 id 的字面量,
 * 测试也一样 —— 否则边界检查器抓的就是自己人。
 *
 * 注意 a-04 的正文是**真的全角**(Ａ = U+FF21),a-10 的正文里嵌着**真的零宽空格**
 * (U+200B)。它们看不见是有意的:归一化那两条用例要的正是真输入,不是转义串。
 */

import type { DocPayload } from '../../feed.js'

export const CAP_A = 'alpha'
export const CAP_B = 'beta'

interface Row {
  key: string
  title: string
  content: string
  space: string
  role: string
  archived?: boolean
  /** 相对基准时间的天数(负数 = 更早) */
  daysAgo: number
}

const ROWS: Row[] = [
  { key: 'a-01', title: '身份牌分发', content: '他的身份牌已私发四人,别再重复发了', space: 's1', role: 'user', daysAgo: 0 },
  { key: 'a-02', title: '发牌次序', content: '份牌先发,身份后验,两步不要并成一步', space: 's1', role: 'user', daysAgo: 1 },
  { key: 'a-03', title: '身份校验', content: '身份这一段要单独校验,不要和牌照混在一起', space: 's1', role: 'assistant', daysAgo: 2 },
  { key: 'a-04', title: '全角输入', content: 'ＡＢＣ１２３ 全角输入也要能搜到', space: 's1', role: 'user', daysAgo: 3 },
  { key: 'a-05', title: 'getUserProfile 重构', content: '把 getUserProfile 拆成两段,user_profile 那张表不动', space: 's1', role: 'assistant', daysAgo: 4 },
  { key: 'a-06', title: '大小写', content: 'HTTP 与 http 应该是同一个词', space: 's1', role: 'user', daysAgo: 5 },
  { key: 'a-07', title: '词序', content: '窗口 大小 记忆', space: 's1', role: 'user', daysAgo: 6 },
  { key: 'a-08', title: '词序倒装', content: '大小 窗口 记忆', space: 's1', role: 'user', daysAgo: 7 },
  { key: 'a-09', title: '换行', content: '第一行\n第二行\n第三行', space: 's1', role: 'assistant', daysAgo: 8 },
  { key: 'a-10', title: '零宽', content: '零​宽​字​符', space: 's1', role: 'user', daysAgo: 9 },
  { key: 'a-11', title: '标点', content: '这里有中文标点,以及句号。还有「引号」', space: 's1', role: 'user', daysAgo: 10 },
  { key: 'a-12', title: '英文短语', content: 'the quick brown fox jumps over the lazy dog', space: 's1', role: 'assistant', daysAgo: 11 },
  { key: 'a-13', title: 'snake_case', content: 'max_retry_count 默认是三次', space: 's1', role: 'assistant', daysAgo: 12 },
  { key: 'a-14', title: '数字混排', content: 'utf8 与 v2 两种写法都要拆开', space: 's1', role: 'user', daysAgo: 13 },
  { key: 'a-15', title: '归档过的', content: '这一条是归档过的旧记录', space: 's1', role: 'user', archived: true, daysAgo: 40 },
  { key: 'a-16', title: '另一个空间', content: '这一条不在当前空间里', space: 's2', role: 'user', daysAgo: 1 },
  { key: 'a-17', title: '另一个空间的身份牌', content: '身份牌在另一个空间也被提到过', space: 's2', role: 'user', daysAgo: 2 },
  { key: 'a-18', title: '排除词', content: '这条讲的是缓存,不是索引', space: 's1', role: 'assistant', daysAgo: 14 },
  { key: 'a-19', title: '索引重建', content: '索引重建大约五秒,期间还能查旧数据', space: 's1', role: 'assistant', daysAgo: 15 },
  { key: 'a-20', title: '单字', content: '牌', space: 's1', role: 'user', daysAgo: 16 },
  { key: 'a-21', title: '前缀展开', content: 'search searchable searching searched', space: 's1', role: 'assistant', daysAgo: 17 },
  { key: 'a-22', title: '时间表达', content: '上周聊过一次,昨天又提了一遍', space: 's1', role: 'user', daysAgo: 18 },
  { key: 'a-23', title: '路径样子的词', content: 'src/main/index.ts 改了两行', space: 's1', role: 'assistant', daysAgo: 19 },
  { key: 'a-24', title: '链接样子的词', content: 'https://example.com/a 这个地址', space: 's1', role: 'user', daysAgo: 20 },
  { key: 'a-25', title: '重复词', content: '重要 重要 重要 说三遍', space: 's1', role: 'user', daysAgo: 21 },
  { key: 'a-26', title: '长一点的中文', content: '把权限往返、流式回复和索引折叠三件事分开,不要混在一条线程上', space: 's1', role: 'assistant', daysAgo: 22 },
  { key: 'a-27', title: '中英混排', content: '这个 retriever 走的是 RRF 融合,k 取 60', space: 's1', role: 'assistant', daysAgo: 23 },
  { key: 'a-28', title: '日文', content: 'これはテストです', space: 's1', role: 'user', daysAgo: 24 },
  { key: 'a-29', title: '只有标题命中', content: '正文里没有那个词', space: 's1', role: 'user', daysAgo: 25 },
  { key: 'a-30', title: '空正文', content: '', space: 's1', role: 'user', daysAgo: 26 },
]

/** 基准时间:所有 daysAgo 都相对它,测试里不许读真实时钟。 */
export const CORPUS_NOW = Date.UTC(2026, 8, 4, 12, 0, 0)

const DAY_MS = 24 * 60 * 60 * 1000

export function corpusDocuments(capability = CAP_A): DocPayload[] {
  return ROWS.map(row => ({
    capability,
    key: row.key,
    time: CORPUS_NOW - row.daysAgo * DAY_MS,
    facets: {
      space: row.space,
      role: row.role,
      archived: row.archived ?? false,
    },
    fields: { title: row.title, content: row.content },
  }))
}

/** 第二个能力的一小把文档:全部档 / 融合 / 分组次序那几条用。 */
export function secondaryDocuments(capability = CAP_B): DocPayload[] {
  return [
    { key: 'b-01', title: '身份牌说明书', content: '牌面朝上,四人一轮' },
    { key: 'b-02', title: '索引说明书', content: '索引是账本的投影' },
    { key: 'b-03', title: '窗口说明书', content: '窗口大小与记忆' },
  ].map((row, position) => ({
    capability,
    key: row.key,
    time: CORPUS_NOW - position * DAY_MS,
    facets: { space: 's1', role: 'doc', archived: false },
    fields: { title: row.title, content: row.content },
  }))
}

export const CORPUS_SIZE = ROWS.length
