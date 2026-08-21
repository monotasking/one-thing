/**
 * 「我」这一侧的身份,单一属主(docs/design/agent-dm-user.md §2.2)。
 *
 * agent 的身份有 `findAgent` 收口,用户这一侧此前没有属主 —— 于是模型面的
 * `userLabel` 参数没人传、renderer 署名写死「我」、dm 根本认不出用户。三条链
 * 各自拼一遍 `settings.userProfile?.name || '用户'` 的下场是可预见的:改名只在
 * 其中两处生效,而哪两处取决于谁最后被改。
 *
 * 纪律与 `dm.ts` 的形态判定同款:**全仓禁止别处直接读 `settings.userProfile`
 * 拼默认值**,消费方一律走 `resolveUserIdentity()`。
 *
 * 每次现取而不做跨模块镜像:settings 缓存本来就是同步热路径(`getSettings()`
 * 不落盘、不 await),而一份镜像意味着改名后要有人负责让它失效 —— 那个"有人"
 * 正是这类 bug 的出处。
 */
import {
  COLLAB_USER_DEFAULT_LABEL,
  normalizeCollabUserHandle,
} from '@onething/runtime/collab'
import * as store from '../store.js'

export interface CollabUserIdentity {
  /** 模型面与 UI 署名用的显示名。 */
  label: string
  /** @ 与 dm 的定位符。永远非空 —— 没配置也有 'user' 兜底。 */
  handle: string
  avatar?: string
  avatarImage?: string
}

/**
 * 三处 builder 共用的注入片段(房间系统提示词 / 意愿判定 / 花名册)。
 *
 * 存在的理由只有一个:两个调用点各写一遍 `{ userLabel: …, userHandle: … }`,
 * 下一次多一个字段时必定漏一处 —— 而漏的那一处会安静地退回「用户」。
 */
export function collabUserPromptFields(): { userLabel: string; userHandle: string } {
  const identity = resolveUserIdentity()
  return { userLabel: identity.label, userHandle: identity.handle }
}

/** 读 settings 缓存,现取。缺省链:label→「用户」、handle→'user'。 */
export function resolveUserIdentity(): CollabUserIdentity {
  const profile = store.getSettings()?.general?.userProfile
  const label = profile?.name?.trim() || COLLAB_USER_DEFAULT_LABEL
  const identity: CollabUserIdentity = {
    label,
    handle: normalizeCollabUserHandle(profile?.handle),
  }
  const avatar = profile?.avatar?.trim()
  if (avatar) identity.avatar = avatar
  const avatarImage = profile?.avatarImage?.trim()
  if (avatarImage) identity.avatarImage = avatarImage
  return identity
}
