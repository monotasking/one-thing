import { describe, expect, it } from 'vitest'
import { migrateWorkbenchPersisted, WORKBENCH_PERSIST_VERSION } from '../store'
import { CENTER_REGION } from '../regions'

/**
 * **persist v4:目录那一种 `files-root` 改名 `dir`**(K2b-1,
 * `docs/design/atom-2026-09.md` §7 盲点 2「两套地址」)。
 *
 * 守的是 `persist-migrate.ts` 从 v2 起就有的那两条硬要求,加改名本身:
 *  ① 存量档案里的 `files-root:<路径>` 翻成 `dir:<路径>`,**tab 与 hidden 两处都翻**;
 *  ② **幂等** —— 走过一遍的档案再走一遍,交回的是同一个对象;
 *  ③ 已经是 v4 形的档案 → **引用恒等**(一格都不重建;没有这一条,每次启动都会
 *     写回一份「内容相同、身份不同」的档案)。
 *
 * **反证**:把 `store.ts` 的 `migrateWorkbenchPersisted` 里 `if (version < 4)` 那条
 * 拆掉 → 第一条当场红。
 */

const V3 = 3

/** v3 的形:中央区一片叶(v3 已折过),里面一格目录树 + 一格文件;hidden 里也躺着一格目录树。 */
const v3 = () => ({
  byWorkspace: {
    default: {
      regions: {
        [CENTER_REGION]: {
          kind: 'leaf',
          id: 'L1',
          tabs: [
            { kind: 'files-root', key: '/x' },
            { kind: 'file', key: '/a.ts' },
          ],
          active: 0,
        },
      },
      hidden: [{ ref: { kind: 'files-root', key: '/y' }, at: 'edge:left' }],
    },
  },
})

const centerTabs = (out: unknown) =>
  (out as ReturnType<typeof v3>).byWorkspace.default.regions[CENTER_REGION].tabs

const hiddenOf = (out: unknown) => (out as ReturnType<typeof v3>).byWorkspace.default.hidden

describe('v4:`files-root` → `dir`', () => {
  it('版本号就是 4(改这个数必须在 migrate 里加一段)', () => {
    expect(WORKBENCH_PERSIST_VERSION).toBe(4)
  })

  it('tab 与 hidden 两处都翻,**key 一个字不动**', () => {
    const next = migrateWorkbenchPersisted(v3(), V3)
    expect(centerTabs(next)).toEqual([
      { kind: 'dir', key: '/x' },
      { kind: 'file', key: '/a.ts' },
    ])
    expect(hiddenOf(next)[0]).toEqual({ ref: { kind: 'dir', key: '/y' }, at: 'edge:left' })
  })

  it('**幂等**:翻过一遍的档案再翻一遍,交回的是**同一个对象**', () => {
    const once = migrateWorkbenchPersisted(v3(), V3)
    const twice = migrateWorkbenchPersisted(once, V3)
    expect(twice).toBe(once)
  })

  it('已经是 v4 形的档案 → **引用恒等**(一格都不重建)', () => {
    const clean = {
      byWorkspace: {
        default: {
          regions: {
            [CENTER_REGION]: { kind: 'leaf', id: 'L1', tabs: [{ kind: 'dir', key: '/x' }], active: 0 },
          },
          hidden: [],
        },
      },
    }
    expect(migrateWorkbenchPersisted(clean, V3)).toBe(clean)
  })

  it('已经是 v4 的档案根本不过这一遍(版本闸)', () => {
    const stale = v3()
    expect(migrateWorkbenchPersisted(stale, WORKBENCH_PERSIST_VERSION)).toBe(stale)
  })

  it('形状认不出来的原样带过(迁移不是校验器)', () => {
    expect(migrateWorkbenchPersisted(null, V3)).toBeNull()
    expect(migrateWorkbenchPersisted('junk', V3)).toBe('junk')
  })
})
