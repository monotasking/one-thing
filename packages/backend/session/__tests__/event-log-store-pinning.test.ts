/**
 * §16.22:事件账本的落点在**同步段**就钉死,不许等队列回调再解析。
 *
 * 这是那次真机 store 污染的反证用例。原来的形状是:seq 在同步段分配、
 * `appendFile` 的路径却写在队列回调里,而那个路径一路走到
 * `getOnethingStorePath()` → `ONETHING_STORE_PATH || os.homedir()` —— 读的是
 * **回调跑到那一刻**的进程环境。测试用换 store(HOME / ONETHING_STORE_PATH)
 * 做隔离时,回调常常跨过恢复点,于是这条属于临时库的事件把字节写进了另一个库,
 * 而 seq 与 expectedBytes 还记在临时库那份 state 上 —— 两边都不报错,两边的账
 * 都错了(真机上表现为凭空插进来的行 / 断号)。
 *
 * 用例不 mock 任何东西:它就用真的 store 解析口,在 append 与 flush 之间把
 * `ONETHING_STORE_PATH` 换掉 —— 修前红(字节落进 B 库),修后绿。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const { appendSessionLogEvent, flushSessionEventLog, readSessionLogEvents, resetSessionEventLogCache } =
  await import('../event-log.js')

const SESSION = 'pinning-1'

let storeA = ''
let storeB = ''
let previousStorePath: string | undefined

function eventsPath(store: string): string {
  return path.join(store, 'sessions', SESSION, 'events.jsonl')
}

beforeEach(() => {
  previousStorePath = process.env.ONETHING_STORE_PATH
  storeA = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-pin-a-'))
  storeB = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-pin-b-'))
  // B 库里**同名会话的目录先摆好**:这正是真机的样子(那个会话在真机库里是
  // 存在的)。目录存在 = 旧代码那次跨库写会安安静静地成功,而不是 ENOENT ——
  // 用例要挡的就是"静悄悄写对了地方以外的地方"。
  fs.mkdirSync(path.join(storeB, 'sessions', SESSION), { recursive: true })
  process.env.ONETHING_STORE_PATH = storeA
  resetSessionEventLogCache()
})

afterEach(async () => {
  await flushSessionEventLog()
  resetSessionEventLogCache()
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  fs.rmSync(storeA, { recursive: true, force: true })
  fs.rmSync(storeB, { recursive: true, force: true })
})

describe('session event log store pinning', () => {
  it('lands the bytes in the store that allocated the seq, not the one live at flush time', async () => {
    expect(appendSessionLogEvent(SESSION, 'session/created', { sessionId: SESSION })).toBe(1)

    // 落盘还在队列上。此刻把进程的 store 换掉 —— 旧代码的回调会在这之后才解析
    // 路径,于是写进 B。
    process.env.ONETHING_STORE_PATH = storeB
    await flushSessionEventLog(SESSION)

    expect(fs.existsSync(eventsPath(storeB))).toBe(false)
    expect(fs.readFileSync(eventsPath(storeA), 'utf8')).toContain('session/created')
  })

  it('keeps a whole run of appends in one store when the store changes mid-flight', async () => {
    expect(appendSessionLogEvent(SESSION, 'session/created', { sessionId: SESSION })).toBe(1)
    process.env.ONETHING_STORE_PATH = storeB
    expect(
      appendSessionLogEvent(SESSION, 'user/message', {
        message: { id: 'u1', role: 'user', content: 'hi', timestamp: 1000 },
      } as never, { surfaceOp: 'append' }),
    ).toBe(2)
    await flushSessionEventLog(SESSION)

    expect(fs.existsSync(eventsPath(storeB))).toBe(false)
    // 读侧同样吃钉死的落点:换了 store 也读得回自己那本账。
    const events = await readSessionLogEvents(SESSION)
    expect(events.map(event => event.type)).toEqual(['session/created', 'user/message'])
  })
})
