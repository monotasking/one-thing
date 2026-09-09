/**
 * 在 RPC 边界铸一次主体(原子 K2a,`docs/design/atom-2026-09.md` §9 K2)。
 *
 * ## 这不是一次新的身份设计
 *
 * 它做的事只有一件:**把 `turn-principal.ts` 已经成立的那套次序,在 RPC 这一侧
 * 复述一遍**。引擎那一侧(`runtime/src/engine/turn-principal.ts`)每个回合铸一次
 * 主体,规则是「能证明的才认,证不出来就最小权限」;RPC 这一侧从前**根本没有主体**
 * ——`RpcDispatchContext` 只有 `transport` / `ownerUid` / `workspaceId` / `callerId` /
 * `sandboxRoot`,而管线(`core/toolkit` 的 `ToolRunner`)要求每条 `Invocation` 带一个
 * `Principal`。K1 把这一条明确留了账:「`RpcDispatchContext` 无 `Principal`,需要在
 * RPC 边界一次性铸主体的规则(与 09-03 搁置的凭证级主体同一片地,**别顺手拍板**)」。
 *
 * 所以这只文件**只用今天已经成立的判据**,一条新的都不发明:
 *
 *  1. `isHostLocallyTrusted()` —— 本机可信宿主(桌面内嵌 HTTP 面、回环 server)。
 *     它已经是六个域共用的那一问(`server/host-trust.ts`,B2)。可信 = 这台机器上的
 *     那个人 = `localUserPrincipal()`,与 `turn-principal.ts` 最后那句
 *     「没有渠道身份撑着的,就是桌面前面的那个人」逐字同义。
 *  2. `context.ownerUid` —— 已经过了那台宿主自己的认证。宿主铸的、永远不从信封上读
 *     (`RpcDispatchContext` 的头注释就是这条规矩的正本)。
 *  3. 都没有 → **抛**。
 *
 * ## 第三条为什么是抛,不是回落到本机用户
 *
 * 因为回落就是提权。一个既不在本机可信面上、又没通过认证的调用方,如果拿到的是
 * `localUserPrincipal()`,它得到的是桌面主人的全部授权范围 —— 与
 * `turn-principal.ts` 头注释里那句「一个继承默认 agent 全部可达范围的兜底不是兜底,
 * 是绕过」是同一句话,也是 `systemPrincipal` 存在的理由。
 *
 * **读也不许。** 检索那条判例已经把话说死了:授权是**查询输入**,不是事后过滤
 * (`docs/design/search-index-2026-09.md`)。一个没有主体的读,压根算不出该给它看
 * 哪个范围;先读出来再想办法遮住,是把范围算错的那一种做法。
 *
 * ## 这里**没有**拍的
 *
 * 凭证级主体、作用域 token、「有 token ≠ 全权限」那一整片地,09-03 用户已经明确
 * 搁置。这只文件不碰它:它既没有新的身份来源,也没有新的权限维度,只是把两个
 * 既有判据按既有次序问一遍,并在都答不上来时诚实地说不。
 */
import {
  localUserPrincipal,
  type Principal,
} from '@onething/core/permission'
import type { RpcDispatchContext } from '@shared/ipc/rpc.js'
import { isHostLocallyTrusted } from '../server/host-trust.js'

/**
 * 这个调用方说不出自己是谁。
 *
 * 具名的错,不是一句字符串:判定读类名(`core/tools/abort.ts` 那条判例 —— 靠消息
 * 文本分类,迟早把一次失败洗成一次别的东西)。
 */
export class RpcPrincipalUnavailableError extends Error {
  constructor() {
    super(
      'This caller has no identity: the host is not locally trusted and the request carries no authenticated owner.',
    )
    this.name = 'RpcPrincipalUnavailableError'
  }
}

/**
 * 谁在做这次调用。见文件头 —— 三条次序,第三条是抛。
 *
 * 纯函数:它不读环境、不查表、不缓存,输入只有 context(加上进程级那一句
 * 「这台宿主可不可信」,而那是装配时声明的常量,不是请求带来的东西)。
 */
export function principalOf(context: RpcDispatchContext): Principal {
  if (isHostLocallyTrusted()) return localUserPrincipal()

  const userId = context.ownerUid
  if (userId) {
    return context.workspaceId
      ? { kind: 'user', userId, workspaceId: context.workspaceId }
      : { kind: 'user', userId }
  }

  throw new RpcPrincipalUnavailableError()
}
