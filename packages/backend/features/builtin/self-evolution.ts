/**
 * 自进化 feature —— C4 第一档(`docs/design/cordis-adoption-2026-08.md` §7)。
 *
 * 它把 C0 立起来的可逆注册基座**交到模型手里**:`feature_mount` /
 * `feature_unmount` / `feature_inspect` 三个会话工具,让模型在一次对话里现场挂
 * 载、卸载、自省一件功能,免重启。对标 dsh 的 cordis_define/run/stop/inspect
 * 四件套 —— 我们少一个 `define`,是因为「写文件」这件事本仓已经有 write/edit
 * 两个工具在干,再造第三个入口只会分叉。
 *
 * ── 场景门(2026-08-18 工具梳理)───────────────────────────────────────
 *
 * 三个工具照旧由本 feature 注册,但**不再出现在普通对话的工具面上**:它们挂在
 * 内置 skill `onething-self-evolution`(`resources/skills/`,默认关闭)名下 ——
 * 它们的 `visibleIn` 只在该 skill 于本回合启用时让它们进请求(旧路那张集中式
 * `SKILL_SCENE_TOOLS` 减法表已随 R4b 删除)。使用说明也从系统提示词搬进了那份 SKILL.md(原 `self-evolution.md`
 * 段落已删):进场景 = 用户在 设置 → Skills 打开它。
 *
 * ── 自己也是 feature(吃自己狗粮)────────────────────────────────────────
 *
 * 这三个工具**不是**加在三档目录(`app/toolkit/catalog.ts`)里的第 21 只内置工具,
 * 而是一个 feature 的注册项。理由是 D1 那句质问的直接推论:自进化能力如果自己
 * 走特权路进内核,那它证明的就不是「feature 基座够用」,而是「基座之外还有一
 * 条更方便的路」。它挂在名册里、`feature_inspect` 看得见自己、卸载自己也能把
 * 三个工具一起摘干净 —— 这是本期唯一有说服力的自证。
 *
 * ── C0 三条 cordis 语义地雷,逐条对照(§5.5.3)────────────────────────────
 *
 * 1. **并行 + 吞错的 `_unload`**。本 feature **有真实的顺序契约**(轨迹那个
 *    被试品没有):卸载时必须**先**把模型挂进来的那批动态 feature 全部收掉,
 *    **再**注销三个工具。反过来会留下一批没人管得着的动态 feature —— 控制面
 *    没了,东西还在跑。按 §5.5.3 第一条的处方,整趟清扫收进**同一个**
 *    `registerDisposer`(cordis 只在单个 effect 内部保证逆序 + 串行);而它在
 *    注册顺序上排**最后**,于是适配层的逆序解绕让它**第一个**跑。
 *    C2 的 G8 给 C3 的建议,在这里第一次被真正执行。
 * 2. **`apply` 抛错 = fiber FAILED**。本 feature 的 `mount` 继续用适配层接住的
 *    默认(首错原样抛给装配方)。但**动态 feature 的 mount 失败不走这条**:那
 *    是模型写的代码出错,不是接线 bug,所以由 `feature_mount` 接住并翻译成教学
 *    文本 —— 一个模型写错的插件绝不该让宿主装配失败。
 * 3. **`ctx.effect()` 在 UNLOADING 期抛 `INACTIVE_EFFECT`**。本 feature 的
 *    dispose 路径**不注册任何东西**,并且用 `sealed` 闩住:清扫一开始就把
 *    `feature_mount` 封死,免得一次在飞的工具调用在 UNLOADING 期间往回挂。
 *    (三个工具的注销发生在清扫之后,那之间有一条窄缝,闩住的就是它。)
 *
 * ── 安全:D1 授信纪律在工具档的映射 ──────────────────────────────────────
 *
 * 「模型现场写的 feature 走同一道授信门」(kernel-shrink §1 D1)。落到工具档
 * 是三条,都不是新机制:
 *
 * - **每挂一次问一次,且永不可记住**。`feature_mount` 声明的 effect kind 是
 *   `capability_change` —— core 的 `NEVER_GRANTABLE_TYPES` 里就它一个,所以
 *   「以后都允许」这个选项在权限卡上根本不出现(`permission-ledger.ts` 已按同
 *   一判据不给授权行)。挑这个 kind 不是凑数:它的定义原文是「Repointing
 *   something the system itself acts on … it changes what the assistant can
 *   reach, so it is never silent and never grantable」,而挂载一个 feature 正是
 *   **改变助手够得着什么**的那件事。**没有新增 effect kind** —— 加一个
 *   `feature_mount` kind 就是 D3 第一条禁止的「功能形状的洞」。
 * - **不入自动放行类**。`autoExecute: false` + `permissionGuard:
 *   'permission-gated'`,与 `edit` 同档(`edit` 是本仓写盘工具里最严的那个)。
 * - **只从一个目录加载**。`<store>/features-dev/<id>/` 之外一律拒绝;`entryPath`
 *   夹进该 feature 自己的目录(不是夹到 features-dev 根就算数)。夹紧用的是
 *   `rpc/sandbox.ts` 的 `isPathInside` —— 与联网宿主的 RPC 沙箱同一份实现,
 *   而不是再抄一遍 `startsWith`(那正是 skills 拒迁时记下的教训)。
 *
 * 另有一道**宿主档门**:三个工具只在「已经有 bash 的宿主」上注册。判据不是
 * 「是不是桌面」(那是宿主探测,装配层不许干),而是一句可证的等价陈述 ——
 * 挂载一个 feature 与跑一条 shell 是同一量级的能力,一个连 bash 都不给的宿主
 * (`readonly` 档,联网 server 的降级形态)当然也不该给这个。full 与 headless
 * 两档有 bash,readonly 档没有,门自然落在正确的位置,且**默认拒绝**:目录还没
 * 装上时 `catalog.has('bash')` 为 false,一个字都不注册。
 *
 * ── 教学式报错(dsh 判例)──────────────────────────────────────────────
 *
 * 每一条失败路径的返回文本都必须回答两个问题:**发生了什么** + **下一步调什
 * 么**。报错是写给模型看的操作指南,不是写给日志的墓碑。目录不存在时给出创建
 * 指引与最小模板,但**工具自己不 mkdir** —— 与 E0 事件日志同纪律:凭空造目录
 * 会把「这个宿主没配过这件事」这条信息抹掉。
 *
 * 三个工具的实现住在 `app/toolkit/builtin/feature-{mount,unmount,inspect}.ts`,
 * 共享的动态挂载表住在 `feature-runtime.ts`;本文件只剩「什么时候装、什么时候
 * 摘」这一件事。
 *
 * import 零副作用:本模块加载只产出一个常量对象,工具注册发生在
 * `mountFeature` 真的调用 `mount` 的那一刻
 * (`app/__tests__/import-side-effect-free.test.ts`)。
 */
import { getToolkitCatalog } from '@onething/runtime/toolkit'
import { FeatureToolRuntime, registerFeatureTools } from '../../toolkit/catalog.js'
import type { FeatureContext, FeatureDefinition } from '../index.js'

/**
 * 三个工具 + 它们共享的动态挂载表,全部**建在 `mount` 里**。
 *
 * 表的生命周期 = feature 的生命周期,这不是风格问题:表若是模块级的,一次
 * 卸载再挂载就会捡到上一轮的残留记录(而那些记录指向的 unmount 早已失效)。
 *
 * R4b:三件套只剩目录这一本册子(旧 registry 那一半随旧树删除)。纪律一个字
 * 没变:
 *  - 宿主档门 = `catalog.has('bash')`(这台宿主给不给跑 shell);
 *  - 注册顺序 = 解绕的逆序,所以清扫的 disposer 在三只工具**之后**注册,
 *    卸载时第一个跑;
 *  - 那张动态挂载表的寿命 = 这次 mount 的寿命(`FeatureToolRuntime` 在这里 new)。
 *
 * 目录没装上(宿主没走 backend)时一个字都不注册 —— 与旧路"注册表没起来就
 * 什么都不装"同一个结果。
 */
function mountSelfEvolution(ctx: FeatureContext): void {
  const catalog = getToolkitCatalog()
  if (!catalog) return
  const handle = registerFeatureTools(catalog, new FeatureToolRuntime())
  // 档门拒绝(目录里没有 bash)= 一个字都不注册。
  if (!handle.registered) return
  ctx.registerDisposer(() => { handle.unregister() })
  ctx.registerDisposer(() => handle.runtime.sweep())
}

export const selfEvolutionFeature: FeatureDefinition = {
  id: 'self-evolution',
  mount: mountSelfEvolution,
}
