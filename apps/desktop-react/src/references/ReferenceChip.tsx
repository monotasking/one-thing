import { useCallback, useRef, useState } from 'react'
import { useT } from '../i18n'
import { notify } from '../services/notify'
import { ButtonBase } from '../ui/ButtonBase'
import { PathText } from '../ui/PathText'
import { Tooltip } from '../ui/Tooltip'
import { useHomeDir } from '../data/home-dir'
import { referenceKindOf } from './registry'

/**
 * **一枚引用画出来的样子** —— 全壳唯一那一只(正本 §2)。
 *
 * 09-12 之前这里是三个各写各的组件(`RefChip` / `SkillChip` / 三段裸 `<span>`),
 * 每加一种引用就多一个。今天它只读那一种自述交出来的 `ChipSpec` **数据表**:
 * 图标 / 记号 / 标签 / 提示 / 可不可点全由那一种说,这只文件一个种类名都不认得。
 *
 * ── 09-14:它从「气泡里那一枚」升成**三个宿主那一枚** ──────────────────────
 * 输入框的草稿(`ComposerInput` 的宿主节点 + `createPortal`)、在飞的乐观气泡
 * (`ChatStream` 的 `UserBubble`)、落账的气泡(`content/user-message`)画的都是
 * 这一只、读的都是同一份 `render(ref)`。所以一条消息从按下回车到落账**一次形都
 * 不换** —— 那正是「所见即所发」在代码里的那一句(正本 §6)。皮住在
 * `ReferenceChip.module.css`,同样只有一份。
 *
 * ── 两形,判据是「点得点不得」 ────────────────────────────────────────────
 *  · 可点 = 一枚真按钮(`ui/ButtonBase`,裸钮三类判的第③类:它有自己的形,
 *    不该硬套 `ui/Button`);提示走 `ui/Tooltip`(禁 native `title=`),
 *    键盘可达是 `<button>` 自带的那一格,焦点环走全局 `:focus-visible`。
 *  · 不可点 = 一枚 `<span>`。**屏幕上不该出现一个按下去没反应的东西** ——
 *    所以「可点」不是一档皮肤开关,它说的是这一种到底有没有 `open`。
 *
 * ── pending 那一格的判据:`open` 交回来的是不是一个 promise ────────────────
 * 同步开完的(文件 / 目录:一句 `placeRef`)一格都不闪;要等一发的(技能得先问
 * 一次表)才画「在飞」。**不转圈**(spinner 只许出现在按钮内或状态栏,而这是
 * 一枚行内小牌)—— 只把 `aria-busy` 打上,让 CSS 压淡一档。
 *
 * **不用 `disabled` 挡重复点**:一颗拿着焦点的按钮变 disabled,浏览器会把焦点
 * 丢回 `<body>` —— 那正是响应链 I1 禁的那一形。改用一格 ref 当闸:pending 期间
 * 再点是恒等,焦点一动不动。
 */
export function ReferenceChip({ kindId, value }: { kindId: string; value: unknown }) {
  const t = useT()
  // 家目录:一格宿主事实,拿到之前是 null = 路径不缩(判词在 `data/home-dir`)。
  const home = useHomeDir()
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const kind = referenceKindOf(kindId)
  const spec = kind?.render?.(value)

  const click = useCallback(() => {
    if (busy.current || !kind?.open) return
    const failed = () => {
      if (!spec?.failKey) return
      // 路全落空。说一句话就够 —— 没有详情可看,也不该赖着不走。
      notify({
        level: 'warn',
        source: spec.failSource ?? 'chat.reference',
        title: t(spec.failKey, spec.tooltipArgs),
      })
    }
    const outcome = kind.open(value)
    if (typeof outcome === 'boolean') {
      if (!outcome) failed()
      return
    }
    busy.current = true
    setPending(true)
    void outcome
      .then((ok) => {
        if (!ok) failed()
      })
      .finally(() => {
        busy.current = false
        setPending(false)
      })
  }, [kind, spec, value, t])

  // 认得出却画不出来在登记那一刻就抛了(registry),所以这一句只会在
  // 「这台上没登记过这一种」时成立 —— 那时什么都不画,而不是画半个空壳。
  if (!spec) return null

  const body = (
    <>
      {spec.icon && (
        <spec.icon className={spec.iconClassName} strokeWidth={1.75} aria-hidden="true" />
      )}
      {spec.mark && <span aria-hidden="true">{spec.mark}</span>}
      {spec.labelClassName ? <span className={spec.labelClassName}>{spec.label}</span> : spec.label}
    </>
  )

  /*
   * 屏幕上那句提示:**这一种自述了什么就画什么**,三档按具体程度排 ——
   * 路径(两层形)▷ 一截数据(URL,不过字典)▷ 字典里那一句。这只文件照旧一个
   * 种类名都不认得:它读的是表上那一格,不是「这个 label 看起来像不像路径」
   * (判词整段在 `content/model/title-tip.ts`)。
   */
  const hint = spec.tooltipKey ? t(spec.tooltipKey, spec.tooltipArgs) : undefined
  const tip = spec.tooltipPath ? (
    <PathText path={spec.tooltipPath.path} home={home} layout="stacked" dir={spec.tooltipPath.dir} />
  ) : (
    spec.tooltipText ?? hint
  )

  if (!spec.clickable) {
    /*
     * 不可点 = 一枚 `<span>`,**但它照样可以有提示**(09-14,网页那一枚要说出
     * 整条 URL)。span 进不了 Tab 序,所以这一形的提示只有悬停一条路 ——
     * 那正是「它不是一个可操作的东西」的诚实后果,不必给它硬挂一个 aria-label。
     */
    const plain = (
      <span className={spec.className} data-ref-kind={spec.dataKind}>
        {body}
      </span>
    )
    return tip ? <Tooltip content={tip}>{plain}</Tooltip> : plain
  }

  const button = (
    <ButtonBase
      className={spec.className}
      data-ref-kind={spec.dataKind}
      // **动词留在这儿**(09-13):`hint` 仍是「打开 /Users/…」整句全路径,
      // 屏幕上那一句换成了两层路径。可见文字(basename)包含在无障碍名里,
      // WCAG 2.5.3 成立;复制与打开走的也是全路径。
      aria-label={hint}
      aria-busy={pending || undefined}
      onClick={click}
    >
      {body}
    </ButtonBase>
  )

  return tip ? <Tooltip content={tip}>{button}</Tooltip> : button
}
