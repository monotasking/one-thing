/**
 * 这张表曾经驮着 `@onething/{core,gateway,runtime}` 共 150+ 条手工登记。P1'-1 与
 * P1'-2 之后它们都是真 workspace 包(根 package.json 的 `workspaces` 逐个列包),
 * node / vite / vitest / tsc 一律走各自 package.json 的 `"exports"` 解析 —— 一张
 * 表,而且缺了子路径在 typecheck 就红,不再只在 build/run 时炸。
 * **新增 runtime 子路径去 `packages/onething-runtime/package.json` 的 exports 加,
 * 永远不要加回这里。**
 *
 * 只剩一条:`@onething/app`。它是一个**包名**,不是 `@onething/runtime` 的子路径
 * —— node 解析 `@onething/app/x` 只会去看 `node_modules/@onething/app` 那个目录的
 * package.json,`@onething/runtime` 的 exports 里写多少 `"./app/*"` 都够不着它。
 * 要让它变成真包,只有两条路:(a) 在 `packages/onething-runtime/src/app/` 里塞一份
 * package.json,把 src 的一个子目录变成嵌套包;(b) 等 P3' 把 `src/app` 整体搬到
 * `packages/backend`,那时它自然就是真包。(a) 是 P3' 上来就要删的临时物,所以
 * P1'-2 不做 —— 保留这一条前缀 alias,等归位。
 *
 * apps/electron 自己的内部路径别名:`@onething/electron-host/<domain>/<file>`
 * 直指 `apps/electron/src/<domain>/<file>.ts`。它不是一个包,是那棵宿主树
 * 内部的一套路径写法 —— 所以不该被包装成 workspace 包,只有真正需要它的两个
 * 配置 spread 它:electron.vite.config.ts(三段构建)和 vitest.config.ts
 * (apps/electron 的测试、以及装配层里 mock 宿主模块的测试要能解析)。
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

/**
 * 装配层 `@onething/app/*` —— 一条前缀条目覆盖所有子路径,**不要**逐文件登记。
 * 见文件头:它是包名而非 runtime 子路径,P3' 归位后整条消失。
 * apps/web(renderer)不 import 这个族,所以它的 vite 配置不 spread 这张表。
 */
export function onethingPackageAliases(projectRoot: string): OnethingAliasEntry[] {
  return [
    { find: '@onething/app', replacement: resolve(projectRoot, 'packages/onething-runtime/src/app') },
  ]
}

export function electronHostAliases(projectRoot: string): OnethingAliasEntry[] {
  return [
    { find: /^@onething\/electron-host\/window$/, replacement: resolve(projectRoot, 'apps/electron/src/window/index.ts') },
    { find: /^@onething\/electron-host\/(.+)$/, replacement: resolve(projectRoot, 'apps/electron/src/$1.ts') },
  ]
}
