import { readdirSync, readFileSync, statSync } from 'node:fs'
import { isBuiltin } from 'node:module'
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
    // 第③步起只服务一个领域的内核并进 `runtime/<d>/kernel/`,身份仍是骨架,这两条 core 规则跟着它走。
    expect(['packages/backend/core', ...runtimeDomainKernelDirectories()].flatMap(directory => findForbiddenReferences(directory, [
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
    ]))).toEqual([])
  })

  it('keeps packages/backend/core at the bottom of the package hierarchy', () => {
    expect(findForbiddenReferences('packages/backend/core', [
      importOf('@onething/backend/runtime'),
      importOf('@onething/backend/gateway'),
    ])).toEqual([])
  })

  /**
   * 领域内核(`runtime/<d>/kernel/`)也在最底层:非测试文件只许 import 自己那个 kernel 目录(相对路径且落在
   * 目录内)、`@onething/backend/core/**` 与 node 内建 —— 同领域的产品文件、`wiring/`、脊柱、gateway 一概不许。
   * 检查器里同名的那条(`checkRuntimeDomainKernelImportClosure`)判的是同一句话。
   */
  it('keeps runtime/*/kernel at the bottom — only its own kernel, core, and node builtins', () => {
    const escapes: string[] = []
    for (const kernel of runtimeDomainKernelDirectories()) {
      for (const filePath of collectSourceFiles(kernel)) {
        if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(filePath)) continue
        const code = stripComments(readFileSync(join(projectRoot, filePath), 'utf8'))
        for (const match of code.matchAll(anyImportPattern)) {
          const specifier = match[1]
          if (specifier.startsWith('.')) {
            const target = join(dirname(filePath), specifier)
            if (target !== kernel && !target.startsWith(`${kernel}/`)) escapes.push(`${filePath} -> ${specifier}`)
          } else if (!/^@onething\/backend\/core(?:\/|$)/.test(specifier) && !isBuiltin(specifier)) {
            escapes.push(`${filePath} -> ${specifier}`)
          }
        }
      }
    }
    expect(escapes).toEqual([])
  })

  it('keeps packages/backend/runtime free of Electron, hosts, and gateway', () => {
    expect(findForbiddenReferences('packages/backend/runtime', [
      ...hostOnlyPatterns,
      /window\.electronAPI/,
      appSourceImportPattern,
      importOf('@onething/backend/gateway'),
    ])).toEqual([])
  })

  it('keeps the runtime product layer off the assembly package', () => {
    // P3'd: the assembly layer is its own workspace package
    // (`@onething/backend`, the former `runtime/app`). The runtime package
    // is host-independent product logic and must never depend on how it gets
    // assembled — the dependency points one way: product ← assembly ← hosts.
    //
    // 合包(server / client 拆分第②步,2026-10-02)以后 runtime 自己也住在 `@onething/backend` 里
    // (`runtime/` 子树),core 是 `core/` 子树。所以「不许碰装配层」改成按目录说:不许 import
    // `@onething/backend` 的脊柱(包根本身,以及 `core/`、`runtime/`、`gateway/` 三棵子树以外的任何子路径)。
    // 相对路径爬出 runtime 子树的情形由下面「三棵子树的相对 import 不出自己的子树」那条守。
    // `runtime/<d>/wiring/**` 是住在领域家里的装配层(第③步,2026-10-02),它 import 脊柱正是它的工作,豁免;
    // 反方向(产品层不许 import 它)由检查器的 `checkRuntimeProductDoesNotImportDomainWiring` 守。
    expect(findForbiddenReferences('packages/backend/runtime', [
      backendSpineImportPattern,
    ], { allowFile: isRuntimeDomainWiringPath })).toEqual([])
  })

  /**
   * 合包以前三个包之间隔着包边界,相对路径爬不进别的包(爬得进去也会在打包与 exports 上露馅);合包以后
   * `runtime/x.ts` 写一句 `../../wiring/y.js` 就能摸到脊柱,上面几条按包说明符判的规则看不见它。
   * 这一条把「包边界」换成等价的目录规则:三棵子树的非测试代码,相对 import 只许落在自己的子树里。
   * (今天一处越界都没有;测试与 `__tests__` 照旧不受包方向约束。)
   */
  it('keeps relative imports of core / runtime / gateway inside their own subtree', () => {
    const escapes: string[] = []
    for (const subtree of ['core', 'runtime', 'gateway']) {
      const relativeDirectory = `packages/backend/${subtree}`
      for (const filePath of collectSourceFiles(relativeDirectory)) {
        if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(filePath)) continue
        // `runtime/<d>/wiring/**` 按路径角色是脊柱(装配层),这条守的是**产品代码**别爬进脊柱,所以它不在射程里。
        // 这个豁免是被逼出来的,不是图省事:内部会话模块(`session/reads.ts`、`session/event-log.ts` …)按
        // `scripts/lib/backend-public-boundary.mjs` 的规矩**不许有 exports 键**,接线拿它们只能走相对路径,
        // 和包根下的脊柱文件一模一样。指向脊柱的其余 import 照样改成了包说明符。
        if (isRuntimeDomainWiringPath(filePath)) continue
        const code = stripComments(readFileSync(join(projectRoot, filePath), 'utf8'))
        for (const match of code.matchAll(relativeImportPattern)) {
          const target = join(dirname(filePath), match[1])
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
   * 重名**。`wiring/` 下不算 —— 那里放的是"接进后端"的薄接线,路径自带角色
   * (`backend/wiring/<d>` 与 `runtime/<d>` 天然不同名)。
   *
   * 当前豁免的是 P3'b 待合并的厚孪生。**这是棘轮:只许缩,不许长。**
   * 每摘掉一个就从这张表里删一行,表空了就把整张表删掉。
   */
  it('I1: keeps one home per domain — backend package root does not shadow a runtime domain', () => {
    // P3'b 逐个摘除(厚孪生:两边都有真代码,合并要逐文件判定契约/实现/接线)。
    // P3'b-A(2026-08-21)摘掉 logging / headless / mcp / voice / music 五个:
    // 逻辑归 `runtime/<d>`,撞脊柱的接线归 `backend/wiring/<d>`,两种去向都离开包根。
    // P3'b-B(2026-08-21)摘掉 collab / providers / toolkit 三个;providers 的
    // 三件绑定件(bound-fetch / request-dump / ai-settings-compose)留在包根,
    // 但目录改名 `provider-binding/` —— 它们是被依赖的脊柱件,不是接线。
    // P3'c(2026-08-21)摘掉最后一个 `plugins`:10 件进 `runtime/plugins/`
    // (与 core 同名的按 I2 带角色改名),17 件进 `backend/wiring/plugins/`。
    //
    // **表空了,但断言留着** —— 它现在守的是"不许再长回来":任何新的包根目录
    // 只要与 runtime 顶层同名就直接红,想豁免必须先在这里写一行理由。
    const pendingThickTwins = new Set<string>([])
    const runtimeDomains = new Set(topLevelDirectories('packages/backend/runtime'))
    // 合包(第②步)以后包根多了三棵原样搬进来的子树 `core/`、`runtime/`、`gateway/`:它们是层,不是领域,
    // 与 `wiring/` 一样不参与比对(`runtime` 子树的顶层目录正是这里拿来比的领域表)。
    const collisions = topLevelDirectories('packages/backend')
      .filter(name => !['wiring', 'core', 'runtime', 'gateway'].includes(name))
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
    const allowed = new Set([
      // mcp 归位的尾巴(P3'b-A):core 那半是 `CoreMcp*` 的连接账本,runtime 那半是
      // 产品侧的服务器管理器。两边都叫 manager,等 mcp 契约下沉时一并改名。
      'mcp/manager.ts',
      // storage 归位(P4b/c):core 那半是零依赖的存储原语,runtime 那半是产品的
      // store 路径与文件存储。两边同名两次。
      'storage/file-storage.ts',
      'storage/paths.ts',
      // tools/toolkit 归位的尾巴(R4b 删旧树时留下的):core 那半是 diff hunk 的
      // 数据结构,runtime 那半是产品侧的生成器。
      'tools/diff-hunks.ts',
    ])
    // 第四条豁免,是**规则**而不是名字:内置插件的产品层实现文件名 = 插件 id
    // (`scripts/headless-boundary-check.ts` 的 `checkPluginLogicStaysOutOfHostAssembly`
    // 按 `backend/wiring/plugins/builtin/<id>.ts` 逐个反查
    // `runtime/plugins/<id>.ts`)。那个名字不是自由变量,所以它不参与 I2 ——
    // 一个插件的 core 侧内核与它的产品侧实现同名,是那条硬判据的直接后果。
    // 这里从插座目录现算,不写死任何插件名。
    const builtinPluginFiles = new Set(
      readdirSync(join(projectRoot, 'packages/backend/wiring/plugins/builtin'), { withFileTypes: true })
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

  it('keeps packages/backend/gateway depending on core only', () => {
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
    expect(findForbiddenReferencesInCode('packages/backend/core/agent-loop', [idComparison, namedKnob])).toEqual([])
    expect(findForbiddenReferencesInCode('packages/backend/core/engine', [idComparison, namedKnob])).toEqual([])
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

/**
 * `@onething/backend` 的脊柱说明符:包根本身,或 `core` / `runtime` / `gateway` 三棵子树以外的任何子路径
 * (合包以前这就是 `importOf('@onething/backend')` 整个包)。
 */
const backendSpineImportPattern = /(?:from\s+['"]|import\s*\(\s*['"]|require\s*\(\s*['"])@onething\/backend(?:['"]|\/(?!(?:core|runtime|gateway)(?:\/|['"])))/

/** 任意说明符(import / export-from / 动态 import / require)。 */
const anyImportPattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g

/** `packages/backend/runtime/<d>/wiring/**`:住在领域家里的装配层。 */
function isRuntimeDomainWiringPath(filePath: string): boolean {
  return /^packages\/backend\/runtime\/[^/]+\/wiring\//.test(filePath)
}

/** 现有的领域内核目录(`packages/backend/runtime/<d>/kernel`),现算,不写死领域名。 */
function runtimeDomainKernelDirectories(): string[] {
  return topLevelDirectories('packages/backend/runtime')
    .map(domain => `packages/backend/runtime/${domain}/kernel`)
    .filter(directory => {
      try { return statSync(join(projectRoot, directory)).isDirectory() } catch { return false }
    })
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
