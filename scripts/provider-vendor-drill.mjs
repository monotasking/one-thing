#!/usr/bin/env node
// 陌生能力演练:加一家服务商,到底要动哪几处(`docs/design/architecture-direction-2026-10.md` §4 P5)。
//
// CLAUDE.md「加功能不许改骨架」那条法要求每个架构方案交卷前做一次陌生能力演练。这个脚本把 provider
// 的那一次演练做成**可以反复跑的**:
//
//   1. 在当前 HEAD 上开一个临时 git worktree(不碰你的工作区);
//   2. 放进一家虚构的服务商 `acme`(`scripts/provider-vendor-drill/acme/*.ts.txt` —— 档位与地址、环境变量、
//      认亲、目录别名、错误码说明、型号规则表、自己的思考线型、方言、运行时工厂、配额源、出厂种子,
//      每一种机制都用上);
//   3. 只做「加一家」允许做的事:`vendors/manifests.ts` 名册一行、`vendors/runtimes.ts` 名册一行、
//      壳的两份文案各一行;
//   4. 断言:改动的文件**恰好**是 `vendors/acme/` 加上这四个文件;node 侧 typecheck 零错;
//      `provider:gate` 里 acme 在自己家以外零命中;端到端演练测试(`acme-drill.test.ts.txt`)全绿 ——
//      通用代码对这家的每一问都答得出,真请求走它自己的方言、地址与思考线型;
//   5. 删掉临时 worktree。
//
// 这次演练**不**断言的事,写在这里免得被误读:加一家之后,冻住「今天的事实」的快照(vendor-facts、
// 出厂设置冻结、「恰好这几家」类列表测试)与「每份方言都在投递契约表里」的元测试**会**红 —— 它们是给搬家
// 保驾的门,新家要经评审重录 / 补一行测试,这是有意的,不算骨架耦合。
//
// 用法:node scripts/provider-vendor-drill.mjs        (约一两分钟)
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const drillDir = path.join(root, 'scripts/provider-vendor-drill')
const VENDORS = 'packages/onething-runtime/src/providers/vendors'
const ALLOWED_TOUCHES = new Set([
  `${VENDORS}/manifests.ts`,
  `${VENDORS}/runtimes.ts`,
  'apps/desktop-react/src/i18n/zh.ts',
  'apps/desktop-react/src/i18n/en.ts',
])

function run(cmd, args, cwd, { allowFail = false } = {}) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (allowFail) return `${error.stdout ?? ''}${error.stderr ?? ''}`
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${error.stdout ?? ''}${error.stderr ?? ''}`)
  }
}

function edit(file, transform) {
  const before = readFileSync(file, 'utf8')
  const after = transform(before)
  if (after === before) throw new Error(`演练没能改动 ${file} —— 名册的写法变了,请同步本脚本`)
  writeFileSync(file, after)
}

/** 在 `export const <name>` 那张数组表的末尾加一行。 */
function appendToList(source, name, row) {
  const start = source.indexOf(`export const ${name}`)
  if (start < 0) throw new Error(`找不到 ${name}`)
  const end = source.indexOf('\n]', start)
  return `${source.slice(0, end)}\n${row}${source.slice(end)}`
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
  const packages = { core: 'core', gateway: 'gateway', backend: 'backend', client: 'client', runtime: 'onething-runtime' }
  for (const [name, dir] of Object.entries(packages)) {
    symlinkSync(path.join(worktree, 'packages', dir), path.join(target, '@onething', name))
  }
}

const worktree = mkdtempSync(path.join(tmpdir(), 'onething-vendor-drill-'))
rmSync(worktree, { recursive: true, force: true })
const failures = []
try {
  run('git', ['worktree', 'add', '--detach', '--quiet', worktree, 'HEAD'], root)
  linkNodeModules(worktree)

  // ① 这一家的家
  const home = path.join(worktree, VENDORS, 'acme')
  mkdirSync(home)
  for (const file of readdirSync(path.join(drillDir, 'acme'))) {
    cpSync(path.join(drillDir, 'acme', file), path.join(home, file.replace(/\.txt$/, '')))
  }
  // ② 名册各一行
  edit(path.join(worktree, VENDORS, 'manifests.ts'), (s) =>
    appendToList(s.replace(/(import \{ \w+_MANIFEST \} from '\.\/[\w-]+\/manifest\.js'\n)(?!import \{ \w+_MANIFEST)/, `$1import { ACME_MANIFEST } from './acme/manifest.js'\n`), 'VENDOR_MANIFESTS', '  ACME_MANIFEST,'))
  edit(path.join(worktree, VENDORS, 'runtimes.ts'), (s) =>
    appendToList(s.replace(/(import \{ \w+_RUNTIME \} from "\.\/[\w-]+\/runtime\.js";\n)(?!import \{ \w+_RUNTIME)/, `$1import { ACME_RUNTIME } from "./acme/runtime.js";\n`), 'VENDOR_RUNTIMES', '\tACME_RUNTIME,'))
  // ③ 壳的文案
  for (const [lang, text] of [['zh', 'Acme 官方接口'], ['en', 'Official Acme API']]) {
    edit(path.join(worktree, `apps/desktop-react/src/i18n/${lang}.ts`), (s) =>
      s.replace(/(\n  'providers\.desc\.[\w-]+': [^\n]+\n)/, `$1  'providers.desc.acme': '${text}',\n`))
  }

  // 断言 1:动到的文件恰好是允许的那几处
  const changed = run('git', ['status', '--porcelain', '--untracked-files=all'], worktree)
    .split('\n').filter(Boolean).map((line) => line.slice(3))
  const outside = changed.filter((file) => !file.startsWith(`${VENDORS}/acme/`) && !ALLOWED_TOUCHES.has(file))
  if (outside.length > 0) failures.push(`改到了允许之外的文件:${outside.join(', ')}`)
  console.log(`[vendor-drill] 动到的文件(acme 家以外):${changed.filter((f) => !f.startsWith(`${VENDORS}/acme/`)).join(', ')}`)

  // 断言 2:typecheck
  const tsc = run('npx', ['tsc', '--noEmit', '-p', 'tsconfig.node.json', '--composite', 'false'], worktree, { allowFail: true })
  if (tsc.trim()) failures.push(`typecheck 不干净:\n${tsc.split('\n').slice(0, 20).join('\n')}`)
  else console.log('[vendor-drill] typecheck(node)零错')

  // 断言 3:尺子 —— acme 在自己家以外零命中
  const gate = run('node', ['scripts/provider-vendor-gate.mjs', '--list', '--verbose'], worktree)
  const acmeLine = gate.split('\n').find((line) => /^\s+\d+\s+acme$/.test(line))
  if (!acmeLine || !/^\s+0\s+acme$/.test(acmeLine)) failures.push(`acme 在自己家以外有命中:${acmeLine ?? '(名单里没认出 acme)'}`)
  else console.log('[vendor-drill] provider:gate:acme 在自己家以外 0 处')

  // 断言 4:端到端演练测试
  const testFile = path.join(worktree, 'packages/backend/__tests__/acme-drill.test.ts')
  cpSync(path.join(drillDir, 'acme-drill.test.ts.txt'), testFile)
  const vitest = run('npx', ['vitest', 'run', 'packages/backend/__tests__/acme-drill.test.ts'], worktree, { allowFail: true })
  if (!/Tests\s+\d+ passed/.test(vitest.replace(/\x1b\[[0-9;]*m/g, '')) || /failed/.test(vitest.replace(/\x1b\[[0-9;]*m/g, ''))) {
    failures.push(`演练测试没全绿:\n${vitest.replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(-30).join('\n')}`)
  } else {
    console.log('[vendor-drill] 端到端演练测试全绿')
  }
} finally {
  if (existsSync(worktree)) {
    run('git', ['worktree', 'remove', '--force', worktree], root, { allowFail: true })
    rmSync(worktree, { recursive: true, force: true })
  }
}

if (failures.length > 0) {
  console.error('[vendor-drill] failed:')
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('[vendor-drill] ok —— 加一家 = 它自己的目录 + 两份名册各一行 + 壳的文案(图标可选)')
