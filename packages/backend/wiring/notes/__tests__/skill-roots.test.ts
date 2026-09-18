/**
 * 「技能来源库」投影成技能根(P3,正本 §4.4)。
 *
 * 两件事各自钉住:
 *  ① **哪些库进来** —— 勾了 `skills` 的那些,而且必须是**在册的**(关掉的库连
 *    `registry.vaults()` 都不在里面);id 与路径无关,挪库不改 id。
 *  ② **那段 `<note_skill_context>`** —— 第一次问不出附件落点就**省掉那一格**
 *    (库答那件事是异步的,技能加载器是同步的),答上来之后喊一声,下一次带上。
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FolderVault, type NoteVault } from '@onething/runtime/notes'
import { NoteSkillRoots } from '../skill-roots.js'

const tempRoots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'note-skill-roots-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

/** 等到那一发后台解析落定(它是 `void` 的,所以只能等一轮微任务队列排空)。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 10))
}

function parse(block: string): Record<string, unknown> {
  const match = /<note_skill_context>\n([\s\S]*)\n<\/note_skill_context>/.exec(block)
  return JSON.parse(match![1]) as Record<string, unknown>
}

describe('NoteSkillRoots', () => {
  it('每个库一个 `custom:` 根,id 按库 id 而不是路径', async () => {
    const root = await makeRoot()
    const vault = new FolderVault({ root, id: 'v-work', name: 'workbook' })
    const roots = new NoteSkillRoots({ listVaults: () => [vault] }).list()

    expect(roots).toHaveLength(1)
    expect(roots[0]).toMatchObject({
      id: 'note-vault:v-work',
      path: vault.root,
      label: 'workbook',
      enabled: true,
      agentId: null,
    })
  })

  it('库表现取:端口答什么就是什么(反证:改成装配时的快照,这一条会红)', async () => {
    const root = await makeRoot()
    let vaults: NoteVault[] = []
    const skillRoots = new NoteSkillRoots({ listVaults: () => vaults })

    expect(skillRoots.list()).toEqual([])
    vaults = [new FolderVault({ root, id: 'v1' })]
    expect(skillRoots.list()).toHaveLength(1)
  })

  it('第一次省掉 attachment_directory,库答上来之后喊一声、下一次带上', async () => {
    const root = await makeRoot()
    const skillDir = path.join(root, 'skills', 'note-taking')
    await fs.mkdir(skillDir, { recursive: true })
    const vault = new FolderVault({ root, id: 'v1', attachmentDirectory: 'attachments' })
    let resolved = 0
    const skillRoots = new NoteSkillRoots({
      listVaults: () => [vault],
      onResolved: () => { resolved += 1 },
    })

    const first = parse(skillRoots.list()[0].instructionContext({ skillDir, rootDir: root }))
    expect(first).toEqual({
      note_root: root,
      skill_directory: skillDir,
      // `system` 原样交出去 —— 消费方一个笔记系统的名字都不认识。
      note_system: 'folder',
    })
    expect(first.attachment_directory).toBeUndefined()

    await settle()
    expect(resolved).toBe(1)

    const second = parse(skillRoots.list()[0].instructionContext({ skillDir, rootDir: root }))
    expect(second.attachment_directory).toBe(path.join(root, 'attachments'))
    // 第二次是从记的那一格读的 —— 没有再问一遍库。
    await settle()
    expect(resolved).toBe(1)
  })

  it('落点按**技能目录**记,不按库:同一个库里两个技能可以落在两处', async () => {
    const root = await makeRoot()
    const a = path.join(root, 'a')
    const b = path.join(root, 'b')
    await fs.mkdir(a, { recursive: true })
    await fs.mkdir(b, { recursive: true })
    // `./` = 文档同目录 —— 这正是「同一个库、两个答案」的那一档。
    const vault = new FolderVault({ root, id: 'v1', attachmentDirectory: './' })
    const skillRoots = new NoteSkillRoots({ listVaults: () => [vault] })

    const context = skillRoots.list()[0].instructionContext
    context({ skillDir: a, rootDir: root })
    context({ skillDir: b, rootDir: root })
    await settle()

    expect(parse(context({ skillDir: a, rootDir: root })).attachment_directory).toBe(a)
    expect(parse(context({ skillDir: b, rootDir: root })).attachment_directory).toBe(b)
  })

  it('reset 之后重新问库(库挪了 / 配置改了,记的那一格就作废)', async () => {
    const root = await makeRoot()
    const skillDir = path.join(root, 'skills')
    await fs.mkdir(skillDir, { recursive: true })
    let resolved = 0
    const skillRoots = new NoteSkillRoots({
      listVaults: () => [new FolderVault({ root, id: 'v1' })],
      onResolved: () => { resolved += 1 },
    })

    skillRoots.list()[0].instructionContext({ skillDir, rootDir: root })
    await settle()
    expect(resolved).toBe(1)

    skillRoots.reset()
    skillRoots.list()[0].instructionContext({ skillDir, rootDir: root })
    await settle()
    expect(resolved).toBe(2)
  })
})
