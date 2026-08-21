/**
 * 这张表曾经驮着 `@onething/{core,gateway,runtime,app}` 共 150+ 条手工登记。P1'-1 /
 * P1'-2 / P3'd 之后它们全部是真 workspace 包(根 package.json 的 `workspaces` 逐个
 * 列包),node / vite / vitest / tsc 一律走各自 package.json 的 `"exports"` 解析 ——
 * 一张表,而且缺了子路径在 typecheck 就红,不再只在 build/run 时炸。
 * **新增子路径去对应包的 package.json `exports` 里加,永远不要加回这里。**
 *
 * 最后一条 `@onething/app` 已随 P3'd(`src/app` → `packages/backend`,name
 * `@onething/backend`)消失 —— 它当年之所以只能当 alias 活着,正是因为
 * "包名不是 `@onething/runtime` 的子路径";变成真包之后就不需要任何登记了。
 *
 * 现在这张表只剩 apps/electron 自己的内部路径别名:
 * `@onething/electron-host/<domain>/<file>` 直指 `apps/electron/src/<domain>/<file>.ts`。
 * 它不是一个包,是那棵宿主树内部的一套路径写法 —— 所以不该被包装成 workspace 包,
 * 只有真正需要它的两个配置 spread 它:electron.vite.config.ts(三段构建)和
 * vitest.config.ts(apps/electron 的测试、以及后端包里 mock 宿主模块的测试要能解析)。
 * apps/web / apps/server 不 import 这个族,也不应该拿到它。
 *
 * electron-host 两条就够,顺序有讲究:
 * 1. barrel(唯一走 index.ts 的 `window`)用**锚定正则**放在最前 —— 写成字符串
 *    的话 vite 的 string find 是前缀匹配,`@onething/electron-host/window` 会把
 *    `…/window/types` 一起吞成 `…/window/index.ts/types`;
 * 2. 叶子模块的 catch-all 正则在后,`$1` 直接落到 `<domain>/<file>.ts`。
 */
import { resolve } from 'node:path'

export interface OnethingAliasEntry {
  find: string | RegExp
  replacement: string
}

export function electronHostAliases(projectRoot: string): OnethingAliasEntry[] {
  return [
    { find: /^@onething\/electron-host\/window$/, replacement: resolve(projectRoot, 'apps/electron/src/window/index.ts') },
    { find: /^@onething\/electron-host\/(.+)$/, replacement: resolve(projectRoot, 'apps/electron/src/$1.ts') },
  ]
}
