import { useEffect, useMemo, useRef, useState } from 'react'
import { AsyncButton } from '../../ui/AsyncButton'
import { Button } from '../../ui/Button'
import { GroupHead } from '../../ui/GroupHead'
import { Input } from '../../ui/Input'
import { useFrozenFlags } from '../../ui/list-placement'
import { useScrolledPast } from '../../ui/scrolled-past'
import { useSettlePulse } from '../../ui/settle-pulse'
import { ChevronsUp, TriangleAlert } from '../../components/icons'
import { useT } from '../../i18n'
import type { AsyncSource } from '../../data/kernel'
import type { QueryPhase } from '../../data/kernel'
import { formatFetchedAt, groupCatalog, priceIsIncluded } from '../projection'
import type { CatalogRow, ModelOverridePatch, ProviderModeKind } from '../types'
import { AddModelRow } from './AddModelRow'
import { ModelCatalogRow } from './ModelCatalogRow'
import { catalogEmptyLine, groupLabel, groupNote, shouldSkipRows } from './model-catalog-transitions'
import s from './ModelCatalog.module.css'

/**
 * 一坑的模型目录。**目录跟着模式走** —— 订阅坑与 API 坑各一份,这块组件一次只
 * 画一份,所以它连「合并两份目录」的可能性都没有。
 *
 * 一行七格:勾选 / 模型(名 + id)/ 能力 / 上下文 / 最大输出 / 单价 / 当前模型。
 * 每一格都可能是「不知道」——目录没填就画一个破折号,不画 0、不画「免费」。
 *
 * ── 这块面由几件拼成(09-02 批 9a 拆分)────────────────────────────────
 * 这个文件只剩**编排**:头 / 列头 / 分区与分组 / 脚注,以及「什么时候画什么」。
 *   · `./ModelCatalogRow.tsx`          一行七格(切线 A,搬家不是改造)
 *   · `./AddModelRow.tsx`              手填 id 那一条带子(切线 D)
 *   · `./model-catalog-transitions.ts` 纯判据:组名 / 组读数 / 空态那句 / 跳排版
 *   · `../../ui/scrolled-past`         「滚过目录头了没有」(库件,批 9a 立)
 *   · `../../ui/settle-pulse`          「一次落位」的淡入闸(库件,批 9a 立)
 * 皮肤仍然是**同一份** `./ModelCatalog.module.css`:这张七列表的轨道是单产地
 * (`__tests__/model-catalog-layout.test.tsx` 逐条钉着),拆件不等于拆表。
 *
 * ── 300+ 行怎么画(削量三层)────────────────────────────────────────────────
 * OpenRouter 一家就 300 多型,平铺是卡顿的产地。三条判据全在 `groupCatalog` 里
 * (纯函数、可断言):①已选置顶、②按 `vendor/` 前缀分组(≥60 行才分)、
 * ③检索时截 50 行并如实报剩余。这块组件只负责**收起的组不渲染行** ——
 * 收起还渲染 DOM 就等于没折叠,那是这类列表最常见的假优化。
 *
 * ── 三张状态表(施工纪律「状态先行」)──────────────────────────────────
 *
 * ① 生命周期
 *   挂载/卸载 父件(ProviderDetail)挂上 / 换模式换坑关面时收走;取数不在这里,
 *             这件收 props 一发都不自己发,所以没有订阅、没有计时器、
 *             没有模块级副作用(不需要 HMR dispose),唯一要拆的那只 observer
 *             归 `useScrolledPast` 自己收。
 *   换宿主    **换一坑就是一次生命周期事件**,而且是这件唯一的一种:展开了哪些组、
 *             手填带子开着没有、滚过头没有,三样都忘掉。带子还多一层
 *             `key={providerId}` —— 换坑 = 重挂,草稿与错误当场归零。
 *   落点形态  只有一种:详情列(`.body`)里的一块**自然高度**区块。于是
 *             **滚动归详情列**(`.catalog` 是 clip 不造滚动容器,组头 sticky 与
 *             回顶都粘在外面那一层)、**尺寸自己量**(`container-type`)、
 *             **檐是自己的**(宿主那一层没有檐)。三条的产地都在 .module.css 头上。
 *
 * ② UI 生命状态(几个**互不冒充**的读数,每一个对应屏幕上一处、且只有一处)
 *   phase==='initial'  骨架 / 空态。**只有它**能让屏幕上没有行
 *   inflight           刷新钮换字 + 禁用 —— **只有 AsyncButton 读它**,
 *                      所以它连一个 prop 都不必是:钮直接吃那一族 query
 *   error              表头下面那一行原话 —— **与旧行并存**,不清屏
 *   updatedAt/dataRev  收尾的两种可感知:时刻更新(总是)与内容变了(才有)
 *   empty              拿到过、且一行都没有:检索没命中 / 真的没有,两句话
 *   超量               1000 型 = 削量三层 + 回顶钮(见上)
 *
 * ③ UI 交互状态
 *   检索框 rest/hover/focus · 刷新钮 +**pending**(换字+禁用,忙态读来的)·
 *   手填钮 +`aria-expanded` 两态 · 组头 +collapsed 两态 +**检索时 disabled**
 *   (那时组是被判据打开的,点它关上会当场自相矛盾)· 行 +**pending 逐格**
 *   (只禁在写的那一行)· 回顶钮只在滚过目录头之后在场,整条带子不吃指针。
 *
 * 「重拉时旧行仍在 DOM」「刷新完屏幕不跳」两条由 `__tests__/model-catalog-state.test.tsx`
 * 钉死;真机那一半是逐帧截图 diff(汇报里有读数)。
 */
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
  onRenameManual,
  onWriteOverride,
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
  /**
   * 改一个手填模型的 id(09-11)。返回一句错误原文 = 没改成。
   * 成功之后这块面自己把覆盖浮层**换到新 id 上**(见下面那段包装)。
   */
  onRenameManual: (oldId: string, newId: string) => string | undefined
  /** 写一个模型的覆盖(上下文窗口 / 工具调用)。`null` = 删那一格。 */
  onWriteOverride: (modelId: string, patch: ModelOverridePatch) => void
}) {
  const t = useT()
  const fetched = formatFetchedAt(fetchedAt)
  const included = priceIsIncluded(kind)
  const searching = query.trim().length > 0

  /*
   * ── 位置固化(09-01 报障:「选中或取消它的位置会改变,很难受」)──────────
   * 「已选置顶」直接读 `row.selected` 的话,**勾选就是一次重排**。整段病历与
   * 修法(位置读快照 / 状态读活值)在原语 `ui/list-placement` 的文件头里,
   * 这里只交出这块面的那句判据:快照什么时候重拍 —— **换一坑** 或
   * **拉到一份新目录**(`fetchedAt` 前进,显式点「刷新目录」也在内)。
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
  /*
   * 逐型覆盖那张浮层**一次只开一个**(09-09)。所以它住在这里而不是每行自持一个
   * 布尔:住在行里的话,点开第二行的钮之前得先有人去关第一行 —— 那个「有人」
   * 只能是这一层,于是状态本来就在这一层,行里那份只是它的影子。
   * 行收 `overrideOpen` + `onOverrideOpen`,一格自己的开合状态都不留。
   */
  const [openOverride, setOpenOverride] = useState<string | null>(null)

  /*
   * 改完 id 之后浮层**留在原位改到新 id 上**(09-11)。它住在这一层,所以
   * 「跟过去」这件事也只能在这一层做:行的 id 换了,旧那一行连同它的浮层
   * 一起卸载,而 `openOverride` 还指着一个已经不存在的 id —— 表现是浮层
   * 当场消失,用户改完名得再点一次钮。
   * 包在这里而不是包在行里:行不知道自己改完之后叫什么(它只把那句话转出去)。
   */
  function renameManual(oldId: string, newId: string): string | undefined {
    const problem = onRenameManual(oldId, newId)
    if (!problem) setOpenOverride(newId)
    return problem
  }

  const headRef = useRef<HTMLDivElement>(null)
  const topMark = useRef<HTMLDivElement>(null)
  /* 「滚过目录头了没有」—— 两条真机判据(问方向 / root 取真正在滚的那一层)
   * 都收在库件里,理由写在 `ui/scrolled-past` 的文件头。换一坑 = 读数归零。 */
  const { past: pastTop } = useScrolledPast(topMark, { resetKey: providerId })

  /** 时刻更新(每次成功都有)与内容更新(只有真变了才有)是两件事,各播各的。 */
  const stamp = useSettlePulse(fetchedAt ?? 0)
  const content = useSettlePulse(dataRev)

  // 换一坑 = 换一份目录。上一坑展开过哪些组、手填带子开着没有,都不能跟过来
  //(带子里那个正在填的 id 由它自己的 `key={providerId}` 归零,见下面那段注释)。
  useEffect(() => {
    setExpanded(new Set())
    setAdding(false)
    // 换坑 = 换一份目录。上一坑开着的那张覆盖浮层跟着走没有任何意义 ——
    // 它锚在一行上,而那一行马上就不在了。
    setOpenOverride(null)
  }, [providerId])

  const emptyLine = catalogEmptyLine(t, {
    firstLoad: phase === 'initial',
    error,
    rowCount: rows.length,
    searching,
  })

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
          `AsyncButton` 吃这一坑的 query —— 忙态是读来的,不是这里记的一份;
          防闪的 150ms 闸在库件里。失败不弹 toast:错误就地画在表头下面那一行。
        */}
        <AsyncButton
          size="sm"
          action={refresh}
          pendingLabel={t('providers.catalogLoading')}
          onClick={onRefresh}
        >
          {t('providers.catalogRefresh')}
        </AsyncButton>
        <Button size="sm" onClick={() => setAdding((open) => !open)} aria-expanded={adding}>
          {t('providers.addModel')}
        </Button>
      </div>

      {/* 「头还在视野里吗」的哨兵。零高度、不占位、不进无障碍树。 */}
      <div ref={topMark} className={s.topMark} aria-hidden="true" />

      {/*
        收起时它自己画 `null`(不是这里不渲染它)—— 那样草稿会在「不小心点了
        一下开合钮」之后丢掉,而拆分之前草稿住在这个文件里、开合只是一个布尔。
        `key` = 「换坑就是重挂」:草稿与错误随之归零,且换坑那一帧不会先把
        上一坑的草稿画出来。
      */}
      <AddModelRow
        key={providerId}
        open={adding}
        providerId={providerId}
        write={write}
        onAddManual={onAddManual}
      />


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
            <ModelCatalogRow
              key={row.id}
              t={t}
              row={row}
              providerId={providerId}
              included={included}
              pending={pendingModelIds.has(row.id)}
              skip={false}
              overrideOpen={openOverride === row.id}
              onToggle={onToggle}
              onSetCurrent={onSetCurrent}
              onRemoveManual={onRemoveManual}
              onRenameManual={renameManual}
              onOverrideOpen={(open) => setOpenOverride(open ? row.id : null)}
              onWriteOverride={onWriteOverride}
            />
          ))}

          {grouped.groups.map((group) => {
            const open = !grouped.grouped || searching || expanded.has(group.prefix)
            const skip = shouldSkipRows(open, group.rows.length)
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
                    <ModelCatalogRow
                      key={row.id}
                      t={t}
                      row={row}
                      providerId={providerId}
                      included={included}
                      pending={pendingModelIds.has(row.id)}
                      skip={skip}
                      overrideOpen={openOverride === row.id}
                      onToggle={onToggle}
                      onSetCurrent={onSetCurrent}
                      onRemoveManual={onRemoveManual}
                      onRenameManual={renameManual}
                      onOverrideOpen={(open) => setOpenOverride(open ? row.id : null)}
                      onWriteOverride={onWriteOverride}
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
        回顶。**滚过目录头才出现** —— 一屏就装得下的目录不需要它。它粘在真正在
        滚的那一层(详情列)的底缘;「怎么算滚过头」的两条判例在 `ui/scrolled-past`。
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
