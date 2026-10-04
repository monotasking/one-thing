#!/usr/bin/env node
// 陌生能力演练:加一个全新的后端功能,到底要动哪几处(CLAUDE.md 第 3 行「加功能不许改骨架」;决策 D250 起)。
//
// `provider:drill` 演练的是「加一家服务商」;这一只演练的是**加一个功能** —— 后端重整(决策记录
// `docs/design/backend-structure-decisions-2026-10.md` D1–D249)交给功能的每一种能力都用上一遍:
//
//   1. 在当前 HEAD 上开一个临时 git worktree(不碰你的工作区与主 git 索引);node_modules 逐项链接主检出的,
//      `@onething/{backend,backend-client}` 指回 worktree 自己的包;
//   2. 放进一个虚构功能「秒表」`packages/backend/stopwatch/`(`scripts/feature-drill/stopwatch/**/*.txt`):
//        - 主入口 `stopwatch.ts`(R3 文件头、具名导出、按类分组)与内部文件 `stopwatch-state.ts`(N2 命名);
//        - 依赖下层功能 storage 的入口(状态落在 store 里的一只 JSON 文件),**不需要装配期建任何东西**;
//        - 一个开给界面的 RPC 域:`@shared/ipc/stopwatch.ts` 的 router 契约 + 第二入口 `stopwatch-client-api.ts`
//          (`defineClientApi` 自述一行);
//        - 一份测试(`__tests__/stopwatch-client-api.test.ts`):装上真名册,经 RPC 分发表(`POST /api/rpc` 背后
//          那张表)调到这个功能的四条操作,store 指到临时目录;
//   3. 只做「加一个功能」允许做的事:层次表一行、client-api 名册一行(加它的 import)、
//      `packages/backend/package.json` 的 exports 一把键,然后 `feature-map` 重生成功能地图;
//   4. 断言:改动的文件**恰好**是功能目录、契约文件与上面四个文件;node typecheck 零错;十三道结构门全绿;
//      演练测试全绿;名册测试(`http-server/__tests__/http-server-client-api-roster.test.ts`)多了一行照旧绿;
//   5. 删掉临时 worktree。
//
// 名册测试从前逐行冻住一份名册的副本,加一个域它就红 —— 那是第一次跑本演练时实测出来的唯一一只「多出来的
// 改动」。D252 把它改成从名册本身读、只断言名册注释里写明的顺序约束,所以它现在是本演练的断言之一。
//
// 用法:node scripts/feature-drill.mjs           (约两三分钟)
//       node scripts/feature-drill.mjs --keep    跑完不删 worktree,打出它的路径(排查用)
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const drillDir = path.join(root, 'scripts/feature-drill')
const keep = process.argv.includes('--keep')

const FEATURE = 'stopwatch'
const FEATURE_DIR = `packages/backend/${FEATURE}`
const CONTRACT = `packages/shared/ipc/${FEATURE}.ts`
const LAYER_TABLE = 'docs/audit/feature-layers-2026-10.json'
const ROSTER = 'packages/backend/http-server/http-server-client-api-roster.ts'
const BACKEND_PACKAGE = 'packages/backend/package.json'
const FEATURE_MAP = 'docs/architecture/feature-map.md'
/** 功能目录之外,加一个功能**允许**动的文件 —— 恰好这几只,多一只就是骨架没抽到位。 */
const ALLOWED_TOUCHES = new Set([CONTRACT, LAYER_TABLE, ROSTER, BACKEND_PACKAGE, FEATURE_MAP])
/** 结构门(CLAUDE.md §5),全部要绿。 */
const GATES = [
  'name:gate',
  'cycle:gate',
  'layer:gate',
  'entry:gate',
  'client-api:gate',
  'cohesion:gate',
  'feature-map:check',
  'boundary:gate',
  'assembly:gate',
  'provider:gate',
  'transport:gate',
  'log:gate',
  'session:gate',
]
const DRILL_TEST = `${FEATURE_DIR}/__tests__/${FEATURE}-client-api.test.ts`
/** 名册的装 / 拆 / 再装门:期望从名册本身读(D252),加一行不该让它红。 */
const ROSTER_TEST = 'packages/backend/http-server/__tests__/http-server-client-api-roster.test.ts'

function run(cmd, args, cwd, { allowFail = false } = {}) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    if (allowFail) return { failed: true, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${error.stdout ?? ''}${error.stderr ?? ''}`)
  }
}

/** 去掉终端颜色码(ESC [ … m)。用 fromCharCode 拼,免得正则字面量里出现控制字符。 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
function stripAnsi(text) {
  return text.replace(ANSI, '')
}

function edit(file, transform) {
  const before = readFileSync(file, 'utf8')
  const after = transform(before)
  if (after === before) throw new Error(`演练没能改动 ${file} —— 这张表的写法变了,请同步本脚本`)
  writeFileSync(file, after)
}

/** 在第一处匹配 `anchor` 的那一行之后插入 `line`。 */
function insertAfterLine(source, anchor, line) {
  const match = anchor.exec(source)
  if (!match) throw new Error(`找不到锚点 ${anchor}`)
  const end = source.indexOf('\n', match.index + match[0].length - 1)
  return `${source.slice(0, end + 1)}${line}\n${source.slice(end + 1)}`
}

/** 在第一处匹配 `anchor` 的那一行之前插入 `line`。 */
function insertBeforeLine(source, anchor, line) {
  const match = anchor.exec(source)
  if (!match) throw new Error(`找不到锚点 ${anchor}`)
  const start = source.lastIndexOf('\n', match.index) + 1
  return `${source.slice(0, start)}${line}\n${source.slice(start)}`
}

/** 在最后一处匹配 `anchor` 的那一行之后插入 `line`。 */
function insertAfterLastLine(source, anchor, line) {
  const matches = [...source.matchAll(anchor)]
  if (matches.length === 0) throw new Error(`找不到锚点 ${anchor}`)
  const last = matches[matches.length - 1]
  const end = source.indexOf('\n', last.index + last[0].length - 1)
  return `${source.slice(0, end + 1)}${line}\n${source.slice(end + 1)}`
}

/** 把模板目录原样复制过去,去掉 `.txt` 后缀。 */
function copyTemplates(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    const source = path.join(from, entry)
    if (statSync(source).isDirectory()) copyTemplates(source, path.join(to, entry))
    else cpSync(source, path.join(to, entry.replace(/\.txt$/, '')))
  }
}

/** worktree 用主检出的 node_modules,但 `@onething/*` 必须解析回 worktree 自己的包。 */
function linkNodeModules(worktree) {
  const source = path.join(root, 'node_modules')
  const target = path.join(worktree, 'node_modules')
  mkdirSync(target)
  for (const entry of readdirSync(source)) {
    if (entry === '@onething') continue
    symlinkSync(path.join(source, entry), path.join(target, entry))
  }
  mkdirSync(path.join(target, '@onething'))
  const packages = { backend: 'backend', 'backend-client': 'backend-client' }
  for (const [name, dir] of Object.entries(packages)) {
    symlinkSync(path.join(worktree, 'packages', dir), path.join(target, '@onething', name))
  }
}

const worktree = mkdtempSync(path.join(tmpdir(), 'onething-feature-drill-'))
rmSync(worktree, { recursive: true, force: true })
const failures = []
try {
  run('git', ['worktree', 'add', '--detach', '--quiet', worktree, 'HEAD'], root)
  linkNodeModules(worktree)
  const at = (file) => path.join(worktree, file)

  // ① 功能自己的目录(入口、内部文件、第二入口、测试)
  if (existsSync(at(FEATURE_DIR))) throw new Error(`${FEATURE_DIR} 已经存在 —— 换一个演练用的功能名`)
  copyTemplates(path.join(drillDir, FEATURE), at(FEATURE_DIR))
  // ② 界面那一侧的契约
  cpSync(path.join(drillDir, `shared-ipc-${FEATURE}.ts.txt`), at(CONTRACT))
  // ③ 层次表一行:站 L2(有自己的存储),排在 L2 那一段的末尾
  edit(at(LAYER_TABLE), (s) => insertAfterLastLine(s, /^ {4}\{ "feature": "[\w-]+", "layer": "L2",[^\n]*\},?$/gm,
    `    { "feature": "${FEATURE}", "layer": "L2", "why": "秒表:开始、记圈、停下、读数,状态落在 store 里的一只 JSON 文件(陌生能力演练放进来的虚构功能)。" },`))
  // ④ client-api 名册一行(连它的 import)
  edit(at(ROSTER), (s) => {
    const withImport = insertAfterLastLine(s, /^import \{ \w+_CLIENT_API \} from '\.\.\/[\w-]+\/[\w-]+-client-api[\w-]*\.js'$/gm,
      `import { STOPWATCH_CLIENT_API } from '../${FEATURE}/${FEATURE}-client-api.js'`)
    return insertAfterLine(withImport, /^ {2}SCRATCHPAD_CLIENT_API,$/m,
      '  // 演练:秒表。不依赖任何装配产物(状态在 store 文件里、首次用到才读),排在哪一格都行。\n  STOPWATCH_CLIENT_API,')
  })
  // ⑤ exports 一把键(按字母序,`stopwatch` 排在 `storage` 前面)
  edit(at(BACKEND_PACKAGE), (s) => insertBeforeLine(s, /^ {4}"\.\/storage": "\.\/storage\/storage\.ts",$/m,
    `    "./${FEATURE}": "./${FEATURE}/${FEATURE}.ts",`))
  // ⑥ 功能地图是生成物
  run('node', ['scripts/feature-map.mjs'], worktree)

  // 断言 1:动到的文件恰好是允许的那几处
  const changed = run('git', ['status', '--porcelain', '--untracked-files=all'], worktree)
    .split('\n').filter(Boolean).map((line) => line.slice(3))
  const outsideFeature = changed.filter((file) => !file.startsWith(`${FEATURE_DIR}/`))
  console.log(`[feature-drill] 功能目录里的文件:${changed.filter((f) => f.startsWith(`${FEATURE_DIR}/`)).join(', ')}`)
  console.log(`[feature-drill] 功能目录以外动到的文件:${outsideFeature.join(', ')}`)
  const extra = outsideFeature.filter((file) => !ALLOWED_TOUCHES.has(file))
  if (extra.length > 0) failures.push(`改到了允许之外的文件:${extra.join(', ')}`)
  const missing = [...ALLOWED_TOUCHES].filter((file) => !outsideFeature.includes(file))
  if (missing.length > 0) failures.push(`该动的文件没动到(演练的插入没生效):${missing.join(', ')}`)

  // 断言 2:typecheck
  const tsc = run('npx', ['tsc', '--noEmit', '-p', 'tsconfig.node.json', '--composite', 'false'], worktree, { allowFail: true })
  const tscOutput = typeof tsc === 'string' ? tsc : tsc.output
  if (tscOutput.trim()) failures.push(`typecheck 不干净:\n${tscOutput.split('\n').slice(0, 20).join('\n')}`)
  else console.log('[feature-drill] typecheck(node)零错')

  // 断言 3:结构门全绿
  for (const gate of GATES) {
    const result = run('npm', ['run', '--silent', gate], worktree, { allowFail: true })
    if (typeof result === 'string') {
      console.log(`[feature-drill] ${gate} 绿`)
    } else {
      failures.push(`${gate} 红:\n${stripAnsi(result.output).split('\n').filter(Boolean).slice(-15).join('\n')}`)
    }
  }

  // 断言 4:演练测试(经名册 + RPC 分发表调到这个功能),以及名册测试在多了一行之后照旧绿
  const vitest = run('npx', ['vitest', 'run', DRILL_TEST, ROSTER_TEST], worktree, { allowFail: true })
  const vitestOutput = stripAnsi(typeof vitest === 'string' ? vitest : vitest.output)
  if (typeof vitest !== 'string' || !/Tests\s+\d+ passed/.test(vitestOutput) || /\bfailed\b/.test(vitestOutput)) {
    failures.push(`演练测试没全绿:\n${vitestOutput.split('\n').slice(-30).join('\n')}`)
  } else {
    console.log('[feature-drill] 演练测试全绿:名册一行 → RPC 分发表 → start / lap / stop / read;名册测试照旧绿')
  }
} finally {
  if (keep) {
    console.log(`[feature-drill] --keep:worktree 留在 ${worktree}(用完 git worktree remove --force ${worktree})`)
  } else if (existsSync(worktree)) {
    run('git', ['worktree', 'remove', '--force', worktree], root, { allowFail: true })
    rmSync(worktree, { recursive: true, force: true })
  }
}

if (failures.length > 0) {
  console.error('[feature-drill] failed:')
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('[feature-drill] ok —— 加一个功能 = 它自己的目录 + 界面契约 + 层次表一行 + 名册一行 + exports 一把键(功能地图重生成)')
