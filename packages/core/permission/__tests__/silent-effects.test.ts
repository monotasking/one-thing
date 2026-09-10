/**
 * 静默效果类 —— **只有一张表**(合表,2026-09-10 用户拍板)。
 *
 * ## 这只文件从「钉住两张表并存」变成「钉住只剩一张」
 *
 * K2b-2 写它时,判定核这一侧自带一份 `SILENT_EFFECT_KINDS = {read, ui_change}`,
 * 与 `core/toolkit/effects.ts` 的 `EFFECT_POLICY` 管同一个问题。当时那笔债归拍板,
 * 所以这里有一条用例把「四类今天真会弹卡」逐条列成字面量,专门让「顺手把两张表合
 * 了」当场红 —— 那条用例是一把**锁**,不是一条判据。
 *
 * 拍板落下之后锁该开:判定核改读策略表,这只文件也跟着换成**一致性**的量法 ——
 * 遍历 `EFFECT_CLASSES`,把 `decidePermission` 实际不问的那一集,与策略表里写
 * `silent` 的那一集整体对比。这条用例量的是「两处口径一致」,不是某一类的取值:
 * 把表里 `net_fetch` 改回 `ask`,它照样绿(红的是下面那条按行为写的用例);而在
 * 判定核里偷偷加回任何一份名单,它立刻红。这就是防第二张表再长出来的门。
 */
import * as fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EFFECT_CLASSES, EFFECT_POLICY } from '../../toolkit/effects.js'
import { decidePermission } from '../permission-policy.js'

function decide(kind: string) {
  return decidePermission({
    sessionId: 'session-a',
    mode: 'normal',
    effects: [{ kind, resources: [] }],
    // 不接 grant 表:静默要靠**效果类**成立,不靠"碰巧有一条授权记着"。
    grantMatcher: () => undefined,
  })
}

/** 这一类跑一遍真判定核,不问人吗。 */
function isSilentInPractice(kind: string): boolean {
  return decide(kind).decision === 'allow'
}

describe('静默效果类', () => {
  it('只有一张表:判定核实际不问的那一集 === 策略表里写 silent 的那一集', () => {
    const silentInPractice = EFFECT_CLASSES.filter(isSilentInPractice)
    const silentInTable = EFFECT_CLASSES.filter(kind => EFFECT_POLICY[kind].policy === 'silent')
    expect(silentInPractice).toEqual(silentInTable)
  })

  /**
   * 上面那条量的是**答案**一致,量不到「一份不改变答案的多余名单」—— 判定核里偷偷
   * 加回一个 `new Set(['read'])` 是策略表的真子集,行为一个字不变,而两张表就这么
   * 长回来了(K2b-2 那份名单起初也只是 `{read}`)。所以这一条量**形状**:判定核那
   * 只文件里不许出现任何一个"装着效果类名字的集合字面量"。
   *
   * 判据不按名字枚举:它拿 `EFFECT_CLASSES` 现问现比,新加一个效果类自动进保护范围。
   */
  it('只有一张表(形状):判定核里不许出现装着效果类名字的集合字面量', () => {
    const source = fs.readFileSync(new URL('../permission-policy.ts', import.meta.url), 'utf-8')
    const offenders: string[] = []
    for (const match of source.matchAll(/new (?:Readonly)?Set\(\[([^\]]*)\]\)/g)) {
      const body = match[1] ?? ''
      const named = EFFECT_CLASSES.filter(kind => body.includes(`'${kind}'`) || body.includes(`"${kind}"`))
      if (named.length > 0) offenders.push(`${match[0]} — 名单里有效果类 ${named.join(' / ')}`)
    }
    expect(offenders, '效果类的策略只有 core/toolkit/effects.ts 一处产地').toEqual([])
  })

  it('未知 kind 照旧要问 —— 拼错一个效果名不该换来一次静默放行', () => {
    expect(decide('quantum_teleport').decision).toBe('ask')
  })

  it('ui_change 不进 ask —— 那扇窗是这个人的窗', () => {
    expect(decide('ui_change').decision).toBe('allow')
  })

  it('read 照旧静默', () => {
    expect(decide('read').decision).toBe('allow')
  })

  /**
   * 合表带来的**行为变化**,逐条钉住(上面那条一致性用例证明不了这个 —— 它只证明
   * 两处说的是同一句话,不证明那句话说的是什么)。
   *
   * `net_fetch` = web_search 发 query / web_open 抓一页:只读的出网取材,不动这台
   * 机器上的任何东西,每查一次资料一张卡是把审批变成噪音(08-18 判例)。
   * `user_ask` = ask_user:它本身就是一次询问,先问「准不准我问你」是同一件事问
   * 两遍,而且第二遍还挡在第一遍前面。
   */
  it('合表后按效果表:net_fetch / user_ask 从此不弹卡', () => {
    expect(decide('net_fetch').decision).toBe('allow')
    expect(decide('user_ask').decision).toBe('allow')
  })

  /**
   * 这两类**行为没变** —— 判定核这一侧从 R0 之前就在问它们,合表改的是策略表那两
   * 行(把一句不作数的 `silent` 改成 `ask`),让表跟上行为。
   *
   * 往别的会话投一条消息、开一条子会话,都是真有后果的事:收件人是另一条会话里的
   * 那个人 / 那个 agent,派工会让另一个主体开始花钱和动手。
   */
  it('合表后按效果表:session_message / session_spawn 照旧要问', () => {
    for (const kind of ['session_message', 'session_spawn'] as const) {
      expect(EFFECT_POLICY[kind].policy, kind).toBe('ask')
      expect(decide(kind).decision, kind).toBe('ask')
    }
  })

  /**
   * K3-a —— 破坏性会话操作。合表之前它是「两张表都说 ask」的第一类;合表之后
   * "两张表"这句话本身没有了,它只是策略表里一行 `ask`。
   */
  it('session_destructive 要问 —— 删掉的东西没有第二个地方还留着', () => {
    expect(EFFECT_POLICY.session_destructive.policy).toBe('ask')
    expect(decide('session_destructive').decision).toBe('ask')
  })

  it('写盘与跑命令当然还是要问', () => {
    expect(decide('file_write').decision).toBe('ask')
    expect(decide('bash').decision).toBe('ask')
  })
})
