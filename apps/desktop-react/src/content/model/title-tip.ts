/**
 * **「这段提示是一条路径」由产地自述**(09-13)。
 *
 * 提示体(`ui/Tooltip`)收的是 `ReactNode`,它不该认识「路径」这件事 —— 一件
 * 通用浮层认得出业务形状,下一种业务就得再改它一次。而消费者那一侧同样不许
 * 反过来猜:`if (looksLikePath(tip))` 这一形在这台上是禁的(仓根 CLAUDE.md
 * 「凡按能力枚举的地方改成能力自述、别人读表」),因为「看起来像路径」永远
 * 会在某条命令、某个 URL 上猜错,而且猜错时没有人报错。
 *
 * 所以判据落在**给出这句提示的那一方**:它本来就知道自己交的是文件路径
 * 还是一整条命令。消费者只读表 —— 字符串照原样画,路径形交给 `ui/PathText`。
 *
 * 这只文件**零 React**:类型与那只拼接用的纯函数住这儿,渲染那一半在隔壁
 * `content/title-tip.tsx`。分开是因为拼接(`a ⫽ b` 那一族)与无障碍名要的是
 * **字符串**,而它们跑在非组件上下文里(`ContentKind.title` 不是 hook)。
 */

/**
 * 一句悬停提示。
 *  · `string`            —— 就是这句话(整条命令 / 一个 URL / 一段说明);
 *  · `{ path, dir? }`    —— 这是一条**路径**,画成「名字一行 + 目录一行」,
 *                           家目录缩成 `~`。`dir: true` = 它指的是一个目录
 *                           (名字行带回尾随 `/`)。
 */
export type TitleTip = string | { path: string; dir?: boolean }

/**
 * 提示的**字符串形**。给两种场合:①拼接(复合内容把两半的全名连成一句);
 * ②无障碍名与别的「只要字」的地方。
 *
 * 路径形交出来的是**全路径**,不是画出来那份缩过的 —— `~` 只活在显示层
 * (判词在 `ui/PathText` 头上)。
 */
export function titleTipText(tip: TitleTip | undefined): string | undefined {
  if (tip === undefined) return undefined
  return typeof tip === 'string' ? tip : tip.path
}

/**
 * 两句提示逐字相同吗。给**记忆化**用(`stage/live-title` 那张表按值比)——
 * 路径形是每次现造的对象,`===` 会让每一次发布都判成「变了」,于是三个宿主
 * 白重渲一遍。这只函数是那条相等判据的唯一产地。
 */
export function sameTitleTip(a: TitleTip | undefined, b: TitleTip | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  if (typeof a === 'string' || typeof b === 'string') return false
  return a.path === b.path && a.dir === b.dir
}
