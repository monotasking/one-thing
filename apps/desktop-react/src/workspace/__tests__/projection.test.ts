import { describe, expect, it } from 'vitest'
import type { SpaceRecord } from '@shared/ipc/spaces'
import {
  currentWorkspace,
  filterWorkspaces,
  initialOf,
  orderSpaces,
  projectWorkspaces,
  swatchOf,
  workspaceAtSlot,
} from '../projection'
import { DEFAULT_SPACE_ID, WORKSPACE_SLOT_COUNT, WORKSPACE_SWATCHES } from '../types'

/**
 * 投影是三个入口(Dock 右键快切表 / ⌘⇧W 命令面板 / 工作区总览)唯一的分子产地,
 * 所以「哪个是当前」「⌘2 是谁」这两句话只在这里被判一次 —— 这一份用例钉的就是它。
 */

function space(id: string, name: string, createdAt = 0, color?: string): SpaceRecord {
  return { id, name, createdAt, ...(color ? { color } : {}) }
}

const DEFAULT = space(DEFAULT_SPACE_ID, '默认', 0, 'violet')
const LENOVO = space('ws-lenovo', 'Lenovo 工作', 200, 'blue')
const PERSONAL = space('ws-personal', '个人', 100, 'green')

describe('次序', () => {
  it('默认空间永远第一,其余按创建时间从早到晚', () => {
    expect(orderSpaces([LENOVO, PERSONAL, DEFAULT]).map((s) => s.id)).toEqual([
      DEFAULT_SPACE_ID,
      'ws-personal',
      'ws-lenovo',
    ])
  })

  it('同刻按 id 定序 —— 次序必须是稳的,序号键才不会在用户背后漂', () => {
    const a = space('ws-b', 'B', 50)
    const b = space('ws-a', 'A', 50)
    expect(orderSpaces([a, b]).map((s) => s.id)).toEqual(['ws-a', 'ws-b'])
  })
})

describe('色标', () => {
  it('记录里那个名字认识就用它', () => {
    expect(swatchOf(LENOVO)).toBe('blue')
  })

  it('缺席 / 不认识的值按 id 稳定派一格,同一个 id 永远同一张脸', () => {
    const nameless = space('ws-x', 'X')
    const bogus = space('ws-x', 'X 改过名了', 999, 'chartreuse')
    expect(WORKSPACE_SWATCHES).toContain(swatchOf(nameless))
    // 喂哈希的是 id 不是显示名 —— 改名不该换脸。
    expect(swatchOf(bogus)).toBe(swatchOf(nameless))
  })
})

describe('字标', () => {
  it('取名字的第一个字', () => {
    expect(initialOf(LENOVO)).toBe('L')
    expect(initialOf(PERSONAL)).toBe('个')
  })

  it('按**字**取而不是按 code unit —— 代理对取半个会画出乱码', () => {
    expect(initialOf(space('ws-e', '🌊 海'))).toBe('🌊')
  })

  it('名字是空白时退到 id 的首字', () => {
    expect(initialOf(space('ws-blank', '   '))).toBe('w')
  })
})

describe('投影', () => {
  const views = projectWorkspaces([LENOVO, PERSONAL, DEFAULT], 'ws-lenovo')

  it('当前那一个标出来,且只有一个', () => {
    expect(views.filter((v) => v.isCurrent).map((v) => v.id)).toEqual(['ws-lenovo'])
    expect(currentWorkspace(views)?.name).toBe('Lenovo 工作')
  })

  it('前三个各有一个序号,第四个起没有 —— 序号是键位预算不是能力上限', () => {
    const many = projectWorkspaces(
      [DEFAULT, space('a', 'A', 1), space('b', 'B', 2), space('c', 'C', 3)],
      DEFAULT_SPACE_ID,
    )
    expect(many.map((v) => v.slot)).toEqual([1, 2, 3, null])
    expect(workspaceAtSlot(many, 2)?.id).toBe('a')
    expect(workspaceAtSlot(many, WORKSPACE_SLOT_COUNT + 1)).toBeUndefined()
  })

  it('当前 id 在列表里找不到时落回默认空间 —— 「当前」不许是幽灵', () => {
    const orphaned = projectWorkspaces([DEFAULT, LENOVO], 'ws-deleted-elsewhere')
    expect(currentWorkspace(orphaned)?.id).toBe(DEFAULT_SPACE_ID)
  })

  it('默认空间自己认得出来', () => {
    expect(views.filter((v) => v.isDefault).map((v) => v.id)).toEqual([DEFAULT_SPACE_ID])
  })
})

describe('过滤', () => {
  const views = projectWorkspaces([LENOVO, PERSONAL, DEFAULT], DEFAULT_SPACE_ID)

  it('空词 = 全表,不过滤也不重排', () => {
    expect(filterWorkspaces(views, '   ').map((v) => v.id)).toEqual(views.map((v) => v.id))
  })

  it('按名字子串命中,大小写不敏感', () => {
    expect(filterWorkspaces(views, '个').map((v) => v.id)).toEqual(['ws-personal'])
    expect(filterWorkspaces(views, 'lenovo').map((v) => v.id)).toEqual(['ws-lenovo'])
  })

  it('没命中就是空表 —— 不做模糊回退', () => {
    expect(filterWorkspaces(views, 'zzz')).toEqual([])
  })
})
