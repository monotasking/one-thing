import { useCallback, useRef } from 'react'
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
import { ProgrammeSheet } from './music/ProgrammeSheet'
import { StationStrip } from './music/StationStrip'
import { Transport } from './music/Transport'
import { TurntableScene } from './music/TurntableScene'
import { splitTitle } from './music/turntable'
import { usePlaybackPosition } from './music/usePlaybackPosition'
import s from './MusicPanel.module.css'

/**
 * **音乐面 · 唱机形**(唱机音乐面 M1,2026-09-17;前身是「音乐收尾 · 壳半边」
 * 09-10 的三块竖摞)。方案页 artifact「唱机音乐面」,拍板记在记忆
 * `music-turntable-2026-09`。
 *
 * ── 一句话:这块面上每一颗按钮走的都是 `resources.do` ────────────────────
 * 与模型调 `music:player` / `music:radio` 的那只工具是**同一条**路。所有分档(电台开着时
 * `next` 走跳过、`prev` 走重播、`like` 按 onDeck 走服务端)全在后端端口里,面板只发
 * `do`,绕开它去调 RPC 域就是把那些分档静默丢掉。
 *
 * ── 操作不许有两个意思(用户 09-17「容易使用,避免操作有二义性」)──────────
 *  · 暂停只有控制条上一颗钮;电台条上的「关台」是另一件事;唱臂没有「抬起」。
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
 * 常驻的,面板没开也该开口)—— 宠物 P3 起宿主表 `speechOutput` 那一格在主进程里起 mpv / afplay
 * 放口播(`electron/speech-output.ts`),所以这里不订语音、不放音频。
 * 主持人从宠物 P1 起是唱机上的黑豆(`music/TurntableScene.tsx`,正本
 * `docs/design/pet-system-2026-09.md` §8):换歌时的那句口播是它的一个气泡,
 * 挑歌 / 关台 / 出错由它的姿势演,面上不再有「主持人一行」那句说明。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 状态先行:三张状态表(施工纪律第一条)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── ① 生命周期 ──────────────────────────────────────────────────────────
 *  · 挂载    —— `useMusicLive()`:订 `resource:event`(前缀 `music:`)+ 五条读数
 *                各 `ensure()` 一次。先订后拉;
 *  · 事件到达 —— 按 `music-source` 那张表标脏 → 后台补拉,**旧读数留在屏上**;
 *  · 播放钟  —— 读数之上按墙钟推位置(`usePlaybackPosition`,只在播放中每 250ms 一拍),
 *                唱臂、进度条、歌词高亮吃同一个数;
 *  · 换宿主  —— 拖成浮窗 / 抬上舞台 / 进全屏不重挂;形随**面板自己的宽**变
 *                (`@container music` 三档,见样式表文件头)。唱臂拖到一半换宿主,
 *                `PointerTrack` 的结束路径作废这一下;
 *  · 卸载    —— `closeMusicSource()` 退订,读数留在格子里。
 *
 * ── ② UI 生命状态 ───────────────────────────────────────────────────────
 *  · 后端没配好 → 顶上一句 `music.backendNotReady`;后端报错 → 一句原话;
 *  · 播放器没在跑 → 唱片收在素面封套里、唱臂归位 + `music.playerIdle`;
 *  · 电台关着 → 电台条换成开台卡,串联单不画;唱机屋里的灯暗一半,黑豆睡着;
 *  · 首载 → 各块身子不画(不画骨架:内容只有几行字,骨架比内容还吵);
 *  · error → 旧内容留着,错误就地一行,零 Toast;
 *  · 超量 → 串联单封顶 `PROGRAMME_LIMIT` 行 + 文字读数,两张长表各自有最大高度。
 *
 * ── ③ UI 交互状态 ───────────────────────────────────────────────────────
 *  · rest / hover / focus 随库件(IconButton / Button / Slider / ButtonBase / Menu);
 *  · pending **逐格**:一只做法一只 mutation(律③);
 *  · disabled:没有总长 → 进度条与唱臂停用(换歌那一串跑着时唱臂也停用);没有音量读数 →
 *    音量条停用;已收藏 → ♥ 停用;
 *  · active:拖进度条 / 拖唱臂(`data-sliding` / `data-dragging`)。
 *  唱机场景自己的三张表在 `music/TurntableScene.tsx` 文件头。
 */
export function MusicPanel() {
  const t = useT()
  useMusicLive()
  const runtime = useQuery(musicRuntimeQuery)
  const now = useQuery(musicNowPlayingQuery)
  const brief = useQuery(musicBriefQuery)
  const programme = useQuery(musicProgrammeQuery)
  const playRef = useRef<HTMLButtonElement | null>(null)
  const petRef = useRef<PetStageHandle | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const position = usePlaybackPosition(now.data)

  const state = runtime.data
  const notReady = state !== undefined && state.setupStage !== 'ready'
  const playing = now.data?.playing ?? false
  const title = now.data?.title
  const duration = now.data?.duration
  const hasSong = Boolean(title) || playing
  const { name, artist } = splitTitle(title)

  const seek = useCallback((seconds: number) => void musicOps.seek.run({ position: seconds }), [])
  const onLiked = useCallback(() => petRef.current?.love(), [])

  return (
    <FocusScope
      scope="music"
      rootRef={panelRef}
      /*
       * 落点 = 播放 / 暂停那颗钮。进这块面第一件想做的事就是让它响或者让它停。
       * Esc **不声明** —— 判词在 `focus/scopes.ts` 那一行上。
       */
      restingTarget={() => playRef.current}
    >
      {({ scopeProps }) => (
        <div {...scopeProps} className={s.panel} data-testid="music-panel">
          <div className={s.layout}>
            <div className={s.notices}>
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
            </div>

            <StationStrip />

            {/*
              * 唱机区:场景铺满这一块的宽(画布按它缩放),歌名与控制条摆在场景下面。
              * 舞台两栏时它是左栏,比面板窄得多 —— 场景自己量自己的宽。
              */}
            <section className={s.deck} data-testid="music-player">
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
                {hasSong && (
                  <Transport
                    title={title}
                    playing={playing}
                    position={position}
                    duration={duration}
                    playRef={playRef}
                    onLiked={onLiked}
                  />
                )}
              </div>
            </section>

            <ProgrammeSheet />
            <LyricsPane position={position} hasSong={hasSong} />
          </div>
        </div>
      )}
    </FocusScope>
  )
}
