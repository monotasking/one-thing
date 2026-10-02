/**
 * 凭证的**写回目标**(批 B6 立,批 8 归一)——「这次登录/刷新出来的 token 该落到哪儿」。
 *
 * ## 为什么需要这个东西
 *
 * 批 B3 起 provider 凭证住在 `workspaces/<id>/credentials.json` 的池里;OAuth 的每一条
 * 读写路径都带一个**目标**参数:授权/交换/刷新的逻辑一行未动,只有「存到哪儿、从哪儿取」
 * 被参数化了。
 *
 * ## 批 8(`docs/design/subscription-accounts-2026-09.md` §8):目标只有一种
 *
 * 从前还有第二种目标 `{kind:'settings'}`,指 `<store>/oauth-tokens.json` —— **一家一把**的
 * 单槽。spaceId 缺席 / 非法 / 等于默认空间一律归到它,于是默认空间的第二次登录盖掉第一次,
 * 而壳从不带 spaceId,**在哪个空间登录都落进那一把**(用户 09-26 报障「添加账号会覆盖上一个
 * 账号」)。现在:
 *
 *  - 目标恒为 `{kind:'space', spaceId, entryId?}`;spaceId 缺席(老调用方 / CLI)或非法 =
 *    **默认空间**那一池。默认空间不再是特例。
 *  - `entryId` 缺席在**登录**里表示「追加一条新 entry」(同一身份再登一次 = 更新那一条,
 *    判据在 `space-token-store.ts` 的 `oauthTokenIdentity`);在**读 / 刷新 / 退出**里表示
 *    「这一池的第一个可用账号」(兼容口,服务在动手之前先把它落成具体的 entryId)。
 *  - 单槽文件只剩一次性归位(`backend/runtime/providers/space-config-migration.ts`
 *    `migrateOAuthSlotToDefaultSpace`)读它;读路不再回落。
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

export type OnethingCredentialTarget = OnethingSpaceCredentialTarget

/** 缺省目标:默认空间那一池、不指名哪一条。老调用方(不带 spaceId)与 CLI 落在这里。 */
export const DEFAULT_CREDENTIAL_TARGET: Readonly<OnethingSpaceCredentialTarget> = Object.freeze({
  kind: 'space',
  spaceId: DEFAULT_SPACE_ID,
})

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
  const resolved = isSpaceCredentialTarget(target) ? target : DEFAULT_CREDENTIAL_TARGET
  return `space:${resolved.spaceId}:${resolved.entryId ?? '*'}`
}

/** 单飞锁 / 流程表的键:provider × 目标。 */
export function credentialRefreshKey(
  providerId: string,
  target: OnethingCredentialTarget | undefined | null,
): string {
  return `${providerId}::${credentialTargetKey(target)}`
}

/**
 * 门口归一。spaceId 缺席或非法 = **默认空间**(批 8):spaceId 会成为
 * `workspaces/<id>/` 的路径片段(spaces/types.ts 的同一条理由),所以非法值绝不进路径;
 * 而「没说哪个空间」从前就等于默认空间,只是那时它的落点是单槽,现在是默认空间的池。
 */
export function normalizeCredentialTarget(
  input:
    | (Partial<OnethingSpaceCredentialTarget> & { spaceId?: string })
    | OnethingCredentialTarget
    | undefined
    | null,
): OnethingSpaceCredentialTarget {
  const raw = (input ?? {}) as { spaceId?: string; entryId?: string; label?: string }
  const spaceId = raw.spaceId && isValidSpaceId(raw.spaceId) ? raw.spaceId : DEFAULT_SPACE_ID
  const entryId = typeof raw.entryId === 'string' ? raw.entryId.trim() : ''
  const label = typeof raw.label === 'string' ? raw.label.trim() : ''
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
 * 没有标记(env / 从不问凭证的家)= 默认空间、不指名条目。
 */
export function credentialTargetFromSpaceMarker(
  marker: { spaceId?: string; entryId?: string } | undefined | null,
): OnethingSpaceCredentialTarget {
  return normalizeCredentialTarget({ spaceId: marker?.spaceId, entryId: marker?.entryId })
}
