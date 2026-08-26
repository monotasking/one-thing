/**
 * legacy 整文件会话的首触迁移 vs 在途写(1.3 的回归,S3w-3 批 6b 改口径)。
 *
 * 原始病灶不变:迁移读 legacy 文件的那一刻,如果有一次尚未落盘的 legacy 写还挂在
 * 慢盘上,迁移就会读到旧内容,而那次写随后又把 legacy 文件重建出来 —— 新数据永久
 * 落进无人读取的 backup 里。
 *
 * 修法从"先 await 排空在途写"换成了"**见到在途写就让这一轮**":批 6b 起迁移是
 * **同步**的(理由见 `migrateLegacySessionNow` 的注释:异步窗口里的事件会被丢),
 * 同步就 await 不了。让一轮的代价只是"这次冷加载仍读 legacy",而下一次冷加载
 * (写已落盘)迁的就是完整内容。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHybridSessionStorageDriver, type SessionStorageDriver } from '../storage-driver.js'

interface TestMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

interface TestSession {
  id: string
  name: string
  updatedAt: number
  messages: TestMessage[]
}

function session(id: string, messageIds: string[]): TestSession {
  return {
    id,
    name: id,
    updatedAt: 1700000000000,
    messages: messageIds.map((mid, i) => ({
      id: mid,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: mid,
      timestamp: 1700000000000 + i,
    })),
  }
}

describe('legacy→events migration vs in-flight write (1.3)', () => {
  let dir: string
  const legacyPath = (id: string) => path.join(dir, `${id}.json`)
  const eventsPath = (id: string) => path.join(dir, id, 'events.jsonl')

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-migrace-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('does not lose a message written while the legacy file is still in flight', async () => {
    // 磁盘起始:legacy 文件仅含 m1。
    fs.writeFileSync(legacyPath('s1'), JSON.stringify(session('s1', ['m1'])))

    // 用 gate 拦住第一次 legacy 写入,制造"在途写"。
    let releaseWrite: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      releaseWrite = resolve
    })
    let gatedOnce = false

    const driver: SessionStorageDriver<TestSession> = createHybridSessionStorageDriver<TestSession>({
      getSessionsDir: () => dir,
      getLegacySessionPath: legacyPath,
      newSessionFormat: () => 'jsonl',
      readJsonFile: (filePath, fallback) => {
        try {
          return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        } catch {
          return fallback
        }
      },
      writeJsonFileAsync: async (filePath, data) => {
        if (filePath === legacyPath('s1') && !gatedOnce) {
          gatedOnce = true
          await gate // 在真正写盘前挂起,模拟慢盘在途写
        }
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
        await fs.promises.writeFile(filePath, JSON.stringify(data), 'utf-8')
      },
      deleteJsonFile: filePath => fs.rmSync(filePath, { force: true }),
    })

    // 在途写:把 m2 追加进来(format 仍是 legacy,因为会话目录尚不存在)。写入被 gate 挂起。
    const inFlight = driver.write('s1', session('s1', ['m1', 'm2']), { kind: 'structural' })

    // 在途写还挂着时冷加载:**这一轮不迁**,读到的是盘上那份(只有 m1)。
    const duringFlight = driver.load('s1')
    expect(fs.existsSync(eventsPath('s1'))).toBe(false)
    expect(duringFlight?.messages.map(m => m.id)).toEqual(['m1'])

    // 放行在途写:它把 m1+m2 写进 legacy 文件。
    releaseWrite()
    await inFlight

    // 下一次冷加载才迁 —— 迁的是完整内容。关键回归:m2 不能丢。
    driver.load('s1')
    expect(fs.existsSync(eventsPath('s1'))).toBe(true)
    const imported = fs.readFileSync(eventsPath('s1'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
    expect(imported.map(record => record.data.message.id)).toEqual(['m1', 'm2'])
    expect(fs.existsSync(legacyPath('s1'))).toBe(false)
  })
})
