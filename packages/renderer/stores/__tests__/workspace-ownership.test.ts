/**
 * Fence tests for the workspace-store data flow (docs/design/workspace-store.md §5.3):
 *
 * - `currentSessionId` is written only inside stores/sessions.ts. Everything
 *   else goes through workspace mutations (openSession & friends), and the
 *   workspace effect drives switchSession. A direct write anywhere else
 *   reintroduces the two-way sync this refactor removed.
 * - The legacy v1 `openTabs` ui-state field is never written again; the
 *   workspace store persists the whole tree under `workspace`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER_ROOT = join(__dirname, '..', '..')

function rendererSourceFiles(): string[] {
  return readdirSync(RENDERER_ROOT, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(ts|vue)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name))
    .map(entry => join(entry.parentPath, entry.name))
}

describe('workspace state ownership', () => {
  it('only stores/sessions.ts assigns currentSessionId', () => {
    const offenders = rendererSourceFiles()
      .filter((file) => {
        const source = readFileSync(file, 'utf8')
        return /(?:currentSessionId(?:\.value)?)\s*=[^=]/.test(source)
      })
      .map(file => relative(RENDERER_ROOT, file))
      .filter(file => file !== join('stores', 'sessions.ts'))

    expect(offenders).toEqual([])
  })

  it('nothing writes the legacy v1 openTabs ui-state field', () => {
    const offenders = rendererSourceFiles()
      .filter((file) => {
        const source = readFileSync(file, 'utf8')
        // P4c 之后写面叫 `appStateApi.saveUiState`;两种拼法都盯着,
        // 免得这道栅栏被一次改名变成永远空跑。
        return /save[Uu][Ii]State\s*\(\s*\{[^}]*openTabs/s.test(source)
      })
      .map(file => relative(RENDERER_ROOT, file))

    expect(offenders).toEqual([])
  })
})
