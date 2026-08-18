/**
 * 凭证的**写回目标**(批 B6)——「这次登录/刷新出来的 token 该落到哪儿」。
 *
 * ## 为什么需要这个东西
 *
 * 批 B3 起,非 default 空间的 provider 凭证住在
 * `workspaces/<id>/credentials.json` 的池里;而 OAuth 的 token 在此之前只有
 * **一个**落点:`<store>/oauth-tokens.json`,按 providerId 一把钥匙。
 * 「同一个 provider 在两个空间各登一个账号」在那种形状下根本表达不出来 ——
 * 后登的那次会直接盖掉前一次。
 *
 * 所以 OAuth 的每一条读写路径都被加了一个**目标**参数,而不是复制一条流程:
 * 授权/交换/刷新的逻辑一行未动,只有「存到哪儿、从哪儿取」被参数化了。
 *
 *  - 缺省 / `{kind:'settings'}` = 今天的行为(`oauth-tokens.json`,默认空间的
 *    凭证层就是它)。**default 空间一个字节都不改。**
 *  - `{kind:'space', spaceId, entryId?}` = 落进那个空间的凭证池。`entryId` 缺席
 *    表示「追加一条新 entry」(多账号:同一个 provider 允许多条 oauth entry),
 *    由 store 在写入时分配并回报真正的 id。
 *
 * ## 这个 key 还是刷新单飞锁的锁名(盲点 5)
 *
 * 并发 refresh 会互相作废 refresh token(rotation 语义下,第二次拿着已被消费的
 * refresh token 去换,换回来的是一个错误,而第一次的结果可能已经被覆盖)。
 * 单飞锁的粒度必须**恰好等于 token 的存放位置**:同一个 provider 在两个空间是
 * 两把不同的钥匙,锁在一起会让 A 空间的刷新把 B 空间的调用挡在门外并返回
 * **别人的 token**。所以 key = providerId × target,见 `credentialRefreshKey`。
 */

import { DEFAULT_SPACE_ID, isValidSpaceId } from '../spaces/types.js'

export interface OnethingSpaceCredentialTarget {
  kind: 'space'
  spaceId: string
  /** 命中的池条目。缺席 = 追加一条新 entry(登录新账号)。 */
  entryId?: string
  /** 新建 entry 时的展示名。只在 `entryId` 缺席时用得上。 */
  label?: string
}

export interface OnethingSettingsCredentialTarget {
  kind: 'settings'
}

export type OnethingCredentialTarget =
  | OnethingSettingsCredentialTarget
  | OnethingSpaceCredentialTarget

export const SETTINGS_CREDENTIAL_TARGET: OnethingSettingsCredentialTarget = { kind: 'settings' }

export function isSpaceCredentialTarget(
  target: OnethingCredentialTarget | undefined | null,
): target is OnethingSpaceCredentialTarget {
  return target?.kind === 'space'
}

/**
 * 目标的稳定字符串形式。用于:单飞锁的 key、登录流的按目标索引。
 *
 * `entryId` 参与 key —— 同一个空间的两条 oauth entry(两个账号)各自刷新,
 * 合成一把锁会让第二个账号拿到第一个账号的 token。
 * `entryId` 缺席(新登录)用 `*`:那一路还没有 entry,同一个空间同一个 provider
 * 同时开两个新登录本来就该串起来。
 */
export function credentialTargetKey(
  target: OnethingCredentialTarget | undefined | null,
): string {
  if (!isSpaceCredentialTarget(target)) return 'settings'
  return `space:${target.spaceId}:${target.entryId ?? '*'}`
}

/** 单飞锁 / 流程表的键:provider × 目标。 */
export function credentialRefreshKey(
  providerId: string,
  target: OnethingCredentialTarget | undefined | null,
): string {
  return `${providerId}::${credentialTargetKey(target)}`
}

/**
 * 门口归一。**非法 spaceId 一律落回 settings** —— spaceId 会成为
 * `workspaces/<id>/` 的路径片段(spaces/types.ts 的同一条理由),而
 * default 空间的凭证层本来就是 settings,两件事在这里合成一句。
 */
export function normalizeCredentialTarget(
  input:
    | (Partial<OnethingSpaceCredentialTarget> & { spaceId?: string })
    | OnethingCredentialTarget
    | undefined
    | null,
): OnethingCredentialTarget {
  if (!input) return SETTINGS_CREDENTIAL_TARGET
  if ('kind' in input && input.kind === 'settings') return SETTINGS_CREDENTIAL_TARGET
  const spaceId = (input as { spaceId?: string }).spaceId
  if (!spaceId || !isValidSpaceId(spaceId) || spaceId === DEFAULT_SPACE_ID) {
    return SETTINGS_CREDENTIAL_TARGET
  }
  const entryId = (input as { entryId?: string }).entryId?.trim()
  const label = (input as { label?: string }).label?.trim()
  return {
    kind: 'space',
    spaceId,
    ...(entryId ? { entryId } : {}),
    ...(label ? { label } : {}),
  }
}

/**
 * 从 B3 盖在 providerConfig 上的运行期标记换成目标。
 *
 * 这是「解析点有 sessionId、鉴权点没有」那条老规矩的延续(B3 勘误 2):
 * 判定在 `getEffectiveProviderConfig` 做一次,结论顺着 config 往下走,
 * 鉴权点读它就知道该去哪儿取 token —— 不必再反查一遍会话属于哪个空间。
 */
export function credentialTargetFromSpaceMarker(
  marker: { spaceId?: string; entryId?: string } | undefined | null,
): OnethingCredentialTarget {
  if (!marker?.spaceId) return SETTINGS_CREDENTIAL_TARGET
  return normalizeCredentialTarget({ spaceId: marker.spaceId, entryId: marker.entryId })
}
