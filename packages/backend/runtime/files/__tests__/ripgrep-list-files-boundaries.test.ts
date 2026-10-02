/**
 * `listOnethingRipgrepFiles` 的**边界**(09-07 事故第三条修)。
 *
 * 事故原样:搜一个词之后两条 `rg --files --follow --no-ignore` 挂在 462% CPU、
 * 415GB 虚拟内存上,清空输入框也不死 —— 因为那只生成器既不收 `signal`、也没有
 * `finally`、从不 `kill`。消费方 `break` 之后它只是不再读 stdout,进程照跑。
 *
 * 所以这一组用**真进程**验,不用假件:临时目录里放一个叫 `rg` 的壳脚本,`pathEnv`
 * 指向那个目录,于是 `getOnethingRipgrepPath` 就找到它。断言是「那个 pid 真的没了」
 * —— `process.kill(pid, 0)` 抛 ESRCH。假的 `kill()` spy 证不了这件事。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listOnethingRipgrepFiles,
  resetOnethingRipgrepRuntimeForTests,
} from '../ripgrep.js'

/**
 * 无视参数、吐三行、**然后彻底安静下去,永不结束**。
 *
 * 「吐完就安静」不是省事,是这一组的**实验条件**:09-07 那两条挂死的 rg 正是这一形
 * ——`for await` 停在 `await` 上,消费方一行都收不到,于是「消费方 break / 生成器
 * return」那条自愈路径**永远走不到**。只有一条明确的 `kill()` 能把它停下来。
 * (吐个不停的那种反而证不出什么:随便谁把 stdout 一 destroy,它就自己 SIGPIPE 死了。)
 */
const QUIET_RG = `#!/bin/sh
echo "file-1.ts"
echo "file-2.ts"
echo "file-3.ts"
while true; do sleep 0.2; done
`

let binDir: string
let workDir: string
let spawned: ReturnType<typeof nodeSpawn>[] = []

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function adapters() {
  return {
    pathEnv: binDir,
    platform: process.platform,
    logger: { log: () => undefined, error: () => undefined },
    // 真 spawn,只是顺手把孩子记下来 —— 断言要的是它的 pid。
    spawn: ((...args: Parameters<typeof nodeSpawn>) => {
      const child = nodeSpawn(...args)
      spawned.push(child)
      return child
    }) as typeof nodeSpawn,
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 杀掉之后进程表要一小会儿才收尸;给它几拍。 */
async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i += 1) {
    if (!alive(pid)) return true
    await delay(20)
  }
  return false
}

beforeEach(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-bin-'))
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-work-'))
  const shim = path.join(binDir, 'rg')
  fs.writeFileSync(shim, QUIET_RG)
  fs.chmodSync(shim, 0o755)
  spawned = []
  resetOnethingRipgrepRuntimeForTests()
})

afterEach(() => {
  for (const child of spawned) {
    try {
      child.kill('SIGKILL')
    } catch {
      // 已经没了。
    }
  }
  resetOnethingRipgrepRuntimeForTests()
  fs.rmSync(binDir, { recursive: true, force: true })
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('listOnethingRipgrepFiles 的边界(真进程)', () => {
  it('消费方 break 之后那条 rg 没了', async () => {
    const seen: string[] = []
    for await (const line of listOnethingRipgrepFiles({ cwd: workDir }, adapters())) {
      seen.push(line)
      // 「够了」由消费方表达 —— 而 break 现在等于杀进程。
      if (seen.length >= 2) break
    }
    expect(seen.length).toBe(2)
    const pid = spawned[0]?.pid
    expect(pid).toBeTypeOf('number')
    /*
     * **这一条不是 `kill()` 的反证**,说清楚免得下一个人误读:`for await` 被 break
     * 时 Node 自己会 destroy 那条 stdout,子进程随即 SIGPIPE 而死 —— 把 `kill()`
     * 整个挖掉这一条照样绿。它守的是「break 之后不会留下东西」这个**结果**,
     * 而 `kill()` 真正不可替代的场合在下一条(进程安静下去、没人 destroy 得了它)。
     */
    expect(await waitDead(pid!)).toBe(true)
  })

  it('**已经安静下去**的进程被 abort 停掉 —— 这一条才是 `kill()` 的反证', async () => {
    const controller = new AbortController()
    const seen: string[] = []
    // 三行收完之后消费方就停在 `await` 上了(shim 不再吐东西),这时喊停。
    const timer = setTimeout(() => controller.abort(), 300)
    try {
      for await (const line of listOnethingRipgrepFiles(
        { cwd: workDir, signal: controller.signal },
        adapters(),
      )) {
        seen.push(line)
      }
    } finally {
      clearTimeout(timer)
    }
    /*
     * 反证:把 `kill` 变成 no-op(或摘掉 `signal.addEventListener('abort', onAbort)`)
     * → 这个 `for await` **永远不结束**,用例超时红。09-07 真机上那两条 462% CPU
     * 的 rg 就是停在这一形:没有人能把一个不再说话的子进程叫停。
     */
    expect(seen).toEqual(['file-1.ts', 'file-2.ts', 'file-3.ts'])
    const pid = spawned[0]?.pid
    expect(await waitDead(pid!)).toBe(true)
  })

  it('一进来就已经 abort 的话,一个进程都不起', async () => {
    const controller = new AbortController()
    controller.abort()
    const seen: string[] = []
    for await (const line of listOnethingRipgrepFiles(
      { cwd: workDir, signal: controller.signal },
      adapters(),
    )) {
      seen.push(line)
    }
    expect(seen).toEqual([])
    expect(spawned).toHaveLength(0)
  })

  it('消费方抛错也不留下东西(`finally` 兜的是一切退出方式)', async () => {
    const boom = new Error('consumer blew up')
    await expect((async () => {
      for await (const line of listOnethingRipgrepFiles({ cwd: workDir }, adapters())) {
        void line
        throw boom
      }
    })()).rejects.toBe(boom)
    const pid = spawned[0]?.pid
    expect(await waitDead(pid!)).toBe(true)
  })
})
