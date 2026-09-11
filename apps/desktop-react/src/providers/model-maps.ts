import type { ProviderConfig } from '@shared/ipc/providers'

/**
 * **按模型 id 键的那几张表**(09-11,手填模型改 id 立的件)。
 *
 * `ProviderConfig` 上有七张表的键是**模型 id**:改一个模型的 id,这七格里
 * 它那一行都得跟着搬,否则用户改完名字会发现自己填过的窗口、最大输出、
 * 思考档、能力覆盖全丢了(那正是「删了重填」今天的下场 —— 退役的 Vue 壳
 * `useProviderSettings.renameModel` 当年就是跨这几处一起迁的)。
 *
 * ── 为什么是一张表 + 一只函数,而不是七段 ────────────────────────────────
 * 七段抄的必然结局是「这张表搬了、那张忘了」,而每一段自己都跑得通、没有门
 * 看得见。所以搬的动作收成 `moveModelKey` 一只纯函数,**搬哪几张表**收成
 * 下面这张名单 —— 后端哪天再加一张按模型键的表,改的是名单里一行,
 * 不是找出七个地方各补一段。
 *
 * `satisfies readonly (keyof ProviderConfig)[]` 是这张名单的门:写错一个键名
 * 当场过不了 tsc(名单是**声明**,不是一把字符串)。
 */
export const MODEL_KEYED_TABLES = [
  'temperatureByModel',
  'maxOutputByModel',
  'contextLengthByModel',
  'thinkingByModel',
  'thinkingEffortByModel',
  'serviceTierByModel',
  'modelCapabilitiesByModel',
] as const satisfies readonly (keyof ProviderConfig)[]

export type ModelKeyedTable = (typeof MODEL_KEYED_TABLES)[number]

/**
 * 一张表里的**一格换个键**。三条出口,一条都不许合并:
 *
 *  · **没有这张表 / 表里没有旧键 → `false`** = 这一发一个字不动它。
 *    调用方据此**不把这张表放进 delta** —— `writeProviders` 是浅合并,
 *    递一张没变的表只是把同一份数据再写一遍,而递 `undefined` 会把它**删掉**。
 *    两者都不是「不动」,所以「不动」必须是第三种答案。
 *  · 搬完还有格子 → 交出新的那一份(旧键删干净、新键就位)。
 *  · 搬完空了 → `undefined` = **删整张表**。留一个 `{}` 在盘上是一句
 *    「这一型被配置过」的假话(与 `setModelOverride` 同一条守则)。
 *    今天这一支走不到(搬一格不会让表变空),它在这里是因为**判空是这张表
 *    唯一的产地** —— 把它交给七个调用点各判一次才是那种会漂开的事。
 *
 * 新键已经占着的情况这只函数不挡:它是纯搬运,「新 id 不许撞已有的」是
 * 调用方(`renameManualModel`)的校验,而那条校验看的是 `selectedModels`,
 * 不是某一张覆盖表 —— 一个早就不在列表里的陈年键不该拦住一次改名。
 */
export function moveModelKey<V>(
  table: Readonly<Record<string, V>> | undefined,
  from: string,
  to: string,
): Record<string, V> | undefined | false {
  if (!table || !Object.prototype.hasOwnProperty.call(table, from)) return false
  const next: Record<string, V> = { ...table }
  next[to] = next[from] as V
  delete next[from]
  return Object.keys(next).length > 0 ? next : undefined
}
