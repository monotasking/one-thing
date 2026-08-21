/**
 * R5.x-b 验收:描述树 v2。
 *
 * 每加一个原语要动**四处**(类型/校验/渲染/测试)—— 这份文件是校验与协议的
 * 那一半;渲染分支见 renderer 的 PluginPanelNode.v2.test.ts。两处由同一份节点
 * 清单驱动,漏一边就是"协议说支持,实现不支持"那类漂移。
 */
import { describe, expect, it } from 'vitest'
import {
  PANEL_MIN_REFRESH_INTERVAL_MS,
  PLUGIN_PANEL_PROTOCOL_VERSION,
  validatePluginPanelTree,
  type PluginPanelNode,
  type PluginPanelTree,
} from '@onething/core/plugins'

function treeOf(body: PluginPanelNode, extra: Partial<PluginPanelTree> = {}): PluginPanelTree {
  return { version: PLUGIN_PANEL_PROTOCOL_VERSION, body, ...extra }
}

function expectValid(body: PluginPanelNode): void {
  expect(validatePluginPanelTree(treeOf(body))).toBeNull()
}

function expectInvalid(body: unknown, fragment: string): void {
  expect(validatePluginPanelTree(treeOf(body as PluginPanelNode))).toContain(fragment)
}

describe('panel tree v2 — version gate', () => {
  it('v1 的树在 v2 宿主上照常通过(向后兼容)', () => {
    const v1 = {
      version: 1,
      body: { type: 'stack', children: [{ type: 'markdown', text: 'hi' }] },
    }
    expect(validatePluginPanelTree(v1)).toBeNull()
  })

  it('比宿主新的版本被拒', () => {
    const future = { version: PLUGIN_PANEL_PROTOCOL_VERSION + 1, body: { type: 'divider' } }
    expect(validatePluginPanelTree(future)).toContain('newer than this host supports')
  })
})

describe('panel tree v2 — new nodes', () => {
  it('table:合法通过;缺列/坏单元格被拒', () => {
    expectValid({
      type: 'table',
      columns: [{ key: 'file', label: '文件' }, { key: 'lines', label: '行数', width: 60 }],
      rows: [{ key: 'r1', cells: { file: 'a.ts', lines: 12, stale: false, note: null } }],
      emptyText: 'empty',
    })
    expectInvalid({ type: 'table', columns: [], rows: [] }, 'columns must be a non-empty array')
    expectInvalid(
      { type: 'table', columns: [{ key: 'a', label: 'A' }], rows: [{ key: 'r', cells: { a: { nested: true } } }] },
      'must be a string/number/boolean/null',
    )
  })

  it('tabs:body 递归校验且计深度', () => {
    expectValid({
      type: 'tabs',
      items: [
        { id: 'one', label: '一', body: { type: 'markdown', text: '1' } },
        { id: 'two', label: '二', body: { type: 'badge', text: 'ok' } },
      ],
    })
    expectInvalid({ type: 'tabs', items: [] }, 'items must be a non-empty array')
    expectInvalid(
      { type: 'tabs', items: [{ id: 'x', label: 'x', body: { type: 'nope' } }] },
      'type must be one of',
    )
  })

  it('progress:value 限 0–100,indeterminate 限布尔', () => {
    expectValid({ type: 'progress', value: 40, label: '执行中' })
    expectValid({ type: 'progress', indeterminate: true })
    expectInvalid({ type: 'progress', value: 101 }, 'between 0 and 100')
    expectInvalid({ type: 'progress', indeterminate: 'yes' }, 'indeterminate must be a boolean')
  })

  it('spinner / badge / code / divider', () => {
    expectValid({ type: 'spinner', label: '加载中' })
    expectValid({ type: 'spinner' })
    expectValid({ type: 'badge', text: 'idle', tone: 'success' })
    expectInvalid({ type: 'badge', text: '' }, 'text must be a non-empty string')
    expectValid({ type: 'code', text: 'const a = 1', language: 'ts' })
    expectInvalid({ type: 'code', text: 42 }, 'text must be a string')
    expectValid({ type: 'divider' })
  })
})

describe('panel tree v2 — URL scheme 白名单(表达力文档 §2.4)', () => {
  it('image 只允许 data: 与 https:', () => {
    expectValid({ type: 'image', url: 'https://example.com/a.png', alt: 'a' })
    expectValid({ type: 'image', url: 'data:image/png;base64,iVBOR', alt: 'a' })
    expectInvalid({ type: 'image', url: 'http://example.com/a.png', alt: 'a' }, 'scheme is not allowed')
    expectInvalid({ type: 'image', url: '//example.com/a.png', alt: 'a' }, 'scheme is not allowed')
    expectInvalid({ type: 'image', url: 'file:///etc/passwd', alt: 'a' }, 'scheme is not allowed')
  })

  it('link 只允许 https:/mailto:,或改走 actionId;javascript: 当场拒', () => {
    expectValid({ type: 'link', text: 'docs', url: 'https://example.com' })
    expectValid({ type: 'link', text: 'mail', url: 'mailto:a@b.c' })
    expectValid({ type: 'link', text: 'inline', actionId: 'open', payload: { id: 1 } })
    expectInvalid({ type: 'link', text: 'x', url: 'javascript:alert(1)' }, 'scheme is not allowed')
    expectInvalid({ type: 'link', text: 'x' }, 'needs a url or an actionId')
  })
})

describe('panel tree v2 — refreshIntervalMs(1Hz 上限)', () => {
  it('低于下限整树拒收;等于下限放行', () => {
    const body: PluginPanelNode = { type: 'badge', text: 'ok' }
    expect(validatePluginPanelTree(treeOf(body, { refreshIntervalMs: 500 })))
      .toContain(`>= ${PANEL_MIN_REFRESH_INTERVAL_MS}`)
    expect(validatePluginPanelTree(treeOf(body, { refreshIntervalMs: 1000 }))).toBeNull()
    expect(validatePluginPanelTree(treeOf(body, { refreshIntervalMs: Number.NaN })))
      .toContain('finite number')
  })
})

describe('panel tree v2 — new form controls', () => {
  function formWith(control: string, extra: Record<string, unknown> = {}) {
    return {
      type: 'form',
      fields: [{ key: 'k', label: 'L', control, ...extra }],
    } as unknown as PluginPanelNode
  }

  it('textarea / slider / date / color 不需要 options', () => {
    for (const control of ['textarea', 'slider', 'date', 'color']) {
      expectValid(formWith(control))
    }
  })

  it('checkbox-group / radio 与 select 同规:需要非空 options', () => {
    expectValid(formWith('checkbox-group', { options: ['a'] }))
    expectValid(formWith('radio', { options: ['a', 'b'] }))
    expect(validatePluginPanelTree(treeOf(formWith('checkbox-group'))))
      .toContain('needs a non-empty "options" array')
    expect(validatePluginPanelTree(treeOf(formWith('radio', { options: [] }))))
      .toContain('needs a non-empty "options" array')
  })
})
