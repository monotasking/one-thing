import { useState } from 'react'
import { ButtonBase } from '../../ui/ButtonBase'
import { Field, useFieldControlProps } from '../../ui/Field'
import { IconButton } from '../../ui/IconButton'
import { InlineEditStrip } from '../../ui/InlineEditStrip'
import { useInlineEdit } from '../../ui/inline-edit'
import { Input } from '../../ui/Input'
import { Popover } from '../../ui/Popover'
import { Segmented } from '../../ui/Segmented'
import { Pencil } from '../../components/icons'
import { useT } from '../../i18n'
import type { MessageKey, TFn } from '../../i18n'
import { formatQuantity, parseQuantity } from '../../format/quantity'
import { CAPABILITY_KEYS, CAP_OF_KEY, CATALOG_CONTEXT_FALLBACK, requestedMaxOutputOf } from '../types'
import type { CapabilityKey, CatalogRow, ModelOverridePatch } from '../types'
import { CAP_ICONS, CAP_LABELS } from './model-capability-icons'
import s from './ModelOverridePopover.module.css'

/**
 * **逐型覆盖**(09-09,设计正本 `docs/model-override-proposal-2026-09-09.html`)。
 *
 * 后端早就有这三张表 —— `settings.ai.providers[pid].contextLengthByModel[m]`、
 * `maxOutputByModel[m]` 与 `modelCapabilitiesByModel[m]`,引擎读它们的地方是
 * `model-registry.ts` 的 `getOnethingModelContextLength`(上下文,覆盖优先于目录、
 * 优先于 128k 兜底)、`packages/core/engine/agent-loop-runtime.ts` 的
 * `resolveAgentLoopContextBudgetValues`(最大输出,**填了就直接当请求的 max_tokens**;
 * 没填则按注册上限的一半发,**注册上限也没有就不带 `max_tokens`** —— 09-09 之前
 * 这里兜底 4096 再对半成 2048,那个编出来的数连同它的产地一起在同日删掉了;
 * 全局 `settings.chat.maxTokens` 也在同日整格退役,请求侧只剩这两个来源)
 * 与 `runtime/src/providers/model-capability.ts` 的 `resolveOnethingModelCapabilities`
 * (五项能力,覆盖优先于目录条目、优先于按名字猜的规则表)。
 * 缺的一直只是壳上的写面:手填进来的模型只能进 `selectedModels`,它的窗口有多大、
 * 一次能吐多长、支不支持工具,用户明明知道却没地方说。这块浮层就是那张嘴,
 * **后端零改动**。
 *
 * ── 09-10:能力从一格开到五格 ───────────────────────────────────────────
 * 用户原话「模型能力也要配置,现在只有 tool call」。后端那张
 * `ModelCapabilityOverride` 从第一天起就是六个键,壳只接了 `tools` 一个 ——
 * 于是「这一型其实看得懂图 / 收得下 PDF」这句话在壳上无处可说。
 * 本批把它开成 `vision / tools / reasoning / imageOutput / fileInput` 五行
 * (第六个键 `audio` 不开面,见 `types.ts` 的 `CapabilityKey` 注)。
 * 随之退役的是工具那一格从前那五句随状态换的提示语 —— 五格照抄就是二十五句,
 * 而它们真正在说的「目录说了什么」现在由每一行右边的三态小字如实说出来。
 *
 * ── 它为什么不是一张对话框 ──────────────────────────────────────────────
 * 几格设置,贴着被配置的那一行开出来,背后那张表照旧能看能滚 —— 那正是
 * `ui/Popover` 的语义(附属,不打断)。做成 Dialog 会压一层遮罩,把「顺手改
 * 一格」变成「答一道题」。定位走 Popover 的**矩锚档**(本批给它补的,
 * 与 `ui/Menu` 逐字同形)+ `below-end`:锚点是行尾那颗钮,左对齐会把整张浮层
 * 甩到目录外面去(判例:密钥池的行菜单,09-02 批 12)。
 *
 * ── 三张状态表(这件那一份)──────────────────────────────────────────────
 *
 * ① 生命周期
 *   挂载   点行尾那颗滑杆钮。**开的那一刻从设置读一次**:两个数字框各自的草稿 =
 *          自己那一格的覆盖值或空,五只分段器不用草稿(它们每一下都当场写,
 *          自己没有中间态)。两个数字框**各自独立提交**(各自的 blur / ↵),
 *          改一格不动另一格 —— 它们是两张表,不是一次表单;五项能力同理,
 *          点一行只写那一键。
 *          **头部那一行是读数还是在改 id**(09-11)也在这一格:挂载恒是读数,
 *          草稿不预生成 —— 草稿的寿命是「这一次编辑」,不是「这张浮层」。
 *   卸载   关浮层 / 换模式换坑(开合状态住在 `ModelCatalog`,换坑那一发
 *          `useEffect` 把它归零)/ 这一行被折叠起来。**改 id 成功也算一次卸载**:
 *          行的 id 变了,目录层把浮层开到新 id 上,这张随旧行一起走、新行上
 *          重新挂一张(`ModelCatalogRow` 的 key 就是 `row.id`)。成功那一支
 *          仍显式退出编辑态 —— 为没有目录层的场合(单测 / 规格页)守住同一个行为。
 *   换宿主 只有一种落点:锚在那颗钮下面的一块浮层。没有第二种形。**滚动归浮层**
 *          (`ui/Popover` 自带 `max-height` + `overflow:auto`)—— 能力开成五行
 *          之后这块浮层能长到接近一屏高,那条既有约束是它不溢出屏幕的唯一保证。
 *   副作用 无订阅、无计时器、无模块级副作用 → 不需要 HMR dispose。
 *
 * ② UI 生命状态
 *   无覆盖   数字框空 + 占位符写**生效值与它的来源**;五行分段都在「跟目录」;
 *            「恢复目录值」禁用。
 *   有覆盖   数字框是那个数;被动过的那一行分段在开/关;「恢复目录值」可按。
 *   目录没填 占位符与提示行都说生效值(上下文 128k;最大输出**没有数可说** ——
 *            请求里根本不带 `max_tokens`,写「由服务商决定」);能力那五行
 *            右边的小字说「目录:没填」,而分段**仍是三格** —— 目录没填不等于
 *            不能覆盖,覆盖恰恰是给这一档准备的。
 *   填错     边线转 danger + 错误句**替换**那一格自己的提示行;不写、行上一格不动。
 *            **两格各自一份 invalid** —— 上一格填错不该把下一格也判红。
 *            能力那一组**没有错误态**:分段是封闭集合,填不错。
 *   超量     能力恒五行(`CAPABILITY_KEYS` 是编译期常量),不随数据涨。
 *            id 可以很长(openrouter 那种):读数态 `.ident` 是那一行唯一的弯腰件
 *            (笔 `flex:none`),编辑态输入框是那一条唯一的弯腰件(两颗钮 `flex:none`)。
 *   头部三态 (09-11)读数 / 在改 id / 改被拒。**目录里有的行没有第三态也没有笔** ——
 *            它的 id 是目录说的,改了就对不上目录,所以 `onRename` 不传 =
 *            这一格**结构上不存在**,不是画一颗禁着的笔。被拒那一态:输入框边线
 *            转 danger + 错误句折到第二行(`ui/Field` 的 error 槽,`aria-invalid`
 *            与 `aria-describedby` 一并拿到),草稿**一个字不清**(让人看得见自己
 *            刚打的是什么,与 `AddModelRow` 同一手)。
 *   在写     这一行的三颗钮与浮层里的七件控件一起禁;别的行一个都不许动。
 *            头部同此:读数态笔禁,编辑态输入框与两颗钮一起禁(主钮换
 *            `common.saving` + 一枚 Spinner —— `ui/InlineEditStrip` 的 busy 档)。
 *
 * ③ UI 交互状态
 *   数字框 rest / hover / focus / invalid / disabled;**失焦与 ↵ 才提交**
 *          (不逐字打后端);Esc 归响应链(`ui/Popover` 声明的 `onEscape`),
 *          草稿随浮层一起丢掉。两格同一件 `QuantityInput`,只是各自一份 state。
 *   分段器 三格 radio,←→ 换格(`ui/Segmented` 的 roving),**点一下就写**。
 *          五只各自一份值,`aria-label` 是自己那一项的能力名。
 *   能力名 / 目录小字 纯读数,不可交互(它们是事实不是控件)。
 *   恢复钮 rest / hover / disabled(没覆盖时)。
 *   笔     rest / hover / active / focus / disabled(在写);提示走 `ui/IconButton`
 *          自带的 `ui/Tooltip`(禁 native title=),名字 = aria-label = 提示。
 *   id 输入条 形归 `ui/InlineEditStrip`、手势归 `ui/inline-edit`(↵ 落定 /
 *          Esc 收回 / 一进来选中全文),**这块面一行 keydown 监听都不写**。
 *          `cancelOnBlur` 关着:并肩站着两颗真钮,而 `blur` 在 `click` 之前到 ——
 *          失焦即取消会把那两颗钮变成永远点不到的(判据全文在 `ui/inline-edit`)。
 *          **Esc 在这里退的是编辑,不是浮层**:`ui/inline-edit` 向响应链登记的
 *          那个瞬态口在活动路径**之前**被问到,浮层自己那句 `onEscape`
 *          (`ui/Popover` 声明的)因此轮不到 —— 不在编辑时它照旧关浮层。
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
type CapChoice = 'inherit' | 'on' | 'off'

/** 覆盖 → 分段器的格。`undefined`(没覆盖)才是「跟目录」。 */
function capChoiceOf(override: boolean | undefined): CapChoice {
  if (override === undefined) return 'inherit'
  return override ? 'on' : 'off'
}

/** 目录对这一项说过什么。三句整话,不拼装(「目录:没填」不是「目录:」+「没填」)。 */
function catalogFactKey(catalog: boolean | null): MessageKey {
  if (catalog === null) return 'providers.overrideCatalogUnset'
  return catalog ? 'providers.overrideCatalogYes' : 'providers.overrideCatalogNo'
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

export function ModelOverridePopover({
  row,
  providerId,
  anchor,
  pending,
  onClose,
  onWrite,
  onRename,
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
  /**
   * 改这一型的 id(09-11)。**缺席 = 这一行的 id 不给改**,头部连笔都不画 ——
   * 目录里有的行正是这一档:它的 id 是目录说的,改了就对不上目录。
   * 同步返回一句错误原文 = 没改成(口径与 `addManualModel` 同);
   * 答 undefined = 收工(包括「新旧同名」那一种,它是取消不是错误)。
   */
  onRename?: (newId: string) => string | undefined
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

  /*
   * 头部那一行此刻在改 id 吗(09-11)。`null` = 读数态;一个字符串 = 正在改,
   * 里面装的就是草稿。**两格分开**(草稿 + 一句错误)的理由与上面两个数字框
   * 同一条:错误是对**上一次提交**说的,打字要把它就地抹掉。
   */
  const [idDraft, setIdDraft] = useState<string | null>(null)
  const [idError, setIdError] = useState<string | undefined>(undefined)

  const hasOverride =
    row.override.contextLength != null ||
    row.override.maxOutput != null ||
    CAPABILITY_KEYS.some((key) => row.override.caps[key] !== undefined)

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

  /**
   * 改一项能力。**只写这一键**(`caps` 里就一格)—— 五行是五张各自的嘴,
   * 点开图像输入不该顺手把工具调用也答一遍。`inherit` = 删键,不是第三种值。
   */
  /**
   * 落定一次改 id。三条出口,与两个数字框同一种分法:
   *  · 被拒(空 / 重名)→ **留在编辑态、草稿一个字不清**,红字就地说原因;
   *  · 收工 → 退出编辑态。「新旧同名」走的正是这一支(store 答 undefined
   *    且一发都不发)—— 那是取消,不是错误。
   *
   * 递出去的是 **trim 过的**那个 id:草稿里的空格是草稿的事,要改成的 id
   * 是那个看得见的字。目录层据它把浮层开到新 id 上(`setOpenOverride`),
   * 所以这里递一个带空格的字符串会让浮层跟丢 —— 一处 trim,两边同一个字。
   */
  function commitRename() {
    if (!onRename || idDraft === null) return
    const problem = onRename(idDraft.trim())
    setIdError(problem)
    if (problem) return
    setIdDraft(null)
  }

  function pickCap(key: CapabilityKey, value: CapChoice) {
    if (value === capChoiceOf(row.override.caps[key])) return
    onWrite({ caps: { [key]: value === 'inherit' ? null : value === 'on' } })
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
          {idDraft !== null ? (
            /*
              改 id 那一条**顶替 id 那一行**(不是挤在它旁边):这块浮层内容宽只有
              `--pv-override-w`,一行里塞不下「id · 手填 + 输入框 + 两颗钮」。
              错误句经 `ui/Field` 的 error 槽折到第二行占满宽 —— 横排档唯一的
              错误落点(与 `AddModelRow` 同一手),读屏拿得到 `aria-invalid`
              与 `aria-describedby`。
            */
            <Field
              layout="inline"
              size="sm"
              labelHidden
              label={t('providers.renameModel')}
              error={idError}
              className={s.renameField}
            >
              <InlineEditStrip
                className={s.renameStrip}
                saveLabel={t('providers.renameModelSave')}
                savingLabel={t('common.saving')}
                cancelLabel={t('common.cancel')}
                busy={pending}
                canSave={idDraft.trim().length > 0}
                onCommit={commitRename}
                onCancel={() => {
                  setIdDraft(null)
                  setIdError(undefined)
                }}
              >
                <RenameInput
                  draft={idDraft}
                  invalid={Boolean(idError)}
                  disabled={pending}
                  onDraft={(value) => {
                    setIdDraft(value)
                    // 一边打字一边把上一次那句错误抹掉:它是对上一次提交说的。
                    setIdError(undefined)
                  }}
                  onCommit={commitRename}
                  onCancel={() => {
                    setIdDraft(null)
                    setIdError(undefined)
                  }}
                />
              </InlineEditStrip>
            </Field>
          ) : (
            <span className={s.identLine}>
              <span className={s.ident}>
                {row.manual ? `${row.id} · ${t('providers.manualModel')}` : row.id}
              </span>
              {/*
                笔只在**能改**的时候在场(= 手填行,由 `onRename` 在不在场说了算)。
                目录里有的行不画一颗禁着的笔 —— 那是在说「这里有个开关,只是此刻
                不给你按」,而事实是它根本没有这一格。
              */}
              {onRename && (
                <IconButton
                  size="xs"
                  icon={Pencil}
                  label={t('providers.renameModel')}
                  disabled={pending}
                  onClick={() => {
                    setIdDraft(row.id)
                    setIdError(undefined)
                  }}
                  testId={`model-override-rename-${row.id}`}
                />
              )}
            </span>
          )}
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

        {/*
          能力五行。**一组一句 hint,一行一句目录事实** —— 从前工具那一格有五句
          随状态换的整话,五格照抄就是二十五句;而那五句里真正随状态变的只有
          「目录说了什么」,它现在由每一行右边的小字如实说出来(三态),
          剩下那半句「关了会怎样」对五项是同一句,归组上那一句 hint。
        */}
        <Field
          size="sm"
          className={s.grp}
          label={t('providers.overrideCapsLabel')}
          hint={t('providers.overrideCapsHint')}
        >
          <CapabilityGroup row={row} disabled={pending} onPick={pickCap} />
        </Field>

        <div className={s.foot}>
          <span className={s.footNote}>{t('providers.overrideFoot')}</span>
          {/*
            ③ 类行内微型文字动作 → `ui/ButtonBase`(只清 UA,皮肤归本地)。
            点它 = **七个键一起删**(两个数 + 五项能力):这颗钮说的是「恢复
            目录值」,只删一部分就是半句话 —— 而剩下那些留在盘上,屏幕上还照旧
            画着虚线。`audio` 不在这七个里:壳没让用户设过它,也就没资格替他删。
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
              onWrite({
                contextLength: null,
                maxOutput: null,
                caps: Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, null])),
              })
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
 * 改 id 那一格的输入框。**单独一件仍然是因为 hook 只能在组件里调**
 * (`useFieldControlProps()` 要在 `<Field>` 的 context 之内 —— 与 `QuantityInput`、
 * `AddModelRow.ManualIdInput`、`CredentialPool.RowInput` 同一条理由)。
 *
 * 手势整只交给 `ui/inline-edit`:↵ 落定 / Esc 收回 / 一进来 focus + 全选
 * (`controlId` 一到手跑一次,id 由 `ui/Field` 的 `useId` 给、跨渲染稳定,
 * 所以重渲不会把光标重新拽回开头)。**`cancelOnBlur` 关着**:这一形并肩站着
 * 「保存」与「取消」两颗真钮,而 `blur` 在 `click` 之前到。
 *
 * id 是**标识不是句子**,所以框里的字走 mono —— 与它顶替掉的那一行读数
 * (`.ident`)同一种笔迹,改到一半不会看着像换了一个东西。
 */
function RenameInput({
  draft,
  invalid,
  disabled,
  onDraft,
  onCommit,
  onCancel,
}: {
  draft: string
  invalid: boolean
  disabled: boolean
  onDraft: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  const t = useT()
  const field = useFieldControlProps()
  const edit = useInlineEdit({ controlId: field.id, onCommit, onCancel })
  return (
    <Input
      {...field}
      {...edit}
      size="sm"
      className={s.renameInput}
      value={draft}
      onValueChange={onDraft}
      disabled={disabled}
      invalid={invalid}
      placeholder={t('providers.addModelPlaceholder')}
      data-testid="model-override-rename-input"
    />
  )
}

/**
 * 能力五行。同样是为了 `useFieldControlProps()` —— 但摊的地方与另外两格不同:
 *
 * 那两格是「一个 Field 一件控件」,`{...field}` 直接摊在控件上。这一组里有**五只**
 * 分段器,五只都摊就是五个同 id 的元素(axe 的 `duplicate-id`),而且 Field 那句
 * 「能力」也不该同时当五只 radiogroup 的名字。所以摊的是**组自己**:
 * 一个 `role="group"` 的容器吃下 id / `aria-labelledby`(那句「能力」)/
 * `aria-describedby`(那句 hint)—— 正是 `ui/Field` 文件头「不可标注的控件走
 * aria-labelledby」那一档;每只分段器再各自带自己的 `label`(= 能力名),
 * 读屏软件念出来是「能力,分组 → 图像输入,单选组」。
 *
 * 行的形是**两行**不是一行:分段器那三格在英文里是「Follow catalog / On / Off」,
 * 一只就 ≈215px,而这张浮层内容宽只有 268px —— 与能力名同一行就得让名字弯腰到
 * 看不见。挤压纪律(一行一个弯腰件)在这里的答案是**不挤**:名字与目录事实占
 * 第一行(名字弯腰,目录事实定宽),分段器独占第二行。
 */
function CapabilityGroup({
  row,
  disabled,
  onPick,
}: {
  row: CatalogRow
  disabled: boolean
  onPick: (key: CapabilityKey, value: CapChoice) => void
}) {
  const t = useT()
  const field = useFieldControlProps()
  return (
    <div {...field} role="group" className={s.caps} data-testid="model-override-caps">
      {CAPABILITY_KEYS.map((key) => (
        <CapabilityRow key={key} capKey={key} row={row} disabled={disabled} onPick={onPick} t={t} />
      ))}
    </div>
  )
}

/** 一项能力:`[图标 + 名字] [目录事实]` / `[跟目录 | 开 | 关]`。 */
function CapabilityRow({
  capKey,
  row,
  disabled,
  onPick,
  t,
}: {
  capKey: CapabilityKey
  row: CatalogRow
  disabled: boolean
  onPick: (key: CapabilityKey, value: CapChoice) => void
  t: TFn
}) {
  const cap = CAP_OF_KEY[capKey]
  const Icon = CAP_ICONS[cap]
  const name = t(CAP_LABELS[cap])
  return (
    <div className={s.capRow}>
      <span className={s.capHead}>
        <Icon size={14} aria-hidden="true" className={s.capIcon} />
        {/* 名字**画出来**,不只当 aria-label:这一行没有别的东西说得出它是谁。 */}
        <span className={s.capName}>{name}</span>
        <span className={s.capFact}>{t(catalogFactKey(row.catalog.caps[capKey]))}</span>
      </span>
      <Segmented<CapChoice>
        value={capChoiceOf(row.override.caps[capKey])}
        disabled={disabled}
        label={name}
        data-testid={`model-override-cap-${capKey}`}
        options={[
          { value: 'inherit', label: t('providers.overrideCapInherit') },
          { value: 'on', label: t('providers.overrideCapOn') },
          { value: 'off', label: t('providers.overrideCapOff') },
        ]}
        onChange={(value) => onPick(capKey, value)}
      />
    </div>
  )
}
