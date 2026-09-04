/**
 * 检索语料的**脱敏规则** —— 规则表已于 S3a 搬进
 * `packages/core/search/redact.ts`,这里只剩一行再导出。
 *
 * 为什么搬:S0 时消费者只有两个脚本侧的(抽取脚本与夹具自检),规则住 `scripts/`
 * 说得过去。S3a 起**索引写路**也要跑同一张表(`runtime/search/index/filters.ts`
 * 的缺省 `redactionFilter`,设计 §5.2c),而产品代码不许 import `scripts/` ——
 * 一份规则两处副本是「洗过的语料再洗一遍恒等」那条恒等式最先塌掉的地方。
 *
 * 这个文件留着,是因为它有既有消费者:`scripts/search-corpus-extract.mjs`、
 * `scripts/__tests__/search-corpus-redact.test.mjs`、
 * `packages/core/search/__tests__/fixtures.test.ts`,以及那份手写的
 * `search-corpus-redact.d.mts` 类型面。它们的 import 路径一个字不用改。
 *
 * 再导出的是 `.ts` 源文件:仓里跑脚本用 bun(直接吃 TS),跑测试用 vitest(同样
 * 直接吃 TS),两条路都解析得开。
 */
export * from '../../packages/core/search/redact.ts'
