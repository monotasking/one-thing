import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = process.cwd()
const sourceExtensions = new Set(['.js', '.mjs', '.ts', '.tsx', '.vue'])
const skippedDirectories = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'out',
  '__tests__',
])

describe('architecture boundaries', () => {
  it('keeps packages/core free of Electron, renderer, and host imports', () => {
    expect(findForbiddenReferences('packages/core', [
      /from\s+['"]electron['"]/,
      /import\s*\(\s*['"]electron['"]\s*\)/,
      /require\s*\(\s*['"]electron['"]\s*\)/,
      /@onething\/electron-host/,
      /from\s+['"]@main(?:\/|['"])/,
      /from\s+['"]@preload(?:\/|['"])/,
      /window\.electronAPI/,
      /\bipcMain\b/,
      /\bipcRenderer\b/,
      /src\/(?:main|renderer|preload)\//,
    ])).toEqual([])
  })

  it('keeps packages/core at the bottom of the package hierarchy', () => {
    expect(findForbiddenReferences('packages/core', [
      importOf('@onething/runtime'),
      importOf('@onething/gateway'),
    ])).toEqual([])
  })

  it('keeps packages/onething-runtime free of Electron, hosts, and gateway', () => {
    expect(findForbiddenReferences('packages/onething-runtime', [
      ...hostOnlyPatterns,
      /window\.electronAPI/,
      appSourceImportPattern,
      importOf('@onething/gateway'),
    ])).toEqual([])
  })

  it('keeps the runtime product layer off the assembly package', () => {
    // P3'd: the assembly layer is its own workspace package
    // (`@onething/backend`, the former `runtime/src/app`). The runtime package
    // is host-independent product logic and must never depend on how it gets
    // assembled — the dependency points one way: product ← assembly ← hosts.
    expect(findForbiddenReferences('packages/onething-runtime/src', [
      importOf('@onething/backend'),
    ])).toEqual([])
  })

  /**
   * I1(docs/design/structural-debt-plan-2026-08.md §0b.3):**一个领域一个家**。
   *
   * 病根是"一个领域被横切成三片,其中一片叫 app" —— 读代码的人看见 `plugins/`
   * 出现在三棵树里,不知道该找哪一个。P3'd 把装配层变成 `packages/backend` 之后,
   * 这条不变量可以被机械地守住:**backend 包根的目录名不得与 runtime 顶层目录名
   * 重名**。`wiring/` 下不算 —— 那里放的是"接进后端"的薄接线,路径自带角色
   * (`backend/wiring/<d>` 与 `runtime/<d>` 天然不同名)。
   *
   * 当前豁免的是 P3'b 待合并的厚孪生。**这是棘轮:只许缩,不许长。**
   * 每摘掉一个就从这张表里删一行,表空了就把整张表删掉。
   */
  it('I1: keeps one home per domain — backend package root does not shadow a runtime domain', () => {
    // P3'b 逐个摘除(厚孪生:两边都有真代码,合并要逐文件判定契约/实现/接线)。
    const pendingThickTwins = new Set([
      'collab', 'plugins', 'providers', 'toolkit', 'mcp', 'music', 'voice', 'logging',
      // 单文件孪生(backend/headless/backend.ts 对 runtime/headless/),同批处理。
      'headless',
    ])
    const runtimeDomains = new Set(topLevelDirectories('packages/onething-runtime/src'))
    const collisions = topLevelDirectories('packages/backend')
      .filter(name => name !== 'wiring')
      .filter(name => runtimeDomains.has(name) && !pendingThickTwins.has(name))
    expect(collisions).toEqual([])
  })

  it('keeps packages/gateway depending on core only', () => {
    expect(findForbiddenReferences('packages/gateway', [
      ...hostOnlyPatterns,
      /window\.electronAPI/,
      appSourceImportPattern,
      importOf('@onething/runtime'),
    ])).toEqual([])
  })

  it('keeps renderer product code behind platformApi instead of direct IPC', () => {
    expect(findForbiddenReferences('packages/renderer', [
      /window\.electronAPI/,
      /\bipcMain\b/,
      /\bipcRenderer\b/,
      /from\s+['"]electron['"]/,
      /import\s*\(\s*['"]electron['"]\s*\)/,
      /require\s*\(\s*['"]electron['"]\s*\)/,
    ], {
      allowFile: filePath => (
        filePath.startsWith('packages/renderer/platform/')
        || filePath === 'packages/renderer/types/index.ts'
      ),
    })).toEqual([])
  })

  it('keeps web and server hosts independent from Electron host code', () => {
    expect(findForbiddenReferences('apps/web', hostOnlyPatterns)).toEqual([])
    expect(findForbiddenReferences('apps/server', hostOnlyPatterns)).toEqual([])
  })

  it('keeps apps/server off Electron app source (packages/shared stays allowed)', () => {
    // apps/web intentionally builds packages/renderer via vite aliases, so this
    // rule applies to the server host only.
    expect(findForbiddenReferences('apps/server', [
      appSourceImportPattern,
    ])).toEqual([])
  })

  /**
   * The provider-agnostic layers must not name a provider.
   *
   * They used to: core's agent-loop runtime listed `zhipuApiMode` /
   * `qwenApiMode` / `qwenRegion` by name in an interface AND in a `Pick<>`
   * whitelist, and the provider factory bypassed its capability ledger with
   * `providerId === 'acp' || providerId === 'claude-code-agent'`. Both meant
   * that adding a provider forced an edit to code that has no business knowing
   * providers exist — and in the `Pick<>` case, forgetting the edit dropped the
   * field silently with a green typecheck.
   *
   * Knobs travel in the opaque `providerOptions` bag; capabilities are asked
   * for, not looked up. See docs/design/provider-abstraction.md.
   */
  it('keeps the provider-agnostic layers free of provider names', () => {
    const providerNames = [
      'codex', 'claude-code-agent', 'deepseek', 'gemini',
      'openai-compatible', 'qwen', 'zhipu', 'github-copilot', 'openrouter',
    ]
    const idComparison = new RegExp(
      `(providerId|provider\\.id|providerType)\\s*===\\s*['"](${providerNames.join('|')})['"]`,
    )
    const namedKnob = /\b(zhipuApiMode|qwenApiMode|qwenRegion|codexNativeTools|codexRefreshOAuthToken|codexRequestDumper)\b/

    // Comments are stripped first: the point is that no code branches on a
    // provider, not that the history cannot be written down next to it.
    expect(findForbiddenReferencesInCode('packages/core/agent-loop', [idComparison, namedKnob])).toEqual([])
    expect(findForbiddenReferencesInCode('packages/core/engine', [idComparison, namedKnob])).toEqual([])
  })

  /**
   * P1(docs/design/context-compact-fix-2026-08.md §4):压缩通知只有一条正路
   * —— `session:event` 信封里的 `context:compact-started` / `-completed`。
   *
   * 从前还有三层死代码:两个专用 IPC 通道常量、preload 的两个订阅方法(主进程
   * 从来没往那两条通道发过一条)、以及 web 端靠 `JSON.parse` 嗅探消息内容的
   * 幻影订阅。三层都删了 —— 这一条守着它们不被"顺手加回来"。
   */
  it('keeps the retired context-compact IPC surface at zero references', () => {
    // 批 6:光看常量名已经分不出敌我 —— `SESSION_EVENT_TYPES.CONTEXT_COMPACT_STARTED`
    // 正是那"一条正路"的事件表键,与被退役的 IPC 通道**同名不同物**。所以榜上换成
    // 退役通道的**通道名字符串**(改个键名也逃不掉)加那三个订阅方法。
    const deadNames = /sessions:context-compact-(started|completed)|\b(onContextCompactStarted|onContextCompactCompleted|isContextCompactStartedMessage)\b/

    for (const directory of [
      'packages/shared',
      'packages/renderer',
      'apps/electron/src',
      'apps/server/src',
    ]) {
      expect(findForbiddenReferencesInCode(directory, [deadNames])).toEqual([])
    }
  })

})

/** Matches import/require/export-from of `src/main|renderer|preload` from any relative depth. */
const appSourceImportPattern = /(?:from\s+['"]|import\s*\(\s*['"]|require\s*\(\s*['"])[^'"]*src\/(?:main|renderer|preload)\//

/** 顶层目录名(领域名)。`__tests__` 不是领域,不参与 I1 的比对。 */
function topLevelDirectories(relativeDirectory: string): string[] {
  return readdirSync(join(projectRoot, relativeDirectory), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => name !== '__tests__' && !skippedDirectories.has(name))
}

function importOf(packageName: string): RegExp {
  const escaped = packageName.replace(/[/\\^$.*+?()[\]{}|]/g, '\\$&')
  return new RegExp(`(?:from\\s+['"]|import\\s*\\(\\s*['"]|require\\s*\\(\\s*['"])${escaped}(?:/|['"])`)
}

const hostOnlyPatterns = [
  /from\s+['"]electron['"]/,
  /import\s*\(\s*['"]electron['"]\s*\)/,
  /require\s*\(\s*['"]electron['"]\s*\)/,
  /@onething\/electron-host/,
  /from\s+['"]@main(?:\/|['"])/,
  /from\s+['"]@preload(?:\/|['"])/,
  /import\s*\(\s*['"]@main(?:\/|['"])/,
  /import\s*\(\s*['"]@preload(?:\/|['"])/,
  /require\s*\(\s*['"]@main(?:\/|['"])/,
  /require\s*\(\s*['"]@preload(?:\/|['"])/,
  /\bipcMain\b/,
  /\bipcRenderer\b/,
]

function findForbiddenReferences(
  relativeDirectory: string,
  patterns: RegExp[],
  options: { allowFile?: (filePath: string) => boolean } = {},
): string[] {
  return collectSourceFiles(relativeDirectory)
    .filter(filePath => !options.allowFile?.(filePath))
    .flatMap(filePath => {
      const content = readFileSync(join(projectRoot, filePath), 'utf8')
      return patterns
        .filter(pattern => pattern.test(content))
        .map(pattern => `${filePath} matched ${pattern}`)
    })
}

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function findForbiddenReferencesInCode(
  relativeDirectory: string,
  patterns: RegExp[],
): string[] {
  return collectSourceFiles(relativeDirectory).flatMap(filePath => {
    const code = stripComments(readFileSync(join(projectRoot, filePath), 'utf8'))
    return patterns
      .filter(pattern => pattern.test(code))
      .map(pattern => `${filePath} matched ${pattern}`)
  })
}

function collectSourceFiles(relativeDirectory: string): string[] {
  const absoluteDirectory = join(projectRoot, relativeDirectory)
  return readdirSync(absoluteDirectory).flatMap(entry => {
    const filePath = join(relativeDirectory, entry)
    const absolutePath = join(projectRoot, filePath)
    const stat = statSync(absolutePath)
    if (stat.isDirectory()) {
      if (skippedDirectories.has(entry)) return []
      return collectSourceFiles(filePath)
    }
    if (!stat.isFile() || !sourceExtensions.has(extname(entry))) return []
    return [filePath]
  })
}
