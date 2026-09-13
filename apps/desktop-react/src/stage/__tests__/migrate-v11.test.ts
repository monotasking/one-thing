import { describe, expect, it } from 'vitest'
import { STAGE_PERSIST_VERSION, migrateStagePersisted } from '../transitions'
import { PROVIDERS_ITEM_ID } from '../items'
import { DEFAULT_SPACE_ID } from '../../workspace/types'

/**
 * **v10 → v11:「模型服务」那块瓦退役**(2026-09-13,用户裁定「把模型设置移到
 * 设置中去」)。
 *
 * 它跑的是 v8 撤查看器那一次**同一套**函数(`stripRetiredItem`),所以这一组量
 * 的是三件:①逐格清干净(扁平层 + `byWorkspace` 每一格 + `hiddenItems`);
 * ②别的瓦一格不动;③**一格都没碰到就引用恒等**(幂等在这一族档案上的机器化判据)。
 */

/** 一份 v10 的家具。注意 v9 之后 `placements` / 架子 tabs 已经不在 stage 的档案里。 */
function v10Furniture() {
  return {
    floats: {
      [PROVIDERS_ITEM_ID]: { x: 40, y: 60, w: 880, h: 520 },
      music: { x: 10, y: 20, w: 400, h: 300 },
    },
    floatOrder: [PROVIDERS_ITEM_ID, 'music'],
    memory: {
      [PROVIDERS_ITEM_ID]: { kind: 'float', rect: { x: 40, y: 60, w: 880, h: 520 } },
      files: { kind: 'edge', side: 'right', index: 0 },
    },
    shelves: {
      right: { thickness: 420, collapsed: false },
    },
  }
}

const archive = () => ({
  hiddenItems: [PROVIDERS_ITEM_ID, 'diff'],
  byWorkspace: { [DEFAULT_SPACE_ID]: v10Furniture(), 'ws-b': v10Furniture() },
  dockEdge: 'left',
  ...v10Furniture(),
})

const migrate = (input: unknown, version = 10) => migrateStagePersisted(input, version)

describe('v10 → v11:模型服务那块瓦从存量档案里清干净', () => {
  it('`hiddenItems` 摘掉它,别的行原样', () => {
    const out = migrate(archive()) as Record<string, unknown>
    expect(out.hiddenItems).toEqual(['diff'])
  })

  it('**每一个空间那一格**都清(只清当前那一格的话,切过去才露出同一个病)', () => {
    const out = migrate(archive()) as Record<string, unknown>
    const ledger = out.byWorkspace as Record<string, Record<string, unknown>>
    for (const space of [DEFAULT_SPACE_ID, 'ws-b']) {
      expect(ledger[space]!.floats).toEqual({ music: { x: 10, y: 20, w: 400, h: 300 } })
      expect(ledger[space]!.floatOrder).toEqual(['music'])
      expect(Object.keys(ledger[space]!.memory as object)).toEqual(['files'])
      // 几何那一半一个字不动。
      expect(ledger[space]!.shelves).toEqual({ right: { thickness: 420, collapsed: false } })
    }
  })

  it('扁平层那一份也清', () => {
    const out = migrate(archive()) as Record<string, unknown>
    expect(out.floats).toEqual({ music: { x: 10, y: 20, w: 400, h: 300 } })
    expect(out.floatOrder).toEqual(['music'])
    expect(Object.keys(out.memory as object)).toEqual(['files'])
    // 偏好留在顶层(它不是家具)。
    expect(out.dockEdge).toBe('left')
  })

  it('**一格都没碰到就引用恒等**:一份从来没摆过它的档案原样交回', () => {
    const clean = {
      hiddenItems: ['diff'],
      byWorkspace: { [DEFAULT_SPACE_ID]: { floats: {}, floatOrder: [], memory: {} } },
    }
    expect(migrate(clean)).toBe(clean)
  })

  it('已经是 v11 的档案不再迁(而且再迁一次是恒等变换)', () => {
    const once = migrate(archive())
    expect(migrateStagePersisted(once, STAGE_PERSIST_VERSION)).toBe(once)
    // 把版本号说小一号再迁,v11 那段照跑一遍、一格都碰不到 → 同一个对象。
    expect(migrateStagePersisted(once, 10)).toBe(once)
  })

  it('形状烂了不炸(手改过的档案:家具不是对象、表不是表)', () => {
    expect(migrate(null)).toBeNull()
    expect(migrate(7)).toBe(7)
    const weird = { byWorkspace: { a: 'nope' }, hiddenItems: 'nope' }
    expect(migrate(weird)).toBe(weird)
  })

  it('架子上还留着它的那一份老档案(v9 之前的形)照样清得掉', () => {
    const legacy = {
      shelves: {
        right: { tabs: ['music', PROVIDERS_ITEM_ID], activeId: PROVIDERS_ITEM_ID, thickness: 420 },
      },
    }
    const out = migrate(legacy) as Record<string, unknown>
    const right = (out.shelves as Record<string, Record<string, unknown>>).right!
    expect(right.tabs).toEqual(['music'])
    // 活动 tab 恰好是它 → 落到剩下的末位,不留悬空 id。
    expect(right.activeId).toBe('music')
  })
})
