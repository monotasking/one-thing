/**
 * 批 M §5.6「陌生能力演练」的活口:**别人读字段,不点名**。
 *
 * 从前「这是不是 codex / copilot / custom-*」在十几个文件里各判一次,加一家、加一种
 * 能力就得回去改一串 `if (providerId === …)`。批 M 把这些事实收进各家的 manifest
 * (`provider-builtin-manifests.ts`),读的人问字段(`billing` / `models.kind` / `auth.kind` /
 * `behaviors` / `origin`)。这把尺子守的是:它们不许长回来。
 *
 * 扫 runtime + backend + core + 壳的非测试源码(注释先剥掉),命中即红:
 *  - 与五个订阅 / 登录型内置 id 的等值 / 不等判断、`case`;
 *  - `startsWith('custom-')` —— 自定义服务商 = manifest 的 `origin: 'custom'`;
 *  - `SUBSCRIPTION_PROVIDER_IDS` —— 订阅家 = manifest 的 `billing: 'subscription'`。
 *
 * 允许写名字的只有:`provider-builtin-manifests.ts`(唯一产地)与**各家自己的模块**(它们本来
 * 就只讲自己:`providers/codex.ts`、`codex-native-tools.ts`、`github-copilot.ts`、
 * `dialects/<id>.ts` …)。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = process.cwd()

const SCAN_ROOTS = [
  'packages/backend',
  'apps/desktop-react/src',
]

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'dist-electron', '__tests__', '.vite', 'coverage'])

/** 唯一产地 + 各家自己的模块(相对仓根)。 */
const ALLOWED_FILES = new Set([
  'packages/backend/provider/provider-builtin-manifests.ts',
  'packages/backend/provider/codex.ts',
  'packages/backend/provider/codex-native-tools.ts',
  'packages/backend/provider/github-copilot.ts',
])
/**
 * 方言目录下每个文件都是某一家自己的配方;`providers/vendors/<id>/` 是各家的家
 * (服务商自述试点,`docs/design/architecture-direction-2026-10.md`)。更全的尺子是
 * `bun run provider:gate`(字面量 / 键 / 标识符都算,不只等值比较)。
 */
const ALLOWED_DIRECTORIES = [
  'packages/backend/provider/dialects/',
  'packages/backend/provider/vendors/',
]

const NAMES = '(?:codex|claude-code|kimi-code|github-copilot|grok-oauth)'
const PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'equality with a provider name', pattern: new RegExp(`[!=]==?\\s*['"\`]${NAMES}['"\`]`) },
  { label: 'equality with a provider name', pattern: new RegExp(`['"\`]${NAMES}['"\`]\\s*[!=]==?`) },
  { label: 'case on a provider name', pattern: new RegExp(`\\bcase\\s+['"\`]${NAMES}['"\`]`) },
  { label: "startsWith('custom-')", pattern: /startsWith\(\s*['"`]custom-/ },
  { label: 'SUBSCRIPTION_PROVIDER_IDS', pattern: /\bSUBSCRIPTION_PROVIDER_IDS\b/ },
]

function isTestFile(path: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(path)
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRECTORIES.has(name)) continue
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx|mts|cts)$/.test(name) && !name.endsWith('.d.ts') && !isTestFile(name)) out.push(full)
  }
  return out
}

/** 剥注释:块注释整段替成等长空白(保留行号),行注释去掉到行尾。字符串里的 `//` 不在乎 —— 我们找的都是引号里的短名字。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

function findEnumerations(): string[] {
  const hits: string[] = []
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(join(projectRoot, root))) {
      const rel = relative(projectRoot, file)
      if (ALLOWED_FILES.has(rel)) continue
      if (ALLOWED_DIRECTORIES.some((dir) => rel.startsWith(dir))) continue
      const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
      lines.forEach((line, index) => {
        for (const { label, pattern } of PATTERNS) {
          if (pattern.test(line)) hits.push(`${rel}:${index + 1} ${label}: ${line.trim()}`)
        }
      })
    }
  }
  return hits
}

describe('provider manifest — no enumeration outside the manifest', () => {
  it('runtime / backend / core / shell never branch on a provider name', () => {
    expect(findEnumerations()).toEqual([])
  })

  it('the ruler itself still bites (a planted line is caught)', () => {
    const planted = stripComments("if (providerId === 'codex') return\n// providerId === 'codex' in a comment is fine\n")
    const caught = planted.split('\n').filter((line) => PATTERNS.some(({ pattern }) => pattern.test(line)))
    expect(caught).toEqual(["if (providerId === 'codex') return"])
  })
})
