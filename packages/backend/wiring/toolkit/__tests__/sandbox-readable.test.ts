/**
 * 「读得到吗」——`createSandboxPolicy().readable`(2026-09-10 拍板的那一格)。
 *
 * 证的是**两把尺子确实是两把**:
 *   - `contains`(写根)只认工作目录那一个根,一个字没动;
 *   - `readable`(读根)认的是 `read` 工具判 `external_directory` 用的**同一张表**
 *     ——`getOnethingDefaultReadRoots`:接入目录 ∪ 笔记根 ∪ 下载目录,再并上写根。
 *
 * 假的只有「那几个根在哪」(临时目录 + 一份临时 `settings.json`);判据、归一、并表
 * 全是产品层那一份。**反证**:把 `readable` 的实现改成 `contains`,接入目录 / 笔记根 /
 * 下载目录三条当场红。
 *
 * store 隔离与全动态 import 的写法照 `packages/backend/__tests__/resource-dir.test.ts`:
 * 设置仓与会话仓在 **import 期**就够得着 store 根,所以 env 必须先于任何 import 落定。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SandboxPolicy } from '@onething/core/toolkit'

const previousStorePath = process.env.ONETHING_STORE_PATH
const storeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onething-sandbox-readable-')))
process.env.ONETHING_STORE_PATH = storeRoot

const workDir = path.join(storeRoot, 'work')
const connectedDir = path.join(storeRoot, 'connected')
const noteDir = path.join(storeRoot, 'notes')
const downloadsDir = path.join(storeRoot, 'downloads')

for (const dir of [workDir, connectedDir, noteDir, downloadsDir]) {
  fs.mkdirSync(dir, { recursive: true })
}
// 接入目录走**真**设置仓(`getConnectedDirectories()` 读的就是这一格),不是塞给
// 沙箱适配器 —— `readable` 自己会用 `getConnectedDirectoriesForSession` 覆盖那一格,
// 从适配器塞进去的接入目录根本到不了判据面前,那样的绿是假绿。
fs.writeFileSync(
  path.join(storeRoot, 'settings.json'),
  JSON.stringify({ tools: { connectedDirectories: [connectedDir] } }),
)

let policy: SandboxPolicy

beforeAll(async () => {
  const runtime = await import('@onething/runtime/tools/sandbox-runtime')
  runtime.resetOnethingToolSandboxRuntimeForTests()
  runtime.configureOnethingToolSandboxRuntime({
    getDefaultWorkingDirectory: () => workDir,
    getNoteDirectories: () => [noteDir],
    getHostPath: name => (name === 'downloads' ? downloadsDir : undefined),
  })
  const { createSandboxPolicy } = await import('../runner.js')
  policy = createSandboxPolicy()
})

afterAll(async () => {
  const runtime = await import('@onething/runtime/tools/sandbox-runtime')
  runtime.resetOnethingToolSandboxRuntimeForTests()
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

describe('createSandboxPolicy().readable —— 读根那把尺子', () => {
  it('工作目录 / 接入目录 / 笔记根 / 下载目录都读得到', () => {
    expect(policy.readable(path.join(workDir, 'a.txt'))).toBe(true)
    expect(policy.readable(path.join(connectedDir, 'b.md'))).toBe(true)
    expect(policy.readable(path.join(noteDir, 'c.md'))).toBe(true)
    expect(policy.readable(path.join(downloadsDir, 'd.zip'))).toBe(true)
    // 根自己也算在内(列一个目录问的正是这个路径本身)。
    expect(policy.readable(connectedDir)).toBe(true)
  })

  it('家目录里随便一条别的路径读不到 —— 读根宽,不是没有根', () => {
    expect(policy.readable(path.join(os.homedir(), 'onething-not-a-read-root', 'x.txt'))).toBe(false)
    expect(policy.readable('/')).toBe(false)
  })

  it('`contains` 是写根那把,没有跟着放宽', () => {
    expect(policy.contains(path.join(workDir, 'a.txt'))).toBe(true)
    // 三条读根,写根一条都不认 —— 两把尺子确实是两把。
    expect(policy.contains(path.join(connectedDir, 'b.md'))).toBe(false)
    expect(policy.contains(path.join(noteDir, 'c.md'))).toBe(false)
    expect(policy.contains(path.join(downloadsDir, 'd.zip'))).toBe(false)
  })
})
