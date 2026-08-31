import type { SpaceRecord } from '@shared/ipc/spaces'
import { gradientIndexOf } from '../components/gradient'
import {
  DEFAULT_SPACE_ID,
  WORKSPACE_SLOT_COUNT,
  WORKSPACE_SWATCHES,
  type WorkspaceSwatch,
  type WorkspaceView,
} from './types'

/**
 * 「后端记录 → 屏幕上的一行」的**唯一**产地。
 *
 * 三个入口(Dock 瓦右键的快切表 / ⌘⇧W 命令面板 / 工作区总览的大卡)画的东西
 * 粗细不同,读的分子却必须是同一份 —— 否则「哪个是当前」「⌘2 是谁」会在三处
 * 各说各话。所以这里全是纯函数:没有 React、没有 store、没有 DOM。
 */

/**
 * 次序。**默认空间永远第一**,其余按创建时间从早到晚,同刻按 id 定序。
 *
 * 刻意**不按最近使用排**:那需要一份「上次用是什么时候」的事实,而这台今天
 * 没有这个事实 —— 现造一个本地计时器,等于让序号键(⌘1/2/3)指向的空间
 * 在用户背后漂。序号要稳,先得有一个稳的次序。
 */
export function orderSpaces(spaces: readonly SpaceRecord[]): SpaceRecord[] {
  return [...spaces].sort((a, b) => {
    if (a.id === DEFAULT_SPACE_ID) return b.id === DEFAULT_SPACE_ID ? 0 : -1
    if (b.id === DEFAULT_SPACE_ID) return 1
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * 色标。记录里那个名字认识就用它;不认识 / 缺席就按 **id** 哈希派一格 ——
 * 喂进哈希的必须是身份而不是显示名(改个名字不该换一张脸),
 * 判据与 components/gradient.ts 逐字相同,连哈希都是同一个。
 */
export function swatchOf(space: SpaceRecord): WorkspaceSwatch {
  const declared = space.color as WorkspaceSwatch | undefined
  if (declared && (WORKSPACE_SWATCHES as readonly string[]).includes(declared)) return declared
  return WORKSPACE_SWATCHES[gradientIndexOf(space.id) % WORKSPACE_SWATCHES.length]
}

/**
 * 字标:名字的第一个**字**(不是第一个 code unit)。
 *
 * 用 `Array.from` 而不是 `name[0]`:emoji 与部分汉字是代理对,取半个会画出乱码。
 * 空名字退成 id 的首字;id 也空(不可能,但契约上 id 是 string)退成一个占位横杠 ——
 * 占位符是**数据**不是文案,与 files-source 的单位符号同一条判据,不进字典。
 */
export function initialOf(space: SpaceRecord): string {
  const source = space.name.trim() || space.id.trim()
  return Array.from(source)[0] ?? '—'
}

/**
 * 投影。**这是三个入口唯一的入口**。
 *
 * `currentId` 在列表里找不到时(那个空间被别的窗口删了、或者档案是老的),
 * 落回默认空间 —— 「当前」永远指得出一个真的存在的空间,不许是幽灵。
 */
export function projectWorkspaces(
  spaces: readonly SpaceRecord[],
  currentId: string,
): WorkspaceView[] {
  const ordered = orderSpaces(spaces)
  const resolved = ordered.some((s) => s.id === currentId) ? currentId : DEFAULT_SPACE_ID
  return ordered.map((space, index) => ({
    id: space.id,
    name: space.name,
    swatch: swatchOf(space),
    initial: initialOf(space),
    isDefault: space.id === DEFAULT_SPACE_ID,
    isCurrent: space.id === resolved,
    slot: index < WORKSPACE_SLOT_COUNT ? index + 1 : null,
  }))
}

/** 当前那一个。列表空(还没读到)时是 undefined —— 瓦面据此退成一个静默的占位。 */
export function currentWorkspace(views: readonly WorkspaceView[]): WorkspaceView | undefined {
  return views.find((v) => v.isCurrent)
}

/** `⌘<n>` 落在哪个工作区上。没有第 n 个 = undefined,那一下什么都不做。 */
export function workspaceAtSlot(
  views: readonly WorkspaceView[],
  slot: number,
): WorkspaceView | undefined {
  return views.find((v) => v.slot === slot)
}

/**
 * 命令面板的过滤。**只按名字,大小写不敏感,子串命中**(不做模糊匹配)——
 * 工作区名是用户自己起的短词,子串已经够用;模糊匹配会让「个人」把
 * 「个人备份」排到前面这种事变成一个要解释的判据。
 * 空词 = 全表(不过滤,也不重排)。
 */
export function filterWorkspaces(
  views: readonly WorkspaceView[],
  query: string,
): WorkspaceView[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...views]
  return views.filter((v) => v.name.toLowerCase().includes(q))
}
