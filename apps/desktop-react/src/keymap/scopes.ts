import { FOCUS_SCOPE_LIST, FOCUS_SCOPES } from '../focus/scopes'
import { findCommand } from './commands'
import { effectiveCombos, sameCombo } from './transitions'
import type { FocusScopeId } from '../focus/types'
import type { MessageKey } from '../i18n'
import type { CommandId, KeymapState } from './types'

/**
 * **「谁答这条命令」** —— 快捷键三层立法在 K0 之后剩下的那一问。
 *
 * ── 这只文件的三段史 ────────────────────────────────────────────────────
 * ① 09-01:它是**面域局部键的正本**(`SCOPED_KEYS`)—— 中间那一层从前没有名字,
 *    查看器的 ⌘S/⌘L、文件行的 ⌘I 有名字、能撞车、却不在任何一张表里。
 * ② 09-02/03(R0→R2):正本搬去 `focus/scopes.ts`(局部键本来就是「作用域自己的
 *    键」,而作用域是响应链上的东西),这里只剩 `scopedCollisionsOf` ——
 *    把「全局命令与局部键撞在一个组合上」这件事说给设置页听。
 * ③ K0(2026-09-12):**撞车这个问题不存在了**。三块面的 ⌘F 不再是三条恰好同键
 *    的局部键,而是**同一条命令** `view.find` 的三个响应者;⌘L 上的两条命令由
 *    冲突规则批准(`keymap/commands.comboConflictBetween`:作用域集合不交)。
 *    于是 `scopedCollisionsOf` 退役,换成两只**投影**:
 *
 *      `answerersOf(command)` —— 这条命令谁答得出,各自怎么称呼它;
 *      `claimantsOf(state, command)` —— 这个键在哪几块面里归里面那台程序。
 *
 * 两只都只**读**正本(`FOCUS_SCOPES[*].answers` / `.claims`),没有第二份数据。
 *
 * ── 三层(判词照旧,措辞跟着 K0 走)──────────────────────────────────────
 * ① **应用级命令**(`app: true`)—— 焦点在哪儿都响:活动路径上没人接住时由
 *    `keymap/run-command.ts` 兜底。语义:呼出一块面 / 做一件全局的事。
 * ② **跟随焦点的命令**(`app: false`)—— 它需要一个由焦点决定的目标,所以没有
 *    兜底:没人答就放行。语义:这块面自己的动作(存这份文件 / 在这块屏幕里查找)。
 * ③ **行内结构键** —— 方向键 / Enter / Space / Tab / Esc 的 DOM 焦点语义。
 *    **不进任何表**,理由与 `types.ts` 里那段逐字相同:它们是这套语法本身,
 *    一旦可配置,「Esc 就是退一层」这条全局承诺就没了。
 *
 * 撞键裁决也照旧:**局部先接,没接住放行** —— 由活动路径的深度保证
 * (`focus/transitions.routeKey` 由深到浅),不靠冒泡序。
 */

/** 一格「谁答」:哪块面、它管这件事叫什么。 */
export interface CommandAnswerer {
  scope: FocusScopeId
  /** 这块面对这条命令的说法;没覆盖就是命令自己那一句通名。 */
  labelKey: MessageKey
}

/**
 * 这条命令**谁答得出**(声明这一头,不问树上此刻有没有那一格实例)。
 *
 * 设置页一行一命令,右边那一列读它:「查找 ⌘F —— 浏览器(在这一页里查找)/
 * 终端(在这块屏幕里查找)/ 查看器(在这份文件里检索)」。三句话仍然是三句,
 * 但它们挂在**响应者**上,不再各绑一次键 —— 那正是 K0 要治的那件事。
 */
export function answerersOf(command: CommandId): CommandAnswerer[] {
  const fallback = findCommand(command)?.labelKey
  const out: CommandAnswerer[] = []
  for (const spec of FOCUS_SCOPE_LIST) {
    for (const answer of spec.answers ?? []) {
      if (answer.command !== command) continue
      const labelKey = answer.labelKey ?? fallback
      if (labelKey) out.push({ scope: spec.id, labelKey })
    }
  }
  return out
}

/**
 * 这条命令**当下绑的键**在哪几块面里被认领走了(`FOCUS_SCOPES[*].claims`)。
 *
 * 今天只有一个答案:Win / Linux 上终端认领的那五个 `Ctrl+字母`。设置页要把它
 * 说出来 —— 「⌘P 检索面:终端里这个键交给终端」。这不是错误(它正是「在终端里
 * `^P` 是上一条历史」),但不许**静默**:一个键在某块面里根本不到应用这儿来,
 * 用户有权在键位页上看见。
 *
 * 判据与 `bindCombo` 同一只 `sameCombo`(⌘P 与 Ctrl+P 判为同一条绑定),所以
 * 「设置页说得出」与「派发器真的这么走」不会分叉。
 */
export function claimantsOf(state: KeymapState, command: CommandId): FocusScopeId[] {
  const combos = effectiveCombos(state, command)
  if (combos.length === 0) return []
  const out: FocusScopeId[] = []
  for (const spec of FOCUS_SCOPE_LIST) {
    const claims = spec.claims ?? []
    if (claims.some((c) => combos.some((mine) => sameCombo(mine, c)))) out.push(spec.id)
  }
  return out
}

/** 一格作用域给人读的名字(设置页的「谁答」列与「归里面」那一句都用它)。 */
export function scopeLabelKeyOf(scope: FocusScopeId): MessageKey {
  return FOCUS_SCOPES[scope].labelKey
}
