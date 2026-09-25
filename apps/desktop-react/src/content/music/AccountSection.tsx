import type { MusicPlayerBackend, MusicRuntimeState, MusicSetupStage } from '@shared/ipc/music'
import { useMutation } from '../../data/kernel'
import { musicSetupOp } from '../../data/music-source'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { useConfirm } from '../../ui/Dialog'
import { Segmented } from '../../ui/Segmented'
import { StatusDot } from '../../ui/StatusDot'
import type { StatusDotTone } from '../../ui/StatusDot'
import { MUSIC_DEFAULT_SECTION_ID } from './section-ids'
import { SetupWizard } from './SetupWizard'
import s from './MusicFrame.module.css'

/** 接入三步的名字与一句「这一步做什么」。顺序即后端 `setupStage` 的走法。 */
const STEPS: readonly { stage: Exclude<MusicSetupStage, 'ready'>; titleKey: MessageKey; bodyKey: MessageKey }[] = [
  { stage: 'env', titleKey: 'music.onboard.envTitle', bodyKey: 'music.onboard.envBody' },
  { stage: 'credentials', titleKey: 'music.onboard.credentialsTitle', bodyKey: 'music.onboard.credentialsBody' },
  { stage: 'login', titleKey: 'music.onboard.loginTitle', bodyKey: 'music.onboard.loginBody' },
]

type StepState = 'done' | 'current' | 'todo'

function stepStateOf(stage: MusicSetupStage, index: number): StepState {
  const at = stage === 'ready' ? STEPS.length : STEPS.findIndex((step) => step.stage === stage)
  return index < at ? 'done' : index === at ? 'current' : 'todo'
}

const STEP_TONE: Record<StepState, StatusDotTone> = { done: 'ok', current: 'info', todo: 'off' }
const STEP_LABEL: Record<StepState, MessageKey> = {
  done: 'music.onboard.stepDone',
  current: 'music.onboard.stepCurrent',
  todo: 'music.onboard.stepTodo',
}

/**
 * **「账号」那一格**(音乐面 v9,2026-09-25;正本 `docs/music-panel-2026-09.md` §10.3)。
 *
 * 用户那一条硬要求:「没登录引导用户登录」。没登录时面板**自动落到这一格**(`hostsSetup`),而且
 * 檐右端那颗钮写着「登录」;别的分区画登录引导卡、一颗钮带回这里。这一格自己分两半:
 *
 *  · 还没登上 —— 上面一张**三步清单**:每一步一个名字、一句「这一步做什么」、一枚状态点 + 文字
 *    (已完成 / 正在这一步 / 待办)—— 人一眼知道自己走到哪了、还剩什么;下面是接入向导本身
 *    (`SetupWizard`,一个字没改:走到哪一格由后端说,没有「下一步」钮);
 *  · 登上了   —— 账号卡(已登录 · 出声方式 · 退出登录)+ 一颗「去听歌」。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三张状态表
 * ══════════════════════════════════════════════════════════════════════════
 * ① 生命周期:不取数,读父级那份 `runtime`;`setupStage` 一变(后端发 `setupChanged`)这一格跟着换半边。
 * ② UI 生命状态:
 *    · 读不到 `runtime` —— 一句「连不上音乐服务」(顶上状态条带「重新连接」);
 *    · env / credentials / login —— 清单 + 向导;清单里当前那一步高亮;
 *    · ready    —— 账号卡;
 *    · 换出声方式失败 / 退出失败 —— 那一块下面一行原话。
 * ③ UI 交互状态:随库件;出声方式换的那一发在路上时分段器停用(逐格:只停它);
 *    退出登录先确认(整块面的后果,值一个模态框 —— 与 `AccountMenu` 同一条判据)。
 */
export function AccountSection({ runtime, navigate }: { runtime?: MusicRuntimeState; navigate: (id: string) => void }) {
  const t = useT()
  if (!runtime) {
    return (
      <div className={s.page} data-testid="music-section-account">
        <p className={s.hint}>{t('music.status.unreachableHint')}</p>
      </div>
    )
  }
  if (runtime.setupStage !== 'ready') {
    return (
      <div className={s.page} data-testid="music-section-account">
        <Card titleAs="h2" title={t('music.onboard.title')} note={t('music.onboard.lead')} notePlacement="below">
          <ol className={s.steps} data-testid="music-onboard-steps">
            {STEPS.map((step, index) => {
              const state = stepStateOf(runtime.setupStage, index)
              return (
                <li key={step.stage} className={s.step} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
                  <StatusDot tone={STEP_TONE[state]} size="sm" />
                  <span className={s.stepText}>
                    <span className={s.stepTitle}>{t('music.onboard.stepN', { n: index + 1, title: t(step.titleKey) })}</span>
                    <span className={s.stepBody}>{t(step.bodyKey)}</span>
                  </span>
                  <span className={s.stepState}>{t(STEP_LABEL[state])}</span>
                </li>
              )
            })}
          </ol>
        </Card>
        <SetupWizard state={runtime} withHeader={false} />
      </div>
    )
  }
  return <AccountReady runtime={runtime} navigate={navigate} />
}

function AccountReady({ runtime, navigate }: { runtime: MusicRuntimeState; navigate: (id: string) => void }) {
  const t = useT()
  const confirm = useConfirm()
  const setPlayer = useMutation(musicSetupOp('set-player'))
  const logout = useMutation(musicSetupOp('logout'))

  return (
    <div className={s.page} data-testid="music-section-account">
      <Card
        titleAs="h2"
        title={t('music.account.title')}
        actions={
          <Button variant="primary" data-testid="music-account-listen" onClick={() => navigate(MUSIC_DEFAULT_SECTION_ID)}>
            {t('music.account.listen')}
          </Button>
        }
      >
        <p className={s.stationLine}>
          <StatusDot tone="ok" size="sm" />
          <span>{t('music.account.signedIn')}</span>
        </p>
      </Card>

      <Card titleAs="h2" title={t('music.account.playerTitle')} note={t('music.account.playerHint')} notePlacement="below">
        <Segmented<MusicPlayerBackend>
          label={t('music.account.playerTitle')}
          value={runtime.playerBackend}
          disabled={setPlayer.pending}
          aria-busy={setPlayer.pending || undefined}
          data-testid="music-account-player"
          options={[
            { value: 'mpv', label: t('music.account.playHere') },
            { value: 'orpheus', label: t('music.account.playInApp') },
          ]}
          onChange={(player) => {
            if (player !== runtime.playerBackend) void musicSetupOp('set-player').run({ player })
          }}
        />
        {setPlayer.error ? <p className={s.bad}>{setPlayer.error}</p> : null}
      </Card>

      <Card
        titleAs="h2"
        title={t('music.account.logout')}
        note={t('music.account.logoutConfirmBody')}
        notePlacement="below"
        actions={
          <Button
            variant="danger"
            disabled={logout.pending}
            aria-busy={logout.pending || undefined}
            data-testid="music-account-logout"
            onClick={() => {
              void confirm({
                title: t('music.account.logoutConfirmTitle'),
                description: t('music.account.logoutConfirmBody'),
                confirmLabel: t('music.account.logout'),
              }).then((yes) => {
                if (yes) void musicSetupOp('logout').run({})
              })
            }}
          >
            {logout.pending ? t('common.working') : t('music.account.logout')}
          </Button>
        }
      >
        {logout.error ? <p className={s.bad}>{logout.error}</p> : null}
      </Card>
    </div>
  )
}
