import s from './SourceView.module.css'

/**
 * 源码的**唯一**画法。
 *
 * 三处用它:兜底块(`source-fallback`)的本体、错误边界的降级、檐上「查看源码」
 * 的展开态。写成一件东西不是为了少写几行 —— 是因为它是**失败语义的落点**:
 * 「源码永远可见」这句话在屏幕上长什么样,只该有一个答案。
 *
 * 它自己**不可能抛错**(一个 pre 一段字),所以错误边界拿它当降级是安全的 ——
 * 兜底的兜底不能再走一次可能抛错的渲染器。
 */
export function SourceView({ source }: { source: string }) {
  return <pre className={s.source}>{source}</pre>
}
