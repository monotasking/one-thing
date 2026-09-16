import { useEffect } from 'react'
import { Switch } from '../../ui/Switch'
import { useAsyncPending, useQuery } from '../../data/kernel'
import {
  semanticPhaseOf,
  semanticSearchQuery,
  semanticStatusWorthPolling,
  setSemanticSearchEnabledMutation,
} from '../../data/search-settings-source'
import { searchStatusQuery } from '../../data/search-catalog-source'
import { useT } from '../../i18n'
import type { MessageKey, TFn } from '../../i18n'
import shared from './Settings.module.css'

/** 开着的时候多久问一次索引状态。下载 / 建索引是分钟级的事,5s 够慢也够跟手。 */
const STATUS_POLL_MS = 5000

/**
 * 设置页「搜索」那一页,今天只有一节:**语义召回**(`docs/design/search-index-2026-09.md`
 * §15)。它结清了那份文档 §13 留账的最后一条「S7:设置页没有 UI」。
 *
 * ── 这一页为什么只有一格开关 ──────────────────────────────────────────────
 * 「设置极简」判例:**只暴露必填项,技术参数走默认值**。检索本身没有开关(索引是
 * 账本的投影,一直在建);这一页说的只是**语义召回**那一半 —— 它要下载约 110MB 的
 * 模型、冷嵌占几分钟 CPU,所以默认关、由人一键打开。嵌入器 id、向量维数、切段长度、
 * KNN 的 k 全是技术参数,一个都不露脸。模型那一行**露脸但不给改**:说出来是诚实,
 * 给个下拉框(而且只有一项)是负担。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三张状态表(状态先行,09-01 用户令)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ① **生命周期**
 *
 * | 时机 | 做什么 |
 * | --- | --- |
 * | 挂载 | `semanticSearchQuery.ensure()`(设置)+ `searchStatusQuery.ensure()`(索引状态)各一发。后者是**检索面已有的那一格**,面板开过的话这一发直接命中缓存,不多一次往返 |
 * | 首载 | 两格都没回来 → `unknown`:开关**画着但禁着**,状态行写「检查中」。不画骨架 —— 一行设置的骨架比一行字更吵 |
 * | 常驻 | 开着(或状态未知)时每 5s 问一次索引状态;**关着 / 装不上时不问**(那两态下什么都不会动) |
 * | 换宿主 | 不存在:这一节只活在设置页的一页里,没有第二种落点形态 |
 * | 离开这一页 / 卸载 | `useEffect` 的拆卸把那只 5s 计时器清掉。两格 query 留着 = 缓存(整族退役只有 HMR dispose 那一口) |
 *
 * ② **UI 生命状态**(八态,判据全在 `semanticPhaseOf` 里,屏上文案全在字典里)
 *
 * | 态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | unknown | 设置或状态还没问到 | 开关禁着(翻一个不知道的值等于拿猜测当底本写设置);状态行「检查中…」 |
 * | unsupported | `status.vectorExtension === 'missing'` | 开关**禁着**(不是藏起来:藏起来的开关说不出「这台机器做不了」);状态行「这个版本不带语义召回的运行时」 |
 * | disabled | 设置里关着 | 状态行「未启用」。模型那一行照画 —— 它说的是「开了会用哪个」 |
 * | starting | 开着,但 `status.vector` 缺席(= 不知道) | 「正在启动…」。翻开关那一下写路顺手把那一格抹成缺席,所以这里**不会**闪一下「没跑起来」 |
 * | downloading | `vector === 'downloading'` | 「正在下载模型…」 |
 * | embedding | `vector === 'embedding'` | 「正在建立索引(还有 N 条)」;`vectorPending` 缺席时退回不带数字的那句 |
 * | ready | `vector === 'ready'` | 「就绪」 |
 * | failed | 开着但 `vector === 'off'` | 「没跑起来。原因在日志里」——**不猜是哪一种**,理由写在 `semanticPhaseOf` 上 |
 * | error | 设置那一发红了 | 错话与**旧值并陈**(律②):拉不到不把开关那一行抹掉 |
 * | 超量 | 不存在:这一节是定长的三行,不随数据长 | — |
 *
 * ③ **UI 交互状态**:开关随 `ui/Switch` 全套(rest/hover/focus/active),
 *    `disabled` 有两个产地 —— 「还不知道」与「这台机器做不了」;写路 pending 期间
 *    也禁着(一开一关两发打在同一份设置上,后到的那发会拿旧底本把前一发写回去)。
 *    这一节**一颗按钮都没有**,所以没有 pending 文案要换。
 */
export function SearchSettings() {
  const t = useT()
  const { data, error } = useQuery(semanticSearchQuery)
  const status = useQuery(searchStatusQuery).data
  const toggling = useAsyncPending(setSemanticSearchEnabledMutation)

  useEffect(() => {
    void semanticSearchQuery.ensure()
    void searchStatusQuery.ensure()
  }, [])

  const phase = semanticPhaseOf(data, status)

  /*
   * 轻轮询:**只在有东西会动的时候问**。下载与冷嵌是分钟级的事,而这一页正开着 ——
   * 一行不会自己更新的进度读数比没有进度更糟。离开这一页(或者翻到别的设置页,
   * 那也是卸载)计时器就没了。
   */
  const polling = semanticStatusWorthPolling(phase)
  useEffect(() => {
    if (!polling) return
    const timer = setInterval(() => void searchStatusQuery.refetch(), STATUS_POLL_MS)
    return () => clearInterval(timer)
  }, [polling])

  const enabled = data?.enabled === true
  const unsupported = phase === 'unsupported'

  return (
    <>
      <div className={shared.settingRow} data-testid="search-semantic-row">
        <div>
          <div className={shared.settingRowLabel}>{t('search.semanticLabel')}</div>
          <div className={shared.settingRowHint}>{t('search.semanticHint')}</div>
        </div>
        <Switch
          checked={enabled}
          // 两个产地:还没问到(翻它等于拿猜测当底本写设置)、这份产物结构上做不了。
          disabled={!data || unsupported || toggling}
          onChange={(next) => void setSemanticSearchEnabledMutation.run(next)}
          label={t('search.semanticLabel')}
        />
      </div>

      {/* 错误与旧值**并陈**(律②):拉不到不把那一行抹掉。 */}
      {error ? (
        <div className={shared.settingRowNote}>{`${t('search.semanticLoadFailed')} · ${error}`}</div>
      ) : null}

      <div className={shared.settingRowNote} data-testid="search-semantic-status">
        {statusLine(t, phase, status?.vectorPending)}
      </div>

      {/*
        模型那一行。**只读**(见文件头):今天注册表里只有一档,一个只有一项可选的
        选择器是纯噪音。`modelId` 是**数据**(嵌入器注册表的键),所以它不进字典 ——
        换一门语言它不该跟着变。
      */}
      {data ? (
        <div className={shared.settingRow} data-testid="search-semantic-model-row">
          <div>
            <div className={shared.settingRowLabel}>{t('search.semanticModelLabel')}</div>
            <div className={shared.settingRowHint}>{t('search.semanticModelHint')}</div>
          </div>
          <div className={shared.settingRowHint}>{data.modelId}</div>
        </div>
      ) : null}
    </>
  )
}

/**
 * 一个态 → 屏幕上那一句(键 + 插值)。**纯函数、导出**,所以「每个态都有话说」
 * 这件事可以被逐条单测,而不必把八种后端状态在渲染层摆一遍。
 */
export function statusMessage(
  phase: ReturnType<typeof semanticPhaseOf>,
  vectorPending: number | undefined,
): { key: MessageKey; vars?: { count: number } } {
  switch (phase) {
    case 'unknown':
      return { key: 'search.semanticStatusUnknown' }
    case 'unsupported':
      return { key: 'search.semanticStatusUnsupported' }
    case 'disabled':
      return { key: 'search.semanticStatusDisabled' }
    case 'starting':
      return { key: 'search.semanticStatusStarting' }
    case 'downloading':
      return { key: 'search.semanticStatusDownloading' }
    case 'embedding':
      // 数不出来就不给数(§7.3「不知道就别给」),不是画一个 0。
      return vectorPending === undefined || vectorPending <= 0
        ? { key: 'search.semanticStatusEmbedding' }
        : { key: 'search.semanticStatusEmbeddingCount', vars: { count: vectorPending } }
    case 'ready':
      return { key: 'search.semanticStatusReady' }
    case 'failed':
      return { key: 'search.semanticStatusFailed' }
  }
}

/** 查出那一句。`vars` 缺席的那几句不给插值表 —— 递一张空表也是递。 */
function statusLine(
  t: TFn,
  phase: ReturnType<typeof semanticPhaseOf>,
  vectorPending: number | undefined,
): string {
  const message = statusMessage(phase, vectorPending)
  return message.vars === undefined ? t(message.key) : t(message.key, message.vars)
}
