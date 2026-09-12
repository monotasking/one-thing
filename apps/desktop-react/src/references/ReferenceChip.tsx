import { useCallback, useRef, useState } from 'react'
import { useT } from '../i18n'
import { notify } from '../services/notify'
import { ButtonBase } from '../ui/ButtonBase'
import { Tooltip } from '../ui/Tooltip'
import { referenceKindOf } from './registry'

/**
 * **一枚引用画出来的样子** —— 全壳唯一那一只(正本 §2)。
 *
 * 09-12 之前这里是三个各写各的组件(`RefChip` / `SkillChip` / 三段裸 `<span>`),
 * 每加一种引用就多一个。今天它只读那一种自述交出来的 `ChipSpec` **数据表**:
 * 图标 / 记号 / 标签 / 提示 / 可不可点全由那一种说,这只文件一个种类名都不认得。
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

  if (!spec.clickable) {
    return (
      <span className={spec.className} data-ref-kind={spec.dataKind}>
        {body}
      </span>
    )
  }

  const hint = spec.tooltipKey ? t(spec.tooltipKey, spec.tooltipArgs) : undefined
  const button = (
    <ButtonBase
      className={spec.className}
      data-ref-kind={spec.dataKind}
      aria-label={hint}
      aria-busy={pending || undefined}
      onClick={click}
    >
      {body}
    </ButtonBase>
  )

  return hint ? <Tooltip content={hint}>{button}</Tooltip> : button
}
