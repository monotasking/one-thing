import { useRef, useState } from 'react'
import { Disc3, Heart, Pause, Play, SkipBack, SkipForward } from '../components/icons'
import { FocusScope } from '../focus/FocusScope'
import { AsyncButton } from '../ui/AsyncButton'
import { Fold, FoldBody, FoldTrigger } from '../ui/Fold'
import { IconButton } from '../ui/IconButton'
import { Input } from '../ui/Input'
import { Slider } from '../ui/Slider'
import { Tooltip } from '../ui/Tooltip'
import { useMutation, useQuery } from '../data/kernel'
import type { MutationSnapshot } from '../data/kernel'
import {
  musicBriefQuery,
  musicLyricsQuery,
  musicNowPlayingQuery,
  musicOps,
  musicProgrammeQuery,
  musicRuntimeQuery,
  useMusicLive,
} from '../data/music-source'
import { useT } from '../i18n'
import type { TFn } from '../i18n'
import s from './MusicPanel.module.css'

/**
 * **音乐面**(音乐收尾 · 壳半边,2026-09-10)。三块:正在放 / 电台 / 歌词。
 *
 * ── 一句话:这块面上每一颗按钮走的都是 `resources.do` ────────────────────
 * 与模型调 `music:player` 的那只工具是**同一条**路。444f915f 把 `music` 域十四条
 * 退成资源投影时,后端那一半的判词是「界面点按钮也走它」—— 这块面就是那句话的
 * 另一半。它因此**一个 `musicRouter` 的字都没有**:所有分档(电台开着时 `next`
 * 走 `skipToNextRadioSong`、`like` 按 onDeck 走服务端、`radioResume` 走保活重启)
 * 全在后端那只端口里,绕开它去调 RPC 域就是把那些分档静默丢掉。
 *
 * ── 封面:**不画**,而这是一条判断不是一格没做完 ────────────────────────
 * 自述里 `nowPlaying` 只有 `title / position / duration / progress / queueLength /
 * currentIndex` 六格,整台机器上**没有封面这件事实**(连歌手都没有独立一格 ——
 * `title` 就是 CLI 交出来的展示串「可惜没如果 - 林俊杰」,自述那一格上写着理由)。
 * 所以这里画的是一枚唱片字形,不是一张占位图:一张灰色方块会被读成「封面还没
 * 加载出来」,而它永远不会加载出来。真要有封面,该做的是给自述加一格。
 *
 * ── DJ 语音(`MUSIC_DJ_SPEAK`)**没接,而且今天接不上** ─────────────────
 * 那条推送骑的是 `broadcastVoiceHostMessage`(`runtime/src/voice/host-ports.wiring.ts`),
 * 而 React 壳的宿主端口表里 `voice: null`(`electron/host-ports.ts`)—— 于是那只
 * 广播在这台壳上是一个 noop,四条 `MUSIC_*` 推送**一条都到不了这里**。
 * 它也不在 `GET /api/events` 上(那条 SSE 只转发 `GLOBAL_EVENT_LEAVES_PROCESS`
 * 那张表上的全局事件,`music:dj-speak` 不是全局事件)。所以这里既没有播放器
 * 也没有回执:接一条收不到的订阅只会让下一个人以为它通了。真要接,要么给这台
 * 壳注入 voice 宿主端口,要么让 DJ 语音退成一条资源事实 —— 两条都是拍板,不是
 * 顺手件。留账写在回报里。
 *
 * 面上的「活」因此全部来自 `resource:event`(`nowPlayingChanged` / `radioOpened` /
 * `radioClosed` / `providerChanged`,`GLOBAL_EVENT_LEAVES_PROCESS` 里 `resource:event`
 * 是 `true`)—— 那正是派工单说的「四条推送除 DJ 语音都可改走 `resource:event`」。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 状态先行:三张表(施工纪律第一条)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── ① 生命周期 ──────────────────────────────────────────────────────────
 *  · 挂载    —— `useMusicLive()`:订 `resource:event`(前缀 `music:`)+ 五条读数
 *                各 `ensure()` 一次。先订后拉;
 *  · 事件到达 —— 按 `music-source` 那张表标脏 → 有人在看就后台补拉,**旧读数留在
 *                屏上**(律②),屏幕不闪;
 *  · 换宿主  —— 从架子拖成浮窗 / 抬上舞台 / 进全屏:拼贴树的结构共享保证**不重挂**,
 *                这块面一格状态都不动(两个本地 state:意图输入框与点歌输入框的
 *                草稿,它们跟着组件实例走,所以换宿主之后草稿还在)。檐与滚动由
 *                宿主管(`.panel` 自己 `height:100%` + 身子那一段可滚),尺寸由
 *                宿主定 —— 这块面不写任何与形态有关的尺寸;
 *  · 卸载    —— `closeMusicSource()` 退订。**读数留在格子里**:再开一次先画旧的
 *                再后台对账。
 *
 * ── ② UI 生命状态 ───────────────────────────────────────────────────────
 *  · empty   —— 播放器没在跑 → 一句 `music.playerIdle`;电台没开 → 一句
 *                `music.radioOff`;节目单空 → `music.programmeEmpty`;
 *                这首没歌词 → `music.lyricsEmpty`。**四句各说各的,不合并** ——
 *                「没在放」与「电台没开」是两件事(手动播的时候电台就是关着的);
 *  · loading —— 只有**首载**算(`phase === 'initial'`):那一块的身子先不画
 *                (不画骨架 —— 三块各自只有几行字,骨架比内容还吵)。重拉期间
 *                旧内容一像素不动;
 *  · ready   —— 有过一次答案就永远是它;
 *  · error   —— 读失败 → 那一块的身子留着旧内容,错误另起一行如实并陈
 *                (kernel 的「错误与旧数据共存」);做法失败 / 被拒 → 就地一行
 *                (`music-player-error` / `music-radio-error`),**零 Toast**
 *                (复制类反馈就地纪律同族);
 *  · 超量    —— 节目单封顶 `PROGRAMME_LIMIT` 行,余下的用一句文字读数说出来
 *                (`music.programmeMore`);列表自己带最大高度可滚,长节目单
 *                不会把歌词那一块挤出屏幕。
 *
 * ── ③ UI 交互状态 ───────────────────────────────────────────────────────
 *  · rest / hover / focus —— 全部由库件带(`ui/IconButton` 的配方、`ui/Button`
 *    的配方、全局 `:focus-visible` 那一圈);这块面自己一个 hover 皮肤都不画;
 *  · pending —— **逐格**:一只做法一只 mutation,按了暂停只有暂停那颗 disabled,
 *    别的钮照常能点(律③,病型 B 的疫苗)。文字钮走 `ui/AsyncButton`
 *    (150ms 之后才换字,disabled 立刻),图标钮走 `disabled` + `aria-busy`;
 *  · disabled —— 读不到数的杆整条停用(进度条没有 `duration`、音量没有
 *    `brief.volume`);电台关着时「关台 / 换台 / 点歌」停用,开着时「开台」停用;
 *  · active —— 拖杆拖动中(`data-sliding`,配方在 `ui/Slider`)。
 *
 * **电台开着时 `next` 走的是 `skipToNextRadioSong`** —— 这块面不判那件事,
 * 它只发 `do(music:player, next)`;分档在后端那只端口里(见文件头第一段)。
 */

/** 节目单最多画几行。余下的用一句文字读数说出来 —— 见 ② 的「超量」。 */
export const PROGRAMME_LIMIT = 50

/** 一组 mutation 里第一句错话。**就地一行**用它,零 Toast。 */
export function firstError(...snapshots: readonly MutationSnapshot[]): string | undefined {
  for (const snapshot of snapshots) if (snapshot.error) return snapshot.error
  return undefined
}

/** 秒 → `m:ss`。 */
export function clockOf(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(whole / 60)
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * `位置 / 总长`。**这不是 UI 文案而是一个数的格式**(它跟着语言不变),所以那条
 * 斜杠不进字典 —— 形逐字照抄播放器自己交出来的那一格(`4:01 / 4:58`),两处一样
 * 才不会在「读数」与「拖动中」之间跳一下形。总长不知道就只报位置。
 */
export function progressOf(position: number, duration: number | undefined): string {
  return duration === undefined ? clockOf(position) : `${clockOf(position)} / ${clockOf(duration)}`
}

export function MusicPanel() {
  const t = useT()
  useMusicLive()
  const runtime = useQuery(musicRuntimeQuery)
  const playRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const state = runtime.data
  const notReady = state !== undefined && state.setupStage !== 'ready'

  return (
    <FocusScope
      scope="music"
      rootRef={panelRef}
      /*
       * 落点 = 播放 / 暂停那颗钮(三件声明的第二件)。进这块面第一件想做的事
       * 就是让它响或者让它停。Esc **不声明** —— 判词在 `focus/scopes.ts` 那一行上。
       */
      restingTarget={() => playRef.current}
    >
      {({ scopeProps }) => (
        <div {...scopeProps} className={s.panel} data-testid="music-panel">
          {notReady && (
            <p className={s.notice} data-testid="music-not-ready">
              {t('music.backendNotReady')}
            </p>
          )}
          {state?.lastError && (
            <p className={s.notice} data-testid="music-backend-error">
              {t('music.backendError', { message: state.lastError })}
            </p>
          )}
          <PlayerBlock t={t} playRef={playRef} />
          <RadioBlock t={t} />
          <LyricsBlock t={t} />
        </div>
      )}
    </FocusScope>
  )
}

/* ── 正在放 ──────────────────────────────────────────────────────────────── */

function PlayerBlock({
  t,
  playRef,
}: {
  t: TFn
  playRef: { current: HTMLButtonElement | null }
}) {
  const now = useQuery(musicNowPlayingQuery)
  const brief = useQuery(musicBriefQuery)

  // 七只各一格 pending、各一句 error(律③逐格)。
  const prev = useMutation(musicOps.prev)
  const pause = useMutation(musicOps.pause)
  const resume = useMutation(musicOps.resume)
  const next = useMutation(musicOps.next)
  const like = useMutation(musicOps.like)
  const seek = useMutation(musicOps.seek)
  const volume = useMutation(musicOps.volume)
  const error = firstError(prev, pause, resume, next, like, seek, volume)

  const playing = now.data?.playing ?? false
  const duration = now.data?.duration
  const position = now.data?.position
  const title = now.data?.title

  return (
    <section className={s.block} data-testid="music-player">
      <h2 className={s.head}>{t('music.player')}</h2>

      {now.phase === 'ready' && !now.data?.title && !playing && (
        <p className={s.none}>{t('music.playerIdle')}</p>
      )}

      {now.data && (now.data.title !== undefined || playing) && (
        <>
          <div className={s.track}>
            {/* 封面这件事实这台机器上没有 —— 画字形不画假图,判词在文件头。 */}
            <span className={s.artless} aria-hidden="true">
              <Disc3 />
            </span>
            {/* 标题会被截断(结构行只截断不换行),所以配 Tooltip 全名 —— 禁 native title=。 */}
            <Tooltip content={title || t('music.untitled')}>
              <span className={s.title}>{title || t('music.untitled')}</span>
            </Tooltip>
          </div>

          <div className={s.row}>
            <Slider
              value={duration !== undefined && position !== undefined ? position : undefined}
              min={0}
              max={duration ?? 0}
              label={t('music.seekLabel')}
              // 拖动中报的必须是**手底下那个数**,不是上一次读到的 `progress`
              // (那一格是播放器自己的格式,拖的时候它是陈的)。
              format={(value) => progressOf(value, duration)}
              testId="music-seek"
              onCommit={(value) => void musicOps.seek.run({ position: value })}
            />
            {/* 读数优先用播放器自己那格格式(`4:01 / 4:58`);它没给就自己排一个。 */}
            {(now.data.progress ?? (position !== undefined ? progressOf(position, duration) : '')) && (
              <span className={s.clock}>
                {now.data.progress ?? progressOf(position ?? 0, duration)}
              </span>
            )}
          </div>

          <div className={s.controls}>
            <IconButton
              icon={SkipBack}
              label={t('music.prev')}
              testId="music-prev"
              disabled={prev.pending}
              aria-busy={prev.pending || undefined}
              onClick={() => void musicOps.prev.run({})}
            />
            <IconButton
              ref={playRef}
              icon={playing ? Pause : Play}
              label={t(playing ? 'music.pause' : 'music.resume')}
              size="md"
              testId="music-play"
              disabled={pause.pending || resume.pending}
              aria-busy={pause.pending || resume.pending || undefined}
              onClick={() => void (playing ? musicOps.pause : musicOps.resume).run({})}
            />
            <IconButton
              icon={SkipForward}
              label={t('music.next')}
              testId="music-next"
              disabled={next.pending}
              aria-busy={next.pending || undefined}
              onClick={() => void musicOps.next.run({})}
            />
            <IconButton
              icon={Heart}
              label={t('music.like')}
              testId="music-like"
              disabled={like.pending}
              aria-busy={like.pending || undefined}
              onClick={() => void musicOps.like.run({})}
            />
            <Slider
              value={brief.data?.volume}
              label={t('music.volumeLabel')}
              format={(value) => String(value)}
              testId="music-volume"
              disabled={volume.pending}
              onCommit={(value) => void musicOps.volume.run({ level: value })}
            />
          </div>
        </>
      )}

      {now.error && <p className={s.bad}>{now.error}</p>}
      {error && (
        <p className={s.bad} data-testid="music-player-error">
          {error}
        </p>
      )}
    </section>
  )
}

/* ── 电台 ────────────────────────────────────────────────────────────────── */

function RadioBlock({ t }: { t: TFn }) {
  const brief = useQuery(musicBriefQuery)
  const programme = useQuery(musicProgrammeQuery)
  const [intent, setIntent] = useState('')
  const [song, setSong] = useState('')

  const open = useMutation(musicOps.open)
  const retune = useMutation(musicOps.retune)
  const close = useMutation(musicOps.close)
  const request = useMutation(musicOps.request)
  const radioResume = useMutation(musicOps.radioResume)
  const radioStop = useMutation(musicOps.radioStop)
  const error = firstError(open, retune, close, request, radioResume, radioStop)

  const active = brief.data?.active ?? false
  const entries = programme.data?.entries ?? []
  const shown = entries.slice(0, PROGRAMME_LIMIT)
  const hidden = entries.length - shown.length

  return (
    <section className={s.block} data-testid="music-radio">
      <h2 className={s.head}>{t('music.radio')}</h2>

      {brief.phase === 'ready' && !active && <p className={s.none}>{t('music.radioOff')}</p>}

      <div className={s.row}>
        <Input
          value={intent}
          onValueChange={setIntent}
          placeholder={t('music.intentPlaceholder')}
          aria-label={t('music.intentPlaceholder')}
          data-testid="music-intent"
        />
        {/*
          * 开台 / 换台是同一格意图的两个出口:电台关着 = 开台,开着 = 换台。
          * 两颗**都在**,各自按电台此刻的状态停用 —— 一颗会变名字的钮让人认不出
          * 自己刚点了什么(与 composer 那颗发送/停止两副面孔不同:那一处的两态
          * 是同一次生成的两端,这里是两条不同的做法)。
          */}
        <AsyncButton
          action={musicOps.open}
          pendingLabel={t('common.working')}
          disabled={active}
          data-testid="music-open"
          onClick={() => void musicOps.open.run({ intent })}
        >
          {t('music.open')}
        </AsyncButton>
        <AsyncButton
          action={musicOps.retune}
          pendingLabel={t('common.working')}
          disabled={!active}
          data-testid="music-retune"
          onClick={() => void musicOps.retune.run({ intent })}
        >
          {t('music.retune')}
        </AsyncButton>
      </div>

      <div className={s.row}>
        <AsyncButton
          action={musicOps.close}
          pendingLabel={t('common.working')}
          disabled={!active}
          data-testid="music-close"
          onClick={() => void musicOps.close.run({})}
        >
          {t('music.close')}
        </AsyncButton>
        <AsyncButton
          action={musicOps.radioResume}
          pendingLabel={t('common.working')}
          disabled={!(brief.data?.canResume ?? false)}
          data-testid="music-radio-resume"
          onClick={() => void musicOps.radioResume.run({})}
        >
          {t('music.radioResume')}
        </AsyncButton>
        <AsyncButton
          action={musicOps.radioStop}
          pendingLabel={t('common.working')}
          disabled={!active}
          data-testid="music-radio-stop"
          onClick={() => void musicOps.radioStop.run({})}
        >
          {t('music.radioStop')}
        </AsyncButton>
      </div>

      {brief.data?.starting && (
        <p className={s.meta}>{t('music.starting', { title: brief.data.starting })}</p>
      )}
      {brief.data?.upNext && (
        <p className={s.meta}>{t('music.upNext', { title: brief.data.upNext })}</p>
      )}

      <div className={s.row}>
        <Input
          value={song}
          onValueChange={setSong}
          placeholder={t('music.requestPlaceholder')}
          aria-label={t('music.requestPlaceholder')}
          data-testid="music-song"
        />
        <AsyncButton
          action={musicOps.request}
          pendingLabel={t('common.working')}
          disabled={!active || song.trim() === ''}
          data-testid="music-request"
          onClick={() => void musicOps.request.run({ song })}
        >
          {t('music.request')}
        </AsyncButton>
      </div>

      <h3 className={s.subhead}>{t('music.programme')}</h3>
      {programme.data?.onDeck && (
        <p className={s.meta}>{t('music.onDeck', { title: programme.data.onDeck })}</p>
      )}
      {programme.phase === 'ready' && entries.length === 0 && (
        <p className={s.none}>{t('music.programmeEmpty')}</p>
      )}
      {shown.length > 0 && (
        <ul className={s.list} data-testid="music-programme">
          {shown.map((entry) => (
            <li key={entry.encryptedId} className={s.entry}>
              <span className={s.entryTitle}>{entry.title}</span>
              {entry.note && <span className={s.entryNote}>{entry.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && <p className={s.meta}>{t('music.programmeMore', { count: hidden })}</p>}

      {brief.error && <p className={s.bad}>{brief.error}</p>}
      {error && (
        <p className={s.bad} data-testid="music-radio-error">
          {error}
        </p>
      )}
    </section>
  )
}

/* ── 歌词 ────────────────────────────────────────────────────────────────── */

function LyricsBlock({ t }: { t: TFn }) {
  const lyrics = useQuery(musicLyricsQuery)
  const lines = lyrics.data?.lines ?? []

  return (
    <section className={s.block} data-testid="music-lyrics">
      <Fold>
        {/*
          * 标题仍是一个 `<h2>`(三块的层级要一致),可点的是里面那个 span ——
          * `FoldTrigger` 只开 `div` / `span` 两种标签,理由写在它自己的 prop 上
          * (触发器里常常直接摆正文,而 `<p>` 放进 `<button>` 是非法嵌套)。
          */}
        <h2 className={s.head}>
          <FoldTrigger as="span" className={s.foldHead} data-testid="music-lyrics-toggle">
            {t('music.lyrics')}
          </FoldTrigger>
        </h2>
        <FoldBody>
          {lyrics.phase === 'ready' && lines.length === 0 ? (
            <p className={s.none}>{t('music.lyricsEmpty')}</p>
          ) : (
            <ol className={s.lyrics}>
              {lines.map((line, i) => (
                // 一行歌词没有 id;`at` 是它在这首歌里的坐标,同一首里不会重复。
                <li key={`${line.at}-${i}`} className={s.lyricLine}>
                  {line.text}
                </li>
              ))}
            </ol>
          )}
        </FoldBody>
      </Fold>
      {lyrics.error && <p className={s.bad}>{lyrics.error}</p>}
    </section>
  )
}
