import {
  permissionGrantsRouter,
  type ListPermissionGrantsResponse,
  type PermissionGrantMutationResponse,
} from '@shared/ipc/permission-grants'

/**
 * **授权账页**(已经记下来的许可)与 core 之间的那一层端口。
 *
 * 判例与 `agents-port.ts` / `chat-port.ts` 逐条相同:形状是**平台调用面的子集**,
 * 不是新契约,存在的唯一理由是可测 —— 设置页那一节的判据(按 `app` 分组、撤销的
 * 就地更新与回滚)全是纯逻辑,不该为了测它去起一台 core。
 *
 * ── 为什么它与权限卡不共一条端口 ──────────────────────────────────────────
 * 两件事、两个域:卡问的是**引擎此刻在等什么**(`permission` 域,读引擎内存里的
 * 活状态,归 `chat-port.ts` —— 判据是「谁按下它」,答卡的手在聊天区);账页问的是
 * **已经记下了什么**(`permissionGrants` 域,读落盘的 grant 表,手在设置页)。
 * 那两个域在 `@shared/ipc` 里本来就是分开的两只文件,理由写在 `permissions.ts`
 * 的域注里(「授权账页(列/撤/清)不在这里」)。
 */
export interface PermissionGrantsPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  /**
   * 整份账页。**不带任何筛选参数** —— 设置页那一节说的是「这台机器上记下过什么」,
   * 而 `sessionId` / `workspaceRoot` 那两格是「只看某一条会话 / 某一棵树」的问法,
   * 这一节不问那个问题;夹紧宿主上的 `userId` / `workspaceId` 以 context 为准
   * (契约上写着请求体里的同名字段被忽略),所以填了也是白填。
   */
  list(): Promise<ListPermissionGrantsResponse>
  /** 撤一条。整应用一键撤 = 逐条调它(后端没有批量口,壳不假装有)。 */
  revoke(id: string): Promise<PermissionGrantMutationResponse>
}

let port: PermissionGrantsPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configurePermissionGrantsPort(next: PermissionGrantsPort | undefined): void {
  port = next
  pending = undefined
}

async function realPort(): Promise<PermissionGrantsPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const api = client.api(permissionGrantsRouter)
  return {
    ready: () => whenConnected(),
    list: () => api.list({}),
    revoke: (id) => api.revoke({ id }),
  }
}

let pending: Promise<PermissionGrantsPort> | undefined

export function permissionGrantsPort(): Promise<PermissionGrantsPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
