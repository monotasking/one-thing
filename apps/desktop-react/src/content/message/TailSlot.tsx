import { useEffect, useRef, useState } from 'react'
import { composerSink } from '../../composer/sink'
import { exitMs, STALL_HARD_MS, STALL_SOFT_MS } from '../../components/motion'
import { formatDuration } from '../../format/quantity'
import { useT } from '../../i18n'
import { ButtonBase } from '../../ui/ButtonBase'
import c from './MessageChrome.module.css'
import s from './TailSlot.module.css'

/**
 * **尾槽** —— 整列末尾那一格常驻的槽位(G 线 P1 立,P1b 收成一张脸;正本
 * `apps/desktop-react/docs/stream-geometry-2026-09.md` §3.1 / §5.2 / §8)。
 *
 * ── 它治的是哪两件事 ──────────────────────────────────────────────────────
 * §0 的真机量测里有两条病,病根是同一句话:**只在流式期间存在的东西,住在流里**。
 *  · ④ 首字到达那一帧,尾部读数行被推下 **52–158px**;长思考那一轮它全程动
 *    **303 次**、单帧最大 **335px**、方向反转 **3** 次 —— 因为读数行从前排在正文与
 *    光标**之后**,跟着正文下缘走;
 *  · ③ 收尾那一帧贴底时整屏正文下移 **23.8px** —— 因为流式光标 `.cursor` 独占一行、
 *    条件渲染,卸载带走一个行盒。
 * 正本 §1 的 G4 把治法写成一句话:「只在流式期存在的东西必须住进**槽位**:从头到尾
 * 都占着的固定格子,内容只换 `opacity`」。这一件就是那个格子。
 *
 * ── 它在哪儿 ──────────────────────────────────────────────────────────────
 * **整列的末尾,排在卷尾垫块之后**(`ChatStream` 摆它)。所以它不属于任何一条消息 ——
 * 一轮回复长多长、思考段折不折、工具卡开不开,都改不了它的位置:它永远是列尾
 * 那一格。高度由 token `--tail-slot-h` 钉死,与此刻在跑没在跑无关。
 *
 * ── 一张在跑的脸(P1b 裁定 B,2026-09-21)────────────────────────────────
 * P1 那版有**两张**在跑的脸:等待期一道在扫的线,出字之后换成呼吸光标,两张交叉
 * 淡入。用户原话:「保留的尾部的 generate 不需要是一个横线,和之前的样式一致即可,
 * 且在流式过程中,生成中的这块样式布局应保持不变」。于是**等待那张脸退役**:
 * 从 run 开张到收场,这一格的样子与布局**逐字不变** —— 呼吸光标 + 读数 + 停止。
 * 「在等第一个字」不再是这一格的一种形态,它与「已经在出字」在这里是同一件事:
 * 这一轮在跑。推论是 `awaitingFirstToken` 不再喂这一格,`WaitingSeam` 随之零消费者
 * 被删(它最后那一个住处就是这里)。
 *
 * ── 收场:淡出再卸载(P1b 裁定 C)────────────────────────────────────────
 * 用户原话:「在结束后,做一个丝滑的消失」。run 收场那一刻**不当场卸载**:
 * 内容先原地淡出(`--dur-exit` / JS 侧镜像 `exitMs()`),播完才卸载。这一段里
 *  · **读数冻在收场那一刻**(表停了,不是继续跳到一个没人看的数);
 *  · 整格 `inert` —— 它已经不是活的了,Tab 与读屏都不该再碰到那颗停止钮;
 *  · **那一格的高一个像素不动**(`--tail-slot-h` 钉死,与淡不淡出无关),所以
 *    「丝滑」说的只有透明度,几何上什么都没发生(G4 的同一条判词)。
 * 动效档「无」与系统 `prefers-reduced-motion` 下 `exitMs()` 是 0 → 当场卸载,
 * 一帧都不多留(判词在 `components/motion.ts` 的 `EXIT_MS_BY_TIER` 上)。
 * 淡出播到一半又开了新一轮:**直接回到在跑那张脸,不是淡回去** —— 过渡只声明在
 * 淡出那一态上(判词在 `TailSlot.module.css` 的 `.body[data-leaving]`),属性一摘
 * 过渡就不存在了,于是是一次瞬时的归位,而不是一段反向动画。
 *
 * ── 三张状态表(施工纪律「状态先行」;正本 §8 有完整三表)──────────────
 * ① **生命周期**:随会话叶挂载、常驻、随叶卸载;`ChatStream` 在
 *    `sessionId && status === 'ready'` 时始终渲染它。两只计时器都在这件里,都在
 *    effect 的清理里退役:读数那只 100ms 的表(只在跑时起),与收场那一只
 *    `exitMs()` 的一次性表(卸载时清掉,所以叶被拆掉时不会留下一发空响)。
 *    **按 `sessionId` 分家** —— 停止那一口打给的是 prop 上这一条会话,分屏下各叶
 *    各一格(W5-c-2 的同一条判词)。零模块级副作用 → **不需要 HMR dispose**。
 * ② **UI 生命状态**:空 / 在跑 / 收场中(淡出)三种,在跑里再按静默分
 *    live / stalled(静默)/ stuck(疑似卡住)—— 后两者**只改墨色与那半句话**,
 *    不改这一格的形。空会话与 loading、error 时**整件不画**(那三态由 `ChatStream`
 *    自己的空态说话)。**超量不成立** —— 它不吃数据,内容长度是常数。
 * ③ **UI 交互状态**:停止钮 rest / hover / focus / disabled 照旧(`ButtonBase` +
 *    `.ghost`,皮肤与动作行同源);空脸与淡出中整格 `inert`,Tab 进不去、读屏念不到。
 */

/**
 * 读数的刷新节拍。
 *
 * 100ms 是"读数"该有的节拍:比它慢,秒的小数位会一顿一顿;比它快,除了多烧几次
 * 渲染什么都不多。它**不是动效时长** —— 动效档一格都不动它(见下面 `StreamReadout`
 * 的「动效档」那一节),所以它没有对应的 CSS token,也不该被塞进 `--dur` 族。
 *
 * 留账:同类的 JS 侧数(`ESC_STOP_WINDOW_MS` 等)住在 `components/motion.ts`,
 * 这一个留在产地旁边;要归并是另一批的事。
 */
export const READOUT_TICK_MS = 100

/**
 * 从起点到此刻**过了多少毫秒**。倒着走(时钟回拨 / 未来时刻)按 0 算。
 *
 * 09-05:它从前直接吐字符串(`(ms/1000).toFixed(1)`)—— 那是**第四个**写时间的地方。
 * 进位收进 `format/quantity.formatDuration` 之后,这里只剩「量出多少毫秒」这一件事,
 * 怎么写出来由那一个产地说(分钟档的 `1m 05s` 因此白送)。
 */
export function elapsedMs(startedAt: number, now: number): number {
  const ms = Number.isFinite(startedAt) ? now - startedAt : 0
  return Math.max(0, ms)
}

/**
 * **活性读数**(§6.6,拍点 ⑩ 用户补的真需求:「不展开也行,反正我要分得清它是在
 * 接收流式还是卡住了」)—— 一句话由静默时长说了算。
 *
 * 判据是**静默**(上一次**有东西到达**到此刻),不是总耗时:一轮跑十分钟但一直在
 * 动是正常的,跑三十秒什么都没来才是异常。「有东西到达」四类来源(产地在
 * `data/chat-source.ts` 的 `markActivity`,四个调用点各写了为什么):三种裸 delta、
 * 工具进度快照、活 run 的工具账本行(`tool/*`、`assistant/first-token`、
 * `assistant/part-end`)、`tool:input-start`。
 *
 * **2026-09-09 从「上一次收到 delta」放宽到这里**:真店 fe5261d9 那一轮模型不到
 * 1 秒就发了工具调用,bash 跑了 7 秒、卡片一直在刷输出,而读数行说「已 7.0s 没有
 * 新内容」—— 屏幕上明明在动。用户裁定:工具进度计入活性。放宽的是**这一行的**判据,
 * 跟随状态机那格 `lastDeltaAt` 语义一个字没动(工具跑着不是模型又说了话)。
 *
 * `lastActivityAt` 缺席(这一轮什么都还没到)时退到 `startedAt` —— 从开张那一刻
 * 起算,而不是当成「刚刚收到过」。
 *
 * 纯函数,不碰 DOM 也不碰 i18n:它只答「此刻该说哪一句、静默了多久」,
 * 句子长什么样归字典。
 */
export type ReadoutTone = 'live' | 'stalled' | 'stuck'

export function readoutTone(silentMs: number): ReadoutTone {
  if (silentMs > STALL_HARD_MS) return 'stuck'
  if (silentMs > STALL_SOFT_MS) return 'stalled'
  return 'live'
}

/**
 * 此刻是几点 —— `live` 为假时**表停掉,并把指针钉在停表那一刻**。
 *
 * 钉在停表那一刻(effect 里那一句 `setNow(Date.now())`)而不是「保留上一次 tick
 * 的值」:后者最多会比真值早 100ms,于是收场那一下人眼能看见读数往回跳一点。
 * 这是 P1b 裁定 C 的「读数冻在收场那一刻」那半句的全部实现。
 */
function useNow(tickMs: number, live: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) {
      setNow(Date.now())
      return
    }
    const timer = setInterval(() => setNow(Date.now()), tickMs)
    return () => clearInterval(timer)
  }, [tickMs, live])
  return now
}

/**
 * 流式读数行 —— 台一「安静编辑器」的第二件(第一件是那枚呼吸光标,G 线 P1 起
 * 两件住在同一格尾槽里)。
 *
 * 一行话回答两个问题:**还活着吗**(数字在跳)、**跑了多久**;外加一个出口:停止。
 *
 * ── 耗时的产地 ────────────────────────────────────────────────────────────
 * `startedAt` = 这条助手消息的 `timestamp`,而它是账本上 `run/start` 自己带的
 * 时刻(core 的 `materializeAssistantNode`:`time: event.data.timestamp ?? event.time`)。
 * 所以这不是"壳收到推送的那一刻"—— 断线重连、整份重折之后它一个数都不变,
 * 而本地起的表会在每一次重折时归零。**没有第二个产地**:壳这边一格都不记。
 *
 * ── tokens 那一格为什么不在这行字里 ───────────────────────────────────────
 * 流分片(`session:stream` 的 chunk)**不带用量**(`packages/core/events` 的
 * chunk 词汇里没有 usage 这一格),而消息级 `usage` 在投影里是被
 * `outcome === 'completed'` 闸住的 —— 这一轮跑完才有。也就是说流式期间壳手上
 * **没有**一个诚实的 token 读数。用字符数或 delta 条数冒充是造事实,所以这行字
 * 只说耗时。真产地(逐轮结算的 `steps[].usage`)要不要显示是一次拍板,记在留账里。
 *
 * ── 动效档 ────────────────────────────────────────────────────────────────
 * 这一行属动效三分类的 ③「寿命 / 进度读数」(见 styles/motion.css 文件头):
 * 它说的是"这件事本身花了多久",不是"一次形变花多久"。所以它**不吃档位** ——
 * 动效选「无」时光标停住,而这行数字照跳。归错类的后果是:关掉动效之后屏幕上
 * 再没有任何东西说明这一轮还在跑。
 */
export function StreamReadout({
  sessionId,
  startedAt,
  lastActivityAt,
  live = true,
}: {
  sessionId: string
  startedAt: number
  lastActivityAt?: number
  /** 表还走不走。收场那一段是假 —— 读数冻在收场那一刻(裁定 C)。 */
  live?: boolean
}) {
  const t = useT()
  const now = useNow(READOUT_TICK_MS, live)

  const elapsed = formatDuration(elapsedMs(startedAt, now))
  const silentMs = elapsedMs(lastActivityAt ?? startedAt, now)
  const tone = readoutTone(silentMs)
  /*
   * 三句话共一行:活着时只说耗时;软阈值起**改说静默**(陈述事实,不下结论);
   * 硬阈值再补一句判断。「可能」两个字不许去掉 —— 壳这一侧没有任何证据能说明
   * 它真的卡死了,它只知道「这么久没收到东西」。
   */
  const line =
    tone === 'live'
      ? t('chat.streamReadout', { d: elapsed })
      : t('chat.streamStalled', { silent: formatDuration(silentMs), d: elapsed })

  return (
    <div className={c.readout} data-testid="chat-readout" data-tone={tone}>
      <span>{line}</span>
      {tone === 'stuck' && <span className={c.stuck}>{t('chat.streamStuck')}</span>}
      {/*
        停止走 composer 那条 sink —— **同一条通道**,不新开。发送键在忙态下翻成的
        那颗停止键按的也是它,于是"停"这件事在这台上只有一个实现、一个失败处理
        (`chat-source.abort`:没在跑就是恒等,发不出去是 error 档通知)。
        停哪一条**由这一行自己说**(W5-c-2):它长在某一条会话的消息流里,
        那就是收件人 —— 从前那一口读「当前会话」投影,分屏下能停到隔壁去。
      */}
      {/* 与动作行那两颗同判(见 MessageActions):幽灵皮肤留本地,清 UA 归基座。
        * 这一颗还比它们再小一档(`.readout .ghost`)—— 它是读数的一部分。 */}
      <ButtonBase
        className={c.ghost}
        data-testid="chat-stop"
        onClick={() => composerSink().abort(sessionId)}
      >
        {t('chat.stop')}
      </ButtonBase>
    </div>
  )
}

/** 这一格此刻处在哪一段。`idle` = 空着(内容不挂载,高度照占)。 */
export type TailPhase = 'idle' | 'run' | 'leaving'

/**
 * 收场那一段的闸:`running` 由真变假时开 `exitMs()` 那么长的一扇窗,播完关上。
 *
 * ── 为什么这一步在**渲染期**做,不在 effect 里做 ──────────────────────────
 * 放在 effect 里的那一版真跑出了病(单测钉着):`running` 变假的**那一次渲染**里
 * `leaving` 还是假,于是那一帧整块内容先卸载一次,effect 跑完才又挂回来 ——
 * 一次卸载 + 一次挂载,屏幕上就是要治的那一下闪。所以这里用的是 React 文档那条
 * 「props 变了就地调整 state」的写法:同一次渲染里就切到淡出,一帧都不空。
 * 它是幂等的(同样的 `running` 进来答同样的 state),StrictMode 的双渲染无碍。
 *
 * 三条判词:
 *  · **只有从「跑过」落下来才算收场** —— 挂载时 `running` 本来就是假的那一次
 *    `prev` 与它相等,窗根本不开,于是每片叶开屏不会先播一段没人要的淡出;
 *  · **动效档在落下来那一刻读一次**(`exitMs() > 0`):`none` 档与系统
 *    `prefers-reduced-motion` 下窗压根不开 = 当场卸载,一帧都不多留;
 *  · **清理里清表**:叶在淡出中被拆掉、或者中途又开了新一轮时,那一发定时器要跟着
 *    走,否则它会晚一步把刚开张的这一轮掐回空态。
 */
function useTailPhase(running: boolean): TailPhase {
  const [prevRunning, setPrevRunning] = useState(running)
  const [leaving, setLeaving] = useState(false)
  if (prevRunning !== running) {
    setPrevRunning(running)
    setLeaving(!running && exitMs() > 0)
  }
  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(() => setLeaving(false), exitMs())
    return () => clearTimeout(timer)
  }, [leaving])
  return running ? 'run' : leaving ? 'leaving' : 'idle'
}

export function TailSlot({
  sessionId,
  running,
  startedAt,
  lastActivityAt,
  pinned,
}: {
  /** 这一格属于哪条会话 —— 停止那一口的收件人(分屏下各叶各一格)。 */
  sessionId: string
  /**
   * 这一轮在跑吗。判据在 `ChatStream` 顶层(它已经算好了那一格事实)。
   *
   * **「在等第一个字」不是这里的一种形态**(P1b 裁定 B):从开张到收场,这一格的
   * 样子与布局逐字不变。
   */
  running: boolean
  /**
   * 这一轮什么时候开的张(活消息的 `timestamp`)。
   *
   * **重试那一路的真空里它是 `undefined`**:core 要先删掉旧回复、截断其后消息、
   * 再开新 run,那段真空里账本上还没有这一轮的助手消息,「跑了多久」因此**无从说起**。
   * 那时这一格照旧画那枚光标,只是不画读数与停止 —— 一个编出来的起点比没有读数
   * 更糟(与 StopNotice 那条「缺席的键就是账本上真的没有那格账」同判)。
   */
  startedAt?: number
  lastActivityAt?: number
  /**
   * **此刻是不是贴底跟随**(G 线 P1h)。
   *
   * 这一层浮在滚动口上,没有底色;人往上翻历史时它必须让开 —— 否则就是字叠字,
   * 而凭空给它加一层 background 是更糟的修法(Dock 那条「多一格颜色就是多一层」)。
   * `browsing` 时「还在跑」由 `FollowPill` 说(丸上那三个点),停止由 composer
   * 忙态那颗键给:两件事都已经在屏上,不必让这一层去挤。
   */
  pinned: boolean
}) {
  const t = useT()
  const phase = useTailPhase(running)
  /*
   * 收场那一段 `ChatStream` 已经把这两格收走了(活消息没了,`startedAt` 当场变
   * `undefined`),而淡出中的读数要接着显示收场那一刻的数 —— 所以在跑时留一份。
   * 存在 ref 里而不是 state:它只在渲染时被读,写它不该引起一次渲染。
   */
  const lastRunRef = useRef<{ startedAt?: number; lastActivityAt?: number }>({})
  if (running) lastRunRef.current = { startedAt, lastActivityAt }
  const shown = phase === 'run' ? { startedAt, lastActivityAt } : lastRunRef.current
  const alive = phase !== 'idle'
  /*
   * **在跑 ∧ 贴底跟随**才可达。两件事各有各的理由,所以是两格而不是一格:
   * 非 `run` 时没东西可碰(空着 / 淡出中那颗停止钮已经不作数了);
   * `browsing` 时这一层整层淡出、不在屏上,Tab 与读屏都不该碰到它。
   */
  const reachable = phase === 'run' && pinned
  return (
    <div
      className={s.overlay}
      data-pinned={pinned ? '' : undefined}
      /* 这一层没有身份问题:它就是那一格尾槽,只是从列里搬到了滚动口上。
         门的取件口(`data-tail-slot` / `data-face` / testid)跟着内容走,
         列里那格空位另起 `data-tail-spacer`(判词在 `TailSpacer` 上)。 */
      data-tail-slot=""
      data-face={phase}
      data-testid="chat-tail-slot"
      inert={!reachable}
      aria-hidden={reachable ? undefined : true}
    >
      <div className={s.overlayRow}>
      {alive && (
        <div className={s.body} data-leaving={phase === 'leaving' || undefined}>
          {/*
            * 指示格(只装那枚光标)。**`flex: 1` 09-21 P1g 删了** —— 它是那道
            * 已退役的扫光横线留下的化石,后果是整行被推成右对齐、左缘随秒数位数
            * 左右跳 7px(判词与录屏读数整段在 `TailSlot.module.css` 的 `.indicator`)。
            * 今天这一行左对齐贴正文列左缘,秒数长一位只往右长。
            */}
          <span className={s.indicator}>
            {/*
              * 呼吸光标。它从前独占消息列里的一行(`ChatStream.module.css` 的
              * `.cursor`),收尾那一帧卸载带走一个行盒 —— §0 的病 ③,23.8px。
              * 现在它住在这一格里,而这一格的高由 token 钉死。
              */}
            <span
              className={s.cursor}
              data-testid="chat-streaming"
              aria-label={t('chat.streaming')}
            />
          </span>
          {shown.startedAt !== undefined && (
            <StreamReadout
              sessionId={sessionId}
              startedAt={shown.startedAt}
              lastActivityAt={shown.lastActivityAt}
              live={phase === 'run'}
            />
          )}
        </div>
      )}
      </div>
    </div>
  )
}

/**
 * **列里那格空位**(G 线 P1h,2026-09-21)。
 *
 * 它是 `TailSlot` 在**列**里留下的那一半:高度恒为 `--tail-slot-h`、一个像素都不画。
 * 画的那一份搬去了滚动口上那一层(判词整段在 `TailSlot.module.css` 的 `.overlay`)。
 *
 * **为什么还要留这一格**:列的几何不能变。座位量法(`ChatStream` 的 `measureSeat`
 * 的 `belowSeat`)、`gate:stream-geometry` 的 ①⑧、「发送只滚一次」那几条都按
 * 「列尾有这么高一格」算的;把它一起搬走等于顺手改了那几条判据。所以这一格是
 * **列的事实**,那一层是**屏幕的事实**,两件事各留各的。
 *
 * 属性只有一个 `data-tail-spacer` —— 量几何的那几处按这个名字把它剔出去
 * (与座位垫块的 `data-seat` 同一条判词)。它**不带** `data-tail-slot`:
 * 那个名字跟着画出来的那一行走了,门量「人看见的那一行」问的是那一层。
 */
export function TailSpacer() {
  return <div className={s.spacer} data-tail-spacer="" aria-hidden="true" />
}
