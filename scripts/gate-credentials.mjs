#!/usr/bin/env node
/**
 * `gate:credentials` —— 第④步批 0「凭证归后端」的门(`docs/design/two-process-2026-10.md` §2.1 验收)。
 *
 * 把 `scripts/gate-credentials/entry.ts` 用主进程同一份 esbuild 配方(`shellEsbuildOptions`)打成单文件 cjs,
 * 在**系统 Node** 下跑一遍;探针只 import 产品自己的凭证模块,一项一项在临时 store 上跑,最后交回一行
 * `__GATE_CREDENTIALS_RESULT__` + JSON,这里逐项判。七项是什么写在探针文件头。
 *
 * 三条纪律:
 *  - **只用 node、`file` 档、临时 store**:子进程环境显式设 `ONETHING_CREDENTIALS_KEYRING=file` 与一间
 *    mkdtemp 出来的 `ONETHING_STORE_PATH`,不碰 `~/.onething`;
 *  - **绝不碰真钥匙串**:要测钥匙串那一档的两项用一只假的 `security` 脚本,探针在切档之前先断言命令已换;
 *  - 产物落 `node_modules/.cache/`(被 git 忽略),跑完删掉。
 *
 * 跑法:`bun run gate:credentials`(或 `node scripts/gate-credentials.mjs`)。退出码非零 = 红。
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import { shellEsbuildOptions } from '../apps/desktop-react/scripts/build-electron.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = join(repoRoot, 'node_modules', '.cache', 'onething-gate-credentials')
const bundleFile = join(bundleDir, 'probe.cjs')
const MARKER = '__GATE_CREDENTIALS_RESULT__'
const EXPECTED = ['①', '②', '③', '④', '⑤', '⑥', '⑦']

const LABELS = {
  '①': 'safeStorage 旧密文 → 迁移 → 主密钥信封,条目逐条相等',
  '②': '口令导出 → 换 store 导入 → 条目相等;口令不对被拒',
  '③': 'ONETHING_CREDENTIALS_KEYRING=none 下 credentialsStatus 答 none',
  '④': '钥匙串超时 → credentials:locked → unlockCredentials 重试成功',
  '⑤': '迁移后旧文件变成 .safestorage-backup,字节未变',
  '⑥': '另一个活着的后端在服务这个 store → 拒绝迁移',
  '⑦': 'security 挂住(假的慢命令)→ 有界时间内答 locked,不挂',
}

async function main() {
  mkdirSync(bundleDir, { recursive: true })
  await build({
    ...shellEsbuildOptions({
      entryPoints: { probe: join(repoRoot, 'scripts/gate-credentials/entry.ts') },
      outdir: bundleDir,
    }),
    logLevel: 'warning',
  })
  const store = mkdtempSync(join(tmpdir(), 'onething-gate-credentials-store-'))
  let failed = false
  try {
    const res = spawnSync(process.execPath, [bundleFile], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_CREDENTIALS_KEYRING: 'file',
      },
    })
    const stdout = res.stdout ?? ''
    const at = stdout.indexOf(MARKER)
    if (res.error || at < 0) {
      console.error(`[gate:credentials] 探针没交回结果(status=${res.status} signal=${res.signal ?? ''})`)
      console.error((res.stderr ?? '').slice(-4000))
      console.error(stdout.slice(-4000))
      process.exitCode = 1
      return
    }
    const checks = JSON.parse(stdout.slice(at + MARKER.length).split('\n')[0])
    const byId = new Map(checks.map(check => [check.id, check]))
    for (const id of EXPECTED) {
      const check = byId.get(id)
      if (!check) {
        failed = true
        console.log(`  FAIL ${id} ${LABELS[id]} —— 没有跑到`)
        continue
      }
      if (!check.ok) failed = true
      console.log(`  ${check.ok ? 'ok  ' : 'FAIL'} ${id} ${LABELS[id]}  (${check.detail})`)
    }
    const crash = byId.get('crash')
    if (crash) {
      failed = true
      console.log(`  FAIL 探针崩了:${crash.detail}`)
    }
  } finally {
    rmSync(store, { recursive: true, force: true })
    rmSync(bundleDir, { recursive: true, force: true })
  }
  if (failed) {
    console.log('[gate:credentials] RED')
    process.exitCode = 1
  } else {
    console.log('[gate:credentials] ok —— ① 迁移 / ② 导出导入 / ③ none 档 / ④ 锁定与重试 / ⑤ 备份字节 / ⑥ 拒绝动别人的文件 / ⑦ 钥匙串超时不挂 全绿')
  }
}

await main()
