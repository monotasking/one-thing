import { createMutation, createQuery, type Mutation } from './kernel'
import { permissionGrantsPort } from './permission-grants-port'
import { notify } from '../services/notify'
import { t } from '../i18n'
import type { PermissionGrantProjection } from '@shared/ipc/permission-grants'

/**
 * **已授权账页**的取数与撤销(应用级许可 · 壳半边,2026-09-10)。
 *
 * ── 屏幕上那一节要的形状 ──────────────────────────────────────────────────
 * 后端把账页分成两摞交出来(`sessionGrants` / `workspaceGrants`),而设置页那一节
 * 问的是「**这台机器上记下过什么**」—— 一条许可属于哪一摞是它的 `scope` 那一格,
 * 不是两张不同的表。所以这里合成一份 `PermissionGrantProjection[]`,`scope`
 * 原样带着;分组的判据是 `app`(后端在域处理器里从 `pattern` 投影出来的那一格),
 * **不是** scope。
 *
 * ── 排序在这里做完,不在渲染层 ────────────────────────────────────────────
 * 「线上形状 → 屏幕形状只投一次」(与 `agents-source` 的 `toAgentOption` 同判)。
 * 序是**新的在前**:一个人打开这一节多半是为了撤掉刚刚点错的那一条。
 */
export const permissionGrantsQuery = createQuery<readonly PermissionGrantProjection[]>(
  'permissionGrants.list',
  async () => {
    const port = await permissionGrantsPort()
    const response = await port.list()
    // `success:false` 是「后端说不行」—— 抛出去,kernel 记进 error 并**留住上一份**
    // (律②)。回一张空表会把「拉不到」画成「你一条都没授权过」,那是编。
    if (!response.success) throw new Error(response.error || 'permissionGrants.list 未成功')
    return [...(response.sessionGrants ?? []), ...(response.workspaceGrants ?? [])].sort(
      (a, b) => b.createdAt - a.createdAt,
    )
  },
)

/** 撤销的忙态格子:**唯一词表**。写路记账与钮读账共用它,两头各拼一次就是两处会漂。 */
export function revokeKey(id: string): string {
  return `revoke:${id}`
}

/** 整应用一键撤的忙态格子。与 `revokeKey` 分开:它们是两颗不同的钮上的两件事。 */
export function revokeAppKey(app: string): string {
  return `revoke-app:${app}`
}

/**
 * 撤一条许可。
 *
 * ── 就地更新,重拉对账(律①)──────────────────────────────────────────────
 * `optimistic` 当场把那一行从 query 缓存里摘掉(交出来的函数就是回滚),`settle`
 * 再 `invalidate()` 让它后台对一次账 —— 屏幕上没有「清空 → 骨架 → 重灌」那一拍。
 *
 * 失败那句话**只有这一处产地**:整应用那一路是逐条调这一只跑的,所以它砸了的时候
 * 说的是同一句(与 `agents-source` 把两口写的 try/catch 收成一只 mutation 同判)。
 */
export const revokeGrantMutation: Mutation<string, void> = createMutation<string, void>(
  'permissionGrants.revoke',
  {
    key: (id) => revokeKey(id),
    optimistic: (id) =>
      permissionGrantsQuery.patch((prev) => (prev ?? []).filter((grant) => grant.id !== id)),
    run: async (id) => {
      const port = await permissionGrantsPort()
      const response = await port.revoke(id)
      // 「后端说没成」与「这一发抛了」在这条原语里是同一件事:都得走回滚 + onError。
      if (!response.success) throw new Error(response.error || 'permissionGrants.revoke 未成功')
    },
    onError: (error) => {
      notify({
        level: 'error',
        source: 'settings.permissions',
        title: t('permissions.revokeFailed'),
        body: error.message,
        detail: error.message,
      })
    },
    settle: () => permissionGrantsQuery.invalidate(),
  },
)

/**
 * **整应用一键撤 = 逐条调上面那只**。
 *
 * 后端没有批量撤销口(`permissionGrantsRouter` 只有 `revoke` / `clearSession` /
 * `clearWorkspace` 三条,后两条撤的是**一整个作用域**,不是「这个应用的那几条」)。
 * 壳不假装有:一个应用是 `scheme × 效果类` 若干条(a50d4f99 留账)。
 *
 * 它为什么是**第二只 mutation** 而不是在组头那颗钮里就地 for 一圈:忙态。
 * `AsyncButton` 一颗钮只读一格 `pendingKey`,而组头那颗钮忙的是「这一整摞」——
 * 没有自己的格子,它就只能读整只 mutation 的粗读数,于是撤**任何一行**都会
 * 把组头那颗钮一起禁灰(律③的粒度病)。
 *
 * **串行而不是 `Promise.all`**:失败时「撤掉了几条」是一个人看得懂的答案,而并发
 * 之下它是一个随机数;顺带撤销这件事本来就不该同时开五发去挤同一张 grant 表。
 * 内层那只**不抛**(kernel 的 `run` 契约),所以中途失败不打断剩下的 —— 每一条各自
 * 回滚、各自说一句,对账那一发把真相画回来。
 */
export const revokeAppGrantsMutation: Mutation<{ app: string; ids: readonly string[] }, void> =
  createMutation<{ app: string; ids: readonly string[] }, void>('permissionGrants.revokeApp', {
    key: (input) => revokeAppKey(input.app),
    run: async ({ ids }) => {
      for (const id of ids) await revokeGrantMutation.run(id)
    },
  })

/**
 * 账页按**应用**分组。
 *
 * 一个应用可能有好几条(`scheme × 效果类`,a50d4f99 留账原话:用户点一次「始终
 * 允许」只覆盖当前这一类,换一类再弹)。`app` 缺席的那些**不是一个叫「其他」的
 * 应用** —— 它们是一条具体路径 / 一个工具名 / 一串命令的许可,压根不是应用级的
 * 东西,所以它们各自成一行、共处一节,由渲染层用一句「单条许可」领着。
 *
 * 纯函数、无 React:分组是投影,不是画画。
 */
export interface PermissionGrantGroup {
  /** 应用名(资源命名空间);`undefined` = 这一摞不是应用级许可。 */
  app?: string
  grants: readonly PermissionGrantProjection[]
}

export function groupGrantsByApp(
  grants: readonly PermissionGrantProjection[],
): readonly PermissionGrantGroup[] {
  const byApp = new Map<string, PermissionGrantProjection[]>()
  const loose: PermissionGrantProjection[] = []
  for (const grant of grants) {
    if (!grant.app) {
      loose.push(grant)
      continue
    }
    const bucket = byApp.get(grant.app)
    if (bucket) bucket.push(grant)
    else byApp.set(grant.app, [grant])
  }
  // 应用按名字排,**不按条数** —— 条数是会动的量,按它排会让撤掉一条之后整页跳序。
  const groups: PermissionGrantGroup[] = [...byApp.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([app, list]) => ({ app, grants: list }))
  // 散条永远排在最后:它们是「不属于任何应用」的那一摞。
  if (loose.length > 0) groups.push({ grants: loose })
  return groups
}

/**
 * **HMR 退役**(壳规范「模块级副作用必须配 HMR dispose」,09-01 立法;起因是
 * chat-source 那一案:热更之后旧模块的模块级副作用没死,两个实例同时活着)。
 *
 * 这个文件的模块级副作用有三样:账页 query(自带监听表与缓存)、逐条撤销那只
 * mutation(自带监听表与逐格计数)、整应用撤销那只。三样的寿命都是「这个模块
 * 实例」—— 不退役,旧实例的监听表会攥着已卸载组件的回调。
 *
 * 退役**复用它们各自已有的那一口拆卸**(`reset()`),不写第二套:两套拆卸迟早
 * 漏一格。它自身幂等;生产构建里 `import.meta.hot` 是 undefined,整段被
 * tree-shake 掉。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    permissionGrantsQuery.reset()
    revokeGrantMutation.reset()
    revokeAppGrantsMutation.reset()
  })
}
