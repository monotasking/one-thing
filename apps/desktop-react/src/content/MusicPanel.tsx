import { useCallback, useEffect, useRef, useState } from 'react'
import { FocusScope } from '../focus/FocusScope'
import { useQuery } from '../data/kernel'
import {
  musicBriefQuery,
  musicNowPlayingQuery,
  musicOps,
  musicProgrammeQuery,
  musicRuntimeQuery,
  useMusicLive,
} from '../data/music-source'
import { useT } from '../i18n'
import type { PetStageHandle } from '../pets/PetStage'
import { LyricsPane } from './music/LyricsPane'
import { PlaylistDrawer } from './music/PlaylistDrawer'
import { SetupWizard, useSetupWizardVisible } from './music/SetupWizard'
import { StationStrip } from './music/StationStrip'
import { IdlePlayButton, PlaylistButton, Transport } from './music/Transport'
import { TurntableScene } from './music/TurntableScene'
import { useMusicPanelForm } from './music/panel-width'
import { splitTitle } from './music/turntable'
import { usePlaybackPosition } from './music/usePlaybackPosition'
import s from './MusicPanel.module.css'

/**
 * **音乐面 · 整面布局 v7**(2026-09-18,正本 `apps/desktop-react/docs/music-panel-2026-09.md`;
 * 唱机形 M1 是 09-17,宠物 P1 起唱机那一块是一整幕场景)。
 *
 * ── v7 改的是**整面**,不是唱机那一块 ────────────────────────────────────
 * M1 把节目单直铺在唱机下面。用户原话:「你这个歌词我以为是歌曲列表呢。谁家歌曲列表
 * 直接往下铺一排啊。」音乐软件的做法是:歌单藏在一颗钮后面,主界面留给正在放的这一首。
 * 于是:
 *  · **播放列表** 任何宽度下都不铺在页面上 —— 歌条上一颗钮开抽屉(`PlaylistDrawer`);
 *  · **窄 / 中(< 900)** 一栏:唱机场景 → 歌名 → 歌条;歌词不在主界面上,
 *    点「歌词」把唱机场景整块换成歌词页,页头一颗小碟点回来;
 *  · **宽(≥ 900)** 两栏:左唱机 + 歌名 + 歌条,右常驻歌词,**没有歌词钮**。
 * 形由**面板自己的宽**说(`music/panel-width.ts`),不是窗口宽:这块面落在架子 /
 * 浮窗 / 舞台三种宿主里,同一扇窗里它可以只有 320 也可以有 1200。
 *
 * ── 一句话:这块面上每一颗按钮走的都是 `resources.do` ────────────────────
 * 与模型调 `music:player` / `music:radio` 的那只工具是**同一条**路。所有分档(电台开着时
 * `next` 走跳过、`prev` 走重播、`like` 按 onDeck 走服务端)全在后端端口里,面板只发
 * `do`,绕开它去调 RPC 域就是把那些分档静默丢掉。
 *
 * ── 操作不许有两个意思(用户 09-17「容易使用,避免操作有二义性」)──────────
 *  · 暂停只有歌条上一颗钮;电台条上的「关台」是另一件事;唱臂没有「抬起」。
 *  · 唱臂只表示「跳到这里」,与进度条发同一条 `seek`;唱片只是显示,不接手势。
 *  · 换台在浮层里按「换台」才生效,预设只填框(换台会重排节目单)。
 *  · `close` 与 `radioStop` 合成一颗「关台」;⏮ ⏭ 的名字随电台变,说出后端真做的事。
 *  · ♥ 一次性;串联单的动作全在右键菜单(行尾「⋯」开同一张表),不做双击。
 *
 * ── 封面:**不画**,而这是一条判断不是一格没做完 ────────────────────────
 * 自述里 `nowPlaying` 没有封面这件事实,`title` 就是 CLI 交出来的展示串。唱片标签
 * 只印歌名,不画占位图:一张灰方块会被读成「封面还没加载出来」,而它永远不会来。
 *
 * ── DJ 语音**不在这块面上播**(M3 用户 09-17 拍板:改在主进程播)──────────
 * React 壳的 `voice: null`,`MUSIC_DJ_SPEAK` 在这台壳上是哑的;主进程自己出声(电台是后台
 * 常驻的,面板没开也该开口)。主持人是唱机上的黑豆(`music/TurntableScene.tsx`,正本
 * `docs/design/pet-system-2026-09.md` §8)。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 状态先行:三张状态表(施工纪律第一条;正本 §3 那三张的落地)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── ① 生命周期 ──────────────────────────────────────────────────────────
 *  · 挂载    —— `useMusicLive()`:订 `resource:event`(前缀 `music:`)+ 五条读数
 *                各 `ensure()` 一次(先订后拉);按当前宽定一栏 / 两栏;
 *                抽屉关着;歌词页不在;
 *  · 事件到达 —— 按 `music-source` 那张表标脏 → 后台补拉,**旧读数留在屏上**;
 *  · 播放钟  —— 读数之上按墙钟推位置(`usePlaybackPosition`,只在播放中每 250ms 一拍),
 *                唱臂、进度条、歌词高亮吃同一个数;
 *  · 宽度跨 900 —— 两栏 ↔ 一栏。变一栏时歌词**不**自动进歌词页(回到唱机);
 *                变两栏时若正停在歌词页则退回唱机,歌词改在右栏显示;
 *  · 开 / 关抽屉 —— 主界面不动、照常播;关掉时焦点**结构性地**回到那颗钮
 *                (归还在 `PlaylistDrawer` 的文件头);
 *  · 换歌    —— 抽屉开着不关;歌词页开着不退;
 *  · 电台关台 / 没歌 —— 歌词页退回唱机;抽屉留着(里面是空态);
 *  · 换宿主  —— 拖成浮窗 / 抬上舞台 / 进全屏不重挂;唱臂拖到一半换宿主,
 *                `PointerTrack` 的结束路径作废这一下;
 *  · 卸载    —— `closeMusicSource()` 退订;**抽屉与歌词页状态不落盘**
 *                (下次开面板从唱机开始)。
 *
 * ── ② UI 生命状态 ───────────────────────────────────────────────────────
 *  · 后端没配好 → **接入向导**占唱机那一块(`music/SetupWizard`,正本 §6;电台条、
 *    歌词栏、节目单抽屉这几步里都不画);后端整个读不到 → 顶上一句
 *    `music.backendNotReady`(向导不画:后端都不在,装什么都没用);
 *  · 后端报错 → 一句原话;
 *  · 首载 → 唱机场景照画(素面唱片),歌名与歌条不画;
 *  · 没歌 → 唱机空态,歌名位置一句「播放器没在跑」,歌条不画;
 *  · 电台关着 → 电台条换成开台卡;唱机屋里的灯暗一半,黑豆睡着;
 *  · 歌词读不到 → 歌词区一句「这首没有歌词」(≥900 右栏 / 歌词页同一句);
 *  · error → 旧内容留着,错误就地一行,零 Toast;
 *  · 超量 → 歌名过长单行截断;节目单封顶 `PROGRAMME_LIMIT` 行,抽屉内滚动。
 *
 * ── ③ UI 交互状态 ───────────────────────────────────────────────────────
 *  · rest / hover / focus 随库件(IconButton / Button / Slider / ButtonBase / Menu);
 *  · pending **逐格**:一只做法一只 mutation(律③);
 *  · disabled:没有总长 → 进度条与唱臂停用;没有音量读数 → 音量条停用;已收藏 → ♥ 停用;
 *  · active:拖进度条 / 拖唱臂(`data-sliding` / `data-dragging`);
 *    「播放列表」钮带 `aria-expanded`、「歌词」钮带 `aria-pressed`。
 *  唱机场景自己的三张表在 `music/TurntableScene.tsx` 文件头。
 */
export function MusicPanel({
  initialPlaylistOpen = false,
  initialView = 'turntable',
}: {
  /**
   * **只给实验台用的两格初始态**(`dev/MusicLab`:六档宽 ×「抽屉开 / 歌词页」要一开
   * 就能量)。产品里两处落点都不传 —— 缺省就是正本 §3.1 那一行「挂载:抽屉关着;
   * 歌词页不在」。它们是 `initial*` 不是受控属性:开合的主人自始至终是这块面。
   */
  initialPlaylistOpen?: boolean
  initialView?: 'turntable' | 'lyrics'
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
  const position = usePlaybackPosition(now.data)
  const form = useMusicPanelForm(panelRef)
  const [playlistOpen, setPlaylistOpen] = useState(initialPlaylistOpen)
  const [view, setView] = useState<'turntable' | 'lyrics'>(initialView)

  const state = runtime.data
  /*
   * **后端没配好 = 画向导,不是画一句话**(2026-09-18,正本 §6)。从前这里只有
   * 顶上一句「音乐后端还没配好」,而人得自己去命令行把事办了 —— 那句话等于把人
   * 挡在门外。
   *
   * 两档分得清楚:
   *  · `state` 读得到但没配好 → 向导占唱机那一块的位置,电台条与节目单**不画**
   *    (§6.3:这几步里它们没有任何可说的);
   *  · `state` 读不到(后端整个不在)→ 向导不画,顶上仍是今天那句话(§6.5 首行:
   *    后端都不在,装什么都没用)。首载那一瞬间两样都不画 —— 「还没问到」不是
   *    「问不到」。
   */
  const wizard = useSetupWizardVisible(state?.setupStage)
  const unreachable = state === undefined && (runtime.error !== undefined || runtime.phase === 'ready')
  const playing = now.data?.playing ?? false
  const title = now.data?.title
  const duration = now.data?.duration
  const hasSong = Boolean(title) || playing
  const { name, artist } = splitTitle(title)

  /*
   * 歌词页只在「一栏 + 有歌」两件同时成立时在场。两条退出规矩(§3.1)因此是**同一句
   * 判据的推论**,不是两条各自的 effect:变两栏 / 没歌了 → 它不在场 → 回唱机。
   * 状态里那格 `view` 仍然留着 'lyrics',是为了「两栏 → 一栏」时**不**自动进歌词页 ——
   * 所以退出那一下要真的写回 'turntable'。
   */
  const lyricsPage = view === 'lyrics' && !form.wide && hasSong
  useEffect(() => {
    if (view === 'lyrics' && (form.wide || !hasSong)) setView('turntable')
  }, [form.wide, hasSong, view])

  const seek = useCallback((seconds: number) => void musicOps.seek.run({ position: seconds }), [])
  const onLiked = useCallback(() => petRef.current?.love(), [])
  const backToTurntable = useCallback(() => setView('turntable'), [])
  const closePlaylist = useCallback(() => setPlaylistOpen(false), [])

  return (
    <FocusScope
      scope="music"
      rootRef={panelRef}
      /*
       * 落点 = 播放 / 暂停那颗钮。进这块面第一件想做的事就是让它响或者让它停。
       * Esc(§3.3 最后一行):**有抽屉先关抽屉** —— 那一格是这一格的孩子,比它深,
       * 由树的深度先问到,所以这里只管第二级「在歌词页就回唱机」;都没有就答 false,
       * 这一下继续往外传(不拦,输入法组字等后面的消费者照旧)。
       */
      restingTarget={() => playRef.current}
      onEscape={() => {
        if (!lyricsPage) return false
        setView('turntable')
        return true
      }}
    >
      {({ scopeProps }) => (
        <div {...scopeProps} className={s.panel} data-testid="music-panel">
          <div className={s.scroller}>
            <div className={s.layout} data-wide={form.wide ? 'true' : undefined}>
              <div className={s.notices}>
                {unreachable && (
                  <p className={s.notice} data-testid="music-not-ready">
                    {t('music.backendNotReady')}
                  </p>
                )}
                {state?.lastError && (
                  <p className={s.notice} data-testid="music-backend-error">
                    {t('music.backendError', { message: state.lastError })}
                  </p>
                )}
              </div>

              {!wizard && <StationStrip state={state} />}

              {/*
                * 唱机区:上半块是场景(或歌词页),下半块是歌名与歌条。
                * 场景铺满这一块的宽(画布按它缩放);两栏时它是左栏,比面板窄得多 ——
                * 场景自己量自己的宽。
                */}
              <section className={s.deck} data-testid="music-player">
                {wizard && state ? (
                  <SetupWizard state={state} />
                ) : lyricsPage ? (
                  <LyricsPane
                    mode="page"
                    position={position}
                    duration={duration}
                    title={title}
                    playing={playing}
                    onBack={backToTurntable}
                  />
                ) : (
                  <TurntableScene
                    runtime={state}
                    brief={brief.data}
                    nowPlaying={now.data}
                    nowError={now.error}
                    programme={programme.data}
                    position={position}
                    onSeek={seek}
                    petRef={petRef}
                  />
                )}
                {/*
                  * 向导在场时下半块整块**不画**(不是藏起来):歌名、歌条、播放列表钮
                  * 在这几步里都没有内容,而藏起来的话这块面的落点(播放钮)会落进一个
                  * 看不见的元素里 —— 焦点不许落在「没有东西」上(响应链不变量 I1)。
                  */}
                {!wizard && (
                  <div className={s.deckBody}>
                    {now.phase === 'ready' && !hasSong ? (
                      <p className={s.none}>{t('music.playerIdle')}</p>
                    ) : (
                      hasSong && (
                        <div className={s.nowText}>
                          <p className={s.nowTitle} data-testid="music-now-title">
                            {name || t('music.untitled')}
                          </p>
                          {artist && <p className={s.nowArtist}>{artist}</p>}
                        </div>
                      )
                    )}
                    {now.error && <p className={s.bad}>{now.error}</p>}
                    {!hasSong && (
                      <div className={s.idleKeys}>
                        <IdlePlayButton />
                        <PlaylistButton
                          open={playlistOpen}
                          onToggle={() => setPlaylistOpen((open) => !open)}
                          buttonRef={playlistRef}
                        />
                      </div>
                    )}
                    {hasSong && (
                      <Transport
                        title={title}
                        playing={playing}
                        position={position}
                        duration={duration}
                        playRef={playRef}
                        onLiked={onLiked}
                        lyricsOpen={lyricsPage}
                        onToggleLyrics={form.wide ? undefined : () => setView(lyricsPage ? 'turntable' : 'lyrics')}
                        playlistOpen={playlistOpen}
                        onTogglePlaylist={() => setPlaylistOpen((open) => !open)}
                        playlistRef={playlistRef}
                      />
                    )}
                  </div>
                )}
              </section>

              {!wizard && form.wide && hasSong && (
                <LyricsPane
                  mode="column"
                  position={position}
                  duration={duration}
                  title={title}
                  playing={playing}
                />
              )}
            </div>
          </div>

          {!wizard && playlistOpen && <PlaylistDrawer form={form.drawer} onClose={closePlaylist} />}
        </div>
      )}
    </FocusScope>
  )
}
