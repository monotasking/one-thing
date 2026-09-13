import { describe, expect, it } from 'vitest'
import {
  BUILTIN_KEYMAP_PROFILES,
  findBuiltinProfile,
  isBuiltinProfileId,
  keymapProfilesFor,
} from '../profiles'
import { findCommand } from '../commands'
import {
  activeProfile,
  addUserProfile,
  bindCombo,
  effectiveCombos,
  initialKeymapState,
  isProfileBound,
  listProfiles,
  profileCombos,
  profileConflicts,
  setProfile,
} from '../transitions'
import type { KeymapProfile } from '../profiles'
import type { CommandId, KeymapState } from '../types'

/**
 * **键位组:三层落法 + 三组各自过冲突规则**(K5)。
 *
 * 三件事在这儿钉着:
 *  ① **三层**(用户逐格覆盖 ▷ 当前组 ▷ 出厂表)每一层都真的挡得住下面那层,
 *    而且缺席**往下落**、显式 null **不往下落**;
 *  ② **换组不丢手** —— 换组那一下覆盖层一个字不动;
 *  ③ **每一组自己过冲突规则**。出厂表从 K0 起就自己跑这条检查,而一个键位组是
 *    出厂表的替身 —— 换一组就是换一张有效表,那张表一样会撞。最后一条用例是
 *    这只检查器的**反证**:它对一个真撞的组必须报红,否则前三条的绿是假的。
 */

describe('键位组:内置三组', () => {
  it('三组都在,id 与名字对得上,而且都是内置', () => {
    expect(BUILTIN_KEYMAP_PROFILES.map((p) => p.id)).toEqual(['default', 'vscode', 'jetbrains'])
    for (const profile of BUILTIN_KEYMAP_PROFILES) expect(profile.builtin).toBe(true)
    expect(isBuiltinProfileId('vscode')).toBe(true)
    expect(isBuiltinProfileId('user:x')).toBe(false)
  })

  it('组里映射的每一条都是这台壳真有的命令(拼错一个 id 当场红)', () => {
    for (const profile of BUILTIN_KEYMAP_PROFILES) {
      for (const id of Object.keys(profile.bindings)) {
        expect(findCommand(id as CommandId), `${profile.id} / ${id}`).toBeTruthy()
      }
    }
  })

  it('**三组各自的有效表全过冲突规则**(K0 的那一条,出厂表与组同一只函数)', () => {
    for (const profile of BUILTIN_KEYMAP_PROFILES) {
      expect(profileConflicts(profile), profile.id).toEqual([])
    }
  })

  /**
   * 上面那一条跑的是**这台机器**那一份(jsdom 里是 `other` 档)。⌃G / ⌃→ / ⌃\`
   * 三条按平台分档,mac 那一档在这台机器上一次都没被跑过 —— 而它恰恰是
   * `offHand` 那一支,也就是最容易撞到别人的那一支。所以两档都跑。
   */
  it('两台机器的三组**各自**都过冲突规则(mac 档的 offHand 那几条也跑到)', () => {
    for (const platform of ['mac', 'other'] as const) {
      for (const profile of keymapProfilesFor(platform)) {
        expect(profileConflicts(profile), `${platform} / ${profile.id}`).toEqual([])
      }
    }
  })

  it('mac 档的 ⌃G / ⌃→ / ⌃ 反引号要的是 Ctrl 那一枚物理键(offHand),不是 ⌘', () => {
    const mac = keymapProfilesFor('mac')
    const vscode = mac.find((p) => p.id === 'vscode') as KeymapProfile
    const jetbrains = mac.find((p) => p.id === 'jetbrains') as KeymapProfile
    expect(vscode.bindings['viewer.gotoLine']).toEqual([{ offHand: true, key: 'g' }])
    expect(vscode.bindings['toggle:terminal']).toEqual([{ offHand: true, key: '`' }])
    expect(jetbrains.bindings['tab.next']).toEqual([{ offHand: true, key: 'arrowright' }])
    // 其余平台上同一个手势写成主修饰键(那儿 Ctrl 就是主修饰键)。
    const other = keymapProfilesFor('other')
    expect((other.find((p) => p.id === 'vscode') as KeymapProfile).bindings['viewer.gotoLine']).toEqual([
      { ctrl: true, key: 'g' },
    ])
  })

  it('default 组就是出厂表本身(bindings 为空,一个字不重复抄)', () => {
    const factory = findBuiltinProfile('default')
    expect(factory?.bindings).toEqual({})
    expect(profileCombos(factory, 'tab.close')).toEqual(findCommand('tab.close')?.defaultCombos)
  })

  it('VS Code 组:命令面板是 ⌘⇧P,而出厂组里那条是 ⌘⇧W', () => {
    const vscode = findBuiltinProfile('vscode')
    expect(profileCombos(vscode, 'workspace.palette')).toEqual([
      { meta: true, shift: true, key: 'p' },
    ])
    expect(profileCombos(findBuiltinProfile('default'), 'workspace.palette')).toEqual([
      { meta: true, shift: true, key: 'w' },
    ])
  })

  it('JetBrains 组没有对应物的那几条**缺席**,于是落回出厂键', () => {
    const jetbrains = findBuiltinProfile('jetbrains') as KeymapProfile
    for (const id of ['workspace.palette', 'tab.reopen'] as CommandId[]) {
      expect(isProfileBound(jetbrains, id), id).toBe(false)
      expect(profileCombos(jetbrains, id)).toEqual(findCommand(id)?.defaultCombos)
    }
    // 它自己说了话的那一条不落(终端在 JetBrains 里是 ⌥F12)。
    expect(profileCombos(jetbrains, 'toggle:terminal')).toEqual([{ alt: true, key: 'f12' }])
  })
})

describe('键位组:三层', () => {
  const onVscode: KeymapState = { ...initialKeymapState, profileId: 'vscode' }

  it('组赢出厂表', () => {
    expect(effectiveCombos(initialKeymapState, 'workspace.palette')).toEqual([
      { meta: true, shift: true, key: 'w' },
    ])
    expect(effectiveCombos(onVscode, 'workspace.palette')).toEqual([
      { meta: true, shift: true, key: 'p' },
    ])
  })

  it('用户逐格覆盖赢组', () => {
    const bound = bindCombo({ ...onVscode, overrides: { 'workspace.palette': [] } }, 'workspace.palette', {
      meta: true,
      alt: true,
      key: 'y',
    })
    expect('ok' in bound).toBe(true)
    if ('ok' in bound)
      expect(effectiveCombos(bound.ok, 'workspace.palette')).toEqual([
        { meta: true, alt: true, key: 'y' },
      ])
  })

  it('组里缺席的往下落到出厂表;组里显式 null 是解绑,**不**往下落', () => {
    // `tab.new` 两组都没说 —— 落到出厂的 ⌘T。
    expect(effectiveCombos(onVscode, 'tab.new')).toEqual([{ meta: true, key: 't' }])
    const muted: KeymapProfile = { id: 'user:m', name: 'm', bindings: { 'tab.new': null } }
    const state = addUserProfile(initialKeymapState, muted)
    expect(effectiveCombos(state, 'tab.new')).toEqual([])
  })

  it('**换组不丢手**:换组那一下覆盖层一个字不动', () => {
    const mine: KeymapState = {
      ...initialKeymapState,
      overrides: { 'toc.toggle': [{ meta: true, alt: true, key: 'y' }] },
    }
    const switched = setProfile(mine, 'jetbrains')
    expect(switched.overrides).toEqual(mine.overrides)
    expect(effectiveCombos(switched, 'toc.toggle')).toEqual([{ meta: true, alt: true, key: 'y' }])
  })

  it('认不出的组 id 落回出厂表(最坏的后果是键回出厂,不是一个键都没有)', () => {
    const lost: KeymapState = { ...initialKeymapState, profileId: 'user:已经删掉了' }
    expect(activeProfile(lost)).toBeUndefined()
    expect(effectiveCombos(lost, 'tab.close')).toEqual([{ meta: true, key: 'w' }])
  })

  it('导入一组:同 id 覆盖(不堆一摞),并且当场切过去', () => {
    const one: KeymapProfile = { id: 'user:x', name: 'x', bindings: { 'tab.close': [] } }
    const two: KeymapProfile = { id: 'user:x', name: 'x2', bindings: {} }
    const state = addUserProfile(addUserProfile(initialKeymapState, one), two)
    expect(state.userProfiles).toHaveLength(1)
    expect(state.profileId).toBe('user:x')
    expect(activeProfile(state)?.name).toBe('x2')
    expect(listProfiles(state).map((p) => p.id)).toEqual([
      'default',
      'vscode',
      'jetbrains',
      'user:x',
    ])
  })
})

describe('冲突检查器自己不是空转', () => {
  it('往一组里塞一条真撞的绑定 → 报得出来(反证:前面三组的绿不是因为它永远答空)', () => {
    /*
     * `toc.toggle` 与 `agent.menu` 都是 `app: true`,把它们按到同一个键上正是
     * 规则里那条「同一个键上只能有一条全局命令」。
     */
    const bad: KeymapProfile = {
      id: 'user:bad',
      name: 'bad',
      bindings: {
        'toc.toggle': [{ meta: true, key: 'q' }],
        'agent.menu': [{ meta: true, key: 'q' }],
      },
    }
    const found = profileConflicts(bad)
    expect(found).toHaveLength(1)
    expect(found[0]).toEqual({
      command: 'toc.toggle',
      conflict: { rule: 'app', with: 'agent.menu' },
    })
  })
})
