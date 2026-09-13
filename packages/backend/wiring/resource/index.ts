/**
 * K1 —— 资源内核的装配面(`docs/design/atom-2026-09.md` §9 K1)。
 *
 * 两件事,一件不多:
 *   ① `createResourceKernel(runner)` —— 把一张新注册表与**宿主那台 `ToolRunner`**
 *      装进一个 `ResourceKernel`。递进来的是同一台 runner,不是「给资源另配一台」:
 *      那正是 K1 的整句话(不新造第二条管线)在装配这一侧的样子。
 *   ② `mountBuiltinResources(kernel)` —— 内置资源的**唯一**注册点,返回逆序注销。
 *
 * 加一种内置资源 = 这只文件里加一行 `providers.push(new XxxProvider())`,加一份
 * 自述,加一份 provider。§8 演练要的「能力自己的模块 + 一行注册」就是这一行 ——
 * `backend.ts` 里不出现任何资源的名字,`core` 里更不出现。
 *
 * ── 目录名为什么是 `wiring/resource` ────────────────────────────────────────
 * `wiring/<domain>` 是「只为把一个领域插进脊柱而存在」的那一档(结构债 P3 定的),
 * 而这里正是:自述在产品层、内核在 core,这一层只负责把两头接上并交给装配。
 * I1(backend 根目录名不许影子化 runtime 领域名)对 `wiring/` 豁免;I2 那条不适用
 * ——`packages/onething-runtime/src` 下**没有** `resource/` 目录,会话那份自述住在
 * `sessions/` 里,不新开一棵同名树。
 */

import { NO_ORIGIN_SESSION, ResourceInputValidator, ResourceKernel, ResourceRegistry } from '@onething/core/resource'
import type { ResourceKernelOptions } from '@onething/core/resource'
import { combineValidators, type ToolRunner, type Validator } from '@onething/core/toolkit'
import { ZodValidator } from '@onething/runtime/toolkit'
import { DIR_RESOURCE_SCHEME } from '@onething/runtime/files/resource-spec'
import { GIT_RESOURCE_SCHEME } from '@onething/runtime/files/git-resource-spec'
import * as store from '../../store.js'
import { isHostLocallyTrusted } from '../../server/host-trust.js'
import { createSandboxPolicy } from '../toolkit/runner.js'
import { DirResourceProvider } from './dir-provider.js'
import { GitResourceProvider } from './git-provider.js'
import { createMusicResourceProvider } from './music-provider.js'
import { createLocalOnlyReadGuard } from './read-guard.js'
import { SessionResourceProvider } from './session-provider.js'
import type { ToolCatalogTier } from '../toolkit/catalog.js'

export { forwardResourceEventsToBus } from './event-bridge.js'
export { syncResourceToolsIntoCatalog } from './catalog-sync.js'
export type { ResourceCatalogSyncOptions } from './catalog-sync.js'
export { DEFAULT_SHELL_COMMAND_TIMEOUT_MS, ShellCommandDispatch, ShellCommandFailedError } from './shell-dispatch.js'
export type { ShellCommandDispatchOptions } from './shell-dispatch.js'
export { ShellResourceProvider, resourceSpecFromShell } from './shell-provider.js'
export {
  DEFAULT_SHELL_HEARTBEAT_MS,
  ShellMountRegistry,
  ShellMountShapeError,
  ShellSchemeNotOwnedError,
  UnknownShellError,
} from './shell-registry.js'
export type { ShellMountRegistryOptions } from './shell-registry.js'
export { SessionResourceProvider, SessionNotFoundError, SessionRefRequiredError } from './session-provider.js'
export type { SessionOpPayload } from './session-provider.js'
export {
  DirOperationFailedError,
  DirOutsideSandboxError,
  DirRefRequiredError,
  DirResourceProvider,
  DirShellUnavailableError,
} from './dir-provider.js'
export type { DirEntryKind, DirOpPayload, DirRefusalReason } from './dir-provider.js'
export { resolveReadable, resolveWritable } from './path-guard.js'
export {
  GitOperationFailedError,
  GitRefRequiredError,
  GitResourceProvider,
  GitUnavailableError,
} from './git-provider.js'
export type { GitChangedFile, GitFileStatus } from './git-provider.js'
export { createLocalOnlyReadGuard } from './read-guard.js'
export type { LocalOnlyReadGuardOptions } from './read-guard.js'
export { mountMcpResources } from './mcp-mount.js'
export type { McpResourceManagerPort, McpResourceMountOptions } from './mcp-mount.js'
export {
  McpResourceCallFailedError,
  McpResourceProvider,
  McpResourceRefMismatchError,
} from './mcp-provider.js'
export type { McpOpPayload, McpResourceCallPort } from './mcp-provider.js'
export {
  createMusicResourceProvider,
  MusicCommandFailedError,
  MusicCommandValueError,
  MusicIntentRequiredError,
  MusicProgrammeActionRequiredError,
  MusicProviderIdRequiredError,
  MusicRefMismatchError,
  MusicResourceProvider,
  MusicSearchQueryRequiredError,
  MusicSetupActionError,
  MusicSongRequiredError,
  musicBackendAdapters,
  musicPlayerAdapters,
  musicStationAdapters,
} from './music-provider.js'
export type {
  MusicBackendAdapters,
  MusicOpPayload,
  MusicPlayerAdapters,
  MusicResourceAdapters,
  MusicStationAdapters,
} from './music-provider.js'

/**
 * 一台资源内核。注册表是**新建**的(不是进程单例):谁要一张表谁自己 new 一个,
 * `OnethingBackend` 把它当字段持有 —— 与 `registry.ts` 头注释里那条组合根法条
 * 逐字同义。
 *
 * ## 为什么收的是**造 runner 的配方**而不是一台造好的 runner(K2a)
 *
 * 因为这台 runner 的 `Validator` 必须认得这台内核生成的入参契约,而那份契约是内核
 * `mount` 的时候才造出来的 —— 先造 runner 再造内核,校验器就永远晚一步。收配方之后
 * 两件事在同一处扣上:这里先造 `ResourceInputValidator`,串成组合校验器交给配方,
 * 再把**同一个实例**交给内核去认领每个 scheme 的契约。结果是**结构性**的:
 * 建不出一台"runner 不认识自己工具契约"的资源内核。
 *
 * 组合的次序是「先问资源校验器,它不认领的交给 zod」。次序不能反:`ZodValidator`
 * 对认不出的 schema 是 `passthrough`(那对插件 / MCP 是对的 —— 替远端把关不是本地
 * 校验者的事),而一个 passthrough 排在前面就等于后面那位永远轮不上。
 */
export function createResourceKernel(
  makeRunner: (validator: Validator) => ToolRunner,
  options: ResourceKernelOptions = {},
): ResourceKernel {
  const resourceValidator = new ResourceInputValidator()
  const runner = makeRunner(combineValidators([resourceValidator], new ZodValidator()))
  return new ResourceKernel(new ResourceRegistry(), runner, {
    /*
     * K3-c —— **沙箱与工具 runner 同一把尺子**。
     *
     * `createAppToolRunner` 的缺省就是这一只(`wiring/toolkit/runner.ts` 的
     * `createSandboxPolicy()`),所以模型经 `read` 工具读一个路径、与经资源面读
     * 同一个路径,判的是同一条边界。两把尺子是「一个洞会在两处之一悄悄张开」的
     * 标准形状。
     *
     * 它在这里而不在 `backend.ts`:那只文件里不许出现任何资源的名字,而「资源的读
     * 要按哪把尺子判」正是这一层的事。宿主真要换一把,`options.sandbox` 盖得住。
     *
     * **资源读根 = 工具读根,同一张表,漏一格就是「两把尺子」**(2026-09-13):
     * 工具那条路(`toolkit/families/file.ts` 的 `sandboxRoots`)一直把
     * `scope.workingDirectory`(发起会话绑的工作目录)算进根里,而这一条以前没传
     * —— 于是同一条会话、同一个仓,`read` 工具读得到、`dir:` / `git:` 资源答
     * 「outside the sandbox root」。两把尺子不是「资源更严」:它是一处会被当成规矩
     * 的自相矛盾,而修它的方向只能是把漏的那一格补上,不是把另一把放松。
     *
     * `scope` 就是内核递来的**发起坐标**:缺席 / `NO_ORIGIN_SESSION` / 查无此会话
     * 一律空数组 —— 退回这一格存在之前的行为,一个字都不猜。
     */
    sandbox: createSandboxPolicy(undefined, {
      workingDirectoryRootsFor: scope => {
        if (!scope || scope === NO_ORIGIN_SESSION) return []
        const session = store.getSession(scope) as { workingDirectory?: string } | undefined
        return session?.workingDirectory ? [session.workingDirectory] : []
      },
    }),
    /*
     * K3-c —— 读的守卫。名单在这里给,判据在 `./read-guard.ts`(它自己不认识任何
     * 一个命名空间)。理由与退场条件写在那只文件的头上:资源面还没有 per-caller 的
     * 沙箱根,所以非本机可信的进程上本地文件那一族的读一律拒。
     *
     * `git` 与 `dir` 同一条、同一天进这张表(「改动」面那一单):它答的是这台机器上
     * 某个工作树里的文件名与它们的 diff —— 那比一次目录列举交出去的东西**更多**,
     * 而两者的授权诚实账缺的是同一格。
     */
    readGuard: createLocalOnlyReadGuard({
      schemes: [DIR_RESOURCE_SCHEME, GIT_RESOURCE_SCHEME],
      isTrusted: () => isHostLocallyTrusted(),
    }),
    ...options,
    validator: resourceValidator,
  })
}

/**
 * 装上这台宿主的内置资源,返回**逆序**注销。
 *
 * 逆序不是仪式:注销顺序与注册顺序相反是 `own()` 那条纪律的形状,一种资源将来若
 * 依赖另一种先在场(K3 的音乐依赖目录),顺序就已经是对的。
 *
 * K2a':注销是**异步**的(内核的 `mount` 返回 `() => Promise<void>` —— §10.2 要求
 * 摘之前先让在飞的收场),而且**逐个 await**:并发摘会让「逆序」这句话失效。
 */
export interface MountBuiltinResourcesOptions {
  /**
   * 这台宿主建工具目录时用的那一档(K3-b)。缺席 = 不按档减。
   *
   * **只有 `music` 读它**,而且只认 `'full'`:那是旧 `radio` 工具的注册条件逐字
   * 搬过来的(它只在桌面档 `createDesktopCatalog` 里注册)。判据不是「桌面才有
   * 喇叭」——server 也可能有,而是**这一档以外的宿主今天根本没有音乐子系统的
   * 消费者**:CLI daemon 上没有电台,给它挂一个能开台的命名空间,等于凭空多出一个
   * 没有人验收过的出口。
   *
   * 「不 mount」比「mount 了但工具目录里不给」严一档,这是刻意的:后者(`readonly`
   * 那条规则)只让模型看不见,RPC 那条路照旧;前者连 `resources` 域也没有它 ——
   * 与今天 CLI 上没有 `radio` 一致。
   */
  readonly tier?: ToolCatalogTier
}

export function mountBuiltinResources(
  kernel: ResourceKernel,
  options: MountBuiltinResourcesOptions = {},
): () => Promise<void> {
  const disposers: Array<() => void | Promise<void>> = [
    kernel.mount(new SessionResourceProvider()),
    /*
     * K3-c / K3-c' —— 目录。**所有档都装**(含 `readonly`),与 `session` 同一条:
     * `readonly` 那一档的契约由 `catalog-sync.ts` 执行 —— 它对那一档**一只工具都不
     * 投**,于是模型看不见任何资源;内核本身照装,RPC 与脚本那条路照旧。
     *
     * K3-c 当时这一行的理由写的是「它一格写面都没有」,K3-c' 补上写面之后那句话不再
     * 成立(`createDirectory` / `rename` / `delete` 是真的本地副作用),所以理由换成
     * 上面这条 —— 它与 `session`(那只早就能改名、归档、删消息)是同一句话,而且
     * 是那一档真正的判据。
     */
    kernel.mount(new DirResourceProvider()),
    /*
     * 「改动」面 —— git 工作树。**不分 tier**:两条读法零效果、零副作用
     * (`ops: {}`),所以 `readonly` 那一档没有任何理由把它摘掉,而 server / CLI 上
     * 「这个工作树此刻改了什么」是一句照样答得出、也照样有人问的话。
     *
     * 副作用要说清:挂上即自动多一只 `git` 工具(`catalog-sync`)。模型用它比
     * `bash git status` 拿到的是结构化的表,而且不必过一次 `bash` 的权限。
     */
    kernel.mount(new GitResourceProvider()),
  ]
  /*
   * K3-b —— 音乐,**只在 `full` 档**(理由写在 `MountBuiltinResourcesOptions.tier`
   * 那一格上)。
   *
   * 两次 push 的顺序是有意的:退订先 push、注销后 push,于是逆序跑的时候是
   * 「先摘掉这个 scheme(等在飞收场)、再退掉 now-playing 那条订阅」——§10.2
   * 「不许摘了之后 apply 还在写」的另一半:也不许摘了之后还有事件往一台已经没人
   * 听的 hub 上发。`ResourceProvider` 没有 detach 钩子,所以这一步归登记方收。
   */
  if (options.tier === 'full') {
    const music = createMusicResourceProvider()
    disposers.push(() => music.dispose(), kernel.mount(music))
  }
  return async () => {
    for (const dispose of [...disposers].reverse()) await dispose()
  }
}
