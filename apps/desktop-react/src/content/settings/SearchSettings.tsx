import { useEffect } from 'react'
import { Button } from '../../ui/Button'
import { Progress } from '../../ui/Progress'
import { Switch } from '../../ui/Switch'
import { Tooltip } from '../../ui/Tooltip'
import { useAsyncPending, useQuery } from '../../data/kernel'
import {
  cancelSemanticModelMutation,
  downloadSemanticModelMutation,
  removeSemanticModelMutation,
  semanticModelPhaseOf,
  semanticPhaseOf,
  semanticSearchQuery,
  semanticStatusPollMs,
  setSemanticSearchEnabledMutation,
  type SemanticModelPhase,
  type SemanticPhase,
} from '../../data/search-settings-source'
import { searchStatusQuery } from '../../data/search-catalog-source'
import type { SearchStatusResponse } from '@shared/ipc/search'
import { formatBytes } from '../../format/quantity'
import { useT } from '../../i18n'
import type { MessageKey, MessageVars, TFn } from '../../i18n'
import shared from './Settings.module.css'
import s from './SearchSettings.module.css'

/** 后端答的那几类原因(`SearchStatusResponse.vectorErrorKind`;判据在后端,壳只查表)。 */
type VectorErrorKind = NonNullable<SearchStatusResponse['vectorErrorKind']>

/** 认得出的那三类。`unknown`(与将来多出来的码)走「只说原话」那一支。 */
type KnownVectorErrorKind = Exclude<VectorErrorKind, 'unknown'>

/**
 * 原因码 → 那一句人话(2026-09-17 R12)。**一张表,不是一串 if** —— 后端将来多一类,
 * 这里多一行 + 字典两句,`statusMessage` 一个字不改。
 *
 * ── 认得出的那三类**不再把原话括在屏上**(2026-09-17 报障后改)───────────────
 * 从前每一句后面都跟着 `({reason})`。真机上那是一串
 * 「(Unsupported device: "wasm". Should be one of: cpu.)」—— 用户的原话是
 * 「这是给用户看的吗?」。人话留在屏上,原话搬进 Tooltip(`SettingsLine.detail`):
 * 排障的人把指针放上去就有,别人不必读机器的话。
 * **只有不认识那一类把原话直接上屏** —— 不认识就没有人话可说,不说等于什么都没说。
 */
const FAILED_REASON_KEY: Record<KnownVectorErrorKind, MessageKey> = {
  network: 'search.semanticStatusFailedNetwork',
  runtime: 'search.semanticStatusFailedRuntime',
  model: 'search.semanticStatusFailedModel',
}

/**
 * 同一张判据表的**另一族句子**:下载那一发败了(2026-09-17)。
 *
 * 为什么不复用上面那三句:主语不同。上面说的是「语义召回没跑起来」,这里说的是
 * 「模型没下成」—— 把「没跑起来」写在模型那一行上,人会去找一个此刻还不存在的
 * 功能的毛病。**码是同一张表,句子按行分**。
 */
const MODEL_FAILED_REASON_KEY: Record<KnownVectorErrorKind, MessageKey> = {
  network: 'search.semanticModelFailedNetwork',
  runtime: 'search.semanticModelFailedRuntime',
  model: 'search.semanticModelFailedFiles',
}

/**
 * 屏上一行副文案:**一句人话 + (可选)一句机器原话**。
 *
 * 两格分开的理由就是上面那条判词 —— 原话是给排障的人看的,它进 Tooltip,不进句子。
 * `detail` 缺席 = 没有原话可挂,那一行就是一段素文本(不包 Tooltip:一个悬上去
 * 什么都不出的锚点比没有更糟)。
 */
export interface SettingsLine {
  text: string
  detail?: string
}

/**
 * 设置页「搜索」那一页,今天只有一节:**语义召回**(`docs/design/search-index-2026-09.md`
 * §15)。它结清了那份文档 §13 留账的最后一条「S7:设置页没有 UI」。
 *
 * ── 这一页为什么只有一格开关 ──────────────────────────────────────────────
 * 「设置极简」判例:**只暴露必填项,技术参数走默认值**。检索本身没有开关(索引是
 * 账本的投影,一直在建);这一页说的只是**语义召回**那一半 —— 它要下载约 110MB 的
 * 模型、冷嵌占几分钟 CPU,所以默认关、由人一键打开。嵌入器 id、向量维数、切段长度、
 * KNN 的 k 全是技术参数,一个都不露脸 —— **模型 id 也是**(2026-09-17 报障后删掉:
 * 屏上那串 `multilingual-e5-small` 对读它的人不构成任何一个可做的决定,而这一节
 * 只有一档模型可用,说出一个不能选的名字是噪音)。模型那一行今天只说两件事:
 * 下没下、多大。
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
 * | 首载 | 两格都没回来 → `unknown`:开关**画着但禁着**,模型行写「检查中…」、状态行让位不画(同一句不印两遍)。不画骨架 —— 一行设置的骨架比一行字更吵 |
 * | 常驻 | 开着(或状态未知)时每 5s 问一次索引状态;**关着 / 装不上时不问**(那两态下什么都不会动) |
 * | 换宿主 | 不存在:这一节只活在设置页的一页里,没有第二种落点形态 |
 * | 离开这一页 / 卸载 | `useEffect` 的拆卸把那只 5s 计时器清掉。两格 query 留着 = 缓存(整族退役只有 HMR dispose 那一口) |
 *
 * ② **UI 生命状态**(八态,判据全在 `semanticPhaseOf` 里,屏上文案全在字典里)
 *
 * | 态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | unknown | 设置或状态还没问到 | 开关禁着(翻一个不知道的值等于拿猜测当底本写设置);状态行「检查中…」,**模型行也正写着这一句时就整行不画**(同一句不印两遍) |
 * | unsupported | `status.vectorExtension === 'missing'` | 开关**禁着**(不是藏起来:藏起来的开关说不出「这台机器做不了」);状态行「这个版本不支持」;**模型那一行整行不画** —— 在一台结构上用不了它的机器上请人下 113MB 是骗人 |
 * | needsModel | 模型不是 `ready` 也不是「管不了」 | 状态行「先下载模型」,模型行自己画着未下载 / 进度 / 没下成。**开关只在关着时才被它禁**(开着的老用户永远许关) |
 * | disabled | 设置里关着(而且模型已就绪) | **状态行整行不画** —— 一个关着的开关本身就是那句「未启用」,再写一遍是凑字 |
 * | starting | 开着,且 `vector` 缺席 / `'downloading'`(= 正在把模型装进内存)/ `'off'` 但说不出死因 | 「正在启动…」。翻开关那一下写路顺手把那一格抹成缺席,对账那一帧上一条 Worker 还没换走,所以这里**不会**闪一下「没跑起来」 |
 * | embedding | `vector === 'embedding'` | 「正在建立索引,还剩 N 条」;`vectorPending` 缺席时退回不带数字的那句 |
 * | ready | `vector === 'ready'` | 「已就绪」 |
 * | failed | 开着、模型就绪、`vector === 'off'` 且**说得出死因** | 按 `vectorErrorKind` 查一句人话(网络 / 运行时 / 模型三行,表在 `FAILED_REASON_KEY`),**原话挂 Tooltip 不上屏**;码不认识就只说原话;连原话都没有才写光秃秃的「没跑起来」 |
 * | error | 设置那一发红了 | 错话与**旧值并陈**(律②):拉不到不把开关那一行抹掉 |
 * | 超量 | 不存在:这一节是定长的两行 + 两条读数,不随数据长 | — |
 *
 * ③ **UI 交互状态**:开关随 `ui/Switch` 全套(rest/hover/focus/active),
 *    `disabled` 有四个产地 —— 「还不知道」/「这台机器做不了」/「模型还没到位而它此刻
 *    关着」/「写路还在飞」(一开一关两发打在同一份设置上,后到的那发会拿旧底本把前
 *    一发写回去)。模型那一行右边**恒有且只有一颗钮**(`ModelAction` 一态一颗),三条
 *    写路任一在飞时三颗都禁着 —— 钮**换文案不换节点**,焦点因此留在原位。
 */
export function SearchSettings() {
  const t = useT()
  const { data, error } = useQuery(semanticSearchQuery)
  const status = useQuery(searchStatusQuery).data
  const toggling = useAsyncPending(setSemanticSearchEnabledMutation)
  const downloading = useAsyncPending(downloadSemanticModelMutation)
  const cancelling = useAsyncPending(cancelSemanticModelMutation)
  const removing = useAsyncPending(removeSemanticModelMutation)

  useEffect(() => {
    void semanticSearchQuery.ensure()
    void searchStatusQuery.ensure()
  }, [])

  const phase = semanticPhaseOf(data, status)
  const model = semanticModelPhaseOf(status)

  /*
   * 轻轮询:**只在有东西会动的时候问**,而且**下模型那一段问得更勤**(1s)——
   * 那是一条会走的进度条,5s 一跳的读数比没有进度更糟。档位由纯函数说
   * (`semanticStatusPollMs`),这里只照它起 / 清计时器;离开这一页(翻到别的设置页
   * 也是卸载)计时器就没了。
   */
  const pollMs = semanticStatusPollMs(phase, model)
  useEffect(() => {
    if (pollMs === undefined) return
    const timer = setInterval(() => void searchStatusQuery.refetch(), pollMs)
    return () => clearInterval(timer)
  }, [pollMs])

  const enabled = data?.enabled === true
  const unsupported = phase === 'unsupported'
  // 模型没下全就不许打开(打开只会得到一条立刻自己关回去的 Worker);
  // **开着的时候永远许关** —— 老用户那一形不能被锁死,判据写在 `semanticPhaseOf`。
  const blockedByModel = !enabled && phase === 'needsModel'

  const line = statusLine(t, phase, model, status)

  return (
    <>
      {/*
        模型那一行**在开关上面**:它是前置条件。先问「这台机器上有没有那份模型」,
        再问「要不要用它」—— 反过来摆,一个禁着的开关下面才解释为什么禁,那是让人
        先撞墙再读说明。

        **装不上扩展那一台整行不画**(2026-09-17):`vec0` 装不上 = 这份产物结构上
        做不了语义召回,那时还画一颗「下载」是请人为一个用不了的功能下 113MB。
      */}
      {unsupported ? null : (
        <div className={shared.settingRow} data-testid="search-semantic-model-row">
          <div>
            <div className={shared.settingRowLabel}>{t('search.semanticModelLabel')}</div>
            <div className={shared.settingRowHint}>
              <Line line={modelHint(t, model, status?.model)} />
            </div>
          </div>
          <ModelAction
            t={t}
            model={model}
            enabled={enabled}
            busy={downloading || cancelling || removing}
          />
        </div>
      )}

      {/*
        下载中才画进度条。**画在两行之间、通栏** —— 它是那一行的读数,不是一颗控件;
        塞进右边那一格会把「43 MB / 113 MB」挤成两行。
      */}
      {!unsupported && model === 'downloading' ? (
        <Progress
          className={s.modelProgress}
          {...(downloadRatio(status?.model) === undefined
            ? {}
            : { value: downloadRatio(status?.model) })}
          label={t('search.semanticModelDownloading')}
        />
      ) : null}

      <div className={shared.settingRow} data-testid="search-semantic-row">
        <div>
          <div className={shared.settingRowLabel}>{t('search.semanticLabel')}</div>
          {/*
            说明句**恒定一句**(2026-09-17):从前模型没下全时它会换成「先把上面那份
            模型下下来」,于是同一行文字在两种情形下说两件事,而「该先下载」这件事
            状态行已经在说了。一行说明只说这一格是什么。
          */}
          <div className={shared.settingRowHint}>{t('search.semanticHint')}</div>
        </div>
        <Switch
          checked={enabled}
          /*
           * 四个产地:还没问到(翻它等于拿猜测当底本写设置)、这份产物结构上做不了、
           * 模型还没下全、上一发还在飞(一开一关两发打在同一份设置上,后到的那发会
           * 拿旧底本把前一发写回去)。
           */
          disabled={!data || unsupported || blockedByModel || toggling}
          onChange={(next) => void setSemanticSearchEnabledMutation.run(next)}
          label={t('search.semanticLabel')}
        />
      </div>

      {/* 错误与旧值**并陈**(律②):拉不到不把那一行抹掉。 */}
      {error ? (
        <div className={shared.settingRowNote}>{`${t('search.semanticLoadFailed')} · ${error}`}</div>
      ) : null}

      {/*
        状态行**说得出话才画**:关着的时候那一格是空的(一个关着的开关本身就是
        「未启用」),所以整行不占位置 —— 画一条空的 note 会留下一道说不出理由的间距。
      */}
      {line === undefined ? null : (
        <div className={shared.settingRowNote} data-testid="search-semantic-status">
          <Line line={line} />
        </div>
      )}
    </>
  )
}

/**
 * 一行副文案的画法:**有原话就把这一行包进 Tooltip**,没有就是一段素文本。
 *
 * 包的是一层 `<span>` 而不是那一行的容器:容器是布局用的格子(整行宽),悬停区
 * 跟着它会宽出一大片什么都没有的地方。`cursor: help` + 点线下划线是**这一行还有话**
 * 的唯一提示 —— 不给提示的 Tooltip 等于没有。
 */
function Line({ line }: { line: SettingsLine }) {
  if (line.detail === undefined) return <>{line.text}</>
  return (
    <Tooltip content={line.detail}>
      <span className={s.detail}>{line.text}</span>
    </Tooltip>
  )
}

/**
 * 模型那一行右边那颗钮。**一态一颗,没有一颗钮在两个态里换文案** —— 换文案的钮
 * 会让人按下去才知道刚才按的是什么。
 *
 * | 态 | 钮 | 禁着的理由 |
 * | --- | --- | --- |
 * | unknown | 一颗都不画 | 还不知道有没有这件事 |
 * | absent | 下载 | — |
 * | downloading | 取消 | — |
 * | ready | 删除 | 开关开着(Tooltip 说「先关掉开关」) |
 * | failed | 重试 | — |
 *
 * 「重试」与「下载」是同一发(`downloadSemanticModelMutation`),字不同是因为人
 * 此刻要做的判断不同:一个是「要不要开始」,一个是「刚才那次不算,再来」。
 */
function ModelAction({ t, model, enabled, busy }: {
  t: TFn
  model: SemanticModelPhase
  enabled: boolean
  busy: boolean
}) {
  if (model === 'unknown') return null
  if (model === 'downloading') {
    return (
      <Button
        disabled={busy}
        onClick={() => void cancelSemanticModelMutation.run()}
        data-testid="search-semantic-model-cancel"
      >
        {t('search.semanticModelCancel')}
      </Button>
    )
  }
  if (model === 'ready') {
    const remove = (
      <Button
        variant="danger"
        // 正在用的东西不许从底下抽走。**后端还有第二道**(`model-in-use`)——
        // 这一颗禁着是礼貌,那一道是结构。
        disabled={enabled || busy}
        onClick={() => void removeSemanticModelMutation.run()}
        data-testid="search-semantic-model-remove"
      >
        {t('search.semanticModelRemove')}
      </Button>
    )
    /*
     * Tooltip 包在一个 `<span>` 上而不是直接包那颗钮:**禁着的 `<button>` 收不到
     * 指针事件**,包在钮上的提示永远不出现(那种提示比没有更糟 —— 人会以为坏了)。
     */
    return enabled
      ? (
        <Tooltip content={t('search.semanticModelRemoveBlocked')}>
          <span className={s.blockedAction}>{remove}</span>
        </Tooltip>
        )
      : remove
  }
  return (
    <Button
      variant={model === 'absent' ? 'primary' : 'ghost'}
      disabled={busy}
      onClick={() => void downloadSemanticModelMutation.run()}
      data-testid="search-semantic-model-download"
    >
      {t(model === 'failed' ? 'search.semanticModelRetry' : 'search.semanticModelDownload')}
    </Button>
  )
}

/**
 * 模型那一行的副文案。**导出**,所以「每个态都说得出话」可以逐条单测。
 *
 * 字节数走 `format/quantity` 的 `formatBytes`(全壳唯一把字节念成人话的地方);
 * 单位符号是**数据**不是文案,所以它不进字典。
 */
export function modelHint(
  t: TFn,
  model: SemanticModelPhase,
  status: SearchStatusResponse['model'],
): SettingsLine {
  switch (model) {
    case 'unknown':
      return { text: t('search.semanticModelUnknown') }
    case 'absent':
      // 总数在这一态是**估计值**,所以那一句里写着「约」。不知道就不给数。
      return {
        text: status?.totalBytes === undefined
          ? t('search.semanticModelAbsent')
          : t('search.semanticModelAbsentSize', { size: formatBytes(status.totalBytes) }),
      }
    case 'downloading': {
      const loaded = formatBytes(status?.loadedBytes ?? 0)
      const total = status?.totalBytes
      const ratio = downloadRatio(status)
      return {
        text: total === undefined || ratio === undefined
          ? t('search.semanticModelDownloadingSize', { loaded })
          : t('search.semanticModelDownloadingProgress', {
            loaded,
            total: formatBytes(total),
            percent: Math.round(ratio * 100),
          }),
      }
    }
    case 'ready':
      return {
        text: status?.totalBytes === undefined
          ? t('search.semanticModelReady')
          : t('search.semanticModelReadySize', { size: formatBytes(status.totalBytes) }),
      }
    case 'failed':
      return renderLine(t, failureMessage(
        MODEL_FAILED_REASON_KEY,
        'search.semanticModelFailed',
        'search.semanticModelFailedReason',
        status?.error,
        status?.errorKind,
      ))
  }
}

/** 一句话在查字典之前的样子:键 + 插值 + (可选)挂 Tooltip 的机器原话。 */
export interface LineMessage {
  key: MessageKey
  vars?: MessageVars
  detail?: string
}

/**
 * 失败那一行的三段判据 —— **模型行与状态行共用**(两族句子,一套规矩)。
 *
 * | 手上有什么 | 屏上 | Tooltip |
 * | --- | --- | --- |
 * | 认得出的码 | 那一句人话 | 原话(没有原话就不挂) |
 * | 不认识的码 / 没有码,但有原话 | 「…:{原话}」 | — |
 * | 什么都没有 | 光秃秃那一句 | — |
 *
 * 那句 `?? undefined` 不是多余的:类型上这张表对三个已知码是全的,但码是**从后端
 * 来的字符串** —— 将来后端多一类而壳还没跟上时,落回「只说原话」比渲染出一个
 * `undefined` 的键好。
 */
export function failureMessage(
  table: Record<KnownVectorErrorKind, MessageKey>,
  bare: MessageKey,
  withReason: MessageKey,
  reason: string | undefined,
  kind: VectorErrorKind | undefined,
): LineMessage {
  const known = kind === undefined || kind === 'unknown' ? undefined : table[kind] ?? undefined
  const raw = reason === undefined || reason.length === 0 ? undefined : reason
  if (known !== undefined) return raw === undefined ? { key: known } : { key: known, detail: raw }
  return raw === undefined ? { key: bare } : { key: withReason, vars: { reason: raw } }
}

/** 查出那一句。`vars` 缺席的那几句不给插值表 —— 递一张空表也是递。 */
function renderLine(t: TFn, message: LineMessage): SettingsLine {
  const text = message.vars === undefined ? t(message.key) : t(message.key, message.vars)
  return message.detail === undefined ? { text } : { text, detail: message.detail }
}

/**
 * 下载走了几成。**总数不知道 / 是 0 就答缺席** —— 那时进度条画的是「不知道进度」
 * 那一档(来回滑),而不是一条停在 0% 的空槽(见 `ui/Progress` 的两态表)。
 */
export function downloadRatio(status: SearchStatusResponse['model']): number | undefined {
  const total = status?.totalBytes
  if (total === undefined || total <= 0) return undefined
  return Math.min(1, (status?.loadedBytes ?? 0) / total)
}

/**
 * 一个态 → 屏幕上那一句(键 + 插值),**或者「这一态不说话」**。**纯函数、导出**,
 * 所以「每个态都有话说 / 该闭嘴的闭嘴」这件事可以被逐条单测,而不必把八种后端状态
 * 在渲染层摆一遍。
 *
 * 答 `undefined` 有两处(2026-09-17,同一条「不许说两遍」):
 *  - `disabled` —— 一个关着的开关本身就是那句「未启用」,底下再写一行是凑字;
 *  - `unknown` **且模型那一行也正写着「检查中…」** —— 首载那一帧两格都没回来,两行
 *    逐字相同的「检查中…」不是两条信息,是同一条印了两遍。设置那一发单独红了
 *    (模型那一格有答案)时照写,那时它说的是「开关的值还不知道」。
 */
export function statusMessage(
  phase: SemanticPhase,
  model: SemanticModelPhase,
  vectorPending: number | undefined,
  vectorError?: string,
  vectorErrorKind?: VectorErrorKind,
): LineMessage | undefined {
  switch (phase) {
    case 'unknown':
      return model === 'unknown' ? undefined : { key: 'search.semanticStatusUnknown' }
    case 'unsupported':
      return { key: 'search.semanticStatusUnsupported' }
    case 'needsModel':
      // 模型还没到位(不管开关开没开)。**这不是「未启用」也不是「没跑起来」** ——
      // 那两句一句会让人去找一个按不动的开关,一句会在一条正在走的进度条底下叫人
      // 重新下载。这一句说的是下一步该做什么,而那一步就在上面那一行里画着。
      return { key: 'search.semanticStatusNeedsModel' }
    case 'disabled':
      return undefined
    case 'starting':
      return { key: 'search.semanticStatusStarting' }
    case 'embedding':
      // 数不出来就不给数(§7.3「不知道就别给」),不是画一个 0。
      return vectorPending === undefined || vectorPending <= 0
        ? { key: 'search.semanticStatusEmbedding' }
        : { key: 'search.semanticStatusEmbeddingCount', vars: { count: vectorPending } }
    case 'ready':
      return { key: 'search.semanticStatusReady' }
    case 'failed':
      /*
       * **原因说得出就说出来**(2026-09-17)。在这之前这一行只写「原因在日志里」,
       * 而真机上 Worker 的日志从来没有落过地 —— 那是一句假话(`worker-logging.ts`
       * 那一半修的就是它)。
       *
       * 后端答的是**码 + 原话**,不是一句中文(R12:后端替壳写文案,英文界面上就是
       * 一句中文)。码查 `FAILED_REASON_KEY` 得到一句人话,**原话挂 Tooltip**
       * (09-17 报障:屏上直接甩一串 `Unsupported device: "wasm"…` 不是给用户看的);
       * 码不认识就只说原话,连原话也没有才退回光秃秃那一句。编一个原因比不说更糟。
       */
      return failureMessage(
        FAILED_REASON_KEY,
        'search.semanticStatusFailed',
        'search.semanticStatusFailedReason',
        vectorError,
        vectorErrorKind,
      )
  }
}

/** 查出那一句;这一态不说话就答缺席(调用方据此整行不画)。 */
function statusLine(
  t: TFn,
  phase: SemanticPhase,
  model: SemanticModelPhase,
  status: SearchStatusResponse | undefined,
): SettingsLine | undefined {
  const message = statusMessage(
    phase,
    model,
    status?.vectorPending,
    status?.vectorError,
    status?.vectorErrorKind,
  )
  return message === undefined ? undefined : renderLine(t, message)
}
