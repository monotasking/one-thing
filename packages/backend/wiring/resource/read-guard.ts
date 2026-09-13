/**
 * K3-c —— `ReadGuard` 的第一个产地(K2c-2 立的那只口:`core/resource/kernel.ts` 的
 * `ResourceKernelOptions.readGuard`,当时明说「今天没有宿主装它」)。
 *
 * ## 它补的是一格**授权诚实账**,而且是过渡的
 *
 * `rpc/domains/files.ts` 的 `listDirectory` / `stat` 对非本机可信的调用方还有一层
 * per-caller 夹持:每条路径先夹进 `context.sandboxRoot`(那是这个调用方自己的
 * `<workspaceRoot>/<uid>/<wid>` 子树)。资源那条路上**没有这一格** —— `Invocation`
 * 里只有 `principal`,没有「这个调用方的根在哪」(K2c-1 / K2c-2 的留账)。于是同一个
 * 目录,经 `resources.read('dir:…','list')` 会比经 `files` 域宽。
 *
 * provider 那一侧判的是**进程级**沙箱(`SandboxPolicy`,与工具 runner 同一把尺子),
 * 它挡得住「读到进程沙箱外面去」,挡不住「A 用户读到 B 用户的子树」——后者要的正是
 * 那格不存在的 per-caller 根。
 *
 * 所以这一批的兜法是**保守到底**:一台没有声明本机可信的进程上,名单上那几种的读
 * 一律拒(今天是 `dir` 与 `git` —— 后者答的是某个工作树里的文件名与它们的 diff)。
 * 说得直白些 —— 独立部署(非回环)的 server 上,资源面的目录读这一批**不开**;
 * 桌面内嵌面与回环 `server:start` 照常(它们服务的就是这台机器上的同一个用户,
 * 与 `files` 域 2026-08-30 那次拍板「本机可信宿主的 HTTP 面与 IPC 同权」逐字同一条
 * 判据、同一只函数 `isHostLocallyTrusted()`)。
 *
 * 宽一点的做法(按 principal 分档、按 uid 拼一个根)全部要求先知道「这个调用方的根
 * 在哪」,而那正是缺的那一格。在它到位之前**拒绝**比**猜**诚实:一次拒绝是看得见
 * 的,一次猜错是安静的。
 *
 * ## 退场条件,写在这里免得它长成永久设施
 *
 * 等 per-caller 的沙箱根进了 `Invocation`(设计正本 §7 盲点 3「授权粒度」那条),
 * 这只守卫**整只删掉**:那时 provider 拿到的 `SandboxPolicy` 就是这个调用方自己的
 * 那把尺子,越界判定回到一处,守卫这一层没有任何东西可判。判据不是「守卫变复杂了」,
 * 是「provider 已经能替它把这句话说完」。
 *
 * ## 为什么它收的是一张表,而不是自己写 `'dir'`
 *
 * 「内核不认识任何 scheme」那条法(§2 不变量 3)管的是 `packages/core`,这只文件在
 * 装配层、名字里就写着它是一条策略。但同一条法的**形状**在这里照样成立:守卫认的
 * 是「谁被列进了本机限定」,而那份名单由 mount 那一处给
 * (`./index.ts`,加一种资源只改那一只文件)。守卫自己不认识任何一个命名空间 ——
 * 明天音乐或别的什么也要这条待遇,改的是名单不是这只文件。
 */

import type { ReadGuard, ReadVerdict, ResourceRef } from '@onething/core/resource'
import type { Principal } from '@onething/core/permission'

export interface LocalOnlyReadGuardOptions {
  /** 哪些 scheme 的读只许在本机可信的进程上发生。空表 = 这只守卫什么都不拦。 */
  readonly schemes: readonly string[]
  /** 这台进程可不可信。**每次现读** —— 声明可能晚于装配(独立 server 在 listen 时才声明)。 */
  isTrusted(): boolean
}

/**
 * 本机限定的读守卫。返回的对象是无状态的:名单与判据都在闭包里,没有可变格。
 */
export function createLocalOnlyReadGuard(options: LocalOnlyReadGuardOptions): ReadGuard {
  const guarded = new Set(options.schemes)
  return {
    decide(ref: ResourceRef, _name: string, _principal: Principal): ReadVerdict {
      if (!guarded.has(ref.scheme)) return { kind: 'allow' }
      if (options.isTrusted()) return { kind: 'allow' }
      return {
        kind: 'deny',
        // 这句话说的是**过渡**,不是「你没有权限」:同一个人在桌面上读得到。
        reason: `${ref.scheme} reads are local-only until per-caller sandbox lands`,
      }
    },
  }
}
