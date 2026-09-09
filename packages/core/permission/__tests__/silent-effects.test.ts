/**
 * 不打扰人的效果类(原子 K2b-2,`docs/design/atom-2026-09.md` §6)。
 *
 * K2a' 加了效果类 `ui_change`,策略表(`core/toolkit/effects.ts`)给它写的是
 * `silent`。但**判定核这一侧有第二张表** —— `decidePermission` 从 R0 之前就写死了
 * 「`read` 之外都要问」。K2a' 留账记的正是这条:两张表管同一个问题,策略表的
 * `silent` 在真权限核里不作数,壳侧 provider 一上线,「把面板挪到右边」会当场弹一
 * 张权限卡。
 *
 * 这只文件钉住 K2b-2 的答案:`ui_change` 进静默集,**其余一类都不动**。第二条用例
 * 是那句「不动」的证据 —— 它把四类今天真会弹卡的效果逐条列出来,任何一次「顺手把
 * 两张表合了」都会当场红,而合表是一次用户可感知的变化,归拍板不归接线。
 */
import { describe, expect, it } from 'vitest'
import { EFFECT_POLICY } from '../../toolkit/effects.js'
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

describe('静默效果类', () => {
  it('ui_change 不进 ask —— 那扇窗是这个人的窗', () => {
    expect(decide('ui_change').decision).toBe('allow')
  })

  it('read 照旧静默', () => {
    expect(decide('read').decision).toBe('allow')
  })

  it('既有的四类一个都没跟着变静默(那是拍点,不是接线)', () => {
    for (const kind of ['net_fetch', 'user_ask', 'session_message', 'session_spawn']) {
      expect(decide(kind).decision, kind).toBe('ask')
    }
  })

  /**
   * K3-a —— 新加的破坏性类。它是**两张表都说 ask** 的第一类:策略表写 `ask`,而
   * 判定核这一侧「`read` / `ui_change` 之外都要问」也把它判成 ask。两张表并存的存量
   * 债照旧在(归拍板),但这一类不因此含糊。
   */
  it('session_destructive 要问 —— 删掉的东西没有第二个地方还留着', () => {
    // 两张表都得说 ask。**判定核这一侧才是行为的产地**:把策略表那一行改成
    // `silent` 不会改变任何事(这条用例照绿),真正的杠杆是上面那个集合 ——
    // 这正是 K2a' 留账的「两张表并存」那笔债的形状,写在这里好让下一个人看见。
    expect(EFFECT_POLICY.session_destructive.policy).toBe('ask')
    expect(decide('session_destructive').decision).toBe('ask')
  })

  it('写盘与跑命令当然还是要问', () => {
    expect(decide('file_write').decision).toBe('ask')
    expect(decide('bash').decision).toBe('ask')
  })
})
