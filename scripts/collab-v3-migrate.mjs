#!/usr/bin/env bun
/**
 * Collab v2 → v3 迁移器(docs/design/collab-actor-v3.md §4,D5)。
 *
 * 搬三样:房间账(`collab/<roomId>/state.json` → `actors/room.json`)、agent 的
 * 两个水位(执行会话 meta 的 `collab.seenMessageId` → `agents-v3/<id>/state.json`)、
 * 未读尾巴回填(游标之后的房间消息补成 posted 事件进信箱)。房间转录、看板、
 * 经历流(`agent-exec-*` 会话)**零迁移**,只做存在性校验并计入对账。
 *
 * 用法(必须用 bun 跑 —— 它要直接 import TS 源码并走 tsconfig 的 @onething/* 路径):
 *   bun scripts/collab-v3-migrate.mjs                      # dry-run(默认),只出报告
 *   bun scripts/collab-v3-migrate.mjs --dry-run
 *   bun scripts/collab-v3-migrate.mjs --execute             # 真跑
 *   bun scripts/collab-v3-migrate.mjs --store ~/.onething-test --execute
 *   bun scripts/collab-v3-migrate.mjs --json                # 报告出 JSON(给别的工具吃)
 *
 * ⚠️ **默认档是 dry-run**:迁移是一趟单向门,`--execute` 必须是打出来的那个词。
 * ⚠️ 执行前请先停掉 dev server / 桌面端 —— 迁移器写 `~/.onething` 下的账,
 *    另一个进程同时在写同一批文件时,后写的那个赢。
 *
 * 执行会先把 `<store>/collab/**` 整体拷进 `<store>/backup/collab-v2-<时间戳>/`。
 * **不备份 `sessions/`**:迁移一个字节都不写它,而全量快照会拖进几百 MB 会话。
 * 迁完落 marker `<store>/collab/v3-migrated.json`;marker 存在则整体跳过(幂等重入)。
 */
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flags = new Set(args.filter(arg => arg.startsWith('--')))

if (flags.has('--help') || flags.has('-h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf-8').split('*/')[0].replace(/^#![^\n]*\n/, ''))
  process.exit(0)
}

const unknown = [...flags].filter(flag => !['--dry-run', '--execute', '--store', '--json', '--help', '-h'].includes(flag))
if (unknown.length > 0) {
  console.error(`[collab-v3-migrate] 不认识的参数:${unknown.join(' ')}(--help 看用法)`)
  process.exit(2)
}

const storeIndex = args.indexOf('--store')
const storeArg = storeIndex >= 0 ? args[storeIndex + 1] : undefined
if (storeIndex >= 0 && (!storeArg || storeArg.startsWith('--'))) {
  console.error('[collab-v3-migrate] --store 后面要跟一个目录')
  process.exit(2)
}
// store 根必须在 import 之前钉住:`getOnethingStorePath` 每次现读 env,但迁移器
// 里的路径helper 是模块级函数,先 import 再改 env 也来得及 —— 早钉一步只是让
// 「这一趟动的是哪个 store」在日志第一行就写死。
if (storeArg) process.env.ONETHING_STORE_PATH = storeArg.replace(/^~(?=\/)/, homedir())

const dryRun = !flags.has('--execute')

const { migrateCollabToV3 } = await import(
  '@onething/backend/wiring/collab/actors/migrate.js'
)
const { formatCollabMigrationReport } = await import(
  '../packages/onething-runtime/src/collab/actors/migrate-rules.ts'
)

const report = await migrateCollabToV3({ dryRun })

if (flags.has('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  for (const line of formatCollabMigrationReport(report)) console.log(line)
  console.log('')
  if (report.skipped) {
    console.log(`[collab-v3-migrate] 已迁过 —— marker 在 ${join(report.storePath, 'collab', 'v3-migrated.json')}`)
  } else if (dryRun) {
    console.log('[collab-v3-migrate] dry-run:一个字节都没写。确认无误后加 --execute 真跑。')
  } else {
    console.log(`[collab-v3-migrate] 完成。备份在 ${report.backupDir}`)
  }
}

// 有房间迁失败时用非零退出码:这条命令会被人接在 `&&` 后面。
process.exit(report.totals.roomsFailed > 0 ? 1 : 0)
