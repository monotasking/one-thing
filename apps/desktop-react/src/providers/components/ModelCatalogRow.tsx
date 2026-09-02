import { Button } from '../../ui/Button'
import { Checkbox } from '../../ui/Checkbox'
import { Tooltip } from '../../ui/Tooltip'
import { Brain, Image, ImagePlus, Mic, Wrench } from '../../components/icons'
import type { LucideIcon } from '../../components/icons'
import type { MessageKey, TFn } from '../../i18n'
import { formatPrice, formatTokens } from '../projection'
import { MODEL_CAPS } from '../types'
import type { CatalogRow, ModelCap } from '../types'
import s from './ModelCatalog.module.css'

/**
 * 目录里的**一行**(09-02 批 9a 从 ModelCatalog.tsx 出文件,切线 A)。
 *
 * 出文件是**搬家不是改造**:props 八格一字未改、JSX 的 DOM 层级与 key 一字未动。
 * 理由写在这里而不是提交信息里 —— `__tests__/model-catalog-state.test.tsx` 有
 * 四对「零重挂 / 零位移」断言(`getByTestId('model-row-a')` 前后必须是**同一个
 * DOM 节点**),多包一层 div、或者把这件包进 memo 换了身份,当场红。
 *
 * 皮肤仍然读 `./ModelCatalog.module.css`:那份样式表是**这张七列表**的产地
 * (轨道单产地那条由 `model-catalog-layout.test.tsx` 逐条钉着),
 * 行搬了家不等于表拆成两张。
 *
 * ── 三张状态表(这件那一份)──────────────────────────────────────────────
 *   生命周期:随所属分区挂载 / 卸载;**收起的组不渲染行**(收起还渲染就等于
 *             没折叠),所以这件的卸载是常态而不是异常。无订阅、无计时器、
 *             无模块级副作用 → 不需要 HMR dispose。
 *   UI 生命状态:每一格都可能是「不知道」—— 目录没填就画破折号,不画 0、
 *             不画「免费」;能力一项都没有画破折号而不是五个灰图标
 *             (不知道 ≠ 都不支持);手填的行标出来(它的容量是**没人给过**的)。
 *   UI 交互状态:rest / hover(行底,CSS 画)/ focus(勾选框与两颗钮各自的
 *             全局焦点环)/ **pending 逐行**(只禁这一行,别的行一个都不许动)/
 *             当前模型那一行没有「设为当前」钮,画的是读数。
 */

/** 能力 → 图标 + 全名。**字母缩写退役** —— 「V T R」谁都读不懂(08-31 报障)。 */
const CAP_ICONS: Record<ModelCap, LucideIcon> = {
  vision: Image,
  tools: Wrench,
  reasoning: Brain,
  imageOut: ImagePlus,
  audioIn: Mic,
}

const CAP_LABELS: Record<ModelCap, MessageKey> = {
  vision: 'providers.capVision',
  tools: 'providers.capTools',
  reasoning: 'providers.capReasoning',
  imageOut: 'providers.capImageOut',
  audioIn: 'providers.capAudioIn',
}

/**
 * 一枚能力图标。**图标 + 悬停出全名** —— 图标自己说不出「图像输入」四个字,
 * 所以名字在两处都得有:`aria-label` 给读屏的人,`Tooltip` 给用眼睛的人。
 * 少任何一处,这一格就只对写它的人有意义。
 */
function CapIcon({ cap, label }: { cap: ModelCap; label: string }) {
  const Icon = CAP_ICONS[cap]
  return (
    <Tooltip content={label}>
      {/* **不进 Tab 序**:一行五枚、一屏几十行,把它们都变成落焦点就等于
          把键盘走一遍这张表的成本乘以六。名字给读屏的人靠 aria-label,
          那一路本来就不需要焦点。 */}
      <span className={s.cap} role="img" aria-label={label}>
        <Icon size={14} aria-hidden="true" />
      </span>
    </Tooltip>
  )
}

export function ModelCatalogRow({
  t,
  row,
  included,
  pending,
  skip,
  onToggle,
  onSetCurrent,
  onRemoveManual,
}: {
  t: TFn
  row: CatalogRow
  included: boolean
  /**
   * **这一行**此刻在写吗。只禁这一行 —— 别的行一个都不许动
   * (零重挂断言在 `__tests__/model-catalog-state.test.tsx`:
   *  A 行在飞时 B 行的勾选框既不禁用,也还是操作前那个 DOM 节点)。
   */
  pending: boolean
  /** 长组里的行跳过视口外排版。 */
  skip: boolean
  onToggle: (modelId: string, selected: boolean) => void
  onSetCurrent: (modelId: string) => void
  onRemoveManual: (modelId: string) => void
}) {
  return (
    <div
      className={`${s.grid} ${s.row} ${skip ? s.rowSkip : ''}`}
      data-testid={`model-row-${row.id}`}
    >
      <Checkbox
        checked={row.selected}
        onChange={(next) => onToggle(row.id, next)}
        disabled={pending}
        label={t('providers.pickModel', { model: row.id })}
      />
      <span className={s.cell}>
        <span className={`${s.name} ${row.selected ? '' : s.nameOff}`}>{row.name}</span>
        <span className={s.idLine}>
          <span className={s.id}>{row.id}</span>
          {/* 手填的行标出来:它的能力与容量是**没人给过**的,不是「都不支持」。 */}
          {row.manual && <span className={s.manual}>{t('providers.manualModel')}</span>}
        </span>
      </span>
      <span className={s.caps}>
        {row.caps.length === 0 ? (
          <span className={s.capNone}>{t('providers.unknownValue')}</span>
        ) : (
          MODEL_CAPS.filter((cap) => row.caps.includes(cap)).map((cap) => (
            <CapIcon key={cap} cap={cap} label={t(CAP_LABELS[cap])} />
          ))
        )}
      </span>
      <span className={s.num}>{formatTokens(row.contextLength) ?? t('providers.unknownValue')}</span>
      <span className={s.out}>{formatTokens(row.maxOutput) ?? t('providers.unknownValue')}</span>
      <span className={s.price}>
        {included
          ? t('providers.priceIncluded')
          : row.price
            ? `${formatPrice(row.price.input)} / ${formatPrice(row.price.output)}`
            : t('providers.unknownValue')}
      </span>
      <span className={s.actions}>
        {row.current ? (
          <span className={s.current}>{t('providers.current')}</span>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => onSetCurrent(row.id)}
            data-testid={`set-current-${row.id}`}
          >
            {t('providers.setCurrent')}
          </Button>
        )}
        {row.manual && (
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            disabled={pending}
            onClick={() => onRemoveManual(row.id)}
            aria-label={t('providers.removeModel', { model: row.id })}
          >
            ✕
          </Button>
        )}
      </span>
    </div>
  )
}
