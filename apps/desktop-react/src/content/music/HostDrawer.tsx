import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { MusicHostLogRow, MusicRadioState, MusicRuntimeState } from '@shared/ipc/music'
import type { AsyncSource } from '../../data/kernel'
import { useQuery } from '../../data/kernel'
import { musicHostLogQuery, useMusicHostLog } from '../../data/music-source'
import type { MusicNowPlayingView } from '../../data/music-source'
import { useCurrentPetId, usePetRosterRig } from '../../data/pet-source'
import { useT } from '../../i18n'
import { findBuiltinPet } from '../../pets/builtin'
import { PetRigView } from '../../pets/rigs/PetRigView'
import { AsyncButton } from '../../ui/AsyncButton'
import { Button } from '../../ui/Button'
import { ButtonBase } from '../../ui/ButtonBase'
import { Card } from '../../ui/Card'
import { Dots } from '../../ui/Dots'
import { Drawer } from '../../ui/Drawer'
import { FrameCoalescer } from '../../ui/frame-coalescer'
import { Input } from '../../ui/Input'
import { StatusDot } from '../../ui/StatusDot'
import { AT_BOTTOM_EPS } from '../follow'
import { deriveHostStatus, hostStatusText } from './host-status'
import s from './HostDrawer.module.css'

/**
 * **主持人抽屉**(主持人抽屉 H2,2026-09-27;正本 `docs/music-panel-2026-09.md` §16)。
 *
 * 点黑豆拉开它:他的记录流、他此刻在干嘛、和跟他说话的输入框。工作台一格都不开 —— 黑豆的会话只
 * 属于音乐页(§15 / §16.1)。骨架是 `ui/Drawer`(与播放列表同一副,同一时刻只开一只,父级管)。
 *
 * 从上到下三段,**每一段任何状态下高度固定**(§10 行高律):
 *  1. 檐 —— 小头像 + 名字 + 状态牌(`host-status.ts`,与唱机里黑豆头顶那块同一句)+ ✕;
 *  2. 记录流 —— 后端翻好的人话行(翻译住后端,壳不认识 ncm-cli),四种:你说的 / 叫他干活的 /
 *     他说的 / 找歌卡;最新在底,贴底跟随(离底了不跟);抽屉底下升起那一档也定高(`fill`);
 *  3. 输入框 —— 面板那一份 `talk`(受控,开着时 `tell`、关着时 = 开台意图),错话那一行没错话时
 *     也占着。
 *
 * ── 三张状态表(§16.4)──────────────────────────────────────────────────
 * ① 生命周期:随开随挂、关即卸;挂上那一刻 `useMusicHostLog` 问一次记录流(手上有旧的也重问,
 *    旧行留在屏上),`hostSessionId` 换了再标脏;面板换宿主抽屉跟着面板走;开时焦点进输入框
 *    (`restingTarget`),关时焦点结构性地回到黑豆那颗钮(树的 `returnTo`,这里没有一句 focus)。
 * ② UI 生命状态:
 *    | 态 | 檐 | 记录流 | 输入框 |
 *    | 没接入 / 没登录 | 睡着 | 一句「先在「账号」里接入网易云」+ 去账号 | 停用 |
 *    | 关台、没聊过 | 睡着 | 「还没聊过。…」 | 占位「想听什么?」 |
 *    | 关台、聊过 | 睡着 | 旧记录照摆 | 同上 |
 *    | 开台、在干活 | 后端那一句 / 在挑歌 | 底部一行那一句 + 三个点,随 `doing` 变 | 占位「和黑豆说点什么」 |
 *    | 在放 | 在放 | 静止 | 同上 |
 *    | 首载 | (照算)| 骨架三行(只 `phase === 'initial'` 画)| 发送键停用直到读到 |
 *    | 读失败 | 出错了(开台时)| 一行原话 + 重试;手上有旧行照摆 | 照常 |
 *    | 超量 | — | 只摆后端交来的尾部,`truncated` 时顶上一行灰字;单行正文超 6 行折,点展开 | — |
 * ③ UI 交互状态:行只读(rest 一态;找歌卡上的歌名是纯文字,点选留账 §16.5 H3);「展开 / 收起」随
 *    `ButtonBase` + 本地皮;输入框 rest / focus / pending(发送键停用、字照打)/ error(那一行原话);
 *    ✕ / Esc / 遮罩关。
 */

/** 说话那一格:面板那一份 `talk` 的受控投影(发送的分档 —— tell / 开台 —— 归面板)。 */
export interface HostDrawerTalk {
  value: string
  onChange: (next: string) => void
  onSend: () => void
  /** 这一发走哪一只 mutation(开台时 `tell`,关台时 `open`):发送键的 pending 读它。 */
  action: AsyncSource
  /** 后端那句错话(不发明文案)。 */
  error?: string
  /** 你刚说的那一句(回执,`useHostTalk().echo`);记录流里还没这一行时垫在底下。 */
  echo: string | null
}

export interface HostDrawerProps {
  form: 'side' | 'sheet'
  onClose: () => void
  runtime?: MusicRuntimeState
  brief?: MusicRadioState
  nowPlaying?: MusicNowPlayingView
  talk: HostDrawerTalk
  /** 没接入时那颗「去账号」:父级带去账号那一格(并关掉抽屉)。 */
  onGoSetup: () => void
}

const DEFAULT_PET = findBuiltinPet('heidou')

export function HostDrawer({ form, onClose, runtime, brief, nowPlaying, talk, onGoSetup }: HostDrawerProps) {
  const t = useT()
  useMusicHostLog(brief?.hostSessionId)
  const log = useQuery(musicHostLogQuery)
  const petId = useCurrentPetId()
  const pet = (petId !== undefined ? findBuiltinPet(petId) : undefined) ?? DEFAULT_PET
  const rosterRig = usePetRosterRig(pet?.id)
  const name = pet ? t(pet.name) : ''

  const ready = runtime?.setupStage === 'ready'
  const radioOn = brief?.active === true
  const rows = log.data?.rows ?? []
  const firstLoad = log.phase === 'initial' && log.data === undefined && log.error === undefined
  const status = deriveHostStatus({ runtime, brief, nowPlaying, logFailed: log.error !== undefined && log.data === undefined })
  const host = brief?.host
  const working = radioOn && (host?.working ?? brief?.djWorking === true)
  const liveLabel = working ? (host?.doing?.label ?? t('music.host.picking')) : undefined
  // 回执:记录流里最后一条「你说的」还不是这一句,才垫在底下(后端那一行到了就撤,不重复)。
  const lastYou = [...rows].reverse().find((row) => row.kind === 'you')
  const echo = ready && talk.echo && (lastYou?.kind !== 'you' || lastYou.text !== talk.echo) ? talk.echo : null

  const bodyRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  useFollowBottom(bodyRef, `${log.dataRev}:${liveLabel ?? ''}:${echo ?? ''}`)

  const inputDisabled = !ready
  const sendDisabled = inputDisabled || firstLoad || !talk.value.trim()

  return (
    <Drawer
      form={form}
      fill
      title={name}
      label={t('music.host.label', { name })}
      onClose={onClose}
      testId="music-host"
      bodyRef={bodyRef}
      restingTarget={() => (inputDisabled ? null : inputRef.current)}
      lead={
        <span className={s.avatar}>
          <PetRigView rig={rosterRig ?? pet?.rig} pose="sitting" mouth="closed" />
        </span>
      }
      subtitle={<span data-testid="music-host-status-drawer">{hostStatusText(status, t)}</span>}
      footer={
        <>
          <form
            className={s.talk}
            onSubmit={(e) => {
              e.preventDefault()
              if (sendDisabled) return
              talk.onSend()
            }}
          >
            <Input
              ref={inputRef}
              value={talk.value}
              onValueChange={talk.onChange}
              placeholder={t(radioOn ? 'music.deckTalkOn' : 'music.deckTalkOff')}
              aria-label={t(radioOn ? 'music.deckTalkOn' : 'music.deckTalkOff')}
              disabled={inputDisabled}
              data-testid="music-host-input"
            />
            <AsyncButton type="submit" variant="primary" action={talk.action} pendingLabel={t('common.working')} disabled={sendDisabled} data-testid="music-host-send">
              {t('music.petSend')}
            </AsyncButton>
          </form>
          {/* 没错话时也占着这一行:底栏高度任何状态下不变。 */}
          <p className={s.talkError} role="status" data-testid="music-host-talk-error">
            {talk.error ?? ''}
          </p>
        </>
      }
    >
      <div
        className={s.log}
        role="log"
        aria-label={t('music.host.log', { name })}
        aria-busy={firstLoad || undefined}
        data-testid="music-host-log"
      >
        {!ready ? (
          <div className={s.setup}>
            <p className={s.quiet}>{t('music.host.setup')}</p>
            <Button size="sm" onClick={onGoSetup} data-testid="music-host-go-setup">
              {t('music.host.goAccount')}
            </Button>
          </div>
        ) : firstLoad ? (
          <div aria-hidden="true" data-testid="music-host-skeleton">
            <div className={s.skel} />
            <div className={s.skel} />
            <div className={s.skel} />
          </div>
        ) : (
          <>
            {log.error !== undefined ? (
              <div className={s.failed} data-testid="music-host-log-error">
                <span className={s.failedText}>{log.error}</span>
                <AsyncButton size="sm" action={musicHostLogQuery} pendingLabel={t('common.working')} onClick={() => void musicHostLogQuery.refetch()} data-testid="music-host-log-retry">
                  {t('music.status.retry')}
                </AsyncButton>
              </div>
            ) : null}
            {log.data?.truncated ? (
              <p className={s.quiet} data-testid="music-host-truncated">
                {t('music.host.truncated')}
              </p>
            ) : null}
            {log.data !== undefined && rows.length === 0 && !echo && !liveLabel ? (
              <p className={s.quiet} data-testid="music-host-empty">
                {t('music.host.empty')}
              </p>
            ) : null}
            {rows.map((row) => (
              <HostRow key={row.id} row={row} />
            ))}
            {echo ? (
              <div className={s.you} data-kind="you" data-pending="true" data-testid="music-host-echo">
                <ClampText className={s.bubble} text={echo} />
              </div>
            ) : null}
            {liveLabel ? (
              <div className={s.live} data-testid="music-host-live">
                <span className={s.liveText}>{liveLabel}</span>
                <Dots />
              </div>
            ) : null}
          </>
        )}
      </div>
    </Drawer>
  )
}

/** 记录流里的一行。四种形,只读。 */
function HostRow({ row }: { row: MusicHostLogRow }) {
  const t = useT()
  switch (row.kind) {
    case 'you':
      return (
        <div className={s.you} data-kind="you" data-testid="music-host-row">
          <ClampText className={s.bubble} text={row.text} />
        </div>
      )
    case 'nudge':
      // 叫他干活的机器话:正文不上屏,只有后端给的那一句短标签(§16.2)。
      return (
        <p className={s.nudge} data-kind="nudge" data-testid="music-host-row">
          {row.text}
        </p>
      )
    case 'host':
      return (
        <div className={s.host} data-kind="host" data-testid="music-host-row">
          <ClampText className={s.say} text={row.text} />
        </div>
      )
    case 'card':
      return (
        <Card className={s.tool} data-kind="card" data-failed={row.failed ? 'true' : undefined} data-testid="music-host-row">
          <p className={s.toolLabel}>
            {row.failed ? <StatusDot tone="bad" size="sm" label={t('music.host.failed')} /> : null}
            <span className={s.toolVerb}>{row.label}</span>
          </p>
          {row.detail ? <p className={s.toolDetail}>{row.detail}</p> : null}
          {row.songs?.length ? (
            <p className={s.songs}>
              {row.songs.map((song, i) => (
                // 同一张卡里同名的歌可能出现两次(两个版本),键带上位置。
                <span key={`${i}:${song}`} className={s.song}>
                  {song}
                </span>
              ))}
            </p>
          ) : null}
        </Card>
      )
  }
}

/**
 * 一段可能很长的正文:超过 `--music-host-clamp` 行就折起来,行内一颗「展开」(§16.4 超量)。
 * 折没折由**量**说(折起来那一刻内容比盒子高),不由字数猜;RO 回调只排帧,下一帧读完再写。
 */
function ClampText({ text, className }: { text: string; className: string }) {
  const t = useT()
  const ref = useRef<HTMLParagraphElement | null>(null)
  const [open, setOpen] = useState(false)
  const [over, setOver] = useState(false)
  const measure = useCallback(() => {
    const el = ref.current
    // 展开着的时候不量:那时盒子就是内容的高,量出来恒为「没超」,「收起」会自己消失。
    if (!el || open) return
    setOver(el.scrollHeight - el.clientHeight > AT_BOTTOM_EPS)
  }, [open])
  useLayoutEffect(() => {
    measure()
  }, [measure, text])
  useEffect(() => {
    const el = ref.current
    if (typeof ResizeObserver !== 'function' || !el) return
    const frame = new FrameCoalescer(measure)
    const ro = new ResizeObserver(() => frame.schedule())
    ro.observe(el)
    return () => {
      ro.disconnect()
      frame.cancel()
    }
  }, [measure])
  return (
    <div className={className}>
      <p ref={ref} className={s.text} data-clamped={open ? undefined : 'true'}>
        {text}
      </p>
      {over ? (
        <ButtonBase className={s.more} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {t(open ? 'block.collapse' : 'block.expand')}
        </ButtonBase>
      ) : null}
    </div>
  )
}

/**
 * 贴底跟随(与消息列表同律,判据 `content/follow.ts` 的 `AT_BOTTOM_EPS`):**更新之前**人在底上,
 * 更新之后就落到底;人离了底,内容怎么长都不动他。「在不在底」只看滚动停下的位置,没有「这一下
 * 是不是我滚的」标志位(理由在 `follow.ts` 文件头)。首次有内容时视为在底。
 */
function useFollowBottom(ref: RefObject<HTMLElement | null>, rev: string): void {
  const atBottom = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      atBottom.current = el.scrollHeight - el.clientHeight - el.scrollTop <= AT_BOTTOM_EPS
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [ref])
  useLayoutEffect(() => {
    const el = ref.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [ref, rev])
}
