import { describe, expect, it } from 'vitest'
import {
  parseProfileJson,
  profileFromState,
  serializeProfile,
  userProfileIdOf,
} from '../profile-io'
import { KEYMAP_COMMANDS } from '../commands'
import { effectiveCombos, initialKeymapState, sameCombo } from '../transitions'
import type { KeymapState } from '../types'

/**
 * **键位组的文件形**(K5):导出 → 导入是一个来回,而这一组钉的就是「这个来回
 * 里什么都没丢」,外加「读不懂的那几行说得出口」。
 *
 * 静默是这类功能的病:一份手写的文件里错一个命令 id,用户按下去发现键没变,
 * 而界面上写着「导入成功」。所以报告里三张单子(认不出的命令 / 读不出的键 /
 * 生效了几条)各有用例。
 */

const MAC = 'mac' as const

describe('键位组文件:导出再导入', () => {
  it('整张有效表出去再回来,逐条相等(没绑的那几条写成显式 null,不许落回出厂值)', () => {
    const state: KeymapState = {
      ...initialKeymapState,
      profileId: 'vscode',
      overrides: { 'toc.toggle': [{ meta: true, alt: true, key: 'y' }] },
    }
    const text = serializeProfile(profileFromState(state, '我的键位'), MAC)
    const report = parseProfileJson(text, MAC, '回落名')
    expect(report.error).toBeUndefined()
    expect(report.unknownCommands).toEqual([])
    expect(report.badChords).toEqual([])

    /*
     * 把读回来的那一组当成**当前组**(覆盖层清空),每一条命令的有效键都该与
     * 导出那一刻逐字相同 —— 包括「此刻没绑」的那几条。
     */
    const reimported: KeymapState = {
      overrides: {},
      profileId: report.profile?.id,
      userProfiles: report.profile ? [report.profile] : [],
    }
    for (const command of KEYMAP_COMMANDS) {
      const before = effectiveCombos(state, command.id)
      const after = effectiveCombos(reimported, command.id)
      expect(after.length, command.id).toBe(before.length)
      /*
       * 比的是 `sameCombo` 不是逐字相等:`meta` 与 `ctrl` 是主修饰键的两种拼法,
       * 串这一层只有一个词,所以读回来固定是 `meta` —— 那正是规范该有的样子
       * (判词在 `chord.ts` 上),不是丢了东西。
       */
      before.forEach((combo, i) => {
        expect(sameCombo(after[i], combo), `${command.id} #${i}`).toBe(true)
      })
    }
  })

  it('导出的 id 原样导回来还是同一组(不会每导一次多一层 user: 前缀)', () => {
    const made = profileFromState(initialKeymapState, '我的键位')
    expect(made.id).toBe('user:我的键位')
    const back = parseProfileJson(serializeProfile(made, MAC), MAC, 'x')
    expect(back.profile?.id).toBe('user:我的键位')
  })

  it('用户组 id 一律 user: 打头 —— 文件写 "default" 也盖不住内置组', () => {
    expect(userProfileIdOf('default')).toBe('user:default')
    expect(userProfileIdOf('  ')).toBe('user:imported')
  })
})

describe('键位组文件:读不懂的那几行说得出口', () => {
  it('认不出的命令列出来、认得出的照样生效', () => {
    const text = JSON.stringify({
      name: '半份',
      bindings: { 'tab.close': 'cmd+q', 'no.such.command': 'cmd+z' },
    })
    const report = parseProfileJson(text, MAC, '回落名')
    expect(report.unknownCommands).toEqual(['no.such.command'])
    expect(report.accepted).toBe(1)
    expect(report.profile?.bindings['tab.close']).toEqual([{ meta: true, key: 'q' }])
  })

  it('读不出的键串列出来,而且那一条**不写**(缺席落回出厂值,不是替他解绑)', () => {
    const text = JSON.stringify({ name: 'x', bindings: { 'tab.close': 'hyper+q' } })
    const report = parseProfileJson(text, MAC, '回落名')
    expect(report.badChords).toEqual([{ command: 'tab.close', chord: 'hyper+q' }])
    expect(report.accepted).toBe(0)
    expect('tab.close' in (report.profile?.bindings ?? {})).toBe(false)
  })

  it('一条命令好几个键:读得出的留下,读不出的那一个列出来', () => {
    const text = JSON.stringify({ name: 'x', bindings: { 'tab.next': ['cmd+shift+]', 'hyper+x'] } })
    const report = parseProfileJson(text, MAC, '回落名')
    expect(report.profile?.bindings['tab.next']).toEqual([{ meta: true, shift: true, key: ']' }])
    expect(report.badChords).toEqual([{ command: 'tab.next', chord: 'hyper+x' }])
  })

  it('显式 null 是解绑,它是一句话不是一个空位', () => {
    const text = JSON.stringify({ name: 'x', bindings: { 'tab.close': null } })
    const report = parseProfileJson(text, MAC, '回落名')
    expect(report.profile?.bindings['tab.close']).toBeNull()
    expect(report.accepted).toBe(1)
  })

  it('名字缺席时用回落名(文件名),整份读不成时说清是哪一种', () => {
    const nameless = parseProfileJson(JSON.stringify({ bindings: {} }), MAC, '回落名')
    expect(nameless.profile?.name).toBe('回落名')
    expect(parseProfileJson('{', MAC, 'x').error).toBe('json')
    expect(parseProfileJson('[]', MAC, 'x').error).toBe('shape')
    expect(parseProfileJson(JSON.stringify({ name: 'x' }), MAC, 'x').error).toBe('shape')
  })
})
