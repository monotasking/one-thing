import { useRef } from 'react'
import { Button } from '../../ui/Button'
import { Checkbox } from '../../ui/Checkbox'
import { IconButton } from '../../ui/IconButton'
import { Tooltip } from '../../ui/Tooltip'
import { Brain, Image, ImagePlus, Mic, SlidersHorizontal, Wrench, X } from '../../components/icons'
import type { LucideIcon } from '../../components/icons'
import type { MessageKey, TFn } from '../../i18n'
import { formatQuantity } from '../../format/quantity'
import { formatPrice } from '../projection'
import { CATALOG_CONTEXT_FALLBACK, CATALOG_MAX_OUTPUT_FALLBACK, MODEL_CAPS } from '../types'
import type { CatalogRow, ModelCap, ModelOverridePatch } from '../types'
import { ModelOverridePopover } from './ModelOverridePopover'
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
 *             **第四种读数(09-09):人填的**——上下文格与最大输出格换笔迹
 *             (虚线下划)+ 悬停出目录原值;工具那一枚被关掉时**画出来但划掉**。
 *             三者不能混:破折号 = 不知道,正常读数 = 目录说的,虚线 = 人说的。
 *   UI 交互状态:rest / hover(行底,CSS 画)/ focus(勾选框与三颗钮各自的
 *             全局焦点环)/ **pending 逐行**(只禁这一行,别的行一个都不许动)/
 *             当前模型那一行没有「设为当前」钮,画的是读数 /
 *             滑杆钮多一格 `aria-expanded`(覆盖浮层开着没有)。
 *
 * ── 09-09 加了第三颗钮,而 DOM 层级与 key 一个字没动 ──────────────────────
 * 覆盖浮层由 `ui/Popover` portal 到 body,所以它在这一行的 DOM 里不占任何位置;
 * 加进 `.actions` 的只有那一颗 `ui/IconButton`。零重挂断言因此照旧绿
 * (`__tests__/model-catalog-state.test.tsx`:同一个 `model-row-a` 节点)。
 * 动作列的宽跟着从 116 加到 142(账在 tokens.css,连同两条 @container 阈值一起重算);
 * 09-09 再晚一笔又到 162 —— 「设为当前」与「当前模型」共读 `--pv-btn-current-w`
 * 的宽下限(用户报障「对齐」:同一列上下相邻的两颗药丸左边线对不上)。
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
/**
 * 窗口 / 最大输出这两格的读数。数怎么进位由 `format/quantity` 那一个产地说
 * (§5.7 收口:从前这里另有一份 `formatTokens`,大写 K、不带小数,与输入框
 * 读数里的小写 k 各说各话);这里只剩本地那一条合同 —— **「没填」不是 0**,
 * null 原样交回去,画什么由调用方决定(它画的是破折号,不是 `0`)。
 */
function formatCatalogTokens(value: number | null): string | null {
  return value === null ? null : formatQuantity(value)
}

function CapIcon({ cap, label, skin }: { cap: ModelCap; label: string; skin?: string }) {
  const Icon = CAP_ICONS[cap]
  return (
    <Tooltip content={label}>
      {/* **不进 Tab 序**:一行五枚、一屏几十行,把它们都变成落焦点就等于
          把键盘走一遍这张表的成本乘以六。名字给读屏的人靠 aria-label,
          那一路本来就不需要焦点。 */}
      <span
        className={skin ? `${s.cap} ${skin}` : s.cap}
        role="img"
        aria-label={label}
        data-testid={`cap-${cap}`}
      >
        <Icon size={14} aria-hidden="true" />
      </span>
    </Tooltip>
  )
}

/**
 * 工具那一枚被**人**说过话时,它的名字(= aria-label = Tooltip 一句话)。
 * 六句整话:自定开 / 自定关 × 目录支持 / 目录不支持 / 目录没填。
 * 拼装不得 —— 「目录:支持」在英文里是 `catalog says yes`,语序与括号都不同。
 */
function toolsOverrideTipKey(custom: boolean, catalog: boolean | null): MessageKey {
  if (custom) {
    if (catalog === null) return 'providers.overrideToolsOnTipUnknown'
    return catalog
      ? 'providers.overrideToolsOnTipCatalogOn'
      : 'providers.overrideToolsOnTipCatalogOff'
  }
  if (catalog === null) return 'providers.overrideToolsOffTipUnknown'
  return catalog
    ? 'providers.overrideToolsOffTipCatalogOn'
    : 'providers.overrideToolsOffTipCatalogOff'
}

/**
 * 这一行的能力串**画哪几枚**。与 `row.caps` 差的只有一格:`override.tools === false`
 * 时 tools 不在 `caps` 里(它此刻真的不支持),但那一位仍要**画一枚划掉的扳手**
 * —— 「消失」是不知道,「划掉」是人说不。顺序仍照 `MODEL_CAPS`,一行五枚
 * 从同一条竖线起笔。
 */
function capsDrawnOf(row: CatalogRow): ModelCap[] {
  return MODEL_CAPS.filter((cap) =>
    cap === 'tools'
      ? row.caps.includes('tools') || row.override.tools === false
      : row.caps.includes(cap),
  )
}

export function ModelCatalogRow({
  t,
  row,
  providerId,
  included,
  pending,
  skip,
  overrideOpen,
  onToggle,
  onSetCurrent,
  onRemoveManual,
  onOverrideOpen,
  onWriteOverride,
}: {
  t: TFn
  row: CatalogRow
  /** 这一坑是谁。只往覆盖浮层里传 —— 这一行自己不用它。 */
  providerId: string
  included: boolean
  /**
   * **这一行**此刻在写吗。只禁这一行 —— 别的行一个都不许动
   * (零重挂断言在 `__tests__/model-catalog-state.test.tsx`:
   *  A 行在飞时 B 行的勾选框既不禁用,也还是操作前那个 DOM 节点)。
   */
  pending: boolean
  /** 长组里的行跳过视口外排版。 */
  skip: boolean
  /** 这一行的覆盖浮层开着吗。**一次只开一个**,所以状态住在目录那一层。 */
  overrideOpen: boolean
  onToggle: (modelId: string, selected: boolean) => void
  onSetCurrent: (modelId: string) => void
  onRemoveManual: (modelId: string) => void
  onOverrideOpen: (open: boolean) => void
  onWriteOverride: (modelId: string, patch: ModelOverridePatch) => void
}) {
  /* 覆盖浮层的锚 = 行尾那颗滑杆钮的活矩形(矩锚跟滚,见 ui/float 的裁定)。 */
  const configureRef = useRef<HTMLButtonElement>(null)

  const custom = row.override.contextLength
  const contextTip =
    custom == null
      ? undefined
      : row.catalog.contextLength != null
        ? t('providers.overrideContext', {
            value: formatQuantity(custom),
            catalog: formatQuantity(row.catalog.contextLength),
          })
        : t('providers.overrideContextNoCatalog', {
            value: formatQuantity(custom),
            fallback: formatQuantity(CATALOG_CONTEXT_FALLBACK),
          })

  /*
   * 最大输出那一格与上下文那一格**同一手**:人填过就换笔迹 + 悬停说出目录原话。
   * 目录没填时括号里说的是**兜底值**(4,096,`model-registry.ts:946`),不编一个
   * 目录值出来 —— 与上一格的 `overrideContextNoCatalog` 逐字同形。
   * 注意 `.out` 在最窄那一档**整列退场**,这枚标记跟着它一起走,不另找地方画:
   * 一列已经不在了,还在别处画它的覆盖标记就是把一个读不到的数说成正在生效。
   */
  const customOut = row.override.maxOutput
  const outTip =
    customOut == null
      ? undefined
      : row.catalog.maxOutput != null
        ? t('providers.overrideOutput', {
            value: formatQuantity(customOut),
            catalog: formatQuantity(row.catalog.maxOutput),
          })
        : t('providers.overrideOutputNoCatalog', {
            value: formatQuantity(customOut),
            fallback: formatQuantity(CATALOG_MAX_OUTPUT_FALLBACK),
          })

  const capsDrawn = capsDrawnOf(row)
  const contextText = formatCatalogTokens(row.contextLength) ?? t('providers.unknownValue')
  const outText = formatCatalogTokens(row.maxOutput) ?? t('providers.unknownValue')

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
        {capsDrawn.length === 0 ? (
          <span className={s.capNone}>{t('providers.unknownValue')}</span>
        ) : (
          capsDrawn.map((cap) => {
            // 工具那一位被人说过话时换名字换皮肤;别的四位一个字不动。
            const custom = cap === 'tools' ? row.override.tools : undefined
            if (custom === undefined) return <CapIcon key={cap} cap={cap} label={t(CAP_LABELS[cap])} />
            return (
              <CapIcon
                key={cap}
                cap={cap}
                label={t(toolsOverrideTipKey(custom, row.catalog.tools))}
                skin={custom ? s.ovr : `${s.ovr} ${s.capOff}`}
              />
            )
          })
        )}
      </span>
      {/* 「这个数是人填的」= 换笔迹(虚线下划)+ 悬停出目录原值。禁 native title=。 */}
      {contextTip ? (
        <Tooltip content={contextTip}>
          <span className={`${s.num} ${s.ovr}`} data-testid={`ctx-${row.id}`}>
            {contextText}
          </span>
        </Tooltip>
      ) : (
        <span className={s.num} data-testid={`ctx-${row.id}`}>
          {contextText}
        </span>
      )}
      {outTip ? (
        <Tooltip content={outTip}>
          <span className={`${s.out} ${s.ovr}`} data-testid={`out-${row.id}`}>
            {outText}
          </span>
        </Tooltip>
      ) : (
        <span className={s.out} data-testid={`out-${row.id}`}>
          {outText}
        </span>
      )}
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
            className={s.setCurrent}
            data-testid={`set-current-${row.id}`}
          >
            {t('providers.setCurrent')}
          </Button>
        )}
        {/*
          逐型配置。**所有行都有** —— 覆盖是给「目录没填」与「目录说错了」两种
          情况准备的,不只给手填(转发站把不支持工具的型标成支持,是后一种)。
          浮层 portal 出去,所以这一行的 DOM 层级与 key 一个字没变(零重挂断言)。
        */}
        <IconButton
          ref={configureRef}
          size="sm"
          icon={SlidersHorizontal}
          label={t('providers.configureModel', { model: row.name })}
          disabled={pending}
          aria-haspopup="dialog"
          aria-expanded={overrideOpen}
          onClick={() => onOverrideOpen(!overrideOpen)}
          testId={`configure-${row.id}`}
        />
        {overrideOpen && (
          <ModelOverridePopover
            row={row}
            providerId={providerId}
            anchor={() => configureRef.current?.getBoundingClientRect() ?? null}
            pending={pending}
            onClose={() => onOverrideOpen(false)}
            onWrite={(patch) => onWriteOverride(row.id, patch)}
          />
        )}
        {/*
          ✕ 只有手填行才有,但它的**位置**每一行都占着:09-09 报障「手填那一行的
          Set current 与滑杆钮比别的行靠左」—— 右对齐的 flex 里多一件就把前面两件
          整体推左。没有 ✕ 的行摆一个同宽的空位(`.slot`),滑杆钮就在每一行落在
          同一个 x 上。同批把 ✕ 从 `ui/Button iconOnly`(28 方)换成 `ui/IconButton`
          (22 方):同一行上两颗图标钮两种尺寸,空位也没法按一个数占。
        */}
        {row.manual ? (
          <IconButton
            size="sm"
            icon={X}
            label={t('providers.removeModel', { model: row.id })}
            disabled={pending}
            onClick={() => onRemoveManual(row.id)}
            testId={`remove-${row.id}`}
          />
        ) : (
          <span className={s.slot} aria-hidden="true" data-testid={`remove-slot-${row.id}`} />
        )}
      </span>
    </div>
  )
}
