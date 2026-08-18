/**
 * `markdown-it-mark`(markdown-it 官方组织出品)不带类型声明。
 * 我们只把它当插件整个交给 `markdownit.use()`,不碰它的内部,所以声明到此为止
 * —— 与 `packages/shared/types/culori.d.ts` 同一条口径。
 */
declare module 'markdown-it-mark' {
  const markdownItMark: unknown
  export default markdownItMark
}
