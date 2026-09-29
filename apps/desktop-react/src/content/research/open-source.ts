import { linkReferenceKind } from '../../references/kinds/link'

/**
 * 打开一条来源 —— **与正文里的出处引用走同一条路**:http(s) 进内置浏览器开一格,
 * 宿主没有内置浏览器(网页壳 / 单测)时交给系统。
 *
 * 不另写一份:「这条地址该谁开、开不成退到哪」的判词住在 `references/kinds/link.ts`
 * 的 `open` 上,检索段与引用 chip 是同一件事的两个入口,两份实现迟早分叉。
 */
export async function openSourceUrl(url: string): Promise<boolean> {
  return (await linkReferenceKind.open?.({ kind: 'linkRef', href: url }, {})) ?? false
}
