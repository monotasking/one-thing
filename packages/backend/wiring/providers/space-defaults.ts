/**
 * per-space「默认 provider / 默认模型」的宿主注入函数(批 B9;C2 换源)。
 *
 * 与 `space-credentials.ts` 是同一条老规矩的第三次复用:**解析点有 sessionId,
 * 存储形态只有装配层知道**。产品层的 `getEffectiveOnethingProviderConfig` 拿得到
 * sessionId,但它不认识「会话属于哪个空间」这件事的落盘形态;装配层认识,于是
 * 由它把「这个空间的默认选择」递进那条唯一的解析缝。
 *
 * **C1 起 default 不再是特例**(默认搬进了空间层);**C2 起源头换成
 * `workspaces/<id>/providers.json`** —— 默认 provider 就是那份设置的
 * `provider`,默认模型是 `providers[provider].model`。overlay 里 B9 写的
 * `defaultSelection` 已在 C2 迁移里并进 providers.json,读侧不再看它。
 *
 * 设计见 `docs/design/workspace-spaces-2026-08.md` 批 B9 与
 * `docs/design/workspace-provider-config-review-2026-08-18.md` §7 / C2。
 */

import { readSpaceProviderSettings } from '@onething/runtime/spaces/provider-settings'
import type { CoreSpaceDefaultSelection } from '@onething/runtime/providers'
import { resolveSessionSpaceId } from '../../stores/sessions.js'

/** 某个空间表达过的默认选择。没表达过 = `undefined`(解析链落到「没有默认」那支)。 */
export function resolveSpaceDefaultSelection(
  spaceId: string | undefined | null,
): CoreSpaceDefaultSelection | undefined {
  const settings = readSpaceProviderSettings(spaceId)
  const provider = settings?.provider?.trim()
  if (!provider) return undefined
  const model = settings?.providers[provider]?.model
  return typeof model === 'string' && model.trim()
    ? { provider, model: model.trim() }
    : { provider }
}

/**
 * 「这条会话所在空间的默认选择」。缺席(这个空间还没表达过)= `undefined`,
 * 解析链因此落到「没有默认」那一支 —— 迁移之后这只发生在全新安装上。
 */
export function resolveSessionSpaceDefaultSelection(
  sessionId: string | undefined | null,
): CoreSpaceDefaultSelection | undefined {
  return resolveSpaceDefaultSelection(resolveSessionSpaceId(sessionId))
}
