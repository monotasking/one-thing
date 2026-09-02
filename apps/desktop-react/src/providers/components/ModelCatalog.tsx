import { useEffect, useMemo, useRef, useState } from 'react'
import { AsyncButton } from '../../ui/AsyncButton'
import { Button } from '../../ui/Button'
import { Checkbox } from '../../ui/Checkbox'
import { GroupHead } from '../../ui/GroupHead'
import { Input } from '../../ui/Input'
import { Tooltip } from '../../ui/Tooltip'
import { useFrozenFlags } from '../../ui/list-placement'
import { Brain, ChevronsUp, Image, ImagePlus, Mic, TriangleAlert, Wrench } from '../../components/icons'
import type { LucideIcon } from '../../components/icons'
import { useT } from '../../i18n'
import type { MessageKey, TFn } from '../../i18n'
import type { AsyncSource } from '../../data/kernel'
import type { QueryPhase } from '../../data/kernel'
import {
  formatFetchedAt,
  formatPrice,
  formatTokens,
  groupCatalog,
  priceIsIncluded,
} from '../projection'
import { settingsKey } from '../store'
import { MODEL_CAPS, OTHER_GROUP } from '../types'
import type { CatalogGroup, CatalogRow, ModelCap, ProviderModeKind } from '../types'
import s from './ModelCatalog.module.css'

/**
 * 一坑的模型目录。**目录跟着模式走** —— 订阅坑与 API 坑各一份,这块组件一次只
 * 画一份,所以它连「合并两份目录」的可能性都没有。
 *
 * 一行七格:勾选 / 模型(名 + id)/ 能力 / 上下文 / 最大输出 / 单价 / 当前模型。
 * 每一格都可能是「不知道」——目录没填就画一个破折号,不画 0、不画「免费」。
 *
 * ── 300+ 行怎么画(削量三层)────────────────────────────────────────────────
 * OpenRouter 一家就 300 多型,平铺是卡顿的产地。三条判据全在 `groupCatalog` 里
 * (纯函数、可断言):①已选置顶、②按 `vendor/` 前缀分组(≥60 行才分)、
 * ③检索时截 50 行并如实报剩余。这块组件只负责**收起的组不渲染行** ——
 * 收起还渲染 DOM 就等于没折叠,那是这类列表最常见的假优化。
 *
 * ── 状态戏份(K1 · 第四轴「状态完备性」的立法样板)──────────────────────────
 * 这块面的取数是一族 kernel query(`providers/catalog-query.ts`),于是它有四个
 * **互不冒充**的读数,每一个对应屏幕上一处、且只有一处:
 *
 *   phase==='initial'  骨架 / 空态。**只有它**能让屏幕上没有行
 *   inflight           刷新钮换字 + 禁用 —— **只有 AsyncButton 读它**,
 *                      所以它连一个 prop 都不必是:钮直接吃那一族 query
 *   error              表头下面那一行原话 —— **与旧行并存**,不清屏
 *   updatedAt/dataRev  收尾的两种可感知:时刻更新(总是)与内容变了(才有)
 *
 * 「重拉时旧行仍在 DOM」「刷新完屏幕不跳」两条由 `__tests__/model-catalog-state.test.tsx`
 * 钉死;真机那一半是逐帧截图 diff(汇报里有读数)。
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
 * 超过这个行数的**展开**组,行上挂 `content-visibility: auto` 让浏览器跳过
 * 视口外的排版。只对长组挂:短组挂了只是多一层 containment,白付成本。
 */
const SKIP_ROWS_FROM = 40

/**
 * 往上找第一个**自己会滚**的祖先。认的是计算样式(`overflow-y` 是 auto / scroll),
 * 不是类名 —— 类名会被改,而「谁在滚」是一条样式事实。
 * 一个都没有 = 在滚的是视口本身,交回 null(IntersectionObserver 的缺省 root)。
 */
function scrollParentOf(node: Element): Element | null {
  let current = node.parentElement
  while (current) {
    const overflowY = getComputedStyle(current).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return current
    current = current.parentElement
  }
  return null
}

/**
 * 「一次落位」的淡入闸:token 变了就播一遍,`animationend` 自己收 ——
 * **没有一个 ms 字面量**,时长归 CSS 的 --dur 族,动效档调到「无」时它是 0ms,
 * 于是 animationend 立刻回来,这段逻辑连分支都不必写。
 *
 * 挂载那一次不播:那时屏幕上本来就在长内容,再淡一次是噪音。
 */
function useSettlePulse(token: number): { on: boolean; end: () => void } {
  const seen = useRef(token)
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (token === seen.current) return
    seen.current = token
    setOn(true)
  }, [token])
  return { on, end: () => setOn(false) }
}

export function ModelCatalog({
  providerId,
  rows,
  phase,
  error,
  fetchedAt,
  dataRev,
  refresh,
  kind,
  query,
  pendingModelIds,
  write,
  onQuery,
  onRefresh,
  onToggle,
  onSetCurrent,
  onAddManual,
  onRemoveManual,
}: {
  /** 这一坑是谁。换一坑要把「展开了哪些组」忘掉 —— 那是上一坑的事。 */
  providerId: string
  rows: readonly CatalogRow[]
  /** 'initial' = 这一坑从来没拿到过目录。骨架 / 空态**只看它**。 */
  phase: QueryPhase
  /** 后端那句原话。原样显示 —— 它是数据,不是文案。 */
  error?: string
  fetchedAt?: number
  /** 内容**真的变了**几次。它是「新数据落位」那一下淡入的唯一引信。 */
  dataRev: number
  /** 刷新钮绑的那件异步事(就是这一坑的 query)。 */
  refresh: AsyncSource | undefined
  kind: ProviderModeKind
  query: string
  /**
   * **此刻在写的那些模型 id**(律③:逐格)。从前这里是一颗 `saving: boolean`,
   * 于是勾一个模型会把整张表连同「设为当前」一起禁灰 —— 09-01 报障的
   * 「勾选闪烁」就是它。现在只有正在写的那一行会禁,其余一行都不许动。
   */
  pendingModelIds: ReadonlySet<string>
  /** 手填提交那颗钮绑的那件异步事(设置写路那一发 mutation)。 */
  write: AsyncSource | undefined
  onQuery: (value: string) => void
  onRefresh: () => void
  onToggle: (modelId: string, selected: boolean) => void
  /** 设为这一坑的当前模型(写 `providers[pid].model`)。 */
  onSetCurrent: (modelId: string) => void
  /** 手填一个目录里没有的 id。返回一句错误原文 = 没加上。 */
  onAddManual: (modelId: string) => string | undefined
  onRemoveManual: (modelId: string) => void
}) {
  const t = useT()
  const fetched = formatFetchedAt(fetchedAt)
  const included = priceIsIncluded(kind)
  const searching = query.trim().length > 0

  /*
   * ── 位置固化(09-01 报障:「选中或取消它的位置会改变,很难受」)──────────
   * 「已选置顶」这条判据从前直接读 `row.selected`,于是**勾选就是一次重排**:
   * 真机量到勾一下中段的模型,它当场从第 16 行飞到第 3 行(-689px),而且因为
   * 换了父容器,DOM 节点整个被换掉。
   *
   * 修法是把**位置**与**状态**拆开(原语 `ui/list-placement`,交互稳定四律
   * C 型变体):位置读一张快照,状态照旧读活值。
   *
   * 快照什么时候重拍,由 `token` 一句话说清 —— **换一坑** 或 **拉到一份新目录**
   * (`fetchedAt` 每次成功拉取都前进,显式点「刷新目录」也在内)。
   * 用户改的那一格(`selected`)**不在 token 里**,这正是「冻住」的全部含义。
   */
  const placement = useFrozenFlags(
    rows,
    (row) => row.id,
    (row) => row.selected,
    `${providerId}:${fetchedAt ?? 0}`,
  )

  const grouped = useMemo(
    () => groupCatalog(rows, searching, placement),
    [rows, searching, placement],
  )

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [addError, setAddError] = useState<string | undefined>(undefined)

  const headRef = useRef<HTMLDivElement>(null)
  const topMark = useRef<HTMLDivElement>(null)
  const [pastTop, setPastTop] = useState(false)

  /** 时刻更新(每次成功都有)与内容更新(只有真变了才有)是两件事,各播各的。 */
  const stamp = useSettlePulse(fetchedAt ?? 0)
  const content = useSettlePulse(dataRev)

  // 换一坑 = 换一份目录。上一坑展开过哪些组、正在填的那个 id,都不能跟过来。
  useEffect(() => {
    setExpanded(new Set())
    setAdding(false)
    setDraft('')
    setAddError(undefined)
    setPastTop(false)
  }, [providerId])

  /*
   * 「滚过目录头了没有」——问的是目录**头**是不是已经从上面出去了,不是问
   * 滚动条的数。
   *
   * 两个坑,都是真机上一次一次撞出来的,所以判据写成了现在这个样子:
   *
   * ① **必须问方向**。`!isIntersecting` 同时意味着「已经滚过去了」和
   *    「还没滚到」——目录排在详情列下半截,开面时它本来就在视野下方,
   *    于是回顶钮一上来就出现了。所以判据要看哨兵在视口的**上面**还是下面。
   *
   * ② **root 必须是真正在滚的那一层**,不能用缺省的视口。缺省 root 下
   *    `rootBounds` 是**窗口**的矩形,而这里真正在滚的是详情列
   *    (`ProviderDetail` 的 `.body`,它自己从窗口顶往下 150px 才开始)——
   *    哨兵被 `.body` 裁掉时,它相对**窗口**的 top 仍然是正数,于是 ①
   *    那个判据恒假,钮永远出不来(真机上量到:滚到 1200px 仍然不出现)。
   *    把滚动层交给 observer 当 root,`rootBounds` 就是它的矩形,①才算得准。
   *
   * 往上摸一次 DOM 找滚动层,是这两个坑之后**必要**的代价:布局知识不摸
   * 就换成了一个错的读数。摸法只认计算样式(overflow),不认类名。
   */
  useEffect(() => {
    const mark = topMark.current
    if (!mark || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) =>
        setPastTop(
          entries.some(
            (entry) =>
              !entry.isIntersecting &&
              entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0),
          ),
        ),
      { root: scrollParentOf(mark), threshold: 0 },
    )
    observer.observe(mark)
    return () => observer.disconnect()
  }, [])

  function submitManual() {
    const id = draft.trim()
    if (!id) return
    const failure = onAddManual(id)
    setAddError(failure)
    if (failure) return
    setDraft('')
  }

  /*
   * 骨架 / 空态**只有首载**能画。有过内容之后,重拉一律留着旧行(律②)。
   *
   * 首载这一档里**不再分「在飞」与「还没开始」**:取数是挂载后的一个副作用,
   * 中间隔着一帧,而那一帧按「没在飞」画就会闪一下「这一坑还没有模型」——
   * 一句当时并不成立的话。首载只有两种诚实答案:「在拿」或者「没拿到,原话是这句」。
   * 「空」是一个**只有拿到过才说得出口**的结论,所以它归 ready 那一档。
   */
  const firstLoad = phase === 'initial'
  const emptyLine = firstLoad
    ? error
      ? undefined
      : t('providers.catalogLoading')
    : rows.length === 0
      ? searching
        ? t('providers.catalogNoHit')
        : t('providers.catalogEmpty')
      : undefined

  return (
    <section className={s.catalog} aria-label={t('providers.catalog')}>
      <div className={s.head} ref={headRef}>
        <div className={s.headText}>
          <h3 className={s.title}>{t('providers.catalog')}</h3>
          {/*
            时刻这一格是**收尾的可感知信号**:刷新回来哪怕一个字节都没变,
            这里的「上次拉取」也会往前走,并淡一下让人知道「真的问过了」。
            淡入的名字与时长都是 token(见 styles/motion.css 的名字表)。
          */}
          <span
            className={`${s.hint} ${stamp.on ? s.settled : ''}`}
            onAnimationEnd={stamp.end}
            data-testid="catalog-stamp"
          >
            {fetched
              ? `${t('providers.catalogFetched', { time: fetched })} · ${t('providers.catalogHint')}`
              : t('providers.catalogHint')}
          </span>
        </div>
        <div className={s.search}>
          <Input
            size="sm"
            value={query}
            onValueChange={onQuery}
            placeholder={t('providers.catalogSearch')}
            aria-label={t('providers.catalogSearch')}
          />
        </div>
        {/*
          进行中反馈:**钮自己变文字 + 禁用**(08-31 报障:点了没动静)。
          这一颗从「临时手写」升级成了原语绑定 —— `AsyncButton` 吃这一坑的
          query,忙态是读来的不是这里记的一份,防闪的 150ms 闸也在它里面
          (缓存命中极快时不该闪一下「在拉了」再闪回来)。
          失败不弹 toast:错误就地画在表头下面那一行,离出事的地方最近。
        */}
        <AsyncButton
          size="sm"
          action={refresh}
          pendingLabel={t('providers.catalogLoading')}
          onClick={onRefresh}
        >
          {t('providers.catalogRefresh')}
        </AsyncButton>
        <Button
          size="sm"
          onClick={() => {
            setAdding((open) => !open)
            setAddError(undefined)
          }}
          aria-expanded={adding}
        >
          {t('providers.addModel')}
        </Button>
      </div>

      {/* 「头还在视野里吗」的哨兵。零高度、不占位、不进无障碍树。 */}
      <div ref={topMark} className={s.topMark} aria-hidden="true" />

      {adding && (
        <div className={s.addRow}>
          <div className={s.addField}>
            <Input
              size="sm"
              value={draft}
              onValueChange={(value) => {
                setDraft(value)
                setAddError(undefined)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submitManual()
                }
              }}
              invalid={Boolean(addError)}
              placeholder={t('providers.addModelPlaceholder')}
              aria-label={t('providers.addModelLabel')}
            />
          </div>
          {/*
            手填提交:这一发写的模型 id 此刻还不在表里,挂不到任何一行上,
            所以它自己就是那一格(`manual:<providerId>`)。忙态是**读来的**
            (AsyncButton 吃 mutation),不是这里再记一份。
          */}
          <AsyncButton
            size="sm"
            variant="primary"
            action={write}
            pendingKey={settingsKey.manual(providerId)}
            pendingLabel={t('common.saving')}
            disabled={!draft.trim()}
            onClick={submitManual}
          >
            {t('providers.addModelSubmit')}
          </AsyncButton>
          {addError && <span className={s.addError}>{addError}</span>}
        </div>
      )}

      <div className={`${s.grid} ${s.columns}`}>
        <span />
        <span>{t('providers.colModel')}</span>
        <span>{t('providers.colCaps')}</span>
        <span>{t('providers.colCtx')}</span>
        {/* 窄容器里这一格与行上的最大输出一起退场 —— 类名是它俩的共同开关。 */}
        <span className={s.colOut}>{t('providers.colOut')}</span>
        {/* 窄容器里这一格与行上的价格一起退场 —— 类名是它俩的共同开关。 */}
        <span className={s.colPrice}>{t('providers.colPrice')}</span>
        <span />
      </div>

      {/*
        错误**与旧行并存**(律②的另一半):这一行只说「这次没拿到,原话是这句」,
        它不负责把表清掉。危险色只上图标与字 —— 不铺底、不描边(规范画布状态色纪律)。
      */}
      {error && (
        <p className={s.error} role="status">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>
            {t('providers.catalogFailed')}
            {error ? ` · ${error}` : ''}
          </span>
        </p>
      )}
      {emptyLine && <p className={s.state}>{emptyLine}</p>}

      {rows.length > 0 && (
        <div
          className={`${s.rows} ${content.on ? s.settled : ''}`}
          onAnimationEnd={content.end}
          data-testid="catalog-rows"
        >
          {/*
            已选置顶。**只有折叠生效时才画这条组头** —— 平铺的目录里
            「已选 · 3」是一句废话,行本来就都在眼前。

            读数报的是**此刻真的勾着几个**,不是这一区里有几行:位置固化之后,
            刚被取消的那一行会留在这一区里(不许在用户手底下挪窝),但它已经
            不算「已选」了。区里有几行是排版的事,读数说的必须是事实。
          */}
          {grouped.grouped && grouped.picked.length > 0 && (
            // 静态形(不给 onToggle)—— 这一区永远展开,它没有开合可言。
            // 「已选 · 3」包一层 `.pickedLabel`:GroupHead 的 label 自带 text-1
            // (组名那一档),而这条是**分隔字**,颜色由内容说了算(名册同一手)。
            <GroupHead
              className={s.stickyHead}
              label={
                <span className={s.pickedLabel}>
                  {t('providers.groupPicked', {
                    count: grouped.picked.filter((row) => row.selected).length,
                  })}
                </span>
              }
            />
          )}
          {grouped.picked.map((row) => (
            <Row
              key={row.id}
              t={t}
              row={row}
              included={included}
              pending={pendingModelIds.has(row.id)}
              skip={false}
              onToggle={onToggle}
              onSetCurrent={onSetCurrent}
              onRemoveManual={onRemoveManual}
            />
          ))}

          {grouped.groups.map((group) => {
            const open = !grouped.grouped || searching || expanded.has(group.prefix)
            const skip = open && group.rows.length > SKIP_ROWS_FROM
            return (
              <div key={group.prefix}>
                {grouped.grouped && (
                  // 可折叠形(给了 onToggle):caret / aria-expanded / 键盘全归库件,
                  // 这里只交出「这一组开着没有」和「点了怎么办」。
                  // 组名包一层 `.vendorName`:厂牌前缀是 **id 不是句子**,走 mono ——
                  // 落在内容那一层而不是去覆盖库件的 .label(名册 ProviderRail 同一手)。
                  <GroupHead
                    className={s.stickyHead}
                    collapsed={!open}
                    // 检索时组是被**判据**打开的,不是用户打开的 —— 那时这颗钮
                    // 点了不该把它关上,不然「命中的组自动展开」立刻自相矛盾。
                    disabled={searching}
                    onToggle={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev)
                        if (next.has(group.prefix)) next.delete(group.prefix)
                        else next.add(group.prefix)
                        return next
                      })
                    }
                    data-testid={`model-group-${group.prefix.trim() || 'other'}`}
                    label={<span className={s.vendorName}>{groupLabel(t, group)}</span>}
                    note={groupNote(t, group)}
                  />
                )}
                {/* 收起 = **不渲染行**。收起还渲染就等于没折叠。 */}
                {open &&
                  group.rows.map((row) => (
                    <Row
                      key={row.id}
                      t={t}
                      row={row}
                      included={included}
                      pending={pendingModelIds.has(row.id)}
                      skip={skip}
                      onToggle={onToggle}
                      onSetCurrent={onSetCurrent}
                      onRemoveManual={onRemoveManual}
                    />
                  ))}
              </div>
            )
          })}

          {/* 截了就说。默默少画几百行是这类列表最容易犯的那种谎。 */}
          {grouped.truncated > 0 && (
            <p className={s.truncated}>
              {t('providers.catalogTruncated', { count: grouped.truncated })}
            </p>
          )}
        </div>
      )}

      {/*
        回顶。**滚过目录头才出现** —— 一屏就装得下的目录不需要它,常驻一颗
        浮钮只是多一件要绕开的东西。它粘在真正在滚的那一层(详情列)的底缘,
        这一整块因为 `.catalog` 用的是 `overflow: clip` 而不是 `hidden`
        才成立(clip 不造滚动容器,粘性照旧解析到外面那一层)。
      */}
      {pastTop && (
        <div className={s.toTop}>
          <Button
            size="sm"
            pill
            onClick={() => headRef.current?.scrollIntoView({ block: 'start' })}
            data-testid="catalog-to-top"
          >
            <ChevronsUp size={14} aria-hidden="true" />
            {t('providers.catalogToTop')}
          </Button>
        </div>
      )}
    </section>
  )
}

/** 「anthropic/」;杂项组说「其他」。前缀是数据,不翻译。 */
function groupLabel(t: TFn, group: CatalogGroup): string {
  return group.prefix === OTHER_GROUP ? t('providers.groupOther') : group.prefix
}

/** 「18 型」/「125 型 · 45 个厂牌」。厂牌数只有杂项组说得出口。 */
function groupNote(t: TFn, group: CatalogGroup): string {
  const count = t('providers.groupCount', { count: group.rows.length })
  if (group.prefix !== OTHER_GROUP || group.vendors === 0) return count
  return `${count} · ${t('providers.groupVendors', { count: group.vendors })}`
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

function Row({
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
