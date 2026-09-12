import type { ContentRef } from '../../workbench/kinds'

/**
 * 「一格浏览器 tab」这一种内容的 id 与地址构造器。
 *
 * 它单独一只文件的理由与 `content/terminal/terminal-ref.ts` 逐字相同:种类自述
 * (`content/kinds/browser.tsx`)、叶、启动瓦三边都要它,而让其中任意两边互相
 * import 都会造出一条环。
 *
 * **这个 id 与资源 scheme 是同一个字**:`refId({kind:'browser', key:id})` 拼出来
 * 就是 `browser:<tabId>` —— 拼贴树上那片叶的地址,与 `resources.read/do` 的地址,
 * 与 `resource:event` 里那个 `ref`,三者逐字相同。那不是巧合,是 K0 的形:
 * **有地址的资源**在壳里就该用它自己的地址寻址。
 */
export const BROWSER_KIND = 'browser'

export function browserRef(tabId: string): ContentRef {
  return { kind: BROWSER_KIND, key: tabId }
}
