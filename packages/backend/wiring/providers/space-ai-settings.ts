/**
 * 「这条会话该用哪一份 provider 设置」(C2)。
 *
 * 与 `space-credentials.ts` / `space-defaults.ts` 是同一条老规矩的又一次复用:
 * **解析点有 sessionId,存储形态只有装配层知道**。产品层的解析链拿到的是一份
 * `AppSettings`,它不认识「会话属于哪个空间」;装配层认识,于是由它在把 settings
 * 递进解析链之前换好源。
 *
 * C2 之前这里没有东西可换 —— `settings.ai` 是全局一份。C2 之后
 * `getSessionSettings(sessionId)` 就是那条唯一的换源缝:引擎的两条 provider
 * 解析链都从它取 settings,于是「A 空间配的 deepseek 不会出现在 B 空间」这件事
 * 在**数据源**上就成立,不靠每个消费者各判一次。
 */

import type { AppSettings } from '@shared/ipc.js'
import { resolveSessionSpaceId } from '../../stores/sessions.js'
import { getSpaceSettings } from '../../stores/settings.js'

/** 这条会话所在空间的生效 settings。缺 sessionId / 缺归属 = default 空间。 */
export function getSessionSettings(sessionId: string | undefined | null): AppSettings {
  return getSpaceSettings(resolveSessionSpaceId(sessionId))
}

export { getSpaceSettings }
