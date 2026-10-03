/**
 * 用户句柄的归一规则(docs/design/agent-dm-user.md §2.1)。
 *
 * 纯规则住产品层,读 settings 的那一半住 app 层(`app/collab/user-identity.ts`)
 * —— 因为**渲染层也要用它**:设置页在用户离开输入框时要把「Yi Tian!」变成
 * `yitian`,而渲染层碰不到 app 层。规则写两遍的下场是设置页显示的句柄和 dm 认
 * 的句柄不是同一个。
 */

/** 没配置名字时全链路的称呼。房间投影、花名册、引用快照共用这一个词。 */
export const COLLAB_USER_DEFAULT_LABEL = '用户'
/** 没配置句柄时的定位符。`dm to: "user"` 因此永远可达。 */
export const COLLAB_USER_DEFAULT_HANDLE = 'user'
/** 句柄长度上限:够写够记,也够短到跟在名字后面不喧宾夺主。 */
export const COLLAB_USER_HANDLE_MAX_CHARS = 24

/**
 * 小写 + 只留 `[a-z0-9_-]` + 截断到 24。
 *
 * 清洗而不是拒绝:句柄的唯一职责是"被模型抄进 `to` 参数",用户输入
 * 「Yi Tian!」时给出 `yitian` 比弹一条校验错误更有用。清洗到空(纯中文名之类)
 * 落回 `user` —— 那一档永远可达,所以不存在"句柄丢了就找不到人"。
 */
export function normalizeCollabUserHandle(raw: string | undefined | null): string {
  const cleaned = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, COLLAB_USER_HANDLE_MAX_CHARS)
  return cleaned || COLLAB_USER_DEFAULT_HANDLE
}
