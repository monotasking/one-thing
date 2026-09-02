import type { HTMLAttributes } from 'react'
import s from './StatusDot.module.css'

/**
 * **一枚状态点**(09-01 批 2a 第 1 件,视觉词汇立件)。
 *
 * ── 它为什么是一件组件 ──────────────────────────────────────────────────
 * 这枚点是本壳表达「一样东西现在处在什么状态」的**唯一**视觉出口:
 * **状态色只上点,不换底、不上文字**(验收四轴第一条)。存量里同一个词
 * (`.dot`)在 8 个 module.css 各画了一遍(`ui:consume` 的 `shared-vocab-css`
 * 记着这笔账),于是「同一种东西在两块面里长得不一样」——6px 与 4px、
 * 圆与方、有的还顺手给整行换了底色。收成一件之后,想让整块面变红的人
 * 在这件上**找不到把手**:它只画一颗点。
 *
 * ── 无障碍:给不给 label 是两种用法,不是可选参数 ──────────────────────
 * 点旁边**通常已经有文字**(名字 + 一行事实,ProviderRail 就是这样),
 * 那时候点是纯装饰 —— 再给它一个 aria-label,读屏软件会把同一件事念两遍,
 * 那是噪音。所以判据写死在这里:
 *   · 旁边已有等价文字   → 不给 label → `aria-hidden`(默认档);
 *   · 点是**唯一**的信息载体(一行里只有一颗点,没有任何文字说明状态)
 *                        → 给 label → `role="img"` + `aria-label`。
 * `role="img"` 而不是 `status`/`alert`:它是一张「当下什么样」的静态图,
 * 不是一条会打断人的播报;真要播报状态变化,那是 `a11y/live-region` 的事。
 *
 * ── 三类状态(库件规格,收敛战役纪律)──────────────────────────────────
 *   生命状态:无。它没有订阅、没有计时器、没有可变状态 —— 挂载即画,
 *             卸载即无,所以也不需要 HMR dispose。
 *   交互状态:无。**它不是控件**:不进 Tab 序、没有 hover/active/disabled。
 *             一行的 hover 归那一行画,不归点画。
 *   数据状态:六档 tone,各出一条独立配方(见 .module.css)× 两档 size。
 *
 * ── `size` 是**档位,不是自由量**(09-02 批 8a 补口)────────────────────
 * 起因:宿主檐上那颗未保存丸(`components/HostTitle`)与查看器自己那颗迁不进来,
 * 唯一的差别是几何 —— 它们画的是 5px(`--files-open-dot`),这件只认 6px。
 * 于是那两处各自留在外面自绘,而「同一种东西在两块面里长得不一样」正是立这件
 * 要治的病。
 *
 * 补的是**两个档位**(`'md'` 缺省 6px / `'sm'` 5px),不是一个 `size?: number`
 * 也不是一格 `--dot-size` 让消费方去覆盖:一旦几何可以被消费方自由写,
 * 这件就退回成一个「圆点渲染器」,下一次就会出现 7px 和 4.5px ——
 * 档位的意义在于**穷举**,它把「有几种点」这件事留在库里回答。
 * 两档各有自己的 token(`--status-dot` / `--status-dot-sm`),
 * 与 Dock 瓦角那颗 4px 的未读点仍然是三个名字:值撞了也不合并,
 * 「有新东西」与「现在什么状态」是两个词(理由原文在 tokens.css 那一节)。
 *
 * ── `info` 是 09-02 批 6 补的第六档,不是凑数 ──────────────────────────
 * 收编通知中心那一列点时发现:那面画的是**四档命运**(ok / info / warn /
 * error),而这件当时只认得其中三档 —— 缺的那一档一迁过来就只剩两条路:
 * 要么把「一条提示」染成 `idle`(最淡的一档墨,说的是「还没配」),
 * 要么把那面留在外面继续自绘。两条都是把库件的缺口转嫁给消费方。
 * `--info` 本来就是 palette 里的第四档语义色(有自己的产地),所以补的是
 * 一格**已经存在的事实**,不是新造一个语汇。
 *
 * ── 透传口子:落点自己的身份,不是样式旁路(09-02 批 8c 补口)──────────────
 * 剩下的 `HTMLAttributes` 原样摊到根 `<span>`,照 `ui/Card` / `ui/GroupHead` /
 * `ui/Segmented` 的先例。它开的是**落点自己的 `data-testid` / `aria-describedby`**
 * —— 「这颗丸是不是某条契约的锚点」是落点的事实,不是这件的事实,
 * 所以它不该变成第 N 个 prop。
 * **样式仍然只走 `className` 皮肤**:透传不是给人塞 `style={{…}}` 的口子,
 * 那会把配方产地重新打散成每个消费面一份 —— 正是立这件要治的病。
 *
 * 起因是一格具体的哑火:批 8b 把宿主檐那颗未保存丸收编进来时,既有契约
 * `data-testid="host-title-dirty"` **无处可挂** —— 这件当时是封闭的四格,
 * 于是那个 testid 只能落在外面那格纯排版的落位 span 上,读到的是「落位」
 * 不是「那颗丸」。批 8a 给 Card / GroupHead / Segmented 开口子时独漏了它。
 *
 * 撞名的三个键 Omit 掉,各有理由:
 *  · `role` 与 `aria-label` —— 这两格由**给不给 `label`** 那条判据自己定
 *    (文件头「无障碍」那节):给了 label 就是 `role="img"` + 名字,
 *    没给就是 `aria-hidden` 的装饰。让外面盖掉等于把那条判据交出去,
 *    于是又会出现「旁边写着一句话、丸自己也念一遍」的那种噪音;
 *  · `children` —— 它没有身子(整件就是一颗点),收了只会被静默丢掉。
 *
 * 属性次序是**算出来的**:`className` 解构走并入算好的皮肤(透传盖不掉),
 * `role` / `aria-label` / `aria-hidden` 一律排在 rest **之后** —— 它们是这件
 * 的语义身份,类型上已经拦住(`aria-hidden` 没拦,但排在后面就盖不动)。
 * 这里不需要 `ui/Segmented` 那条「`aria-label` 要排 rest 之前」的例外:
 * 那条治的是「本件的可选 `aria-label` 缺席时会写进 undefined 抹掉落点自传的」,
 * 而这件的 `aria-label` 只在 `label` 在场那条分支上出现,永不为 undefined。
 * ──────────────────────────────────────────────────────────────────────
 */
export type StatusDotTone = 'ok' | 'info' | 'warn' | 'bad' | 'idle' | 'off'

/** `md` 6px(缺省,列表 / 详情栏那一族);`sm` 5px(檐上贴着标题的那一颗)。 */
export type StatusDotSize = 'sm' | 'md'

export interface StatusDotProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, 'children' | 'role' | 'aria-label'> {
  /** ok 正常 / info 一条提示 / warn 要注意 / bad 有错 / idle 还没配 / off 停用。 */
  tone: StatusDotTone
  /** 尺寸是**档位不是自由量**(理由见文件头)。缺省 md。 */
  size?: StatusDotSize
  /**
   * 无障碍名。**只在这颗点是唯一信息载体时给** —— 旁边已经写着同一句话时
   * 给它就是让读屏软件念两遍(判据见文件头)。文案归调用方,组件里不落字面。
   */
  label?: string
  className?: string
}

export function StatusDot({ tone, size = 'md', label, className, ...rest }: StatusDotProps) {
  // `md` 不挂第二个类:它的几何就写在 `.dot` 里(缺省档 = 基类),
  // 只有 `sm` 加一条覆盖 —— 少一个类名,也少一次「两个档谁赢」的疑问。
  const cls = [s.dot, s[tone], size === 'sm' ? s.sm : '', className ?? ''].filter(Boolean).join(' ')
  // 两条分支里 `className` 都显式在前且已不在 rest 里(解构走了),
  // 无障碍那三格都排在 rest 之后 —— 透传盖不掉皮肤,也盖不掉语义身份。
  if (label === undefined) return <span className={cls} {...rest} aria-hidden="true" />
  return <span className={cls} {...rest} role="img" aria-label={label} />
}
