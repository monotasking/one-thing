import { formatQuantity } from '../../format/quantity'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import s from './MessageChrome.module.css'

/**
 * 收场通知 —— 消息外缘那一行的**第三张脸**(前两张是流式读数行与幽灵动作行)。
 *
 * ── 它回答的那个问题 ──────────────────────────────────────────────────────
 * 事故(2026-09-09,真店会话 `fe5261d9…`):三次重试都以
 * `request/end.stopReason = 'length'` 收场 —— 2048 的 `maxTokens` 全花在推理上,
 * 一个字正文都没产出。引擎那边这是**正常收场**(`run/end` outcome `completed`),
 * 于是屏幕上什么都不说,用户看到的是「莫名其妙就停了」。这一行字就是那句缺掉的
 * 话:**这一轮为什么提前结束**。
 *
 * ── 事实从哪来 ───────────────────────────────────────────────────────────
 * 全部来自账本,经 core 投影(`message.stop`):`request/end.stopReason` +
 * 同一条请求的 `request/recipe.params.maxTokens` 与 `request/response.usage`。
 * 壳这一侧**一个数都不算、一格都不猜** —— 缺席的键就是账本上真的没有那格账,
 * 那时候改说不带数字的那一句,而不是补一个 0。
 *
 * ── 为什么壳里不出现 reason 的字面量 ─────────────────────────────────────
 * 「哪些 reason 值得占屏幕」是能力面的事,产地是 core 的
 * `session/projection/stop-reasons.ts` 那张表;这里只按 `kind` 查文案。表里将来
 * 加一档新 kind 而壳还没接上时,落到兜底句 `chat.stopGeneric`(原样把 reason
 * 摆出来)—— 不会说错话,也不需要壳跟着改。这正是仓根那条「能力自述、别人读表」。
 *
 * ── 为什么这里没有按钮 ───────────────────────────────────────────────────
 * 正下方的 `MessageActions` 已经有「重试」。同一件事在同一条消息上不许开两个
 * 入口(动作单产地判例);这一行只**陈述**,不提供出口。自动续写、把 4096 那个
 * 兜底改掉,都是另外的拍板,不在这一行字的职责里。
 */

/** 投影交出来的那一格。形状的正本在 `@shared/ipc/chat.ts` 的 `ChatMessage.stop`。 */
export interface StopNoticeFact {
  kind: string
  reason: string
  maxTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}

/**
 * 挑句子 —— **纯函数**,不碰 DOM 也不碰 i18n:它只答「此刻该说哪一句、变量是
 * 什么」,句子长什么样归字典(与 `readoutTone` / presenter 的 `ToolOutcomeModel`
 * 同一条纪律:模型层说键,渲染层才翻译)。
 *
 * `output-limit` 分四句,由两个正交的问题决定:
 *  ① **有没有可见正文** —— 没有正文、而且产出几乎全是推理(`reasoningTokens ≥
 *     outputTokens`),那就不是「被截断」而是「想完就没额度了,一个字没回」。
 *     这两句话对用户是两件事:前者要的是续写,后者要的是把上限调大或少让它想。
 *     判据要两个条件同时成立 —— 只看 token 会把「正文写了一半也用了推理」误判成
 *     没回复,只看正文会把「模型确实答完了但恰好卡在上限」说成想不完。
 *  ② **知不知道上限是多少** —— 老会话的 recipe 里没有 params 那一格,数字就没有。
 *     缺数字时换成不带数字的那一句,而不是写「上限 undefined」或者编一个 4096。
 */
export function stopNoticeLine(
  stop: StopNoticeFact,
  hasVisibleText: boolean,
): { key: MessageKey; vars?: Record<string, string | number> } {
  if (stop.kind === 'output-limit') {
    const thinking = !hasVisibleText
      && stop.reasoningTokens !== undefined
      && stop.outputTokens !== undefined
      && stop.reasoningTokens >= stop.outputTokens
    if (stop.maxTokens === undefined) {
      return { key: thinking ? 'chat.stopOutputLimitThinkingNoLimit' : 'chat.stopOutputLimitNoLimit' }
    }
    // 进位走全壳唯一那个产地(`format/quantity`)—— 模型目录里同一个数
    // (maxOutput)就是这么写的,两处用两把尺会让同一个上限读出两个样子。
    const max = formatQuantity(stop.maxTokens)
    return {
      key: thinking ? 'chat.stopOutputLimitThinking' : 'chat.stopOutputLimit',
      vars: { max },
    }
  }
  if (stop.kind === 'content-filter') return { key: 'chat.stopContentFilter' }
  // 表里加了新档而壳还没接上:原样把归一后的 reason 摆出来。它是**数据**
  // (provider 的词),不进字典 —— 换一门语言它不该跟着变。
  return { key: 'chat.stopGeneric', vars: { reason: stop.reason } }
}

export function StopNotice({ stop, hasVisibleText }: { stop: StopNoticeFact; hasVisibleText: boolean }) {
  const t = useT()
  const { key, vars } = stopNoticeLine(stop, hasVisibleText)
  /*
   * 皮肤复用读数行的 `.readout`(fs-micro、静音色):它与读数行**占同一个位置、
   * 是同一种东西**——消息外缘的一句读数。不换底、不上状态色(验收四轴第一条:
   * 状态色只上图标 / 点)。
   *
   * `role="status"` 而不是 `alert`:这是一条事实陈述,不是需要打断的警报。
   */
  return (
    <div className={s.readout} role="status" data-testid="chat-stop-notice" data-kind={stop.kind}>
      <span>{t(key, vars)}</span>
    </div>
  )
}
