import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SkillDefinition } from '@shared/ipc/skills'
import { configureSkillsPort } from './skills-port'
import { SKILL_DESC_MAX, toSkillCommand, useSkillsSource } from './skills-source'
import { useStageStore } from '../stage/store'

/**
 * `/skill:<name>` 那一族(09-12)。三件事:
 *  ① **形状** —— 一条技能变成命令表里的一行长什么样(名字一个字不改写,
 *     因为后端按它查表);
 *  ② **取数纪律** —— 懒拉一次、按 cwd 缓存、失败静默降级;
 *  ③ **筛** —— 关掉的技能不进命令表(引擎那头也认不出来),但**进 byId**
 *     (那张表回答的是「某条已经发出去过的引用,它的目录在哪」)。
 *
 * **「打开这条技能所在的目录」那三条路不在这儿** —— 它是个动作,住在
 * `content/skill-open.ts`(壳的依赖方向是 content → data),测试同址。
 */

const skill = (over: Partial<SkillDefinition> = {}): SkillDefinition =>
  ({
    id: 'user/writing',
    name: 'writing',
    description: '把一段话改得更像人说的',
    source: 'user',
    path: '/s/SKILL.md',
    directoryPath: '/s',
    enabled: true,
    instructions: '',
    ...over,
  }) as SkillDefinition

/** 这一发问的是哪个 cwd。缓存判据验的就是这张表。 */
let asked: (string | null)[] = []
let answer: () => Promise<{ success: boolean; skills?: SkillDefinition[] }> = async () => ({
  success: true,
  skills: [skill()],
})

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  asked = []
  answer = async () => ({ success: true, skills: [skill()] })
  useSkillsSource.getState().reset()
  configureSkillsPort({
    ready: async () => undefined,
    getAll: async (cwd) => {
      asked.push(cwd)
      return answer()
    },
  })
})

afterEach(() => {
  configureSkillsPort(undefined)
  useSkillsSource.getState().reset()
})

describe('形状:一条技能 → 命令表里的一行', () => {
  it('名字是 `/skill:<技能名>`,一个字不改写(后端按它查表)', () => {
    const row = toSkillCommand(skill({ name: 'Writing-Pro' }), '说明')
    expect(row.name).toBe('/skill:Writing-Pro')
    expect(row.insertText).toBe('/skill:Writing-Pro ')
    expect(row.kind).toBe('skill')
    expect(row.allowArgs).toBe(true)
  })

  it('usage 里方括号那一截被解析成幽灵占位(与内置走同一句解析)', () => {
    const row = toSkillCommand(skill(), '说明')
    expect(row.usage).toBe('/skill:writing [说明]')
    expect(row.argHint).toBe('[说明]')
  })

  it('说明按一行放得下的量截断 —— 契约上它能到 1024 字', () => {
    const row = toSkillCommand(skill({ description: 'あ'.repeat(200) }), '说明')
    expect(row.desc.length).toBe(SKILL_DESC_MAX + 1) // 截到的字数 + 省略号
    expect(row.desc.endsWith('…')).toBe(true)
  })

  it('id 带前缀 —— 它与内置 / 插件的 id 空间不许撞(兜底 switch 按 id 分派)', () => {
    expect(toSkillCommand(skill({ id: 'cd' }), '说明').id).toBe('skill:cd')
  })
})

describe('取数:懒拉一次、按 cwd、失败静默降级', () => {
  it('同一个 cwd 问过就不再问(第二次是恒等)', async () => {
    await useSkillsSource.getState().ensureSkills('/repo')
    await useSkillsSource.getState().ensureSkills('/repo')
    expect(asked).toEqual(['/repo'])
    expect(useSkillsSource.getState().commands.map((c) => c.name)).toEqual(['/skill:writing'])
  })

  it('换一条工作目录就重新问 —— 「项目根下的技能按它发现」', async () => {
    await useSkillsSource.getState().ensureSkills('/repo')
    await useSkillsSource.getState().ensureSkills('/other')
    expect(asked).toEqual(['/repo', '/other'])
    expect(useSkillsSource.getState().cwd).toBe('/other')
  })

  it('没有工作目录就不带那一格(不在渲染层拼一个根去顶)', async () => {
    await useSkillsSource.getState().ensureSkills(null)
    expect(asked).toEqual([null])
  })

  it('同一个 cwd 的两发挤在一起只发一次', async () => {
    const both = Promise.all([
      useSkillsSource.getState().ensureSkills('/repo'),
      useSkillsSource.getState().ensureSkills('/repo'),
    ])
    await both
    expect(asked).toEqual(['/repo'])
  })

  it('后端说不成:静默降级成没有技能那一组,不抛也不弹', async () => {
    answer = async () => ({ success: false })
    await useSkillsSource.getState().ensureSkills('/repo')
    expect(useSkillsSource.getState().status).toBe('error')
    expect(useSkillsSource.getState().commands).toEqual([])
  })

  it('端口自己抛了也一样(一条没人接的 rejection 是更坏的降级)', async () => {
    answer = async () => {
      throw new Error('desktop host only')
    }
    await useSkillsSource.getState().ensureSkills('/repo')
    expect(useSkillsSource.getState().status).toBe('error')
  })

  it('失败**不清**上一批(律②:错误不抹掉旧答案)', async () => {
    await useSkillsSource.getState().ensureSkills('/repo')
    expect(useSkillsSource.getState().commands).toHaveLength(1)
    answer = async () => ({ success: false })
    await useSkillsSource.getState().ensureSkills('/other')
    expect(useSkillsSource.getState().commands).toHaveLength(1)
  })
})

describe('筛:关掉的技能不进表', () => {
  it('`enabled === false` 的一条都不画 —— 引擎那头也认不出来', async () => {
    answer = async () => ({
      success: true,
      skills: [skill(), skill({ id: 'user/off', name: 'off', enabled: false })],
    })
    await useSkillsSource.getState().ensureSkills('/repo')
    expect(useSkillsSource.getState().commands.map((c) => c.name)).toEqual(['/skill:writing'])
  })
})

describe('byId:回答「某条已经发出去过的引用,它的目录在哪」', () => {
  it('与 commands 同一次取数填,一发 RPC 都不多', async () => {
    await useSkillsSource.getState().ensureSkills('/repo')
    expect(asked).toEqual(['/repo'])
    expect(useSkillsSource.getState().byId.get('user/writing')).toEqual({
      name: 'writing',
      directoryPath: '/s',
      source: 'user',
    })
  })

  it('**不筛 enabled**(与命令表那半分家:今天关了不等于它没有目录)', async () => {
    answer = async () => ({
      success: true,
      skills: [skill(), skill({ id: 'user/off', name: 'off', enabled: false })],
    })
    await useSkillsSource.getState().ensureSkills('/repo')
    expect(useSkillsSource.getState().commands.map((c) => c.name)).toEqual(['/skill:writing'])
    expect([...useSkillsSource.getState().byId.keys()]).toEqual(['user/writing', 'user/off'])
  })

  it('空串目录 = 没有(拿空路径开面板会开出一块无根的树)', async () => {
    answer = async () => ({ success: true, skills: [skill({ directoryPath: '' })] })
    await useSkillsSource.getState().ensureSkills('/repo')
    expect(useSkillsSource.getState().byId.get('user/writing')?.directoryPath).toBeNull()
  })
})
