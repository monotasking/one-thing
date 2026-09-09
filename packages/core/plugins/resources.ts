/**
 * 插件对**原子**的投影(K4-b,`docs/design/atom-2026-09.md` §4 那张表的
 * 「调度 / 网关 / 插件」一行:「都是 `Principal` 不同的 `do`」)。
 *
 * 一句话:插件不再需要宿主为它手写一个动词。今天 `api.sendMessage` /
 * `api.sessions.peek` 是「会话」这一种资源的两只手写口,`registerIMConnector` /
 * `registerSearchProvider` 是两张手写的注册表 —— 每开一种能力就多一组方法、多一处
 * 声明门、多一格熔断。三个动词把这件事收成一次:**读、做、看**,能力由自述表说,
 * 内核不认识任何 scheme,插件面自然也不认识。
 *
 * ## 为什么是三条权限而不是一条
 *
 * 因为它们的代价差着量级,而装前披露要念给用户听的正是这个差别:
 *
 *  · `resources:read` —— 只查询。读无效果、不落审计、不吃预算(`ReadOutcome` 的
 *    文件头写着这条),它的风险是**看见**,不是改动;
 *  · `resources:do`  —— 带副作用的变更,每一次都进权限管线、每一次都落审计。
 *    它是这三条里唯一能让用户的东西**变样**的那一条;
 *  · `resources:watch` —— 订阅事实流。它既不看得见内容也改不了东西,但它是**持续
 *    在场**的那一条(读要主动调,看是被动收),所以它自己一格。
 *
 * 合成一条 `resources:*` 的写法看起来更省,但那样用户点头的是一句他读不出代价的话
 * ——「这个插件能操作资源」既可能是查一眼标题,也可能是删掉一条会话。
 *
 * ## 这只文件是叶子
 *
 * 与 `sessions.ts` / `llm.ts` / `deep-link.ts` 同一条:零运行期依赖(下面两条
 * `import type` 在编译后什么都不剩),渲染层按子路径引它渲染装前披露。判定逻辑
 * (声明门、熔断、超时、主体)分别在 `api-builder.ts` 与装配层 —— 这里只有词汇。
 */

import type { ResourceEvent } from '../resource/events.js'
import type { ReadOutcome } from '../resource/read-outcome.js'
import type { Outcome } from '../toolkit/outcome.js'

/* ── 声明门(manifest contributes.permissions)───────────────────────────── */

/** 读一个地址上的一条读法。纯查询,无副作用。 */
export const PLUGIN_PERMISSION_RESOURCES_READ = 'resources:read'
/** 在一个地址上做一件事。**带副作用**,每一次都过权限管线并落审计。 */
export const PLUGIN_PERMISSION_RESOURCES_DO = 'resources:do'
/** 订阅一个地址前缀上的事实流。 */
export const PLUGIN_PERMISSION_RESOURCES_WATCH = 'resources:watch'

/**
 * 本期新增的三个权限枚举。
 *
 * 与 N1 那三条同规:`contributes.permissions` 本身仍是自由字符串数组(未知值向前
 * 兼容地被忽略),但**这三个名字是被消费的** —— 未声明即拒绝。
 */
export const PLUGIN_RESOURCE_PERMISSIONS = [
  PLUGIN_PERMISSION_RESOURCES_READ,
  PLUGIN_PERMISSION_RESOURCES_DO,
  PLUGIN_PERMISSION_RESOURCES_WATCH,
] as const

export type PluginResourcePermission = (typeof PLUGIN_RESOURCE_PERMISSIONS)[number]

/**
 * 装前披露的人话文案。
 *
 * 三句话都刻意**不提「资源」这个词** —— 它是我们的架构词汇,不是用户的。用户要
 * 听懂的是「它能看什么」「它能改什么」「它一直在旁边听着」。
 */
export const PLUGIN_RESOURCE_PERMISSION_NOTES: Record<PluginResourcePermission, string> = {
  [PLUGIN_PERMISSION_RESOURCES_READ]:
    'can look up things in the app (sessions, folders, what is playing) without changing them',
  [PLUGIN_PERMISSION_RESOURCES_DO]:
    'can act on things in the app (rename, delete, play, open) — every action is recorded',
  [PLUGIN_PERMISSION_RESOURCES_WATCH]:
    'can watch things in the app change while it runs',
}

/* ── 预算 ─────────────────────────────────────────────────────────────────── */

/**
 * 一次 `read` / `do` 的墙钟上限。
 *
 * **这里只有数字,没有实现**:超时不由插件面自己写一个 `Promise.race`,而是把
 * `AbortSignal.timeout(...)` 接进内核的 `ResourceCallOptions.signal` —— 内核已经
 * 把三个取消源合成一处(关机 / 卸载 / 调用方),再写第二套计时器就是第四个源,
 * 而且是唯一一个下游看不见的那种:`race` 输的那一半还在跑,`apply` 还在写。
 *
 * 30s 与 `PLUGIN_LLM_COMPLETE_TIMEOUT_MS` 不是一个量级的事:那边是一次模型往返,
 * 这边是本机的一次读或一次写。取 30s 是因为 `do` 可能停在一张**权限卡**上等人点头
 * (`session_destructive` 那一族),而人抬手要几秒 —— 比人慢的闸才不会把正常操作
 * 判成故障。
 */
export const PLUGIN_RESOURCE_CALL_TIMEOUT_MS = 30_000

/* ── 三个动词 ─────────────────────────────────────────────────────────────── */

/**
 * `api.resources` —— 读、做、看。
 *
 * ## 结局用的是内核自己的词
 *
 * `read` 回 `ReadOutcome`(四支)、`do` 回 `Outcome`(五支),**不另立一套插件专用
 * 的结果类型**。理由是这两个联合已经把「这次调用发生了什么」答完了,而且答的是
 * 与界面、AI、CLI 逐字相同的那一份 —— 再翻译一层的下场是同一次拒绝在插件眼里叫
 * 一个名字、在审计里叫另一个名字。
 *
 * 于是**声明门的拒绝也用同一个词**:没声明 `resources:do` 拿到的是
 * `Outcome.denied('resources:do …')`,与被用户拒掉的那一次同形。这是有意的 ——
 * 对插件而言「规则不让我做」就是一件事,它不该为「哪一层的规则」写两个分支
 * (与 `sendMessage` 的 `reason:'not-declared'` 同一条纪律:拒绝要结构化、从不抛错)。
 *
 * ## 三个动词都不抛错
 *
 * 一个也不抛。`llm.complete` 抛是因为它没有结局类型可回;这里有。
 */
export interface PluginResourcesApi {
  /**
   * 读一件事。`resources:read` 声明门。
   *
   * `ref` 是地址(`<scheme>:<path>`),`name` 是自述 `reads` 里的读法名。
   * 有哪些 scheme、每个 scheme 有哪些读法,插件自己不必硬编码 —— 那是
   * `resources` 元工具与 `resource.describe` 那条路答的问题。
   */
  read(ref: string, name: string, query?: Record<string, unknown>): Promise<ReadOutcome>
  /**
   * 做一件事。`resources:do` 声明门。
   *
   * 主体是 `system:plugin:<id>`(见装配层),所以它拿到的授权面与桌面前的那个人
   * **不同**:同一条做法在用户手里可能不问,在插件手里会进权限卡。
   */
  do(ref: string, op: string, params?: Record<string, unknown>): Promise<Outcome>
  /**
   * 看住一个地址前缀。`resources:watch` 声明门。返回退订函数。
   *
   * 前缀只有两种合法形状(`scheme:` / `scheme:path/`)。插件不调退订也没关系:
   * 它被登记进 state 的订阅账,拆除时一并撤 —— 与 `api.on` 逐字同一条。
   */
  watch(prefix: string, listener: (event: ResourceEvent) => void): () => void
}
