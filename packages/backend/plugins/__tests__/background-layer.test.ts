/**
 * G 期验收(L2.5)的**宿主链路**部分:清单投影 → 胜出描述符 → 运行期调参 → 拆除。
 *
 * 判据与裁决本身在 `packages/core/plugins/__tests__/background.test.ts`;
 * 这里钉的是"装配层有没有把它们接对":
 *  1. 逐插件投影带四态(active / shadowed / inactive / invalid + reason);
 *  2. 胜出描述符挂在**清单响应**上(零新通道 —— renderer 已经在重拉这份清单);
 *  3. `updateBackground` 写下的内存态进得了投影,而且 manifest 缺省照旧兜底;
 *  4. 拆除撤层:停用 → 没有赢家;清运行期参数 → 回 manifest 缺省。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectOnethingPluginsForRenderer } from '@onething/runtime/plugins/plugin-list'
import { listOnethingPluginsForIpc } from '@onething/runtime/plugins/ipc-operations'

/** 装配层只从插件管理器的内存清单读声明 —— 换成假的就能走完整条宿主链路。 */
const managedPlugins: Array<{
  definition: { id: string; enabled: boolean; manifest: unknown; source?: string; dirPath?: string }
  loaded: boolean
  commands: string[]
}> = []
vi.mock('../manager.js', () => ({
  getPluginManager: () => (managedPlugins.length
    ? { getPlugins: () => managedPlugins, getRequestActions: () => [] }
    : null),
}))
const {
  clearAllPluginBackgroundParams,
  clearPluginBackgroundParams,
  getPluginBackgroundParams,
  getPluginBackgroundTable,
  setPluginBackgroundParams,
} = await import('../background.js')

function plugin(id: string, background: unknown, enabled = true) {
  return {
    definition: {
      id,
      enabled,
      source: 'user',
      dirPath: `/plugins/${id}`,
      manifest: {
        name: id,
        version: '1.0.0',
        contributes: background === undefined ? {} : { theme: { background } },
      },
    },
    loaded: true,
    commands: [],
  }
}

function setPlugins(...items: ReturnType<typeof plugin>[]): void {
  managedPlugins.length = 0
  managedPlugins.push(...items)
}

beforeEach(() => {
  managedPlugins.length = 0
  clearAllPluginBackgroundParams()
})

// ── 1. 清单投影的形状 ───────────────────────────

describe('清单投影带背景裁决', () => {
  it('四态逐条投影出来 —— 设置页据此说得出"这张背景为什么没出现"', () => {
    const projected = projectOnethingPluginsForRenderer([
      plugin('alpha', { image: 'a.png' }),
      plugin('zed', { image: 'z.png', opacity: 0.4 }),
      plugin('broken', { image: '../../secret.png' }),
      plugin('off', { image: 'o.png' }, false),
    ] as never)
    const byId = Object.fromEntries(projected.map(item => [item.id, item.contributes.background]))
    expect(byId.zed).toMatchObject({ status: 'active', image: 'z.png', opacity: 0.4 })
    expect(byId.alpha).toMatchObject({ status: 'shadowed', shadowedBy: 'zed' })
    expect(byId.broken?.status).toBe('invalid')
    expect(byId.broken?.reason).toBeTruthy()
    expect(byId.off?.status).toBe('inactive')
  })

  it('没声明背景的插件投影成 null(而不是缺字段)', () => {
    const projected = projectOnethingPluginsForRenderer([plugin('alpha', undefined)] as never)
    expect(projected[0].contributes.background).toBeNull()
  })
})

// ── 2. 胜出描述符挂在清单响应上 ──────────────────

describe('listOnethingPluginsForIpc 携带胜出背景', () => {
  it('赢家带完整 URL 与钳制后的参数;停用即撤层', async () => {
    setPlugins(plugin('ink-brand', { image: 'bg.svg', darkImage: 'bg-dark.svg', opacity: 0.35 }))
    const result = await listOnethingPluginsForIpc({
      manager: { getPlugins: () => managedPlugins, getRequestActions: () => [] } as never,
      getPluginBackgroundParams,
    })
    expect(result).toMatchObject({
      success: true,
      background: {
        pluginId: 'ink-brand',
        imageUrl: 'onething-plugin://ink-brand/bg.svg',
        darkImageUrl: 'onething-plugin://ink-brand/bg-dark.svg',
        opacity: 0.35,
        blur: 0,
        fit: 'cover',
      },
    })

    setPlugins(plugin('ink-brand', { image: 'bg.svg' }, false))
    const disabled = await listOnethingPluginsForIpc({
      manager: { getPlugins: () => managedPlugins, getRequestActions: () => [] } as never,
      getPluginBackgroundParams,
    })
    expect((disabled as { background: unknown }).background).toBeNull()
  })
})

// ── 3. 运行期调参的内存态 ───────────────────────

describe('api.theme.updateBackground 的落点', () => {
  it('写下的参数进得了裁决,且逐字段合并(没给的项仍走 manifest 缺省)', () => {
    setPlugins(plugin('ink-brand', { image: 'bg.svg', opacity: 0.35, fit: 'contain' }))
    expect(getPluginBackgroundTable().winner).toMatchObject({ opacity: 0.35, fit: 'contain' })

    setPluginBackgroundParams('ink-brand', { opacity: 0.8 })
    expect(getPluginBackgroundTable().winner).toMatchObject({ opacity: 0.8, fit: 'contain' })

    setPluginBackgroundParams('ink-brand', { blur: 6 })
    expect(getPluginBackgroundTable().winner).toMatchObject({ opacity: 0.8, blur: 6, fit: 'contain' })
  })

  it('拆除撤参数:重新启用回 manifest 缺省,而不是用户早就忘了的旧值', () => {
    setPlugins(plugin('ink-brand', { image: 'bg.svg', opacity: 0.35 }))
    setPluginBackgroundParams('ink-brand', { opacity: 0.9 })
    expect(getPluginBackgroundTable().winner?.opacity).toBe(0.9)

    clearPluginBackgroundParams('ink-brand')
    expect(getPluginBackgroundParams('ink-brand')).toBeUndefined()
    expect(getPluginBackgroundTable().winner?.opacity).toBe(0.35)
  })

  /*
   * 恢复默认闭环(2026-08-10):撤回穿过的是**合并存**的内存态。
   * null 必须以 null 的样子躺在 map 里 —— 删键与"从来没设过"同形,而合并
   * 语义里这两件事必须可分,否则撤回会静默变成一次空操作。
   */
  it('image: null 撤回运行期图:回落 manifest 缺省 + darkImage 恢复,旋钮不动', () => {
    setPlugins(plugin('ink-brand', { image: 'bg.svg', darkImage: 'bg-dark.svg', opacity: 0.35 }))
    setPluginBackgroundParams('ink-brand', { image: 'storage:imports/paper.png', opacity: 0.8 })
    expect(getPluginBackgroundTable().winner).toMatchObject({
      imageUrl: 'onething-plugin://ink-brand/__storage__/imports/paper.png',
      darkImageUrl: 'onething-plugin://ink-brand/__storage__/imports/paper.png',
      opacity: 0.8,
    })

    setPluginBackgroundParams('ink-brand', { image: null })
    expect(getPluginBackgroundParams('ink-brand')).toMatchObject({ image: null, opacity: 0.8 })
    expect(getPluginBackgroundTable().winner).toMatchObject({
      imageUrl: 'onething-plugin://ink-brand/bg.svg',
      darkImageUrl: 'onething-plugin://ink-brand/bg-dark.svg',
      // 撤图不撤旋钮 —— 那是拆除面(clearPluginBackgroundParams)的活。
      opacity: 0.8,
    })
  })

  it('插件系统没装配起来时是空表,而不是抛', () => {
    managedPlugins.length = 0
    expect(getPluginBackgroundTable()).toEqual({ byPlugin: new Map(), winner: null })
  })
})

// ── 4. 图源的供给闸(与 webview 同一个根、同一批闸) ──

describe('onething-plugin:// 的静态根对背景图开放', () => {
  it('一个面板都没有的背景插件照样开根 —— 否则它的图当场 404', async () => {
    const { resolvePluginWebviewStaticRoot } = await import('../webview.js')
    setPlugins(plugin('ink-brand', { image: 'bg.svg' }))
    expect(resolvePluginWebviewStaticRoot('ink-brand')).toEqual({
      pluginId: 'ink-brand',
      root: '/plugins/ink-brand/webview',
    })
  })

  it('停用即刻停服;背景声明非法也不开根(画不出层就没有理由端出包目录)', async () => {
    const { resolvePluginWebviewStaticRoot } = await import('../webview.js')
    setPlugins(plugin('ink-brand', { image: 'bg.svg' }, false))
    expect(resolvePluginWebviewStaticRoot('ink-brand')).toBeNull()

    setPlugins(plugin('ink-brand', { image: '../../secret.png' }))
    expect(resolvePluginWebviewStaticRoot('ink-brand')).toBeNull()

    setPlugins(plugin('ink-brand', undefined))
    expect(resolvePluginWebviewStaticRoot('ink-brand')).toBeNull()
  })
})
