/**
 * per-space overlay —— `workspaces/<id>/space.json`(批 B2)。
 *
 * overlay 是**追加层**,不是替换层:生效值 = 全局 settings ∪ 本空间 overlay。
 * 全局层继续存在且全空间共享(零迁移,老用户无感),空间只往上加东西。
 *
 * 三条硬约束:
 *  1. **不走 `mergeWithDefaults`**。那是白名单式重建,有静默吞掉白名单外字段的
 *     前科(`storage` / `evals` 两个既有漏项),overlay 独立解析、独立落盘。
 *  2. **不碰 settings.json**。overlay 是另一份文件,两边互不覆盖。
 *  3. schema 从第一天就留位(`overlay` 对象里后续还要放 defaultModel /
 *     selectedModels / persona),所以落盘形状是 `{ overlay: {...} }` 而不是
 *     把 connectedDirectories 平铺在根上。
 *
 * 设计见 `docs/design/workspace-spaces-2026-08.md` 批 B。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { ensureSpaceDir, spaceDir } from './persistence.js'
import { DEFAULT_SPACE_ID, isValidSpaceId } from './types.js'

/** 本切片的 overlay 只有一格。后续切片往这个接口里加字段,不改文件形状。 */
export interface SpaceOverlay {
  connectedDirectories?: string[]
}

/** 落盘形状。`overlay` 是唯一的一级键 —— 给未来的非 overlay 段(如 meta)留位。 */
export interface SpaceFile {
  overlay: SpaceOverlay
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 目录归一:trim + 去尾斜杠,只用于**相等判定**(去重),不改写用户存的原文。
 * 与 project-dirs 的 `canonicalizeProjectRoot` 同一口径 —— 两处目录概念在同一个
 * 会话里并排出现,判据分家的第一天不会有人发现,第一百天没人能解释。
 */
export function canonicalizeSpaceDirectory(dir: string): string {
  const trimmed = dir.trim()
  const stripped = trimmed.replace(/[/\\]+$/, '')
  return stripped || trimmed
}

/**
 * 目录清单归一:丢非字符串/空串/相对路径,尾斜杠不敏感去重,保留首次出现顺序。
 * 只收绝对路径 —— 与 `normalizeConnectedDirectories`(全局层)同一条门槛,
 * 否则两层的收货标准不一样,合并后会冒出全局层永远不可能存在的相对路径。
 */
export function normalizeSpaceDirectories(dirs: unknown): string[] {
  if (!Array.isArray(dirs)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of dirs) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (!(trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed))) continue
    const key = canonicalizeSpaceDirectory(trimmed)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

/**
 * 生效接入目录 = 全局层 ∪ space overlay。全局在前(它是所有空间的共同底座,
 * 顺序上先出现更符合「谁是底、谁是加料」的直觉),去重尾斜杠不敏感。
 */
export function mergeConnectedDirectories(
  global: readonly string[],
  overlay: readonly string[] | undefined,
): string[] {
  return normalizeSpaceDirectories([...global, ...(overlay ?? [])])
}

/**
 * 整份解析。与 index.json 一致:**结构不认就整份判废**(返回 null),调用方退回
 * 空 overlay —— 半份 overlay 比空 overlay 更难排查(用户看见三条目录里少了一条,
 * 而日志里什么都没有)。字段级的脏值(数组里混进数字)按归一规则丢弃,不判废整份。
 */
export function parseSpaceFile(value: unknown): SpaceFile | null {
  if (!isRecord(value)) return null
  if (value.overlay === undefined) return { overlay: {} }
  if (!isRecord(value.overlay)) return null
  const overlay: SpaceOverlay = {}
  if (value.overlay.connectedDirectories !== undefined) {
    if (!Array.isArray(value.overlay.connectedDirectories)) return null
    overlay.connectedDirectories = normalizeSpaceDirectories(value.overlay.connectedDirectories)
  }
  return { overlay }
}

/** 只接受门口卡死过的 id —— id 是路径片段,非法 id 一律当 default。 */
function resolveOverlaySpaceId(spaceId: string | undefined | null): string {
  return spaceId && isValidSpaceId(spaceId) ? spaceId : DEFAULT_SPACE_ID
}

export function spaceFilePath(spaceId: string): string {
  return path.join(spaceDir(resolveOverlaySpaceId(spaceId)), 'space.json')
}

/**
 * 读缓存。key 是**绝对文件路径**,不是 spaceId —— 换 store 根(headless 宿主、
 * 测试)天然换 key,不需要额外的失效钩子,也就不需要 persistence 反向依赖本模块。
 *
 * 为什么要缓存:这条读路径挂在 analyze 热路径上(每次 write/edit/bash 审批判定
 * 各一次,read 也一次),同步读盘虽小也没必要每次都做。
 */
const overlayCache = new Map<string, SpaceOverlay>()

export function resetSpaceOverlayCacheForTests(): void {
  overlayCache.clear()
}

/** 缺文件 / 坏文件 / 读不动 = 空 overlay。overlay 缺席永远等价于「这个空间没加料」。 */
export function readSpaceOverlay(spaceId: string | undefined | null): SpaceOverlay {
  const filePath = spaceFilePath(resolveOverlaySpaceId(spaceId))
  const cached = overlayCache.get(filePath)
  if (cached) return cached
  let overlay: SpaceOverlay = {}
  try {
    if (fs.existsSync(filePath)) {
      const parsed = parseSpaceFile(JSON.parse(fs.readFileSync(filePath, 'utf-8')))
      if (parsed) overlay = parsed.overlay
      else console.warn(`[spaces] ${filePath} failed schema validation, treating as empty overlay`)
    }
  } catch (err) {
    console.warn(`[spaces] failed to read ${filePath}:`, err)
  }
  overlayCache.set(filePath, overlay)
  return overlay
}

/**
 * 整层写入(不是 patch):调用方给什么就是什么。overlay 只有一格时 patch 与整写
 * 无差别,但字段变多之后「漏传 = 清空」是个陷阱,所以入口就定成整写,由 IPC 层
 * 显式决定要不要先读后并。
 */
export function writeSpaceOverlay(
  spaceId: string | undefined | null,
  overlay: SpaceOverlay,
): SpaceOverlay {
  const id = resolveOverlaySpaceId(spaceId)
  const next: SpaceOverlay = {}
  if (overlay.connectedDirectories !== undefined) {
    next.connectedDirectories = normalizeSpaceDirectories(overlay.connectedDirectories)
  }
  ensureSpaceDir(id)
  const filePath = spaceFilePath(id)
  const file: SpaceFile = { overlay: next }
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8')
  overlayCache.set(filePath, next)
  return next
}

/** 本空间 overlay 里登记的接入目录(不含全局层)。 */
export function getSpaceOverlayConnectedDirectories(
  spaceId: string | undefined | null,
): string[] {
  return readSpaceOverlay(spaceId).connectedDirectories ?? []
}
