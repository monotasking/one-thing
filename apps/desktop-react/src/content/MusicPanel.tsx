import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FocusScope } from '../focus/FocusScope'
import { useMutation, useQuery } from '../data/kernel'
import {
  musicBriefQuery,
  musicNowPlayingQuery,
  musicOps,
  musicProgrammeQuery,
  musicRuntimeQuery,
  useMusicLive,
} from '../data/music-source'
import type { MusicRadioState } from '@shared/ipc/music'
import type { MusicNowPlayingView } from '../data/music-source'
import { useT } from '../i18n'
import type { PetStageHandle } from '../pets/PetStage'
import type { PetMenu } from '../pets/types'
import { enterSessionInWorkbench } from './session-open'
import { DeckRow } from './music/DeckRow'
import { LoginGate, MusicHeader, NowLine, StatusBanner, useStatusAnnouncer } from './music/MusicFrame'
import { PlaylistDrawer } from './music/PlaylistDrawer'
import type { RecordDeckProps } from './music/RecordDeck'
import { stationRefilling } from './music/pet-activity'
import { recordSideOf, SIDE_CAP } from './music/record-geometry'
import { MUSIC_DEFAULT_SECTION, MUSIC_SECTIONS, MUSIC_SETUP_SECTION } from './music/sections'
import type { MusicSectionContext } from './music/sections'
import { deriveMusicStatus } from './music/status'
import { useMusicPanelForm } from './music/panel-width'
import { useHostTalk } from './music/useHostTalk'
import { usePlaybackPosition } from './music/usePlaybackPosition'
import s from './MusicPanel.module.css'

/**
 * **音乐面 v9 · 成熟的音乐 App**(2026-09-25;正本 `docs/music-panel-2026-09.md` §10)。用户:「把它设计为一个
 * 成熟的音乐 app,风格、交互你自己定。要求只有一个:状态有反馈、用户能够知道状态;有操作指引,没登录引导
 * 用户登录,支持后续的扩展。」四句话各有一个产地:
 *
 *  · **状态** —— `music/status.ts`:一张状态表 + 一条优先序,吐出**一个**状态;播放条上的状态丸、分区上方
 *    的状态条、读屏播报都读它(`MusicFrame`);
 *  · **指引** —— 状态表每一行带一句「接下来怎么办」和一颗钮;每个分区自己的灰字说「按下去会发生什么」;
 *  · **登录** —— 没登上时面板自动落到「账号」那一格(三步清单 + 接入向导),檐右端一颗「登录」主钮,
 *    其余分区画登录引导卡而不是空白;
 *  · **扩展** —— `music/sections.tsx` 分区表:导航、身子、登录闸都读它,这只文件里**一个分区名都没有**。
 *
 * 整面:檐(分区导航 + 账号)→ 状态条(有才画)→ 分区身子(唱机 / 电台 / 搜索 / 账号)→ 播放条
 * (`NowLine` + `DeckRow`,任何分区下都在)。播放列表仍是播放条上那颗钮后面的抽屉。v8 的唱机、黑豆、
 * 歌词、抽屉一个字没改,整块成了「正在放」那一格。分区**保挂载**(去过就留着,切走只是 `hidden`):
 * 搜索词、打了一半的意图、唱机的转盘都不因为切一下分区而丢(树/面常驻铁律)。
 *
 * 下面是 v8 的原文(唱机那一格的判词,仍然成立)。
 *
 * **音乐面 v8 · 唱针读歌词**(2026-09-18;样例「黑豆电台」v7 —— 用户:「ok,就按照这个去实现,100%」)。
 *
 * 面板只有两部分:**上面一整块是唱片和黑豆**(`music/RecordDeck`),**下面一行是进度和按钮**
 * (`music/DeckRow`)。播放列表住在那一行最右边那颗钮后面的抽屉里(`PlaylistDrawer`)。
 * 宽的面板只是唱片更大、歌词更宽,布局一模一样,也没有「歌词」钮 —— 歌词一直都在。
 *
 * 这一版推翻了 v7 的整面:用户 09-18 连着三句 ——「布局很奇怪,歌词和 cd 机竟然是分开的」
 * 「cd 的复杂」「开关、打开歌词等操作,会让 ui 布局变化」。所以:
 *  · 电台条、歌词页 / 歌词栏、歌名那一行、「接下来」那一行、说话条、音量条、⏮ 全部并掉;
 *  · 开台 = ⏯(关着时它就是「开台」)或者「说话」说一句想听什么;换台 = 开着时「说话」;
 *    关台与账号在播放列表抽屉的檐上;
 *  · **布局从不跟着状态变**:按钮那一行的高度由 token 定死,唱片那一块吃满面板余下的高(弹性,
 *    09-18「他能是一个弹性布局吗?」—— 跟着面板变,不跟着状态变);开台 / 关台 / 暂停 / 说话 /
 *    黑豆挑歌 / 出错,变的只是格子里的东西(错话浮在唱片顶上,不占一行)。
 *
 * ── 一句话:这块面上每一颗按钮走的都是 `resources.do` ────────────────────
 * 与模型调 `music:player` / `music:radio` 的那只工具是同一条路;电台开着时 `next` 走跳过、
 * `like` 按 onDeck 走服务端,这些分档全在后端端口里,面板只发 `do`。
 *
 * ── 封面:**不画** ──────────────────────────────────────────────────────
 * 自述里 `nowPlaying` 没有封面,标签颜色从歌名算(`labelColorsFor`),不画占位图:一张灰方块
 * 会被读成「封面还没加载出来」,而它永远不会来。
 *
 * ── DJ 语音不在这块面上播(M3:主进程播)────────────────────────────────
 * 主持人是唱片左下角的黑豆;他的话走宠物那条路冒在他头顶。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三张状态表(整面;唱片那一块与按钮那一行各自的表在各自文件头)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── ① 生命周期 ──────────────────────────────────────────────────────────
 *  · 挂载    —— `useMusicLive()` 订 `resource:event` + 五条读数各 `ensure()`(先订后拉);抽屉关着;
 *  · 事件到达 —— 标脏 → 后台补拉,旧读数留在屏上;
 *  · 播放钟  —— `usePlaybackPosition`(在放时每 250ms 一拍),唱臂、进度条、歌词高亮吃同一个数;
 *  · 说话    —— 按钮那一行就地换成输入框,焦点由这一格的落点交给框;回车 / Esc / 取消回到按钮;
 *  · 抽屉    —— 开 / 关不动主界面;关掉焦点结构性地回到那颗钮;
 *  · 换宿主  —— 浮窗 / 舞台 / 全屏不重挂;唱头拖到一半换宿主,`PointerTrack` 作废这一下;
 *  · 卸载    —— 退订;抽屉与说话状态不落盘。
 *
 * ── ② UI 生命状态 ───────────────────────────────────────────────────────
 *  · 后端没配好 → 接入向导占唱片那一块(按钮那一行不画:这几步里它没有可说的);
 *    后端整个读不到 → 顶上一句 `music.backendNotReady`;
 *  · 错误(后端 / 按钮)→ 浮在唱片那一块顶上的一行原话,零 Toast;「没有下一首、DJ 在补」不是错,
 *    交给黑豆(他在翻唱片,刚进这一态和按 ⏭ 撞上它时各嘀咕一句);
 *  · 其余全部在唱片那一块里演(关着 / 没歌 / 挑歌 / 没歌词),高度不变。
 *
 * ── ③ UI 交互状态 ───────────────────────────────────────────────────────
 *  · 随库件;pending 逐格;Esc:有抽屉先关抽屉(它更深),其次退出说话;都没有就放行。
 */
export function MusicPanel({
  initialPlaylistOpen = false,
  initialSection,
}: {
  /** 只给实验台用:一开就要量「抽屉开着」那一态。产品里不传。 */
  initialPlaylistOpen?: boolean
  /** 只给实验台与测试用:一开就停在哪一格。产品里不传(缺省 = 按登录与否自动选)。 */
  initialSection?: string
} = {}) {
  const t = useT()
  useMusicLive()
  const runtime = useQuery(musicRuntimeQuery)
  const now = useQuery(musicNowPlayingQuery)
  const brief = useQuery(musicBriefQuery)
  const programme = useQuery(musicProgrammeQuery)
  const playRef = useRef<HTMLButtonElement | null>(null)
  const playlistRef = useRef<HTMLButtonElement | null>(null)
  const petRef = useRef<PetStageHandle | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // 此刻没歌在放、但记得上次放到哪 → 画上次那首、停在那一秒(09-19「播放状态找上次播放的状态」)。
  // 身份跟着读数走(useMemo),否则每次重渲一个新对象,播放钟会当成新采样重起。
  const lastPlayed = brief.data?.lastPlayed
  const restored = useMemo(() => restoredNowPlaying(now.data, lastPlayed), [now.data, lastPlayed])
  const shown = restored ?? now.data
  const position = usePlaybackPosition(shown)
  const form = useMusicPanelForm(panelRef)
  const talk = useHostTalk()
  const [playlistOpen, setPlaylistOpen] = useState(initialPlaylistOpen)
  const [rowError, setRowError] = useState<string | undefined>(undefined)

  const state = runtime.data
  // 没登上(后端说了、而且不是 ready)。读不到 `state` 时不算 —— 那是「连不上」,不是「没登录」。
  const needsSetup = state !== undefined && state.setupStage !== 'ready'
  const unreachable = state === undefined && (runtime.error !== undefined || runtime.phase === 'ready')

  // ── 分区:人点过就听人的;没点过 = 自动(没登上落到账号那一格,登上了落到缺省那一格)──────────
  const [chosen, setChosen] = useState<string | null>(initialSection ?? null)
  const section = chosen ?? (needsSetup ? MUSIC_SETUP_SECTION : MUSIC_DEFAULT_SECTION)
  // 刚登上:人若停在向导那一格,带他去听歌(「登上了」由唱机出现自己说,09-18 用户原话)。
  const wasSetup = useRef(needsSetup)
  useEffect(() => {
    if (wasSetup.current && !needsSetup && state !== undefined) setChosen((cur) => (cur === MUSIC_SETUP_SECTION ? null : cur))
    wasSetup.current = needsSetup
  }, [needsSetup, state])
  const navigate = useCallback((id: string) => setChosen(id), [])
  // 去过的分区留着(保挂载)。在渲染里记账是幂等的(Set.add),StrictMode 的双跑不会多记。
  const visited = useRef<Set<string>>(new Set())
  visited.current.add(section)
  const title = shown?.title
  const radioOn = brief.data?.active === true

  // 点黑豆开出来的那一格(09-19):上面跟他说一句,下面「看他的会话」。关着时说的那句就是开台的意图,
  // 开着时递给他(`tell`)—— 与从前那一行里的说话框同一条路,只是换了个地方住。
  const hostSessionId = brief.data?.hostSessionId
  const petMenu = useMemo<PetMenu>(
    () => ({
      label: t('music.petMenu'),
      talk: {
        value: talk.text,
        onChange: talk.setText,
        placeholder: t(radioOn ? 'music.deckTalkOn' : 'music.deckTalkOff'),
        sendLabel: t('music.petSend'),
        sendDisabled: talk.sending,
        onSend: () => {
          const words = talk.text.trim()
          if (!words) return
          if (radioOn) talk.send()
          else {
            talk.setText('')
            void musicOps.open.run({ intent: words })
          }
        },
      },
      actions: [
        {
          id: 'session',
          label: t('music.petSession'),
          disabled: !hostSessionId,
          onSelect: () => {
            if (hostSessionId) enterSessionInWorkbench(hostSessionId)
          },
        },
      ],
    }),
    [t, talk, radioOn, hostSessionId],
  )

  const seek = useCallback((seconds: number) => void musicOps.seek.run({ position: seconds }), [])
  const playEntry = useCallback((encryptedId: string) => {
    void musicOps.programmeAction.run({ action: { kind: 'promote', encryptedId } }).then(() => {
      if (!musicOps.programmeAction.get().error) void musicOps.next.run({})
    })
  }, [])
  const onLiked = useCallback(() => petRef.current?.love(), [])
  const openStation = useCallback((intent: string) => void musicOps.open.run({ intent }), [])
  const opening = useMutation(musicOps.open).pending

  // 「没有下一首了,DJ 正在补歌单」是黑豆的事(09-18 用户:「这个状态交给 pet 啊」):他在翻唱片
  // (`musicPetActivity` 那一格 busy),刚进这一态时嘀咕一句;按 ⏭ 撞上它,他再嘀咕一句。
  // 不是错话,面板上不出任何一行字。
  const refilling = stationRefilling(brief.data, programme.data)
  // 「刚进」要从一个**读到过的**「不在补」进来:打开面板时读数落地那一下不算(那不是变化,是首载)。
  const known = brief.data !== undefined && programme.data !== undefined
  const wasRefilling = useRef<boolean | null>(null)
  useEffect(() => {
    if (!known) return
    if (refilling && wasRefilling.current === false) petRef.current?.mutter('busy')
    wasRefilling.current = refilling
  }, [known, refilling])
  const onWaitForDj = useCallback(() => petRef.current?.mutter('busy'), [])
  const closePlaylist = useCallback(() => setPlaylistOpen(false), [])

  // 抽屉里「翻面以后」那条线画在第几首之后:这一面还能再排几首。
  const side = recordSideOf({
    nowTitle: title,
    nowDuration: shown?.duration,
    recent: brief.data?.recent,
    entries: programme.data?.entries,
  })
  const sideRoom = side ? SIDE_CAP - side.current - 1 : undefined

  const error = state?.lastError ? t('music.backendError', { message: state.lastError }) : (now.error ?? rowError ?? talk.error)
  const status = deriveMusicStatus({
    runtime: state,
    runtimeUnreachable: unreachable,
    brief: brief.data,
    nowPlaying: shown,
    restored: restored !== undefined,
    opening,
    refilling,
    error,
  })
  useStatusAnnouncer(status)

  const deck: RecordDeckProps = {
    runtime: state,
    brief: brief.data,
    nowPlaying: shown,
    restored: restored !== undefined,
    nowError: now.error,
    programme: programme.data,
    position,
    wide: form.wide,
    onSeek: seek,
    onPlayEntry: playEntry,
    onOpen: openStation,
    opening,
    petRef,
    listening: radioOn && talk.typing,
    awaitingHost: radioOn && talk.waiting,
    petMenu,
  }
  const ctx: MusicSectionContext = {
    runtime: state,
    brief: brief.data,
    programme: programme.data,
    nowPlaying: shown,
    position,
    radioOn,
    loggedIn: state?.setupStage === 'ready',
    status,
    talk,
    navigate,
    deck,
  }

  return (
    <FocusScope
      scope="music"
      rootRef={panelRef}
      restingTarget={() => playRef.current}
    >
      {({ scopeProps }) => (
        <div {...scopeProps} className={s.panel} data-testid="music-panel" data-section={section}>
          <MusicHeader
            sections={MUSIC_SECTIONS}
            current={section}
            onNavigate={navigate}
            runtime={state}
            setupSection={MUSIC_SETUP_SECTION}
          />
          <StatusBanner status={status} onNavigate={navigate} />
          <div className={s.scroller}>
            <div className={s.layout}>
              {MUSIC_SECTIONS.filter((row) => visited.current.has(row.id)).map((row) => (
                <section
                  key={row.id}
                  className={s.section}
                  data-layout={row.layout}
                  data-testid={row.layout === 'fill' ? 'music-player' : undefined}
                  data-music-section={row.id}
                  aria-label={t(row.labelKey)}
                  hidden={row.id !== section}
                >
                  {row.requiresLogin && needsSetup && state ? (
                    <LoginGate runtime={state} sectionLabel={t(row.labelKey)} onLogin={() => navigate(MUSIC_SETUP_SECTION)} />
                  ) : (
                    row.render(ctx)
                  )}
                </section>
              ))}
            </div>
          </div>

          {!needsSetup && (
            <footer className={s.playerBar} data-testid="music-player-bar">
              <NowLine title={title} status={status} onNavigate={navigate} />
              <DeckRow
                title={title}
                playing={shown?.playing ?? false}
                restored={restored !== undefined}
                everPlayed={shown?.title !== undefined || (radioOn && brief.data?.canResume === true)}
                volume={brief.data?.volume}
                position={position}
                duration={shown?.duration}
                playRef={playRef}
                playlistRef={playlistRef}
                playlistOpen={playlistOpen}
                onTogglePlaylist={() => setPlaylistOpen((open) => !open)}
                onLiked={onLiked}
                refilling={refilling}
                onWaitForDj={onWaitForDj}
                onError={setRowError}
              />
            </footer>
          )}

          {!needsSetup && playlistOpen && (
            <PlaylistDrawer
              form={form.drawer}
              onClose={closePlaylist}
              nowPlaying={now.data}
              position={position}
              radioOn={radioOn}
              sideRoom={sideRoom}
            />
          )}
        </div>
      )}
    </FocusScope>
  )
}

/**
 * 播放器此刻说不出在放什么(守护进程退了 / 从没起过),而简报记得上次放到哪 → 拼一份「停在那一秒」的
 * 读数给唱片与那一行画。状态记成 `paused`:它确实是停在半路,不是没放过。播放器自己有歌名时一律听
 * 播放器的 —— 那才是此刻的真相。
 */
function restoredNowPlaying(
  now: MusicNowPlayingView | undefined,
  last: MusicRadioState['lastPlayed'],
): MusicNowPlayingView | undefined {
  if (now?.title || !last) return undefined
  return {
    playing: false,
    status: 'paused',
    title: last.title,
    position: last.position,
    ...(last.durationS !== undefined ? { duration: last.durationS } : {}),
    queueLength: 0,
    currentIndex: 0,
  }
}
