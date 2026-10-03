/**
 * space(workspace)—— 一个工作空间的身份记录。
 *
 * 命名注意:产品内部一律叫 **space**,不叫 workspace —— renderer 已有
 * `stores/workspace.ts`(分栏树),两者正交,撞名只会把人绕晕。落盘目录仍是
 * `workspaces/`(那是 `storage/paths.ts` 早就占好的坑位,不为改名去搬目录)。
 *
 * 设计见 `docs/design/workspace-spaces-2026-08.md` 批 B。
 */

/** 默认空间的固定 id。缺 workspaceId 的旧会话一律视为属于它(读取端缺省,零迁移)。 */
export const DEFAULT_SPACE_ID = 'default'
export const DEFAULT_SPACE_NAME = '默认空间'

export interface Space {
  id: string
  name: string
  /** 切换器上的色点;缺省由前端派生。 */
  color?: string
  /** 预留:图标/emoji。 */
  icon?: string
  createdAt: number
}

export interface SpaceIndex {
  spaces: Space[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 空间名归一:trim 后为空即无效。 */
export function normalizeSpaceName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const trimmed = name.trim()
  return trimmed || null
}

/**
 * id 会成为 `workspaces/<id>/` 的路径片段,所以字符集卡死:小写字母/数字/`-`/`_`。
 * 这是**存储安全**约束,不是审美 —— 放行 `..` 或分隔符等于放行任意路径写入。
 */
const SPACE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function isValidSpaceId(id: unknown): id is string {
  return typeof id === 'string' && SPACE_ID_RE.test(id)
}

export function createDefaultSpace(now = Date.now()): Space {
  return { id: DEFAULT_SPACE_ID, name: DEFAULT_SPACE_NAME, createdAt: now }
}

export function parseSpace(value: unknown): Space | null {
  if (!isRecord(value)) return null
  if (!isValidSpaceId(value.id)) return null
  const name = normalizeSpaceName(value.name)
  if (!name) return null
  if (typeof value.createdAt !== 'number') return null
  const space: Space = { id: value.id, name, createdAt: value.createdAt }
  if (typeof value.color === 'string' && value.color.trim()) space.color = value.color.trim()
  if (typeof value.icon === 'string' && value.icon.trim()) space.icon = value.icon.trim()
  return space
}

/**
 * 整表解析。与 project-dirs 的 index 一致:**有一条坏就整份判废**(返回 null),
 * 由调用方退回空表 —— 半张表比空表更难排查。
 */
export function parseSpaceIndex(value: unknown): SpaceIndex | null {
  if (!isRecord(value) || !Array.isArray(value.spaces)) return null
  const spaces: Space[] = []
  const seen = new Set<string>()
  for (const raw of value.spaces) {
    const space = parseSpace(raw)
    if (!space) return null
    if (seen.has(space.id)) continue
    seen.add(space.id)
    spaces.push(space)
  }
  return { spaces }
}

/** default 永远排第一,其余按创建时间升序 —— 切换器的顺序就是这一份。 */
export function sortSpaces(spaces: readonly Space[]): Space[] {
  return [...spaces].sort((a, b) => {
    if (a.id === DEFAULT_SPACE_ID) return -1
    if (b.id === DEFAULT_SPACE_ID) return 1
    return a.createdAt - b.createdAt
  })
}

/** 读取端缺省:缺 workspaceId = default。**不做数据迁移**,只在读时兜底。 */
export function resolveSpaceId(workspaceId: string | undefined | null): string {
  return workspaceId && isValidSpaceId(workspaceId) ? workspaceId : DEFAULT_SPACE_ID
}
