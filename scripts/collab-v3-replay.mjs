#!/usr/bin/env bun
/**
 * Collab v3 金重放:**本机手工对照**工具(不入测试)。
 *
 * 用途:把本机一间真实房的转录喂进 v3 的重放架,打印决策管线吐出的动词序列。
 * 单测里的 fixture 全是合成的(数据纪律:真实用户转录不入库),所以「真房上是什么
 * 样」只能这样看一眼 —— D1-D3 把真 Room/Agent/Referee 插进管线之后,这条命令
 * 就是新旧行为的肉眼对照面。
 *
 * ⚠️ **只读**。本脚本只 `readFileSync` 转录文件,不写任何文件、不改 ~/.onething、
 * 不起 server、不碰 store lock。跑它不需要先停 dev server。
 *
 * 用法(必须用 bun 跑 —— 它要直接 import TS 源码并走 tsconfig 的 @onething/* 路径):
 *   bun scripts/collab-v3-replay.mjs --list
 *   bun scripts/collab-v3-replay.mjs <sessionId | 会话目录 | messages.jsonl 路径>
 *   bun scripts/collab-v3-replay.mjs <…> --limit 40
 *
 * 会话根目录取 ONETHING_STORE_PATH,缺省 ~/.onething。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import {
  createCollabActorPassthroughPipeline,
  parseRoomTranscriptJsonl,
  replayRoomTranscript,
} from '../packages/backend/runtime/collab/actors/replay.ts'

const args = process.argv.slice(2)
const flags = new Set(args.filter(arg => arg.startsWith('--')))
const positionals = args.filter(arg => !arg.startsWith('--'))
const limitIndex = args.indexOf('--limit')
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : Infinity

const storeRoot = process.env.ONETHING_STORE_PATH || join(homedir(), '.onething')
const sessionsRoot = join(storeRoot, 'sessions')

if (flags.has('--help') || (positionals.length === 0 && !flags.has('--list'))) {
  console.log(readFileSync(new URL(import.meta.url), 'utf-8').split('*/')[0].replace(/^#![^\n]*\n/, ''))
  process.exit(flags.has('--help') ? 0 : 1)
}

if (flags.has('--list')) {
  listRooms()
  process.exit(0)
}

const target = positionals[0]
const { transcriptPath, roomId } = resolveTranscript(target)
if (!existsSync(transcriptPath)) {
  console.error(`[collab-v3-replay] 找不到转录:${transcriptPath}`)
  process.exit(1)
}

const transcript = parseRoomTranscriptJsonl(readFileSync(transcriptPath, 'utf-8'), roomId)
const pipeline = createCollabActorPassthroughPipeline()
const result = replayRoomTranscript({ transcript, pipeline })

console.log(`# room      ${roomId}`)
console.log(`# 转录      ${transcriptPath}`)
console.log(`# 消息      ${transcript.messages.length} 条(去重后 ${result.events.length},丢弃重复 ${result.duplicatesDropped})`)
console.log(`# 管线      ${pipeline.name}`)
console.log(`# 动词      ${result.verbs.length} 条`)
console.log('')
for (const line of result.lines.slice(0, Number.isFinite(limit) ? limit : undefined)) {
  console.log(line)
}
if (result.lines.length > limit) {
  console.log(`… 还有 ${result.lines.length - limit} 条(用 --limit 放宽)`)
}

/** `<id>` / 会话目录 / 直接给 messages.jsonl —— 三种写法都认。 */
function resolveTranscript(input) {
  if (input.endsWith('.jsonl')) {
    // 直接给文件时,房名取父目录名(会话目录就是会话 id),别把整条路径当 roomId
    return { transcriptPath: input, roomId: basename(dirname(input)) || basename(input) }
  }
  const asPath = existsSync(input) && statSync(input).isDirectory() ? input : join(sessionsRoot, input)
  return { transcriptPath: join(asPath, 'messages.jsonl'), roomId: input }
}

/** 列出本机 kind='room' 的会话。只读 meta.json。 */
function listRooms() {
  if (!existsSync(sessionsRoot)) {
    console.error(`[collab-v3-replay] 会话目录不存在:${sessionsRoot}`)
    return
  }
  const rows = []
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const metaPath = join(sessionsRoot, entry.name, 'meta.json')
    if (!existsSync(metaPath)) continue
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
      if (meta.kind !== 'room') continue
      rows.push({ id: entry.name, name: meta.name ?? '(未命名)', updatedAt: meta.updatedAt ?? 0 })
    } catch {
      // 坏 meta 直接跳过 —— 这是排障工具,不是修复工具
    }
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt)
  if (rows.length === 0) {
    console.log(`[collab-v3-replay] ${sessionsRoot} 下没有 kind='room' 的会话`)
    return
  }
  for (const row of rows) console.log(`${row.id}\t${row.name}`)
}
