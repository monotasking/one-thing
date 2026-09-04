import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useT } from '../i18n'
import { announce } from '../ui/a11y/live-region'
import { Button } from '../ui/Button'
import { Dots } from '../ui/Dots'
import { followPillVisible, type FollowState } from './follow'
import s from './FollowPill.module.css'

/**
 * **「回到最新」丸**(§5.3)。
 *
 * 浏览中、且下面确实长出了没看见的东西时,聊天区底部居中、输入框上方浮的那一枚。
 * 它是**聊天区自己的一个块**,不是 Toast、不是通知(零 Toast 的禁令照守):
 * Toast 会自己消失,而这件事没消失 —— 下面就是还有东西没看。
 *
 * ── 三张脸,判据是两格 ──────────────────────────────────────────────────
 *   回复正在流(`streaming`)   → **三个点**,一个字不写(09-04 用户定)
 *   自己发了一条,回复没开始    → `↓ 已发送`
 *   流收场了,下面还有没看的    → `↓ 回到最新`
 * `streaming` 排在最前:它问的是「此刻在不在跑」,而 `unseen` 问的是「攒下了什么」
 * —— 两件事同时成立时,人先要知道的是前者。
 *
 * ── 三张状态表(状态先行)──────────────────────────────────────────────
 * **① 生命周期**:只在 `browsing ∧ unseen ≠ none` 时挂载;pinned 即卸;换会话即卸
 *   (进场 = pinned)。**没有换宿主这回事** —— 它全仓只有一个落点(聊天区的
 *   `.chatArea`,绝对定位在气口里),不进浮窗 / 架子 / 盖,所以「檐怎么合、
 *   滚动谁管、尺寸谁定」三问在这里都不成立。挂载时播报一次(`announce`),
 *   卸载零残留:没有订阅、没有计时器,那格闩跟着实例走,实例下场它一起没
 *   → **不需要 HMR dispose**。点击后**当场卸载**(不等滚动动画):`onJump`
 *   一句就把状态翻成 pinned,而挂载判据读的就是那格状态。
 * **② UI 生命状态**:三张脸(上表)。`empty` / `loading` / `error` 三格**不成立**
 *   —— 它不吃远端数据,输入是壳自己的两格状态。**超量**同理不成立:
 *   没看见的东西再多它也只有一枚,不数数(计数禁令;而这里连文字读数都不该有,
 *   「下面有 37 条」帮不了任何决定)。动效档 `none` 时不做入场滑动(整条入场
 *   由 `--dur-enter` 归 0 自动退化,组件一行都不必判档),三个点也自动变成三颗
 *   静止的点(`ui/Dots` 自己的降级)。
 * **③ UI 交互状态**:rest / hover / focus / active 四态全部随 `ui/Button` 走
 *   —— 这件一个像素都不自绘(基础件先行)。`disabled` / `pending` 不成立:
 *   它在场就一定按得动,而「回到底」是一次同步赋值,没有在飞这回事。
 *
 * ── 无障碍:播报一次,不挂 `aria-live` ──────────────────────────────────
 * `aria-live` 挂在丸上的话,流式期间每一帧都在变的东西会被念疯(§5.3 原话)。
 * 所以走 `announce()` —— **挂载那一次**说一句,之后闭嘴。换脸不重播:
 * 脸换了但事实没变(下面仍然有没看的),再念一遍是噪音。
 */
export interface FollowPillProps {
  follow: FollowState
  /** 此刻有没有一条回复正在流(产地是 `chat-source` 的 `activeMessageId`)。 */
  streaming: boolean
  onJump: () => void
}

export function FollowPill({ follow, streaming, onJump }: FollowPillProps) {
  const t = useT()
  /*
   * 「挂不挂」问的是纯函数,不是这里现判 —— 判据与单测钉的是同一句话。
   * 早退在 `useT()` 之后:这一层只有那一只 hook,而它无条件跑;
   * 真正带生命周期的那格(播报)住在下面那件里,**它的挂载 = 丸的挂载**。
   */
  if (!followPillVisible(follow)) return null

  /*
   * 三张脸各自的文案与名字。生成中那张**没有可见文字**,所以它的名字是另一句
   * (先说此刻在发生什么,再说按下去会怎样);另外两张「同文案」——
   * 看得见的字与读屏软件念的字逐字相同,这是最省事也最不会说岔的一档。
   */
  const text = follow.unseen === 'sent' ? t('chat.follow.sent') : t('chat.follow.reply')
  const label = streaming ? t('chat.follow.streamingLabel') : text

  return (
    <Pill label={label} onJump={onJump}>
      {streaming ? <Dots /> : text}
    </Pill>
  )
}

/**
 * 内层这一件的存在理由只有一个:**丸的挂载就是它的挂载**。
 *
 * 播报要发生在「丸出现」那一刻,而「出现」在外层是一次 `return null` 的翻转 ——
 * 早退之后写不了 hook(hook 次序不许随分支变)。拆一层,那次翻转就变成一次
 * 真正的挂载 / 卸载,`useEffect` 于是说得出「我出现了」这句话。
 */
function Pill({ label, onJump, children }: { label: string; onJump: () => void; children: ReactNode }) {
  /*
   * **只播一次**。闩而不是空依赖数组:名字会在同一次挂载里变(`已发送 → 回到最新`),
   * 依赖里写 `label` 才不违背 exhaustive-deps,而闩保证那几次变更一句都不多念 ——
   * 脸换了,事实(下面还有没看的)没换。顺带把严格模式下的双挂载也压成一次。
   */
  const spoken = useRef(false)
  useEffect(() => {
    if (spoken.current) return
    spoken.current = true
    announce(label)
  }, [label])

  return (
    <div className={s.slot}>
      {/* 托底是一层单独的皮(理由在 .module.css 的 `.backing` 上):写在钮的
        * className 上会被 ghost 档的 hover 当场换掉,悬停一下丸就透了。 */}
      <div className={s.backing}>
        <Button pill variant="ghost" aria-label={label} data-testid="chat-follow-pill" onClick={onJump}>
          {children}
        </Button>
      </div>
    </div>
  )
}
