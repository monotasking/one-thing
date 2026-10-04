import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
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
  // 「core 无宿主 import」随去 core 批 3(2026-10-03)撤掉:core 目录不存在了,它的文件都在 runtime / 包根里,
  // 宿主禁令由下面 runtime 那一条与检查器 `checkRuntimeHostBoundary`(runtime + 包根)管。
  //
  // 「core 在最底层」(core 不许 import runtime / gateway)与「`runtime/*/kernel` 在最底层」(kernel 只许 import 自己、core、
  // `@shared` 与 node 内建)两条随去 core 批 1(2026-10-03)撤掉(正本 `docs/design/server-client-split-2026-10.md` §4):
  // core 的「零依赖骨架」是为了让界面那侧复用,第①步以后界面只许 import `@shared` 与 `@onething/backend-client`,碰不到 core 了;
  // kernel 那条的源头就是「kernel 当 core 判」。

  // 「runtime 不许 import gateway」那一半随去 core 批 3(2026-10-03)撤掉:gateway 搬进了 `gateway/`(用户拍板:
  // core 没了它就是普通功能),runtime 里别的功能 import 它是正常的。
  // 2026-10-04 去掉 `runtime/` 这一层以后,功能目录直接住在包根下:这一条照旧只扫功能目录(`featureDirectories()`),
  // 包根的装配文件与 `http-server/` 不在它的范围里 —— 与搬家前扫 `runtime/` 的范围是同一批文件。
  it('keeps the backend feature directories free of Electron and hosts', () => {
    expect(featureDirectories().flatMap(feature => findForbiddenReferences(`packages/backend/${feature}`, [
      ...hostOnlyPatterns,
      /window\.electronAPI/,
      appSourceImportPattern,
    ]))).toEqual([])
  })

  // 「runtime 产品层不许 import 脊柱」这一条随第③步拍平撤掉(2026-10-02,用户拍板「server 包内部不再区分接线与
  // 产品逻辑」,正本 `docs/design/server-client-split-2026-10.md` §4):一个功能的文件平铺在 `runtime/<d>/`,
  // 它们本来就要 import 脊柱。runtime 的宿主禁令(electron / `@main` / `@preload`)在上一条里照旧。

  /**
   * 合包以前三个包之间隔着包边界,相对路径爬不进别的包(爬得进去也会在打包与 exports 上露馅);合包以后
   * `runtime/x.ts` 写一句 `../../server/y.js` 就能摸到脊柱,上面几条按包说明符判的规则看不见它。
   * 这一条把「包边界」换成等价的目录规则:子树的非测试代码,相对 import 只许落在自己的子树里。
   * 去 core 批 3(2026-10-03)以后子树只剩 `runtime/` 一棵(core、gateway 都并进了它),指向包根的写包说明符。
   * (今天一处越界都没有;测试与 `__tests__` 照旧不受包方向约束。)
   */
  // 2026-10-04 去掉 `runtime/` 这一层以后,「子树」就是全体功能目录:功能的非测试代码,相对 import 只许落在
  // 某个功能目录里,不许爬到包根的装配文件或 `http-server/`(那些写包说明符)。范围与判据都与搬家前相同。
  it('keeps relative imports of the feature directories inside the feature directories', () => {
    const escapes: string[] = []
    const features = new Set(featureDirectories())
    for (const feature of features) {
      const relativeDirectory = `packages/backend/${feature}`
      for (const filePath of collectSourceFiles(relativeDirectory)) {
        if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(filePath)) continue
        const code = stripComments(readFileSync(join(projectRoot, filePath), 'utf8'))
        for (const match of code.matchAll(relativeImportPattern)) {
          const target = join(dirname(filePath), match[1])
          // 唯一的口子:指向内部会话模块(`scripts/lib/backend-public-boundary.mjs` 的 `privateSessionFiles`)。
          // 那条门规定它们**不许有 exports 键**,所以没有包说明符可写,只能相对 import —— 与包根下的脊柱文件一样。
          if (isPrivateSessionModule(target)) continue
          const [packages, backend, first, ...rest] = target.split('/')
          const inFeature = packages === 'packages' && backend === 'backend' && features.has(first) && rest.length > 0
          if (!inFeature) escapes.push(`${filePath} -> ${match[1]}`)
        }
      }
    }
    expect(escapes).toEqual([])
  })

  /**
   * I1(docs/design/structural-debt-plan-2026-08.md §0b.3):**一个领域一个家**。
   *
   * 从前判的是「backend 包根的目录名不得与 runtime 顶层目录名重名」(防一个领域被横切成两片)。2026-10-04 去掉
   * `runtime/` 这一层以后,功能目录本身就是包根的目录,目录与目录不可能重名;剩下能撞的是**包根的散文件与非功能
   * 目录**:`lifecycle.ts`(关机骨架)与功能 `lifecycle/`(入场闸)并排时,读的人分不清 `./lifecycle.js` 是哪一个 ——
   * 这次搬家就因此把包根那只改名为 `backend-shutdown.ts`。断言守的是「不许再长回来」。
   */
  it('I1: keeps one home per domain — no package-root file or non-feature directory shares a feature name', () => {
    const features = new Set(featureDirectories())
    const rootNames = readdirSync(join(projectRoot, 'packages/backend'), { withFileTypes: true })
      .filter(entry => entry.isFile() || NON_FEATURE_DIRECTORIES.has(entry.name))
      .map(entry => entry.name.replace(/\.d\.ts$|\.ts$/, ''))
    expect(rootNames.filter(name => features.has(name))).toEqual([])
  })

  // I2(「同一个领域名下 `core/<d>/x.ts` 与 `runtime/<d>/x.ts` 不许同名」)与「gateway 只依赖 core + `@shared`」
  // 两条随去 core 批 3(2026-10-03)撤掉:core 目录不存在了,没有跨层同名可守(白名单批 1 就已清空);gateway 搬进了
  // `gateway/`,宿主禁令由上面 runtime 那一条管,「只依赖 core」的前提随 core 一起没了。

  it('keeps the server host independent from Electron host code', () => {
    // apps/web(Vue 浏览器构建)于 2026-09-04 随 Vue 宿主退役;浏览器壳现在是 apps/desktop-react 的 web 模式。
    expect(findForbiddenReferences('apps/backend-server', hostOnlyPatterns)).toEqual([])
  })

  it('keeps apps/backend-server off Electron app source (packages/shared stays allowed)', () => {
    // apps/web intentionally builds packages/renderer via vite aliases, so this
    // rule applies to the server host only.
    expect(findForbiddenReferences('apps/backend-server', [
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
      'codex', 'acp', 'deepseek', 'gemini',
      'openai-compatible', 'qwen', 'zhipu', 'github-copilot', 'openrouter',
    ]
    const idComparison = new RegExp(
      `(providerId|provider\\.id|providerType)\\s*===\\s*['"](${providerNames.join('|')})['"]`,
    )
    const namedKnob = /\b(zhipuApiMode|qwenApiMode|qwenRegion|codexNativeTools|codexRefreshOAuthToken|codexRequestDumper)\b/

    // Comments are stripped first: the point is that no code branches on a
    // provider, not that the history cannot be written down next to it.
    expect(findForbiddenReferencesInCode('packages/backend/agent-loop', [idComparison, namedKnob])).toEqual([])
    expect(findForbiddenReferencesInCode('packages/backend/engine', [idComparison, namedKnob])).toEqual([])
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
      'packages/backend-client',
      'apps/desktop-react/src',
      'apps/backend-server/src',
    ]) {
      expect(findForbiddenReferencesInCode(directory, [deadNames])).toEqual([])
    }
  })

})

/** 内部会话模块(`packages/backend/session/<x>.ts`,名单与 `scripts/lib/backend-public-boundary.mjs` 的 `privateSessionFiles` 同源,现读)。 */
const privateSessionFiles = (() => {
  const text = readFileSync(join(projectRoot, 'scripts/lib/backend-public-boundary.mjs'), 'utf8')
  const list = /privateSessionFiles = new Set\(\[([\s\S]*?)\]\)/.exec(text)?.[1] ?? ''
  return new Set([...list.matchAll(/'([^']+)'/g)].map(match => match[1]))
})()

function isPrivateSessionModule(target: string): boolean {
  return dirname(target) === 'packages/backend/session' && privateSessionFiles.has(target.split('/').pop()!.replace(/\.js$/, '.ts'))
}

/** 相对说明符(import / export-from / 动态 import / require)。 */
const relativeImportPattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]*)['"]/g

/** Matches import/require/export-from of `src/main|renderer|preload` from any relative depth. */
const appSourceImportPattern = /(?:from\s+['"]|import\s*\(\s*['"]|require\s*\(\s*['"])[^'"]*src\/(?:main|renderer|preload)\//

/** 包根下不是功能的目录(与 `scripts/lib/backend-structure.mjs` 的 `NON_FEATURE_DIRS` 同一张名单)。 */
const NON_FEATURE_DIRECTORIES = new Set(['__tests__', 'http-server', 'node_modules'])

/** 功能目录:`packages/backend/` 下除非功能目录以外的每个直接子目录。 */
function featureDirectories(): string[] {
  return readdirSync(join(projectRoot, 'packages/backend'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !NON_FEATURE_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.'))
    .map(entry => entry.name)
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
