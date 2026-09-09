import { useState } from 'react'
import { ButtonBase } from '../../ui/ButtonBase'
import { Field, useFieldControlProps } from '../../ui/Field'
import { Input } from '../../ui/Input'
import { Popover } from '../../ui/Popover'
import { Segmented } from '../../ui/Segmented'
import { useT } from '../../i18n'
import type { MessageKey, TFn } from '../../i18n'
import { formatQuantity, parseQuantity } from '../../format/quantity'
import { CATALOG_CONTEXT_FALLBACK, requestedMaxOutputOf } from '../types'
import type { CatalogRow, ModelOverridePatch } from '../types'
import s from './ModelOverridePopover.module.css'

/**
 * **逐型覆盖**(09-09,设计正本 `docs/model-override-proposal-2026-09-09.html`)。
 *
 * 后端早就有这三格 —— `settings.ai.providers[pid].contextLengthByModel[m]`、
 * `maxOutputByModel[m]` 与 `modelCapabilitiesByModel[m].tools`,引擎读它们的地方是
 * `model-registry.ts` 的 `getOnethingModelContextLength`(上下文,覆盖优先于目录、
 * 优先于 128k 兜底)、`packages/core/engine/agent-loop-runtime.ts` 的
 * `resolveAgentLoopContextBudgetValues`(最大输出,**填了就直接当请求的 max_tokens**;
 * 没填则按注册上限的一半发,**注册上限也没有就不带 `max_tokens`** —— 09-09 之前
 * 这里兜底 4096 再对半成 2048,那个编出来的数连同它的产地一起在同日删掉了;
 * 全局 `settings.chat.maxTokens` 也在同日整格退役,请求侧只剩这两个来源)
 * 与 `onethingModelSupportsTools`
 * (工具,覆盖优先于目录条目、优先于按名字猜)。
 * 缺的一直只是壳上的写面:手填进来的模型只能进 `selectedModels`,它的窗口有多大、
 * 一次能吐多长、支不支持工具,用户明明知道却没地方说。这块浮层就是那张嘴,
 * **后端零改动**。
 *
 * ── 它为什么不是一张对话框 ──────────────────────────────────────────────
 * 三格设置,贴着被配置的那一行开出来,背后那张表照旧能看能滚 —— 那正是
 * `ui/Popover` 的语义(附属,不打断)。做成 Dialog 会压一层遮罩,把「顺手改
 * 一格」变成「答一道题」。定位走 Popover 的**矩锚档**(本批给它补的,
 * 与 `ui/Menu` 逐字同形)+ `below-end`:锚点是行尾那颗钮,左对齐会把整张浮层
 * 甩到目录外面去(判例:密钥池的行菜单,09-02 批 12)。
 *
 * ── 三张状态表(这件那一份)──────────────────────────────────────────────
 *
 * ① 生命周期
 *   挂载   点行尾那颗滑杆钮。**开的那一刻从设置读一次**:两个数字框各自的草稿 =
 *          自己那一格的覆盖值或空,分段器不用草稿(它每一下都当场写,自己没有
 *          中间态)。两个数字框**各自独立提交**(各自的 blur / ↵),
 *          改一格不动另一格 —— 它们是两张表,不是一次表单。
 *   卸载   关浮层 / 换模式换坑(开合状态住在 `ModelCatalog`,换坑那一发
 *          `useEffect` 把它归零)/ 这一行被折叠起来。
 *   换宿主 只有一种落点:锚在那颗钮下面的一块浮层。没有第二种形。
 *   副作用 无订阅、无计时器、无模块级副作用 → 不需要 HMR dispose。
 *
 * ② UI 生命状态
 *   无覆盖   数字框空 + 占位符写**生效值与它的来源**;分段在「跟目录」;
 *            「恢复目录值」禁用。
 *   有覆盖   数字框是那个数;分段在开/关;「恢复目录值」可按。
 *   目录没填 占位符与提示行都说生效值(上下文 128k;最大输出**没有数可说** ——
 *            请求里根本不带 `max_tokens`,写「由服务商决定」),
 *            并且说清「跟目录」跟的是**猜**(按名字判,规则在
 *            `model-registry.ts` 的 `onethingModelSupportsTools` —— 壳不复刻那张表,
 *            只如实说出这件事)。
 *   填错     边线转 danger + 错误句**替换**那一格自己的提示行;不写、行上一格不动。
 *            **两格各自一份 invalid** —— 上一格填错不该把下一格也判红。
 *   在写     这一行的三颗钮与浮层里的四件控件一起禁;别的行一个都不许动。
 *
 * ③ UI 交互状态
 *   数字框 rest / hover / focus / invalid / disabled;**失焦与 ↵ 才提交**
 *          (不逐字打后端);Esc 归响应链(`ui/Popover` 声明的 `onEscape`),
 *          草稿随浮层一起丢掉。两格同一件 `QuantityInput`,只是各自一份 state。
 *   分段器 三格 radio,←→ 换格(`ui/Segmented` 的 roving),**点一下就写**。
 *   恢复钮 rest / hover / disabled(没覆盖时)。
 */

/**
 * 两个数字框共用的上限。**不是校验口味,是防手滑**:一个多按了几个零的窗口会让
 * 压缩阈值算在一个根本不存在的量级上(引擎那侧只判 `> 0`,不封顶),而一个多按
 * 了几个零的最大输出会**直接进请求的 max_tokens**。
 * 1 亿 token 比今天任何一个真实窗口都大两个数量级,夹在这里等于「不挡真值,
 * 只挡打错」。与退役的 Vue 壳同一个数(那时它只管上下文,叫 `MAX_CONTEXT_OVERRIDE`)。
 */
export const MAX_QUANTITY_OVERRIDE = 100_000_000

/**
 * 框里回显一个已写进去的数。**能短写就短写**(`200000` → `200k`),但只在短写
 * 能一字不差解析回同一个数时 —— `1048576` 短写成 `1M` 就成了另一个数,
 * 那种就原样写整数。框里的字与盘上的数任何时候都得是同一个。
 */
function draftOf(value: number): string {
  const short = formatQuantity(value)
  return parseQuantity(short) === value ? short : String(value)
}

/** 分段器那三格。`inherit` = 不覆盖(删键),不是「第三种值」。 */
type ToolsChoice = 'inherit' | 'on' | 'off'

/** 覆盖 → 分段器的格。`undefined`(没覆盖)才是「跟目录」。 */
function toolsChoiceOf(override: boolean | undefined): ToolsChoice {
  if (override === undefined) return 'inherit'
  return override ? 'on' : 'off'
}

/**
 * 上下文那一格的提示行。**四句整话,不拼装** —— 「目录 1.0M」与「默认 128k」
 * 在中文里是两个不同的说法,把它们做成一个 `{fallback}` 变量再拼,换一门语言
 * 就得连语序一起赌。
 */
function contextHint(t: TFn, row: CatalogRow): string {
  const custom = row.override.contextLength
  const catalog = row.catalog.contextLength
  if (custom != null) {
    return catalog != null
      ? t('providers.overrideContextHintCustom', {
          value: formatQuantity(custom),
          fallback: formatQuantity(catalog),
        })
      : t('providers.overrideContextHintCustomDefault', {
          value: formatQuantity(custom),
          fallback: formatQuantity(CATALOG_CONTEXT_FALLBACK),
        })
  }
  return catalog != null
    ? t('providers.overrideContextHintCatalog', { n: catalog.toLocaleString() })
    : t('providers.overrideContextHintDefault', { n: formatQuantity(CATALOG_CONTEXT_FALLBACK) })
}

/** 数字框的占位符 —— 写的是**今天实际生效的数与它的来源**,不是一句提示语。 */
function contextPlaceholder(t: TFn, row: CatalogRow): string {
  const catalog = row.catalog.contextLength
  return catalog != null
    ? t('providers.overrideContextPlaceholderCatalog', { n: catalog.toLocaleString() })
    : t('providers.overrideContextPlaceholderDefault', {
        n: formatQuantity(CATALOG_CONTEXT_FALLBACK),
      })
}

/**
 * 最大输出那一格的提示行。**三**句整话(09-09 一度加到四句,同日又收回三句:
 * 全局 `chat.maxTokens` 整格退役 —— 两个设置管一个值,只留这一格)。
 *
 * 这一格与上下文那一格**读法不同**,所以话也不同:引擎对上下文是「覆盖优先,
 * 否则用目录的数,再不行按 128k 算」——那一格**永远有一个数**;而最大输出这一格
 * 的算式是 `perModelOverride ?? halfDefault`
 * (`resolveAgentLoopContextBudgetValues`),两个都缺席时结果是 **undefined**,
 * 请求里**干脆不带 `max_tokens`**。所以这一格有一句上下文那格没有的话:
 * 「由服务商决定」。
 *
 * 三句各自要说出的那件事:
 *   自定    填了就直接当 max_tokens,不对半,只受模型物理上限夹一次。
 *   目录有  按目录上限的**一半**发。那个「一半」是这一格最容易被误读的事实 ——
 *           不说出来,用户会把「目录 16,384」读成「一次能吐 16,384」,而实际只发 8,192。
 *   目录空  不带上限。09-09 之前这里说的是「兜底 4,096 的一半 = 2,048」,
 *           而那个 4096 是引擎编出来的:它同日连同产地一起删了,屏幕上也就不再有
 *           这个数可说 —— 说了就是把一个不存在的数画给用户看,而用户填 10000 被夹成
 *           4096 那次事故正是这么来的。
 */
function maxOutputHint(t: TFn, row: CatalogRow): string {
  const custom = row.override.maxOutput
  const catalog = row.catalog.maxOutput
  if (custom != null) {
    return t('providers.overrideOutputHintCustom', { value: custom.toLocaleString() })
  }
  if (catalog != null) {
    return t('providers.overrideOutputHintCatalog', { n: catalog.toLocaleString() })
  }
  return t('providers.overrideOutputHintNoCatalog')
}

/**
 * 最大输出的占位符 —— 与上一格同一条合同:写的是**今天实际会发出去的数与它的
 * 来源**。目录有数时写的不是目录那个数,而是它的一半(那才是请求里真出现的数);
 * 目录没数时就没有数可写,写的是那件事本身:「由服务商决定」。
 * 数一律写全位(`toLocaleString`)不进位:这一档的数只有四五位,而
 * 「8.2k」与「8,192」之间那 8 个 token 在 max_tokens 上是真的差别。
 */
function maxOutputPlaceholder(t: TFn, row: CatalogRow): string {
  const catalog = row.catalog.maxOutput
  if (catalog != null) {
    return t('providers.overrideOutputPlaceholderCatalog', {
      n: requestedMaxOutputOf(catalog).toLocaleString(),
      catalog: catalog.toLocaleString(),
    })
  }
  return t('providers.overrideOutputPlaceholderNoCatalog')
}

/** 工具那一格的提示行。五态,同样是整话。 */
function toolsHintKey(choice: ToolsChoice, catalog: boolean | null): MessageKey {
  if (choice === 'on') return 'providers.overrideToolsHintOn'
  if (choice === 'off') {
    if (catalog === null) return 'providers.overrideToolsHintOffUnknown'
    return catalog
      ? 'providers.overrideToolsHintOffCatalogOn'
      : 'providers.overrideToolsHintOffCatalogOff'
  }
  // 「跟目录」而目录没填 —— 跟的是**按名字猜**,这件事得说出来,不能藏。
  if (catalog === null) return 'providers.overrideToolsHintGuess'
  return catalog
    ? 'providers.overrideToolsHintCatalogOn'
    : 'providers.overrideToolsHintCatalogOff'
}

export function ModelOverridePopover({
  row,
  providerId,
  anchor,
  pending,
  onClose,
  onWrite,
}: {
  row: CatalogRow
  /** 这一坑是谁。浮层不显示它,但落点得说得出自己属于哪一坑(门与单测按它取)。 */
  providerId: string
  /** 锚:行尾那颗滑杆钮的活矩形。`ui/Popover` 的矩锚档跟着它滚。 */
  anchor: () => DOMRect | null
  /** **这一行**此刻在写吗。只禁这一行的控件。 */
  pending: boolean
  onClose: () => void
  onWrite: (patch: ModelOverridePatch) => void
}) {
  const t = useT()

  /*
   * 草稿**只在这里**,而且只在打开的那一刻从设置读一次(生命周期表第二行)。
   * 浮层不自持任何「写入状态」—— 写完之后行上的读数换成什么,由 store 那一份
   * 乐观更新说了算,不是这里再记一遍。
   */
  const [draft, setDraft] = useState(() =>
    row.override.contextLength != null ? draftOf(row.override.contextLength) : '',
  )
  const [invalid, setInvalid] = useState(false)
  /* 第二个数字框自己的一份 —— 同一件控件,两份互不相干的 state。 */
  const [outDraft, setOutDraft] = useState(() =>
    row.override.maxOutput != null ? draftOf(row.override.maxOutput) : '',
  )
  const [outInvalid, setOutInvalid] = useState(false)

  const choice = toolsChoiceOf(row.override.tools)
  const hasOverride =
    row.override.contextLength != null ||
    row.override.maxOutput != null ||
    row.override.tools !== undefined

  const rect = anchor()

  /**
   * 提交一次上下文。**失焦与 ↵ 各调一次**,中间打字一个请求都不发。
   * 三条出口,一条都不许合并:空 = 删键;认不出来 / 非正数 = 不写并报错;
   * 合法 = 夹上限后写(夹完把框里的字换成真写进去的那个数 —— 屏幕上留着一个
   * 没被采纳的数就是在说谎)。认什么写法由 `parseQuantity` 一处说了算
   * (`200k` / `1M` / `200,000` 都行,09-09 用户要的)。
   */
  function commitContext() {
    const raw = draft.trim()
    if (raw === '') {
      setInvalid(false)
      // 本来就没覆盖时一发都不发:删一个不存在的键是一次白跑的往返。
      if (row.override.contextLength != null) onWrite({ contextLength: null })
      return
    }
    const parsed = parseQuantity(raw)
    if (parsed === null) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    const next = Math.min(parsed, MAX_QUANTITY_OVERRIDE)
    setDraft(draftOf(next))
    if (next === row.override.contextLength) return
    onWrite({ contextLength: next })
  }

  /**
   * 提交一次最大输出。**与上面那一条逐字同形**(三条出口、同一把 `parseQuantity`
   * 的尺、同一个上限、同样夹完回显),差的只有写哪一个键 —— 两格是两张表,
   * 各自 blur / ↵、各自提交,改一格不动另一格。
   */
  function commitMaxOutput() {
    const raw = outDraft.trim()
    if (raw === '') {
      setOutInvalid(false)
      if (row.override.maxOutput != null) onWrite({ maxOutput: null })
      return
    }
    const parsed = parseQuantity(raw)
    if (parsed === null) {
      setOutInvalid(true)
      return
    }
    setOutInvalid(false)
    const next = Math.min(parsed, MAX_QUANTITY_OVERRIDE)
    setOutDraft(draftOf(next))
    if (next === row.override.maxOutput) return
    onWrite({ maxOutput: next })
  }

  function pickTools(value: ToolsChoice) {
    if (value === choice) return
    onWrite({ tools: value === 'inherit' ? null : value === 'on' })
  }

  return (
    <Popover
      x={rect?.right ?? 0}
      y={rect?.bottom ?? 0}
      anchor={anchor}
      /* 锚点贴着这一行的右边线,左对齐会把整张浮层甩到目录外面去。 */
      anchorPlace="below-end"
      label={row.name}
      onClose={onClose}
      testId="model-override"
    >
      <div className={s.body} data-provider={providerId} data-model={row.id}>
        <div className={s.head}>
          <span className={s.name}>{row.name}</span>
          <span className={s.ident}>
            {row.manual ? `${row.id} · ${t('providers.manualModel')}` : row.id}
          </span>
        </div>

        <Field
          size="sm"
          className={s.grp}
          label={t('providers.overrideContextLabel')}
          hint={invalid ? undefined : contextHint(t, row)}
          error={invalid ? t('providers.overrideContextInvalid') : undefined}
        >
          <QuantityInput
            draft={draft}
            invalid={invalid}
            disabled={pending}
            placeholder={contextPlaceholder(t, row)}
            unit={t('providers.overrideContextUnit')}
            testId="model-override-context"
            onDraft={(value) => {
              setDraft(value)
              // 一边打字一边把上一次那句错误抹掉:它是对上一次提交说的。
              setInvalid(false)
            }}
            onCommit={commitContext}
          />
        </Field>

        {/*
          最大输出。放在上下文之后、工具之前 —— 两个「数」挨着,一个「开关」在后,
          而不是把同一族的两格拆到分段器两边。
        */}
        <Field
          size="sm"
          className={s.grp}
          label={t('providers.overrideOutputLabel')}
          hint={outInvalid ? undefined : maxOutputHint(t, row)}
          error={outInvalid ? t('providers.overrideContextInvalid') : undefined}
        >
          <QuantityInput
            draft={outDraft}
            invalid={outInvalid}
            disabled={pending}
            placeholder={maxOutputPlaceholder(t, row)}
            unit={t('providers.overrideContextUnit')}
            testId="model-override-output"
            onDraft={(value) => {
              setOutDraft(value)
              setOutInvalid(false)
            }}
            onCommit={commitMaxOutput}
          />
        </Field>

        <Field
          size="sm"
          className={s.grp}
          label={t('providers.overrideToolsLabel')}
          hint={t(toolsHintKey(choice, row.catalog.tools))}
        >
          <ToolsSegmented
            value={choice}
            disabled={pending}
            label={t('providers.overrideToolsLabel')}
            onPick={pickTools}
          />
        </Field>

        <div className={s.foot}>
          <span className={s.footNote}>{t('providers.overrideFoot')}</span>
          {/*
            ③ 类行内微型文字动作 → `ui/ButtonBase`(只清 UA,皮肤归本地)。
            点它 = **三个键一起删**:这颗钮说的是「恢复目录值」,只删一个就是
            半句话 —— 而剩下那些留在盘上,屏幕上还照旧画着虚线。
          */}
          <ButtonBase
            className={s.reset}
            disabled={pending || !hasOverride}
            data-testid="model-override-reset"
            onClick={() => {
              setDraft('')
              setInvalid(false)
              setOutDraft('')
              setOutInvalid(false)
              onWrite({ contextLength: null, maxOutput: null, tools: null })
            }}
          >
            {t('providers.overrideReset')}
          </ButtonBase>
        </div>
      </div>
    </Popover>
  )
}

/**
 * 数字框那一件,**两格共用一件**(上下文窗口 / 最大输出)。认什么写法、怎么回显、
 * 什么时候提交,两格逐字同一套 —— 复制第二份的下场是两个框慢慢认起不同的写法。
 * 各自不同的只有四样,全部走参数:占位符、`testId`、草稿、提交时写哪个键。
 *
 * **单独一件是因为 hook 只能在组件里调**:`useFieldControlProps()` 拿的是
 * `<Field>` 往下发的 context,在 Field 外面那一层调只会拿到空对象
 * (id / aria-describedby / aria-invalid 全丢)—— 与 `AddModelRow` 同一手。
 */
function QuantityInput({
  draft,
  invalid,
  disabled,
  placeholder,
  unit,
  testId,
  onDraft,
  onCommit,
}: {
  draft: string
  invalid: boolean
  disabled: boolean
  placeholder: string
  unit: string
  testId: string
  onDraft: (value: string) => void
  onCommit: () => void
}) {
  const field = useFieldControlProps()
  return (
    <Input
      {...field}
      size="sm"
      value={draft}
      onValueChange={onDraft}
      disabled={disabled}
      invalid={invalid}
      placeholder={placeholder}
      /* 不给 inputMode="numeric":那副软键盘上没有 k / M,而这一格就是要认它们。 */
      data-testid={testId}
      suffix={<span className={s.unit}>{unit}</span>}
      onBlur={onCommit}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        onCommit()
      }}
    />
  )
}

/**
 * 分段器那一件。同样是为了 `useFieldControlProps()` —— 它把 `aria-labelledby`
 * 与 `aria-describedby` 接到 radiogroup 上,读屏软件才念得出这一组叫什么、
 * 下面那句提示说了什么。
 */
function ToolsSegmented({
  value,
  disabled,
  label,
  onPick,
}: {
  value: ToolsChoice
  disabled: boolean
  label: string
  onPick: (value: ToolsChoice) => void
}) {
  const t = useT()
  const field = useFieldControlProps()
  return (
    <Segmented<ToolsChoice>
      {...field}
      value={value}
      disabled={disabled}
      label={label}
      data-testid="model-override-tools"
      options={[
        { value: 'inherit', label: t('providers.overrideToolsInherit') },
        { value: 'on', label: t('providers.overrideToolsOn') },
        { value: 'off', label: t('providers.overrideToolsOff') },
      ]}
      onChange={onPick}
    />
  )
}
