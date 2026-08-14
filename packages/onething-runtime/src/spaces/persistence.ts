import * as fs from 'node:fs'
import * as path from 'node:path'
import { getOnethingWorkspacesDir } from '../storage/paths.js'
import { parseSpaceIndex, type SpaceIndex } from './types.js'

let rootDirOverride: string | null = null

export function setRootDirForTests(dir: string | null): void {
  rootDirOverride = dir
}

/**
 * 惰性 + env-aware:headless 宿主用 `ONETHING_STORE_PATH` 圈自己的 store,
 * 这里绝不能在模块加载期把路径固化下来(project-dirs 踩过这个坑)。
 */
function rootDir(): string {
  return rootDirOverride ?? getOnethingWorkspacesDir()
}

function indexPath(): string {
  return path.join(rootDir(), 'index.json')
}

/**
 * 每个 space 一个目录 —— 本切片只是**占位**:B1 只写 index.json,
 * `credentials.json` / `space.json` / `project-dirs/` 是后续切片的住址
 * (`docs/design/workspace-spaces-2026-08.md` §3)。
 */
export function spaceDir(spaceId: string): string {
  return path.join(rootDir(), spaceId)
}

function ensureDirs(): void {
  fs.mkdirSync(rootDir(), { recursive: true })
}

export function ensureSpaceDir(spaceId: string): void {
  fs.mkdirSync(spaceDir(spaceId), { recursive: true })
}

export function removeSpaceDir(spaceId: string): void {
  try {
    fs.rmSync(spaceDir(spaceId), { recursive: true, force: true })
  } catch (err) {
    console.warn(`[spaces] failed to remove ${spaceId}/:`, err)
  }
}

export function loadIndex(): SpaceIndex {
  try {
    if (!fs.existsSync(indexPath())) return { spaces: [] }
    const parsed = parseSpaceIndex(JSON.parse(fs.readFileSync(indexPath(), 'utf-8')))
    if (!parsed) {
      console.warn('[spaces] index.json failed schema validation, treating as empty')
      return { spaces: [] }
    }
    return parsed
  } catch (err) {
    console.warn('[spaces] failed to read index.json:', err)
    return { spaces: [] }
  }
}

export function saveIndex(index: SpaceIndex): void {
  ensureDirs()
  fs.writeFileSync(indexPath(), JSON.stringify(index, null, 2), 'utf-8')
}
