import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillDefinition } from '@shared/ipc/skills'
import { configureSkillsPort } from '../../data/skills-port'
import { useSkillsSource } from '../../data/skills-source'
import { openSkillDirectory } from '../skill-open'
import { useStageStore } from '../../stage/store'

/**
 * 「打开这条技能所在的目录」的三条路(09-12):表里有 / 先拉再查 / RPC 回落。
 *
 * 判词与方向的理由在 `content/skill-open.ts` 文件头。这里只量三件事 ——
 * **走的是哪一条**、**没走另外两条**、**落空时不抛只答 false**。
 */

const openDir = vi.hoisted(() => vi.fn())
// 目录面板那条路拖着 stage / workbench 两片 store,这里量的是「叫对了谁」,
// 不是那条路自己 —— 它有自己的用例。`sessionDirOf` 留真的(测试里没有环境会话,
// 所以它答 null,而那正是「拿不到工作目录就不带那一格」要走的那一形)。
vi.mock('../dir-open', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../dir-open')>()),
  openDirectoryPanel: openDir,
}))

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

/** 这一发问的是哪个 cwd。第二条路验的就是这张表有没有被写过。 */
let asked: (string | null)[] = []
/** 回落那一口被叫了几次、拿什么 id 叫的。 */
let openedByRpc: string[] = []
let answer: () => Promise<{ success: boolean; skills?: SkillDefinition[] }> = async () => ({
  success: true,
  skills: [skill()],
})
let rpcOpenAnswer: () => Promise<{ success: boolean }> = async () => ({ success: true })
/** false = 这台没装回落那一口(端口上它是可选的,见 skills-port)。 */
let rpcOpenPresent = true

function installPort(): void {
  configureSkillsPort({
    ready: async () => undefined,
    getAll: async (cwd) => {
      asked.push(cwd)
      return answer()
    },
    ...(rpcOpenPresent
      ? {
          openDirectory: async (skillId: string) => {
            openedByRpc.push(skillId)
            return rpcOpenAnswer()
          },
        }
      : {}),
  })
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  asked = []
  openedByRpc = []
  openDir.mockClear()
  answer = async () => ({ success: true, skills: [skill()] })
  rpcOpenAnswer = async () => ({ success: true })
  rpcOpenPresent = true
  useSkillsSource.getState().reset()
  installPort()
})

afterEach(() => {
  configureSkillsPort(undefined)
  useSkillsSource.getState().reset()
})

describe('openSkillDirectory:三条路', () => {
  it('① 表里有 → 开目录面板(与 @目录 chip 同一条路),不发 RPC 回落', async () => {
    await useSkillsSource.getState().ensureSkills(null)
    expect(await openSkillDirectory('user/writing')).toBe(true)
    expect(openDir).toHaveBeenCalledWith('/s')
    expect(openedByRpc).toEqual([])
  })

  it('② 表里没有(抽屉从没开过)→ 先 ensureSkills 再查,仍然走面板', async () => {
    expect(useSkillsSource.getState().status).toBe('idle')
    expect(await openSkillDirectory('user/writing')).toBe(true)
    // 拉过一发(cwd 走 sessionDirOf —— 测试里没有环境会话,所以是 null)。
    expect(asked).toEqual([null])
    expect(openDir).toHaveBeenCalledWith('/s')
    expect(openedByRpc).toEqual([])
  })

  it('③ 拉完还是没有(这条技能已经不在这台的表里)→ RPC 回落,不开面板', async () => {
    expect(await openSkillDirectory('user/gone')).toBe(true)
    expect(openDir).not.toHaveBeenCalled()
    expect(openedByRpc).toEqual(['user/gone'])
  })

  /**
   * **反证**:把第三条路拆掉(端口上那一口不在场 = 这台没有这条能力),
   * 同一次调用当场答 false —— 上面那条「③ 回落」就是靠它成立的。
   */
  it('反证:回落那一口不在场 → 答 false(结构化降级,不抛)', async () => {
    rpcOpenPresent = false
    installPort()
    expect(await openSkillDirectory('user/gone')).toBe(false)
    expect(openDir).not.toHaveBeenCalled()
  })

  it('回落说没开成 → 答 false(调用方据此说一句 warn)', async () => {
    rpcOpenAnswer = async () => ({ success: false })
    expect(await openSkillDirectory('user/gone')).toBe(false)
  })

  it('回落抛了也答 false —— 点一枚 chip 不该炸掉整条消息列表', async () => {
    rpcOpenAnswer = async () => {
      throw new Error('desktop host only')
    }
    expect(await openSkillDirectory('user/gone')).toBe(false)
  })

  it('目录是空串的那条技能直接落到回落路(不拿空路径开面板)', async () => {
    answer = async () => ({ success: true, skills: [skill({ directoryPath: '' })] })
    expect(await openSkillDirectory('user/writing')).toBe(true)
    expect(openDir).not.toHaveBeenCalled()
    expect(openedByRpc).toEqual(['user/writing'])
  })

  it('空 skillId 一条路都不走', async () => {
    expect(await openSkillDirectory('')).toBe(false)
    expect(asked).toEqual([])
    expect(openedByRpc).toEqual([])
  })
})
