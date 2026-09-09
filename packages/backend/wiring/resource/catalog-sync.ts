/**
 * K3-a —— 资源工具进**工具目录**(`docs/design/atom-2026-09.md` §4「AI 工具」那一行、
 * §10.4「运行中 → 进面」)。
 *
 * K1 把资源工具留在内核自己手里(`kernel.tools()`),目录里一只都没有 —— 当时那是
 * 对的:露面规则还没定,而第一版拿一个产品里零产地的暗标 `resourceTools === true`
 * 控露面,被审查打回(K1 提交 84cb9da4)。这一单给出正式的规则,规则只有一句:
 *
 *   **provider 在注册表里,那只工具就在目录里。**
 *
 * 这不是新立的一条判据,是 §10.4 那张表的第三行(「运行中 = 提供者在 + 有打开中的
 * 实例 → 进面」)在今天这几种资源上的样子:`session` 装配即 mount 恒在;`workbench`
 * 随壳的连接来去(`ShellMountRegistry`);将来的插件资源随 enable / disable。所以
 * 「有没有打开中的实例」这个事实**由 provider 自己决定要不要 mount**,而不是在这里
 * 多长一格状态 —— 表下面那句「谁想加一格 `appState` 就是想绕开这四个事实之一」写的
 * 就是这个。
 *
 * ## 为什么是对账,不是「mount 时顺手 register」
 *
 * 因为登记这件事有两个产地(内置的 `mountBuiltinResources`、壳交上来的
 * `ShellMountRegistry`),将来还会有第三个(插件)。让每个产地各自记得往目录里加一行、
 * 摘的时候记得摘掉,就是「按能力枚举」的形状,而且漏摘不会报错 —— 只会让模型看见
 * 一只调不动的工具。对账只认一份事实(注册表),产地加多少个都不必回来改这只文件。
 *
 * ## 为什么排一个微任务
 *
 * `ResourceKernel.mount` 的**第一行**是 `registry.register(spec)`,而工具是在那之后
 * 才造出来并写进内核内部表的。所以注册表通知到达的那一刻 `kernel.tools()` 里还没有
 * 这只新工具 —— 同步对账会漏掉它。排一个微任务再对账,顺带把「先注销再登记」的重挂
 * (同 shellId 换自述)合成一次对账。
 *
 * 微任务而不是定时器:`mount` 是同步函数,它返回之前不会让出;所以任何 `await` 之后
 * 目录都已经是对的,调用方不必等一个不确定的时长。
 *
 * ## 一份自述可以说「模型面不要我」(K5-a)
 *
 * 上面那句「provider 在 = 工具在」有**一个**例外,而它写在自述里、不写在这只文件
 * 里:`exposure.aiTool === false` 的 scheme 不进目录。今天唯一这么声明的是 MCP 投影
 * 驱动 —— 那台 server 的工具**已经**以 `McpTool` 在目录里了,再进一次就是同一件事
 * 两只工具(两个名字、两张权限卡,而模型会两条都试)。
 *
 * 判据读的是表,不是名单:这只文件里照旧一个 scheme 名都没有,加第二种这样的资源
 * 不必回来改它(§2 不变量 3)。它只关掉**这一份**投影 —— 元工具 `resources` 的
 * `list` 照列它(它读的是注册表,不是目录),RPC / CLI / 内核照旧。
 *
 * ## 摘的时候按**登记过的那份清单**摘
 *
 * K1 踩过这个坑:关机链上内核先被 `dispose()`(表空了),再轮到别人去摘,于是
 * 「按当下的表摘」摘了个空,目录里留下一批调不动的工具。所以这只文件自己记账:
 * 登记过哪几个 id,就摘哪几个。
 */

import type { Catalog, Tool } from '@onething/core/toolkit'
import { ResourceMetaTool, type ResourceKernel } from '@onething/core/resource'
import type { ToolCatalogTier } from '../toolkit/catalog.js'

export interface ResourceCatalogSyncOptions {
  /** 这一档目录是哪一档。缺席 = 不按档减(单测里那种自己 new 一本目录的用法)。 */
  readonly tier?: ToolCatalogTier
}

/**
 * 把这台内核的资源工具(加一只元工具 `resources`)投影进这一档工具目录,并跟着
 * 注册表变。返回退订 + 把登记过的全部摘掉。
 *
 * 元工具在这里造而不是在内核里:它不是任何一份自述的投影,内核没有它的位置;
 * 而它的寿命恰好就是「资源这一族在目录里的那份投影」的寿命 —— 谁起的谁收。
 *
 * ## `readonly` 档一只都不放(K3-a')
 *
 * 那一档的契约写在 `wiring/toolkit/catalog.ts` 上:**零本地副作用**的工具
 * (read / time / web),给一台不该改这台机器任何东西的宿主用
 * (`ONETHING_SERVER_TOOLS=readonly`)。而资源工具**带写面** —— `session` 这一只
 * 就能改名、归档、删消息 —— 放进去是当场违约,而且是那种不会有任何东西红的违约。
 *
 * 判据放在这里而不是 `backend.ts` 里:露面规则这一条与上面那句「provider 在 =
 * 工具在」是同一句话的两半,拆到两个文件里就是下一个人只改一半。`backend.ts`
 * 递的是它建目录时用的那一档,不认识 `'readonly'` 这三个字的含义。
 *
 * `headless`(CLI daemon)照给:它是个完整的宿主,只是没有界面。
 *
 * **`backend.resources` 不受影响** —— 不进目录说的只是「模型看不见」,RPC 那条路
 * (`rpc/domains/resources.ts`)照旧,界面与脚本照旧走管线。
 */
export function syncResourceToolsIntoCatalog(
  kernel: ResourceKernel,
  catalog: Catalog,
  options: ResourceCatalogSyncOptions = {},
): () => void {
  if (options.tier === 'readonly') return () => {}
  const meta = new ResourceMetaTool(kernel.registry)
  /** 这只文件往目录里放过哪几个 id。摘的时候只认它,不认当下的注册表。 */
  const registered = new Set<string>()
  let stopped = false
  let scheduled = false

  const add = (tool: Tool): void => {
    if (registered.has(tool.spec.id)) return
    /*
     * 目录里已经有同名的别人(内置工具、插件工具),是**装配错误**,不是可以静默
     * 吞掉的情况:那意味着一个命名空间的名字与一只工具撞了,而地址的左半边与工具名
     * 是同一个字符串(`core/resource/tool.ts` 的 id 那一格)。`Catalog.register` 自己
     * 会抛 —— 这里不加 `if (catalog.has(id)) return` 把它变成一次静默的少一只工具。
     */
    catalog.register(tool)
    registered.add(tool.spec.id)
  }

  const reconcile = (): void => {
    scheduled = false
    if (stopped) return
    const live = new Map<string, Tool>([[meta.spec.id, meta]])
    for (const tool of kernel.tools()) {
      // K5-a —— 自述说了不进模型面就不进。缺席 = 进(见文件头)。
      if (tool.provider.spec.exposure?.aiTool === false) continue
      live.set(tool.spec.id, tool)
    }
    for (const id of [...registered]) {
      if (live.has(id)) continue
      catalog.unregister(id)
      registered.delete(id)
    }
    for (const tool of live.values()) add(tool)
  }

  const schedule = (): void => {
    if (stopped || scheduled) return
    scheduled = true
    queueMicrotask(reconcile)
  }

  // 开局同步一次(元工具与装配序列里已经 mount 过的资源)。这一次是同步的:
  // 调用方登记 `own()` 之后立刻就该看得见,不必等一拍。
  reconcile()
  const unsubscribe = kernel.registry.subscribe(schedule)

  return () => {
    stopped = true
    unsubscribe()
    for (const id of registered) catalog.unregister(id)
    registered.clear()
  }
}
