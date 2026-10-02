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
  it('keeps packages/backend/core free of Electron, renderer, and host imports', () => {
    // 这一条是**宿主禁令**(后端不许 import electron / `@main` / `@preload` / 渲染层),去 core 以后照旧成立。
    // 从前它还套在 `runtime/<d>/kernel/` 上(「kernel 当 core 判」);去 core 批 1(2026-10-03)起 kernel 只是领域里
    // 一个普通子目录,由下面 runtime 那一条管。
    expect(findForbiddenReferences('packages/backend/core', [
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

  // 「core 在最底层」(core 不许 import runtime / gateway)与「`runtime/*/kernel` 在最底层」(kernel 只许 import 自己、core、
  // `@shared` 与 node 内建)两条随去 core 批 1(2026-10-03)撤掉(正本 `docs/design/server-client-split-2026-10.md` §4):
  // core 的「零依赖骨架」是为了让界面那侧复用,第①步以后界面只许 import `@shared` 与 `@onething/client`,碰不到 core 了;
  // kernel 那条的源头就是「kernel 当 core 判」。core 剩下的文件在批 2 / 批 3 里并进 runtime,这期间它们 import
  // 已经搬进 runtime 的模块是正常的。

  it('keeps packages/backend/runtime free of Electron, hosts, and gateway', () => {
    expect(findForbiddenReferences('packages/backend/runtime', [
      ...hostOnlyPatterns,
      /window\.electronAPI/,
      appSourceImportPattern,
      importOf('@onething/backend/gateway'),
    ])).toEqual([])
  })

  // 「runtime 产品层不许 import 脊柱」这一条随第③步拍平撤掉(2026-10-02,用户拍板「server 包内部不再区分接线与
  // 产品逻辑」,正本 `docs/design/server-client-split-2026-10.md` §4):一个功能的文件平铺在 `runtime/<d>/`,
  // 它们本来就要 import 脊柱。runtime 的宿主禁令(electron / `@main` / `@preload`)在上一条里照旧。

  /**
   * 合包以前三个包之间隔着包边界,相对路径爬不进别的包(爬得进去也会在打包与 exports 上露馅);合包以后
   * `runtime/x.ts` 写一句 `../../server/y.js` 就能摸到脊柱,上面几条按包说明符判的规则看不见它。
   * 这一条把「包边界」换成等价的目录规则:三棵子树的非测试代码,相对 import 只许落在自己的子树里。
   * (今天一处越界都没有;测试与 `__tests__` 照旧不受包方向约束。)
   */
  it('keeps relative imports of core / runtime / gateway inside their own subtree', () => {
    const escapes: string[] = []
    for (const subtree of ['core', 'runtime', 'gateway']) {
      const relativeDirectory = `packages/backend/${subtree}`
      for (const filePath of collectSourceFiles(relativeDirectory)) {
        if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(filePath)) continue
        const code = stripComments(readFileSync(join(projectRoot, filePath), 'utf8'))
        for (const match of code.matchAll(relativeImportPattern)) {
          const target = join(dirname(filePath), match[1])
          // 唯一的口子:runtime 指向内部会话模块(`scripts/lib/backend-public-boundary.mjs` 的 `privateSessionFiles`)。
          // 那条门规定它们**不许有 exports 键**,所以没有包说明符可写,只能相对 import —— 与包根下的脊柱文件一样。
          if (subtree === 'runtime' && isPrivateSessionModule(target)) continue
          if (target !== relativeDirectory && !target.startsWith(`${relativeDirectory}/`)) {
            escapes.push(`${filePath} -> ${match[1]}`)
          }
        }
      }
    }
    expect(escapes).toEqual([])
  })

  /**
   * I1(docs/design/structural-debt-plan-2026-08.md §0b.3):**一个领域一个家**。
   *
   * 病根是"一个领域被横切成三片,其中一片叫 app" —— 读代码的人看见 `plugins/`
   * 出现在三棵树里,不知道该找哪一个。P3'd 把装配层变成 `packages/backend` 之后,
   * 这条不变量可以被机械地守住:**backend 包根的目录名不得与 runtime 顶层目录名
   * 重名**。(从前装配层的接线子目录不参与比对;③-收尾 C(2026-10-02)起那个目录整个撤掉,
   * 接线与产品逻辑同住 `runtime/<d>/`,排除名单里那一格随之删去。)
   *
   * 当前豁免的是 P3'b 待合并的厚孪生。**这是棘轮:只许缩,不许长。**
   * 每摘掉一个就从这张表里删一行,表空了就把整张表删掉。
   */
  it('I1: keeps one home per domain — backend package root does not shadow a runtime domain', () => {
    // P3'b 逐个摘除(厚孪生:两边都有真代码,合并要逐文件判定契约/实现/接线)。
    // P3'b-A(2026-08-21)摘掉 logging / headless / mcp / voice / music 五个:
    // 逻辑归 `runtime/<d>`,撞脊柱的接线归当时装配层的接线子目录,两种去向都离开包根。
    // P3'b-B(2026-08-21)摘掉 collab / providers / toolkit 三个;providers 的
    // 三件绑定件(bound-fetch / request-dump / ai-settings-compose)留在包根,
    // 但目录改名 `provider-binding/` —— 它们是被依赖的脊柱件,不是接线。
    // P3'c(2026-08-21)摘掉最后一个 `plugins`:10 件进 `runtime/plugins/`
    // (与 core 同名的按 I2 带角色改名),17 件进 `backend/runtime/plugins/`。
    //
    // **表空了,但断言留着** —— 它现在守的是"不许再长回来":任何新的包根目录
    // 只要与 runtime 顶层同名就直接红,想豁免必须先在这里写一行理由。
    const pendingThickTwins = new Set<string>([])
    const runtimeDomains = new Set(topLevelDirectories('packages/backend/runtime'))
    // 合包(第②步)以后包根多了三棵原样搬进来的子树 `core/`、`runtime/`、`gateway/`:它们是层,不是领域,
    // 不参与比对(`runtime` 子树的顶层目录正是这里拿来比的领域表)。
    const collisions = topLevelDirectories('packages/backend')
      .filter(name => !['core', 'runtime', 'gateway'].includes(name))
      .filter(name => runtimeDomains.has(name) && !pendingThickTwins.has(name))
    expect(collisions).toEqual([])
  })

  /**
   * I2(docs/design/structural-debt-plan-2026-08.md §0b.3):**一个概念一个文件名**。
   *
   * I1 守的是目录,I2 守的是目录里的文件:同一个领域名下,`packages/backend/core/<d>/x.ts`
   * 与 `packages/backend/runtime/<d>/x.ts` 同时存在,读代码的人搜 `x.ts` 会拿到
   * 两个结果、且看不出哪个是契约哪个是实现。判例(P3'a / P3'b / P3'c):进产品层的
   * 那一半按**角色**改名 —— 绑到进程内单例的叫 `<name>-bound.ts`,说跨进程词汇的叫
   * `<name>.wiring.ts`;两者同时成立时 `.wiring` 优先(不叠后缀)。
   *
   * 三条豁免不参与比对:`index.ts`(每个目录都有一个 barrel,同名是结构而非碰撞)、
   * `types.ts`(同上,类型面)、`__tests__/**`(测试跟着被测者走,两棵树各测各的)。
   *
   * **这是棘轮:allowlist 只许缩。** 每条都注明归哪一期清理。
   */
  it('I2: keeps one file name per concept — core and runtime do not shadow each other inside a domain', () => {
    const allowed = new Set<string>([
      // (`mcp/manager.ts` 那一格 2026-10-02 摘掉:core 那半并进了 `runtime/mcp/kernel/manager.ts`,
      // core 侧的 mcp 目录不存在了,两个 manager 现在同住一个领域、分住 kernel/ 与领域根,不再是 I2 要守的跨层同名。)
      // `storage/{file-storage,paths}.ts` 与 `tools/diff-hunks.ts` 三格随去 core 批 1(2026-10-03)摘掉:core 的 storage、
      // tools 两个目录并进了 runtime,core 那一半按内容改名(`file-storage-base.ts` / `store-layout.ts` /
      // `diff-hunk-json.ts`),与产品那一半同住一个目录、不再同名。表空了,断言留着守「不许再长回来」。
    ])
    // 第四条豁免,是**规则**而不是名字:内置插件的产品层实现文件名 = 插件 id
    // (`scripts/headless-boundary-check.ts` 的 `checkPluginLogicStaysOutOfHostAssembly`
    // 按 `backend/runtime/plugins/builtin/<id>.ts` 逐个反查
    // `runtime/plugins/<id>.ts`)。那个名字不是自由变量,所以它不参与 I2 ——
    // 一个插件的 core 侧内核与它的产品侧实现同名,是那条硬判据的直接后果。
    // 这里从插座目录现算,不写死任何插件名。
    const builtinPluginFiles = new Set(
      readdirSync(join(projectRoot, 'packages/backend/runtime/plugins/builtin'), { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
        .map(entry => `plugins/${entry.name}`),
    )
    const coreDomains = new Set(topLevelDirectories('packages/backend/core'))
    const collisions: string[] = []
    for (const domain of topLevelDirectories('packages/backend/runtime')) {
      if (!coreDomains.has(domain)) continue
      const coreFiles = new Set(domainSourceFiles(join('packages/backend/core', domain)))
      for (const file of domainSourceFiles(join('packages/backend/runtime', domain))) {
        if (!coreFiles.has(file)) continue
        const base = file.split('/').pop()
        if (base === 'index.ts' || base === 'types.ts') continue
        const key = `${domain}/${file}`
        if (allowed.has(key) || builtinPluginFiles.has(key)) continue
        collisions.push(key)
      }
    }
    expect(collisions.sort()).toEqual([])
  })

  // ③-收尾 C(2026-10-02):从「只依赖 core」放宽成「core + `@shared`(含 `@shared/ipc`)」—— shared 是
  // server ↔ client 的契约,后端引用它是合理的(网关生命周期端口 `gateway/lifecycle-port.ts` 的形状就是
  // `@shared/ipc/gateway.js` 上那八对类型)。这条本来就不禁 `@shared`,改的是名字与理由;禁令照旧。
  it('keeps packages/backend/gateway depending on core and @shared only', () => {
    expect(findForbiddenReferences('packages/backend/gateway', [
      ...hostOnlyPatterns,
      /window\.electronAPI/,
      appSourceImportPattern,
      importOf('@onething/backend/runtime'),
    ])).toEqual([])
  })

  it('keeps the server host independent from Electron host code', () => {
    // apps/web(Vue 浏览器构建)于 2026-09-04 随 Vue 宿主退役;浏览器壳现在是 apps/desktop-react 的 web 模式。
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
      'codex', 'acp', 'deepseek', 'gemini',
      'openai-compatible', 'qwen', 'zhipu', 'github-copilot', 'openrouter',
    ]
    const idComparison = new RegExp(
      `(providerId|provider\\.id|providerType)\\s*===\\s*['"](${providerNames.join('|')})['"]`,
    )
    const namedKnob = /\b(zhipuApiMode|qwenApiMode|qwenRegion|codexNativeTools|codexRefreshOAuthToken|codexRequestDumper)\b/

    // Comments are stripped first: the point is that no code branches on a
    // provider, not that the history cannot be written down next to it.
    expect(findForbiddenReferencesInCode('packages/backend/runtime/agent-loop', [idComparison, namedKnob])).toEqual([])
    expect(findForbiddenReferencesInCode('packages/backend/runtime/engine', [idComparison, namedKnob])).toEqual([])
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
      'packages/client',
      'apps/desktop-react/src',
      'apps/server/src',
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

/** 领域目录下的源文件相对路径。`__tests__` 不参与 I2 的比对。 */
function domainSourceFiles(relativeDirectory: string): string[] {
  const out: string[] = []
  const walk = (absolute: string, prefix: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (skippedDirectories.has(entry.name)) continue
      const next = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(absolute, entry.name), next)
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(next)
    }
  }
  walk(join(projectRoot, relativeDirectory), '')
  return out
}

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
