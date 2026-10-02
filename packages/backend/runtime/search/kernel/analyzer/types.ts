/**
 * 分析器的形:文本 → token,token 带原文偏移。
 *
 * 设计:docs/design/search-index-2026-09.md §6.3
 *
 * 索引侧与查询侧共用同一个分析器 —— 这是「打进去的与搜出来的是同一种东西」的
 * 唯一保证。偏移随 token 一路带着,摘要的高亮区间最终经归一化的偏移映射
 * (`normalize.ts`)回到原文,所以高亮永远指原文,不指归一化后的串。
 */

export interface Token {
  /** 归一化后的词形(进倒排的就是它) */
  text: string
  /** 在**传给 analyze 的那段文本**里的闭开区间 */
  start: number
  end: number
  /**
   * 词位。短语相邻靠它:查询侧短语的 token 记下相对位置,文档侧要求存在一个基点
   * b,使每个 token 都出现在 b + 相对位置上。CJK 二元是 0,1;camel 拆出来的
   * 整词与首段共位(0,0,1),两种形都由同一条判据答。
   */
  position: number
}

export interface Analyzer {
  readonly id: string
  analyze(text: string): Token[]
}
