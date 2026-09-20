import { useEffect, useState } from 'react'
import { composerSink } from '../../composer/sink'
import { STALL_HARD_MS, STALL_SOFT_MS } from '../../components/motion'
import { formatDuration } from '../../format/quantity'
import { useT } from '../../i18n'
import { ButtonBase } from '../../ui/ButtonBase'
import { WaitingSeam } from '../seam/WaitingSeam'
import c from './MessageChrome.module.css'
import s from './TailSlot.module.css'

/**
 * **尾槽** —— 整列末尾那一格常驻的槽位(G 线 P1,正本
 * `apps/desktop-react/docs/stream-geometry-2026-09.md` §3.1 与 §5.2)。
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
 * 那一格。高度由 token `--tail-slot-h` 钉死,与此刻是哪张脸无关。
 *
 * ── 三张脸,同格同高,只换 opacity ────────────────────────────────────────
 * 写法逐字照抄 `MessageChrome.module.css` 的「同格同高」那一节(一格 grid,脸全部
 * 落在 `1 / 1`,暗的那张 `opacity: 0` + `inert`)。三张脸:
 *  · **等待** —— 这一轮在跑、一个字还没到(含重试那一路):一道在扫的线
 *    (`WaitingSeam`,折痕基座的 `running` 态)+ 读数 + 停止;
 *  · **流式** —— 在跑且已经有内容:呼吸光标 + 读数 + 停止;
 *  · **空** —— 不在跑:两张脸都不挂载,整格 `inert` + `aria-hidden`,**高度照占**。
 *
 * **读数只有一份**(不是每张脸各挂一个):它挂着一只 100ms 的表,两份就是两只表,
 * 而且 `getByTestId('chat-readout')` 会当场撞上两个。所以它排在指示格**旁边**,
 * 由 `running` 一格判在不在;指示格 `flex: 1`,所以读数在两张脸之间**横向也不动**。
 *
 * ── 空着时为什么不挂载那两张脸 ────────────────────────────────────────────
 * 「同格同高」要的是**几何**不变,而这一格的几何由 token 钉死,与挂不挂载无关。
 * 空着时挂着的代价是真的:那道扫光与那枚光标是两段 `infinite` 动画,一片会话叶一份,
 * 而一台上可以并排开好几片。所以:**在跑时两张脸都在(交叉淡入),不在跑时一张都不挂**。
 *
 * ── 三张状态表(施工纪律「状态先行」)────────────────────────────────────
 * ① **生命周期**:随会话叶挂载、常驻、随叶卸载;`ChatStream` 在
 *    `sessionId && status === 'ready'` 时始终渲染它。读数那只 100ms 的表只在
 *    「在跑」时起(`useNow` 的 effect 自带清理)。**按 `sessionId` 分家** ——
 *    停止那一口打给的是 prop 上这一条会话,分屏下各叶各一格(W5-c-2 的同一条判词)。
 *    零模块级副作用 → **不需要 HMR dispose**。
 * ② **UI 生命状态**:空 / 等待 / 流式 / 静默(stalled)/ 疑似卡住(stuck);
 *    空会话与 loading、error 时**整件不画**(那三态由 `ChatStream` 自己的空态说话)。
 *    **超量不成立** —— 它不吃数据,脸的数量与内容长度都是常数。
 * ③ **UI 交互状态**:停止钮 rest / hover / focus / disabled 照旧(`ButtonBase` +
 *    `.ghost`,皮肤与动作行同源);空脸整格 `inert`,Tab 进不去、读屏念不到。
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

function useNow(tickMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), tickMs)
    return () => clearInterval(timer)
  }, [tickMs])
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
}: { sessionId: string; startedAt: number; lastActivityAt?: number }) {
  const t = useT()
  const now = useNow(READOUT_TICK_MS)

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

/** 这一格此刻是哪张脸。`idle` = 不在跑(两张脸都不挂载,高度照占)。 */
export type TailFace = 'idle' | 'wait' | 'stream'

export function TailSlot({
  sessionId,
  face,
  startedAt,
  lastActivityAt,
}: {
  /** 这一格属于哪条会话 —— 停止那一口的收件人(分屏下各叶各一格)。 */
  sessionId: string
  /** 等待 / 流式 / 空。判据全在 `ChatStream` 顶层(它已经算好了那几格事实)。 */
  face: TailFace
  /**
   * 这一轮什么时候开的张(活消息的 `timestamp`)。
   *
   * **重试那一路的真空里它是 `undefined`**:core 要先删掉旧回复、截断其后消息、
   * 再开新 run,那段真空里账本上还没有这一轮的助手消息,「跑了多久」因此**无从说起**。
   * 那时这一格照旧画等待那张脸(线在扫),只是不画读数与停止 —— 一个编出来的
   * 起点比没有读数更糟(与 StopNotice 那条「缺席的键就是账本上真的没有那格账」同判)。
   */
  startedAt?: number
  lastActivityAt?: number
}) {
  const t = useT()
  const running = face !== 'idle'
  return (
    <div
      className={s.slot}
      /* 量几何的那几处按这个名字把它剔出去:尾槽是常驻的一格,不是「这一轮长了多高」
         的一部分(与座位垫块的 `data-seat` 同一条判词,见 `ChatStream` 的 `measureSeat`)。 */
      data-tail-slot=""
      data-face={face}
      data-testid="chat-tail-slot"
      inert={!running}
      aria-hidden={running ? undefined : true}
    >
      {/*
        * 指示格。`flex: 1` —— 两张脸的宽度差因此不会把读数横向推一下
        * (等待那张是一道贯穿的线,流式那张是一枚 0.5em 的光标)。
        */}
      <span className={s.indicator}>
        {running && (
          <>
            <span className={s.face} data-on={face === 'wait' || undefined} inert={face !== 'wait'}>
              <WaitingSeam label={t('chat.streaming')} />
            </span>
            <span className={s.face} data-on={face === 'stream' || undefined} inert={face !== 'stream'}>
              {/*
                * 呼吸光标。它从前独占消息列里的一行(`ChatStream.module.css` 的
                * `.cursor`),收尾那一帧卸载带走一个行盒 —— §0 的病 ③,23.8px。
                * 现在它住在这一格里:换的只有 `opacity`,行盒从头到尾都在。
                */}
              <span
                className={s.cursor}
                data-testid="chat-streaming"
                aria-label={t('chat.streaming')}
              />
            </span>
          </>
        )}
      </span>
      {running && startedAt !== undefined && (
        <StreamReadout
          sessionId={sessionId}
          startedAt={startedAt}
          lastActivityAt={lastActivityAt}
        />
      )}
    </div>
  )
}
