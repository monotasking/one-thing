import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

describe('historical session execution preparation', () => {
  it.each(['json', 'jsonl'])('imports a real %s transcript and survives disposal before execution', async format => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-legacy-writable-'))
    const previous = process.env.ONETHING_STORE_PATH
    process.env.ONETHING_STORE_PATH = root
    vi.resetModules()
    const { installStoreSessionLayerForTest } = await import('../testing/store-layer.js')
    const { readSessionLogEventsSync, flushSessionEventLog } = await import('../event-log.js')
    const session = { id: `legacy-${format}`, name: 'Existing history', createdAt: 1, updatedAt: 2,
      messages: [
        { id: 'old-user', role: 'user', content: 'old question', timestamp: 1 },
        { id: 'old-assistant', role: 'assistant', content: 'old answer', timestamp: 2 },
      ] }
    const sessionsDir = path.join(root, 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    let originalPath: string
    if (format === 'json') {
      originalPath = path.join(sessionsDir, `${session.id}.json`)
      fs.writeFileSync(originalPath, JSON.stringify(session))
    } else {
      const dir = path.join(sessionsDir, session.id)
      fs.mkdirSync(dir)
      const { messages, ...meta } = session
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta))
      originalPath = path.join(dir, 'messages.jsonl')
      fs.writeFileSync(originalPath, JSON.stringify({ t: 'h', v: 1, sessionId: session.id }) + '\n'
        + messages.map((message, index) => JSON.stringify({ t: 'm', seq: index + 1, m: message })).join('\n') + '\n')
    }
    const original = fs.readFileSync(originalPath, 'utf8')
    let fixture = await installStoreSessionLayerForTest()
    try {
      expect(fixture.sessionLayer.reads.listMessages(session.id).messages.map(message => message.content))
        .toEqual(['old question', 'old answer'])
      expect(fixture.sessionLayer.reads.countMessages(session.id)).toBe(2)
      expect(fs.readFileSync(originalPath, 'utf8')).toBe(original)
      await fixture.sessionLayer.ensureWritable(session.id)
      // 这一句同时是**投影缓存**的回归位(工单 4 A4/C 追出来的):上面那次读已经
      // 建起了一份空投影,而 legacy 整文件会话的首触迁移是**直接写盘换入**的,
      // 追加观察者一无所知。缓存若把那份空的留着,这里读到的就是一段空历史。
      expect(fixture.sessionLayer.reads.listMessages(session.id).messages.map(message => message.content))
        .toEqual(['old question', 'old answer'])
      await fixture.dispose()
      fixture = await installStoreSessionLayerForTest()
      await fixture.sessionLayer.ensureWritable(session.id)
      expect(readSessionLogEventsSync(session.id).filter(event => event.type === 'message/imported')).toHaveLength(2)
      expect(fixture.sessionLayer.events.writer.write(session.id, 'run/start', {
        runId: 'new-run', kind: 'send', assistantMessageId: 'new-assistant', timestamp: 3,
      }, { surfaceOp: 'append' })).toBeDefined()
      await flushSessionEventLog(session.id)
      const preservedPath = format === 'json'
        ? path.join(sessionsDir, 'legacy-backup', `${session.id}.json`)
        : originalPath
      expect(fs.readFileSync(preservedPath, 'utf8')).toBe(original)
    } finally {
      await fixture.dispose()
      if (previous === undefined) delete process.env.ONETHING_STORE_PATH
      else process.env.ONETHING_STORE_PATH = previous
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
