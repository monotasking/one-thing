import { describe, expect, it } from 'vitest'
import {
  BUILTIN_KEYMAP_PROFILES,
  findBuiltinProfile,
  isBuiltinProfileId,
  keymapProfilesFor,
} from '../profiles'
import { TAB_SELECT_SLOTS, findCommand, tabSelectCommandId, toggleCommandId } from '../commands'
import {
  activeProfile,
  addUserProfile,
  bindCombo,
  effectiveCombos,
  initialKeymapState,
  isProfileBound,
  listProfiles,
  lookupCommands,
  profileCombos,
  profileConflicts,
  setProfile,
} from '../transitions'
import type { KeymapProfile } from '../profiles'
import type { CommandId, ComboEvent, KeymapState } from '../types'

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

/**
 * **JetBrains 组的 ⌘n 是工具窗,不是标签**(K7,09-13 用户原话「jetbrains cmd 1
 * 绑定 project,cmd 0 绑定 changes」)。
 *
 * 三件事在这儿钉着:①三条工具窗键真的在这一组里;②序号直达那九条是**显式
 * `null`**(解绑)而不是缺席 —— 缺席会往下落回出厂的 ⌘1–⌘9,那正好是要让开的
 * 那九个键;③这一组的改动**不外溢**:出厂组下 ⌘1 仍旧是「第 1 个标签」。
 *
 * 反证:把那一段 `null` 改成不写(缺席)→ 第二条与第三条里「⌘1 在这一组里只
 * 落在文件列表上」当场红(候选会多出 `tab.select:1`)。
 */
describe('键位组:JetBrains 的工具窗三键(K7)', () => {
  const jetbrains = findBuiltinProfile('jetbrains') as KeymapProfile
  const onJetbrains: KeymapState = { ...initialKeymapState, profileId: 'jetbrains' }

  /** 一次按键的五个字段(与 `transitions.test.ts` 里那只构造器同形)。 */
  function press(key: string): ComboEvent {
    return { key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
  }

  it('⌘1 = 文件列表、⌘7 = 目录、⌘0 = 改动面(三块瓦,不是三格标签)', () => {
    expect(profileCombos(jetbrains, toggleCommandId('files'))).toEqual([{ meta: true, key: '1' }])
    expect(profileCombos(jetbrains, 'toc.toggle')).toEqual([{ meta: true, key: '7' }])
    expect(profileCombos(jetbrains, toggleCommandId('diff'))).toEqual([{ meta: true, key: '0' }])
  })

  it('序号直达那九条是**显式解绑**(在表里、值是 null),不是缺席', () => {
    for (let slot = 1; slot <= TAB_SELECT_SLOTS; slot += 1) {
      const id = tabSelectCommandId(slot)
      // 「在表里」与「有值」是两件事 —— 这一条问的正是前者(判词在 profiles.ts 上)。
      expect(isProfileBound(jetbrains, id), id).toBe(true)
      expect(jetbrains.bindings[id], id).toBeNull()
      // 于是有效键是空的:它**没有**落回出厂的 ⌘1–⌘9。
      expect(effectiveCombos(onJetbrains, id), id).toEqual([])
    }
    // 同一条在出厂组下照旧是 ⌘n(对照组:上面那句说的是「这一组解绑了」)。
    expect(effectiveCombos(initialKeymapState, tabSelectCommandId(1))).toEqual([
      { meta: true, key: '1' },
    ])
  })

  it('切到这一组之后 ⌘1 / ⌘7 / ⌘0 各只落在那块瓦上(标签那一族不在候选里)', () => {
    expect(lookupCommands(onJetbrains, press('1'), 'mac')).toEqual([toggleCommandId('files')])
    expect(lookupCommands(onJetbrains, press('7'), 'mac')).toEqual(['toc.toggle'])
    /*
     * ⌘0 上两条:改动面(应用级)与 `view.zoomReset`(跟焦点,只有浏览器答得出)
     * —— 合法共键,谁做由活动路径说了算。这一条要证的是「改动面真的在候选里」,
     * 所以按包含判,次序不入断言(次序是表的声明序,不是优先级)。
     */
    expect(lookupCommands(onJetbrains, press('0'), 'mac')).toContain(toggleCommandId('diff'))
    // 出厂组下同一个键仍旧是那一格标签 —— 这一组的改动不外溢。
    expect(lookupCommands(initialKeymapState, press('1'), 'mac')).toEqual([tabSelectCommandId(1)])
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
