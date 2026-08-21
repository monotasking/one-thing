/**
 * `file-pick` 的对话框层(B 期,用户壁纸)。
 *
 * 闸与拷贝各有各的测试(core 的 file-pick.test.ts / 装配层的 file-import.test.ts),
 * 这里钉的是**这一层自己的三条**:
 *  1. 取消 = `canceled`,**不是**错误,也不触发拷贝(插件根本不被叫醒);
 *  2. 对话框挂在发起点击的那个窗口上,过滤器与 accept 同源;
 *  3. 回给 renderer 的东西里**没有用户选中的路径**。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}))

vi.mock('@onething/backend/plugins/file-import.js', () => ({
  importPluginFile: vi.fn(),
}))

const { pickPluginFileOnDesktop } = await import('../file-pick.js')

const SOURCE = '/Users/someone/Pictures/Holiday Photo.png'

function deps(overrides: Record<string, unknown> = {}) {
  return {
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [SOURCE] })),
    fromWebContents: vi.fn(() => ({ id: 7 })),
    importFile: vi.fn(() => ({
      ok: true as const,
      result: { path: 'storage:imports/HolidayPhoto.png', name: 'HolidayPhoto.png', size: 42 },
    })),
    ...overrides,
  } as never
}

describe('pickPluginFileOnDesktop', () => {
  it('拷贝成功时只回一个地址 —— 用户选中的路径不过 renderer 的手', async () => {
    const d = deps()
    const response = await pickPluginFileOnDesktop({ pluginId: 'ink' }, { fake: 'sender' }, d)
    expect(response).toEqual({ path: 'storage:imports/HolidayPhoto.png', name: 'HolidayPhoto.png', size: 42 })
    expect(JSON.stringify(response)).not.toContain(SOURCE)
    expect(JSON.stringify(response)).not.toContain('Pictures')
  })

  it('取消 = canceled,不是错误,也不拷贝', async () => {
    const d = deps({ showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) })
    expect(await pickPluginFileOnDesktop({ pluginId: 'ink' }, {}, d)).toEqual({ canceled: true })
    expect((d as never as { importFile: { mock: { calls: unknown[] } } }).importFile.mock.calls).toHaveLength(0)
  })

  it('对话框挂在发起点击的那个窗口上,过滤器与 accept 同源', async () => {
    const d = deps() as never as {
      showOpenDialog: { mock: { calls: unknown[][] } }
      fromWebContents: { mock: { calls: unknown[][] } }
    }
    const sender = { id: 'settings-window' }
    await pickPluginFileOnDesktop({ pluginId: 'ink', accept: ['png', 'webp'], label: 'Choose wallpaper' }, sender, d as never)
    expect(d.fromWebContents.mock.calls[0][0]).toBe(sender)
    const [parent, options] = d.showOpenDialog.mock.calls[0] as [unknown, { title: string; filters: Array<{ extensions: string[] }> }]
    expect(parent).toEqual({ id: 7 })
    expect(options.title).toBe('Choose wallpaper')
    expect(options.filters[0].extensions).toEqual(['png', 'webp'])
  })

  it('accept 里的越权扩展名不会漏进对话框过滤器', async () => {
    const d = deps() as never as { showOpenDialog: { mock: { calls: unknown[][] } } }
    await pickPluginFileOnDesktop({ pluginId: 'ink', accept: ['exe'] }, {}, d as never)
    const [, options] = d.showOpenDialog.mock.calls[0] as [unknown, { filters: Array<{ extensions: string[] }> }]
    expect(options.filters[0].extensions).not.toContain('exe')
  })

  it('闸不过时把那句人话原样带回来', async () => {
    const d = deps({ importFile: vi.fn(() => ({ ok: false as const, reason: 'That file is too large (20.0 MB).' })) })
    expect(await pickPluginFileOnDesktop({ pluginId: 'ink' }, {}, d))
      .toEqual({ error: 'That file is too large (20.0 MB).' })
  })

  it('没有 pluginId 就不拉对话框', async () => {
    const d = deps() as never as { showOpenDialog: { mock: { calls: unknown[][] } } }
    expect(await pickPluginFileOnDesktop({ pluginId: '' }, {}, d as never))
      .toEqual({ error: 'That file could not be imported.' })
    expect(d.showOpenDialog.mock.calls).toHaveLength(0)
  })
})
