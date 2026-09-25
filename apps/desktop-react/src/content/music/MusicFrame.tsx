import { useEffect, useRef } from 'react'
import type { MusicRuntimeState } from '@shared/ipc/music'
import { CircleAlert, Info, LogIn } from '../../components/icons'
import { refreshMusicSource, musicOps } from '../../data/music-source'
import { useMutation } from '../../data/kernel'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import { announce } from '../../ui/a11y/live-region'
import { Button } from '../../ui/Button'
import { Segmented } from '../../ui/Segmented'
import { Spinner } from '../../ui/Spinner'
import { StatusDot } from '../../ui/StatusDot'
import { AccountMenu } from './AccountMenu'
import { discStyle } from './ProgrammeSheet'
import type { MusicSectionSpec } from './sections'
import type { MusicStatus, MusicStatusAction } from './status'
import { splitTitle } from './turntable'
import s from './MusicFrame.module.css'
import panel from '../MusicPanel.module.css'

/**
 * **音乐面 v9 的外框四件**(2026-09-25;正本 `docs/music-panel-2026-09.md` §10)。
 *
 *  · `MusicHeader`  —— 檐:左边分区导航(读分区表),右边账号 —— 登上了是账号钮(`AccountMenu`),
 *                      没登上是一颗写着「登录」的主钮(登录引导的「显眼」那一半);
 *  · `StatusBanner` —— 分区上方一条状态条,**只在需要人注意时画**(连不上 / 出错 / 开台中 / DJ 在补 /
 *                      电台开着但播放器停了):一个图标、一句话、一句接下来怎么办、一颗钮;
 *  · `LoginGate`    —— 没登录时,需要登录的分区画它而不是空白:为什么、还差几步、一颗「去登录」;
 *  · `NowLine`      —— 播放条最上面一行:碟 · 歌名 · 歌手,右边状态丸(点 / 转圈 + 一句话)。
 *
 * 状态丸、状态条、读屏播报读的是**同一个** `MusicStatus`(`status.ts`),三处永远说同一句话。
 *
 * 三张状态表见各件头上。
 */

/* ── 檐 ────────────────────────────────────────────────────────────────── */

/**
 * ① 生命周期:无本地状态;分区是父级的一格。② 生命状态:导航恒在(没登录也在 —— 看得见这里有什么,
 * 点进去是登录引导);账号位两档(登上 / 没登上)。③ 交互:分段器随 `ui/Segmented`(roving、方向键);
 * 登录钮随 `ui/Button`。挤压:导航不截断、先让账号位的字(窄时「登录」钮只剩图标,Tooltip 走库件)。
 */
export function MusicHeader({
  sections,
  current,
  onNavigate,
  runtime,
  setupSection,
}: {
  sections: readonly MusicSectionSpec[]
  current: string
  onNavigate: (id: string) => void
  runtime?: MusicRuntimeState
  setupSection: string
}) {
  const t = useT()
  const ready = runtime?.setupStage === 'ready'
  const nav = sections.filter((row) => row.nav)
  // 此刻在导航之外的那一格(账号)时,分段器里没有哪一段是「选中」的 —— 给一个不在选项里的值,
  // 它就一段都不亮;roving 的 Tab 落点退回第一段(见 Segmented 的 tabIndex 规则)。
  return (
    <header className={s.header} data-testid="music-header">
      <nav className={s.nav} aria-label={t('music.navLabel')}>
        <Segmented<string>
          label={t('music.navLabel')}
          value={current}
          onChange={onNavigate}
          data-testid="music-nav"
          options={nav.map((row) => ({ value: row.id, label: t(row.labelKey) }))}
        />
      </nav>
      <span className={s.headerEnd}>
        {ready && runtime ? (
          <AccountMenu state={runtime} onOpenAccount={() => onNavigate(setupSection)} />
        ) : runtime ? (
          <Button
            variant="primary"
            aria-current={current === setupSection ? 'page' : undefined}
            data-testid="music-login"
            onClick={() => onNavigate(setupSection)}
          >
            <LogIn className={s.buttonIcon} aria-hidden="true" />
            <span className={s.loginLabel}>{t('music.login')}</span>
          </Button>
        ) : null}
      </span>
    </header>
  )
}

/* ── 状态条 ─────────────────────────────────────────────────────────────── */

/** 状态条那一句话:错话是原话(`vars.message`),其余按表里的名字。 */
function messageOf(t: ReturnType<typeof useT>, status: MusicStatus): string {
  if (status.kind === 'error') return status.vars.message ?? ''
  if (status.kind === 'unreachable') return t('music.backendNotReady')
  return t(status.row.labelKey, status.vars)
}

/** 旧壳门与测试认的取件口 —— 错话那一行与「连不上」那一行各是各的。 */
const MESSAGE_TESTID: Partial<Record<MusicStatus['kind'], string>> = {
  unreachable: 'music-not-ready',
  error: 'music-backend-error',
}

/**
 * 一颗动作钮。**按 `action.kind` 分发,不认状态名**(状态表是数据,这里只有三种动词)。
 */
function StatusActionButton({ action, onNavigate }: { action: MusicStatusAction; onNavigate: (id: string) => void }) {
  const t = useT()
  const resume = useMutation(musicOps.radioResume)
  if (action.kind === 'section') {
    return (
      <Button size="sm" data-testid="music-status-action" onClick={() => onNavigate(action.section)}>
        {t(action.labelKey)}
      </Button>
    )
  }
  if (action.kind === 'retry') {
    return (
      <Button size="sm" data-testid="music-status-action" onClick={refreshMusicSource}>
        {t(action.labelKey)}
      </Button>
    )
  }
  return (
    <Button
      size="sm"
      data-testid="music-status-action"
      disabled={resume.pending}
      aria-busy={resume.pending || undefined}
      onClick={() => void musicOps.radioResume.run({})}
    >
      {resume.pending ? t('common.working') : t(action.labelKey)}
    </Button>
  )
}

/**
 * ① 生命周期:状态一变就换字,**不重挂**(同一只节点,律④);状态换了 → `announce()` 播一句(读屏用户
 *    也知道「开台了」「连不上了」),首载那一拍不播(那不是变化)。
 * ② 生命状态:`row.banner` 为假时整条不画(不留空行);在忙的那几档是转圈(状态栏是 Spinner 的合法住处),
 *    坏消息是警示图标,其余是信息图标 —— **状态色只上图标**,底色不换。
 * ③ 交互:只有那一颗动作钮,随 `ui/Button`。
 */
export function StatusBanner({ status, onNavigate }: { status: MusicStatus; onNavigate: (id: string) => void }) {
  const t = useT()
  const { row } = status
  if (!row.banner) return null
  const bad = row.tone === 'bad'
  const message = messageOf(t, status)
  return (
    // ui-consume-allow: spinner-placement — 这一条**就是**状态栏(壳规里 Spinner 的合法住处之一)。
    <div className={s.banner} data-tone={row.tone} role={bad ? 'alert' : 'status'} data-testid="music-status-banner" data-kind={status.kind}>
      {row.ongoing ? (
        <Spinner />
      ) : bad ? (
        <CircleAlert className={s.bannerIcon} aria-hidden="true" />
      ) : (
        <Info className={s.bannerIcon} aria-hidden="true" />
      )}
      <span className={s.bannerText}>
        <p className={s.bannerMessage} data-testid={MESSAGE_TESTID[status.kind]}>
          {message}
        </p>
        {row.hintKey ? <p className={s.bannerHint}>{t(row.hintKey)}</p> : null}
      </span>
      {row.action ? <StatusActionButton action={row.action} onNavigate={onNavigate} /> : null}
    </div>
  )
}

/** 状态换了就播一句。首载那一拍不播;同一种状态不重播。 */
export function useStatusAnnouncer(status: MusicStatus): void {
  const t = useT()
  const last = useRef<string | null>(null)
  const text = status.kind === 'error' ? t('music.status.error') : t(status.row.labelKey, status.vars)
  useEffect(() => {
    const previous = last.current
    last.current = status.kind
    if (previous === null || previous === status.kind) return
    if (status.kind === 'connecting') return
    announce(text, { level: status.row.tone === 'bad' ? 'assertive' : 'polite' })
  }, [status.kind, status.row.tone, text])
}

/* ── 登录引导卡 ─────────────────────────────────────────────────────────── */

const STAGE_STEP: Record<string, { n: number; key: MessageKey }> = {
  env: { n: 1, key: 'music.onboard.envTitle' },
  credentials: { n: 2, key: 'music.onboard.credentialsTitle' },
  login: { n: 3, key: 'music.onboard.loginTitle' },
}

/**
 * ① 生命周期:无状态。② 生命状态:恒为「还没登上」这一档(登上了父级就不画它);当前一步跟着
 * `setupStage` 走。③ 交互:一颗主钮「去登录」,随 `ui/Button`。
 */
export function LoginGate({
  runtime,
  sectionLabel,
  onLogin,
}: {
  runtime: MusicRuntimeState
  sectionLabel: string
  onLogin: () => void
}) {
  const t = useT()
  const step = STAGE_STEP[runtime.setupStage]
  return (
    <div className={s.gate} data-testid="music-login-gate">
      <LogIn className={s.gateIcon} aria-hidden="true" />
      <h2 className={s.gateTitle}>{t('music.gate.title')}</h2>
      <p className={s.gateBody}>{t('music.gate.body', { section: sectionLabel })}</p>
      {step ? <p className={s.hint}>{t('music.gate.step', { n: step.n, total: 3, title: t(step.key) })}</p> : null}
      <Button variant="primary" data-testid="music-gate-login" onClick={onLogin}>
        {t(runtime.setupStage === 'login' ? 'music.status.goLogin' : 'music.status.goSetup')}
      </Button>
    </div>
  )
}

/* ── 播放条的第一行 ───────────────────────────────────────────────────────── */

/**
 * ① 生命周期:无状态;同一只节点跟着读数换字。② 生命状态:有歌 → 碟 · 歌名 · 歌手;没歌 → 一句「没在放」
 *    + 状态表里那句指引(「去电台选个心情」之类)与它的钮;右边状态丸恒在(点 / 转圈 + 一句话)。
 *    超量:歌名、歌手各自单行截断,歌名先让(与节目单同一条)。③ 交互:只有指引那一颗钮。
 */
export function NowLine({
  title,
  status,
  onNavigate,
}: {
  title?: string
  status: MusicStatus
  onNavigate: (id: string) => void
}) {
  const t = useT()
  const { name, artist } = splitTitle(title)
  const { row } = status
  // 没歌时那颗指引钮:只接「去哪一格」这一种 —— 「接着放」是 ⏯ 自己的事,这里再放一颗就是两个入口说一件事。
  const guide = !name && !row.banner && row.action?.kind === 'section' ? row.action : undefined
  return (
    <div className={s.nowLine} data-testid="music-now-line">
      {name ? (
        <>
          <span className={panel.disc} style={discStyle(title)} aria-hidden="true" />
          <span className={s.nowText}>
            <span className={s.nowName}>{name}</span>
            {artist ? <span className={s.nowArtist}>{artist}</span> : null}
          </span>
        </>
      ) : (
        <span className={s.nowText}>
          <span className={s.nowIdle}>{t('music.nowIdle')}</span>
          {row.hintKey && !row.banner ? <span className={s.nowArtist}>{t(row.hintKey)}</span> : null}
        </span>
      )}
      {guide ? <StatusActionButton action={guide} onNavigate={onNavigate} /> : null}
      {/* ui-consume-allow: spinner-placement — 状态丸是播放条上的状态栏:在忙的那几档说「在忙」。 */}
      <span className={s.state} data-tone={row.tone} data-testid="music-status-pill" data-kind={status.kind}>
        {row.ongoing ? <Spinner /> : <StatusDot tone={row.tone} size="sm" />}
        <span className={s.stateLabel}>{t(row.labelKey, status.vars)}</span>
      </span>
    </div>
  )
}
