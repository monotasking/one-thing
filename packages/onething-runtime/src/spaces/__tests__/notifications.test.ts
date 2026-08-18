/**
 * 空间数据变更订阅(批 B9-0)。
 *
 * 病根:设置窗与主窗是两个独立 BrowserWindow、两份 Pinia,设置窗写完凭证之后
 * 主窗那份缓存永远不知道 —— 用户 08-17 真机现象是「配好了 key,模型选择器里
 * 那个 provider 就是不出现,切走再切回空间才好」。
 *
 * 这一层只验**产品侧的订阅点**:两个落盘入口各叫一次、载荷带得对、通知失败不
 * 拖垮写入。广播(electron)与重拉(renderer store)各在自己那一层验。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeSpaceCredentials, resetSpaceCredentialsCacheForTests } from '../credentials.js'
import {
  notifySpaceDataChanged,
  resetSpaceDataListenersForTests,
  subscribeSpaceDataChanged,
  type SpaceDataChangedEvent,
} from '../notifications.js'
import { resetSpaceOverlayCacheForTests, writeSpaceOverlay } from '../overlay.js'
import { setRootDirForTests } from '../persistence.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'onething-spaces-notify-'))
  setRootDirForTests(tmpDir)
  resetSpaceOverlayCacheForTests()
  resetSpaceCredentialsCacheForTests()
  resetSpaceDataListenersForTests()
})

afterEach(async () => {
  setRootDirForTests(null)
  resetSpaceOverlayCacheForTests()
  resetSpaceCredentialsCacheForTests()
  resetSpaceDataListenersForTests()
  await fs.rm(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('subscribeSpaceDataChanged(批 B9-0)', () => {
  it('writeSpaceOverlay 落盘之后叫一次,载荷带 spaceId + kind', () => {
    const seen: SpaceDataChangedEvent[] = []
    subscribeSpaceDataChanged(event => seen.push(event))

    writeSpaceOverlay('work', { selectedModels: { deepseek: ['deepseek-chat'] } })

    expect(seen).toEqual([{ spaceId: 'work', kind: 'overlay' }])
  })

  it('writeSpaceCredentials 落盘之后叫一次(OAuth 登录也经这一处)', () => {
    const seen: SpaceDataChangedEvent[] = []
    subscribeSpaceDataChanged(event => seen.push(event))

    writeSpaceCredentials('work', {
      providers: {
        deepseek: {
          policy: 'single',
          entries: [{ id: 'e1', label: 'k', authType: 'apiKey', apiKey: 'sk-1', source: 'user' }],
        },
      },
    })

    expect(seen).toEqual([{ spaceId: 'work', kind: 'credentials' }])
  })

  it('退订之后不再收到', () => {
    const seen: SpaceDataChangedEvent[] = []
    const off = subscribeSpaceDataChanged(event => seen.push(event))
    off()
    writeSpaceOverlay('work', { connectedDirectories: ['/a'] })
    expect(seen).toEqual([])
  })

  it('一个监听器抛错不拖垮其他监听器,也不拖垮那次写入', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: string[] = []
    subscribeSpaceDataChanged(() => {
      throw new Error('boom')
    })
    subscribeSpaceDataChanged(event => seen.push(event.kind))

    // 写入本身必须成功返回 —— 通知失败只是少刷一次界面。
    const written = writeSpaceOverlay('work', { connectedDirectories: ['/a'] })
    expect(written.connectedDirectories).toEqual(['/a'])
    expect(seen).toEqual(['overlay'])
    expect(warn).toHaveBeenCalled()
  })

  it('notify 是纯广播:没有订阅者时什么也不做', () => {
    expect(() => notifySpaceDataChanged({ spaceId: 'work', kind: 'overlay' })).not.toThrow()
  })
})
