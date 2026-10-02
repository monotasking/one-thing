import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OnethingScratchpadStore, type ScratchpadChangedPayload } from '../store.js'

let root: string
let changed: ScratchpadChangedPayload[]

function createStore() {
  return new OnethingScratchpadStore({
    getDefaultStorePath: () => root,
    notifyChanged: payload => changed.push(payload),
  })
}

async function pathExists(filePath: string): Promise<boolean> {
  return Boolean(await stat(filePath).catch(() => null))
}

describe('OnethingScratchpadStore', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'onething-scratchpad-store-'))
    changed = []
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('读一张从没写过的纸不会把文件创建出来', async () => {
    const document = await createStore().read('session-a')

    expect(document.content).toBe('')
    expect(document.version).toBe(0)
    expect(await pathExists(path.join(root, 'scratchpads'))).toBe(false)
  })

  it('写完再读拿回同一份内容,版本随文件走', async () => {
    const store = createStore()

    const written = await store.update('session-a', '# 想法\n先看这个')
    const read = await store.read('session-a')

    expect(read.content).toBe('# 想法\n先看这个')
    expect(read.version).toBe(written.version)
    expect(written.version).toBeGreaterThan(0)
    expect(await readFile(path.join(root, 'scratchpads', 'session-a.md'), 'utf-8'))
      .toBe('# 想法\n先看这个')
  })

  it('每次写都广播一次,带上写完之后的文档', async () => {
    const store = createStore()

    await store.update('session-a', 'one')
    await store.update('session-a', 'two')

    expect(changed).toHaveLength(2)
    expect(changed[1]).toMatchObject({ sessionId: 'session-a', document: { content: 'two' } })
  })

  it('自己写的那一发会被记下,watcher 拿它当回声跳过', async () => {
    const store = createStore()

    await store.update('session-a', 'mine')

    expect(store.wasSelfWrite(store.scratchpadPath('session-a'))).toBe(true)
    expect(store.wasSelfWrite(store.scratchpadPath('session-b'))).toBe(false)
  })

  it('remove 之后纸不在了,再读是空的', async () => {
    const store = createStore()
    await store.update('session-a', 'gone soon')

    await store.remove('session-a')

    expect(await pathExists(store.scratchpadPath('session-a'))).toBe(false)
    expect((await store.read('session-a')).content).toBe('')
  })

  it('remove 一张不存在的纸不报错', async () => {
    await expect(createStore().remove('never-existed')).resolves.toBeUndefined()
  })

  it('adopt 把纸搬到新会话名下,并广播新 id', async () => {
    const store = createStore()
    await store.update('draft-1', 'carried over')
    changed = []

    await store.adopt('draft-1', 'session-real')

    expect((await store.read('session-real')).content).toBe('carried over')
    expect(await pathExists(store.scratchpadPath('draft-1'))).toBe(false)
    expect(changed).toEqual([
      expect.objectContaining({ sessionId: 'session-real' }),
    ])
  })

  it('adopt 一张不存在的纸是静默的 no-op —— 不广播、不建空文件', async () => {
    const store = createStore()

    await store.adopt('nothing-here', 'session-real')

    expect(changed).toHaveLength(0)
    expect(await pathExists(store.scratchpadPath('session-real'))).toBe(false)
  })

  // sessionId 从 IPC 上来,直接被拼进文件路径 —— 这一条守的是**越狱**。
  it.each(['../escape', 'a/b', '..', '.', '', '/abs', 'has\\sep'])(
    '拒绝把 %j 当会话 id 拼进路径',
    (badId) => {
      expect(() => createStore().scratchpadPath(badId)).toThrow(/Invalid sessionId/)
    },
  )

  it('越狱的 id 到不了文件系统', async () => {
    const store = createStore()
    const outside = path.join(root, 'outside.md')
    await writeFile(outside, 'do not touch', 'utf-8')

    await expect(store.update('../outside', 'clobbered')).rejects.toThrow(/Invalid sessionId/)

    expect(await readFile(outside, 'utf-8')).toBe('do not touch')
  })
})
