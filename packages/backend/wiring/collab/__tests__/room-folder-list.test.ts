/**
 * 群 folder 的只读列目录(docs/design/agent-im-chat-ui.md §3.2「文件」块)。
 *
 * 这条通道存在的理由只有一个:folder 的位置是 app 层的推导
 * (workingDirectory ?? `<store>/rooms/<id>`),渲染进程只看得到房间会话上那个
 * **可能还没写下来**的 workingDirectory。所以这里钉的是四件事:
 *  1. 问对了地方就答"在哪儿 + 有什么",问错了地方(非房间会话)答"没有";
 *  2. **只读**:列一次不该把目录建出来(问"有什么"不能有副作用);
 *  3. 噪音不进列表(隐藏文件、node_modules/.git…)—— folder 是"随手放东西的
 *     地方",不是文件管理器;
 *  4. 浅层递归 + 上限:一个被设成代码仓库的 workingDirectory 不该把整棵树倒出来。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, { kind?: string; workingDirectory?: string }>(),
  storePath: '',
}))

vi.mock('../../../store.js', () => ({
  // drive 现在要渲染用户署名(v3 V1),因此读一次设置里的身份。
  getSettings: () => ({}),
  getSession: (id: string) => mocks.sessions.get(id),
  updateSessionWorkingDirectory: vi.fn(),
}))
vi.mock('@onething/runtime/storage', () => ({
  getOnethingStorePath: () => mocks.storePath,
}))

const { listCollabRoomFolder } = await import('../room-folder.js')

let tmpRoot = ''

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'room-folder-'))
  mocks.storePath = path.join(tmpRoot, 'store')
  mocks.sessions.clear()
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function writeFile(target: string, content = 'x'): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

describe('listCollabRoomFolder', () => {
  it('非房间会话:答"没有",不凭空捏一个目录出来', () => {
    mocks.sessions.set('chat-1', { kind: 'chat' })
    const listing = listCollabRoomFolder('chat-1')
    expect(listing.folder).toBeUndefined()
    expect(listing.missing).toBe(true)
    expect(listing.entries).toEqual([])
  })

  it('目录还没建过是空,而且列一次也不会把它建出来 —— 这是个只读通道', () => {
    mocks.sessions.set('room-1', { kind: 'room' })
    const listing = listCollabRoomFolder('room-1')
    const expected = path.join(mocks.storePath, 'rooms', 'room-1')

    expect(listing.folder).toBe(expected)
    expect(listing.missing).toBe(true)
    expect(fs.existsSync(expected)).toBe(false)
  })

  it('用户设过的工作目录以它为准,条目给相对路径 + 绝对路径 + 大小', () => {
    const folder = path.join(tmpRoot, 'site')
    writeFile(path.join(folder, '方案.md'), 'hello')
    mocks.sessions.set('room-1', { kind: 'room', workingDirectory: folder })

    const listing = listCollabRoomFolder('room-1')
    expect(listing.folder).toBe(folder)
    expect(listing.missing).toBe(false)
    expect(listing.entries).toHaveLength(1)
    expect(listing.entries[0].relativePath).toBe('方案.md')
    expect(listing.entries[0].path).toBe(path.join(folder, '方案.md'))
    expect(listing.entries[0].size).toBe(5)
  })

  it('浅层递归:两层内的文件进列表,更深的不进', () => {
    const folder = path.join(tmpRoot, 'site')
    writeFile(path.join(folder, 'a.txt'))
    writeFile(path.join(folder, 'one', 'b.txt'))
    writeFile(path.join(folder, 'one', 'two', 'c.txt'))
    writeFile(path.join(folder, 'one', 'two', 'three', 'd.txt'))
    mocks.sessions.set('room-1', { kind: 'room', workingDirectory: folder })

    const paths = listCollabRoomFolder('room-1').entries.map(entry => entry.relativePath).sort()
    expect(paths).toEqual(['a.txt', 'one/b.txt', 'one/two/c.txt'])
  })

  it('噪音不进列表:隐藏文件与 node_modules/.git 一律跳过', () => {
    const folder = path.join(tmpRoot, 'site')
    writeFile(path.join(folder, 'keep.md'))
    writeFile(path.join(folder, '.env'))
    writeFile(path.join(folder, 'node_modules', 'pkg', 'index.js'))
    writeFile(path.join(folder, '.git', 'HEAD'))
    mocks.sessions.set('room-1', { kind: 'room', workingDirectory: folder })

    expect(listCollabRoomFolder('room-1').entries.map(entry => entry.relativePath))
      .toEqual(['keep.md'])
  })

  it('最近改动的排前面 —— folder 是"刚放进来的东西"最有用', () => {
    const folder = path.join(tmpRoot, 'site')
    writeFile(path.join(folder, 'old.md'))
    writeFile(path.join(folder, 'new.md'))
    fs.utimesSync(path.join(folder, 'old.md'), new Date(1000), new Date(1000))
    fs.utimesSync(path.join(folder, 'new.md'), new Date(9_000_000), new Date(9_000_000))
    mocks.sessions.set('room-1', { kind: 'room', workingDirectory: folder })

    expect(listCollabRoomFolder('room-1').entries.map(entry => entry.relativePath))
      .toEqual(['new.md', 'old.md'])
  })
})
