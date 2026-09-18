import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MusicRuntimeState, MusicSetupStage } from '@shared/ipc/music'
import { AsyncButton } from '../../ui/AsyncButton'
import { Button } from '../../ui/Button'
import { Field, useFieldControlProps } from '../../ui/Field'
import { Input } from '../../ui/Input'
import { SecretInput } from '../../ui/SecretInput'
import { useMutation } from '../../data/kernel'
import { musicSetupOp } from '../../data/music-source'
import { useInstallLog } from '../../data/music-setup-log'
import { COPY_FEEDBACK_MS, MUSIC_LOGIN_POLL_MS, MUSIC_SETUP_DONE_MS } from '../../components/motion'
import { announce } from '../../ui/a11y/live-region'
import { copyText } from '../../services/clipboard'
import { openBrowser } from '../browser-launcher'
import { useT } from '../../i18n'
import type { TFn } from '../../i18n'
import { QrCode } from './QrCode'
import s from '../MusicPanel.module.css'

/**
 * **接入向导**(2026-09-18;正本 `apps/desktop-react/docs/music-panel-2026-09.md` §6)。
 *
 * 在它之前,这块面在后端没配好时只有顶上一句「音乐后端还没配好」——人得自己去命令行
 * 装 `ncm-cli`、自己登录。那句话等于把人挡在门外。
 *
 * ── 三步,而且**没有「下一步」钮**(§6.3 末行)────────────────────────────
 * 停在哪一格由**后端**说(`state.setupStage`),屏上就画哪一格。这不是省一颗钮:
 * 一颗「下一步」意味着屏幕自己记着走到哪了,而那份记号迟早与后端的判断分家 ——
 * 装好了 CLI 却因为没点「下一步」被困在第一步,或者反过来,凭据没写成却站在了
 * 登录页上。装好并登录之后 `setupStage` 变 `ready`,整块向导消失,唱机出现。
 *
 * ── 每一格自己的忙态与自己的错话 ─────────────────────────────────────────
 * 八个动作各是一只 mutation(`musicSetupOp(action, tool?)`,判词在 `music-source`):
 * 装 `ncm-cli` 的时候 `mpv` 那一行不跟着转圈,`ncm-cli` 的失败也不会抄到它那一行上。
 *
 * ── 私钥 ────────────────────────────────────────────────────────────────
 * 它只从这格输入框走到 `setup { action: 'set-credentials' }` 那一发里,**不回显、
 * 不落盘、不进任何日志**;后端那一侧它也只到 CLI 自己的加密配置里为止。保存成功之后
 * 这一步就不在场了(`setupStage` 往前走),所以连「清空输入框」都不必写 —— 组件跟着
 * 一起卸载。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 状态先行:三张表(施工纪律第一条)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── ① 生命周期 ──────────────────────────────────────────────────────────
 *  · 挂载       —— 按 `setupStage` 画那一格;`env` 还没查过就**自己去查一次**
 *                  (那份读数没有别的产地,不查它第一步永远是占位);
 *  · 事实到达   —— 后端每走完一步发一条 `setupChanged`,`state` 重拉,这块面跟着换格;
 *  · 等人扫码   —— `login.status === 'waiting'` 期间每 2.5s 问一次「登上了没」;
 *                  离开这个状态(成了 / 取消 / 失败)或者**卸载**当场停;
 *  · 换宿主     —— 拼贴树的结构共享保证不重挂,所以轮询不断、输入框里的字还在;
 *  · 卸载       —— 计时器清干净;安装输出留在 `music-setup-log` 那一格小账上
 *                  (再开面板时那次安装若还在跑,输出接着铺)。
 *
 * ── ② UI 生命状态(§6.5 那张表)──────────────────────────────────────────
 *  · 读不到 `state` —— 这块面**根本不挂**(判在 `MusicPanel`:后端整个不在,装什么都没用);
 *  · `env` 还没查  —— 两行工具各一条占位,「安装」钮停用;
 *  · 安装中        —— 那一行的钮转圈 + 就地展开输出块;失败 → 输出块留着 + 一行错话,
 *                     钮变「重试」;
 *  · 写凭据中      —— 「保存」转圈;失败 → 就地一行错话,**输入不清空**;
 *  · 登录 starting —— 「开始登录」转圈;`waiting` → 码 + 地址 + 两颗钮 + 「取消」;
 *                     `failed` / `quota` → 一行原话 + 「再试一次」;
 *  · `ready`(留屏那 1.5 秒)—— 一句「进电台了」。
 *
 * ── ③ UI 交互状态 ───────────────────────────────────────────────────────
 *  · rest / hover / focus 随库件(Button / AsyncButton / Input / SecretInput / Field);
 *  · pending 逐格(见上);disabled:`env` 未知时装钮停用、凭据两格没填满时保存停用;
 *  · 二维码不是控件 —— 不可聚焦、不响应指针(判词在 `QrCode.tsx`)。
 */

/** 向导此刻画哪一格。`ready` 只在留屏那 1.5 秒里出现。 */
type WizardStep = MusicSetupStage

/**
 * **这块面此刻在不在场**(§6.5 末行:`ok` 之后「一句『进电台了』,1.5s 后自然消失」)。
 *
 * 它存在的理由是**后端那一步走得比眼睛快**:`login --check` 答成的同一发里
 * `setupStage` 就变成了 `ready`,不按一下的话人只看见界面闪了一下。所以这一格是
 * 读认窗口,不是动画 —— 它按住的是一个**已经发生**的事实,而不是延后了那件事。
 *
 * 只有「从别的格走到 ready」才按;一开始就 ready(后端本来就配好了)一帧都不按。
 */
export function useSetupWizardVisible(stage: MusicSetupStage | undefined): boolean {
  const [holding, setHolding] = useState(false)
  const previous = useRef(stage)
  useEffect(() => {
    const was = previous.current
    previous.current = stage
    if (!(was !== undefined && was !== 'ready' && stage === 'ready')) return undefined
    setHolding(true)
    const timer = setTimeout(() => setHolding(false), MUSIC_SETUP_DONE_MS)
    return () => clearTimeout(timer)
  }, [stage])
  if (stage === undefined) return false
  return stage !== 'ready' || holding
}

export function SetupWizard({ state }: { state: MusicRuntimeState }) {
  const t = useT()
  const step: WizardStep = state.setupStage
  return (
    <section className={s.wizard} data-testid="music-setup" data-step={step}>
      <header className={s.wizardHead}>
        <h2 className={s.wizardTitle}>{t('music.setup.title')}</h2>
        <Steps step={step} />
      </header>
      {step === 'env' && <EnvStep t={t} state={state} />}
      {step === 'credentials' && <CredentialsStep t={t} />}
      {step === 'login' && <LoginStep t={t} state={state} />}
      {step === 'ready' && (
        <p className={s.wizardDone} data-testid="music-setup-done">
          {t('music.setup.done')}
        </p>
      )}
    </section>
  )
}

const ORDER: readonly MusicSetupStage[] = ['env', 'credentials', 'login']

/**
 * 三格进度记号。**不是控件**(点不动:走到哪一格由后端说),所以 `aria-hidden` ——
 * 「第几步」这句话由每一步自己的标题说给读屏软件听,一排读不出名字的方块念出来
 * 只是噪音。
 */
function Steps({ step }: { step: MusicSetupStage }) {
  const at = ORDER.indexOf(step)
  return (
    <div className={s.wizardSteps} aria-hidden="true">
      {ORDER.map((id, index) => (
        <i
          key={id}
          className={s.wizardStep}
          data-state={at < 0 || index < at ? 'done' : index === at ? 'on' : undefined}
        />
      ))}
    </div>
  )
}

/* ── ① 装工具 ───────────────────────────────────────────────────────────── */

function EnvStep({ t, state }: { t: TFn; state: MusicRuntimeState }) {
  const env = state.env
  const probeOp = musicSetupOp('check-env')
  const probe = useMutation(probeOp)
  /*
   * `env` 那份读数**没有别的产地** —— `state` 这条读法交的是后端此刻记着的那一份,
   * 而它在没人问过 `check-env` 之前是空的。所以这块面自己去查一次。
   * 一次就够(`asked` 那格记号):查完 `env` 就在了,查砸了也不该每次重渲再砸一遍
   * —— 那会变成一台对着坏掉的 npm 每秒起一个子进程的机器。
   */
  const asked = useRef(false)
  useEffect(() => {
    if (env || asked.current) return
    asked.current = true
    void probeOp.run({})
  }, [env, probeOp])

  // 装哪几件由**后端自述**(provider descriptor 的 tool id),这里不列名单。
  const tools = env ? Object.keys(env.tools) : ['', '']
  return (
    <>
      <p className={s.wizardHint}>{t('music.setup.envHint')}</p>
      <div className={s.wizardBox}>
        {tools.map((tool, index) => (
          <ToolRow key={tool || index} t={t} tool={tool} state={state} />
        ))}
      </div>
      {probe.error && (
        <p className={s.bad} data-testid="music-setup-env-error">
          {probe.error}
        </p>
      )}
    </>
  )
}

function ToolRow({ t, tool, state }: { t: TFn; tool: string; state: MusicRuntimeState }) {
  const status = tool ? state.env?.tools[tool] : undefined
  // 占位那一行(`tool` 还是空串)也得有一只 mutation —— hook 不能有条件地调。
  const installOp = musicSetupOp('install-tool', tool || 'unknown')
  const install = useMutation(installOp)
  const lines = useInstallLog((log) => (tool ? log.byTool[tool] : undefined))
  const installed = status?.installed === true

  return (
    <div className={s.toolLine} data-tool={tool || undefined} data-testid={tool ? `music-tool-${tool}` : undefined}>
      <b className={s.toolName}>{tool || t('music.setup.probing')}</b>
      {installed ? (
        <span className={s.toolOk} data-testid={`music-tool-ok-${tool}`}>
          {status?.version ? t('music.setup.installed', { version: status.version }) : t('music.setup.installedPlain')}
        </span>
      ) : (
        <AsyncButton
          action={installOp}
          pendingLabel={t('music.setup.installing')}
          size="sm"
          disabled={!tool}
          data-testid={tool ? `music-install-${tool}` : undefined}
          onClick={() => void installOp.run({})}
        >
          {install.error ? t('music.setup.retry') : t('music.setup.install')}
        </AsyncButton>
      )}
      {lines && lines.length > 0 && <InstallLog lines={lines} label={t('music.setup.output', { tool })} />}
      {install.error && (
        <p className={s.bad} data-testid={`music-install-error-${tool}`}>
          {install.error}
        </p>
      )}
    </div>
  )
}

/**
 * 安装输出那一块。**自动跟到底**:每来一块新输出就把滚动条按回底部 ——
 * 一段还在跑的安装,人要看的永远是最后一行。
 *
 * `useLayoutEffect` 而不是 `useEffect`:新行落位与滚到底要在**同一帧**里发生,
 * 排到下一帧的话眼睛看得见它先跳出半行再被拽下去。
 */
function InstallLog({ lines, label }: { lines: readonly string[]; label: string }) {
  const ref = useRef<HTMLPreElement | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (element) element.scrollTop = element.scrollHeight
  }, [lines])
  return (
    <pre ref={ref} className={s.installLog} aria-label={label} data-testid="music-install-log">
      {lines.join('\n')}
    </pre>
  )
}

/* ── ② 填凭据 ───────────────────────────────────────────────────────────── */

function CredentialsStep({ t }: { t: TFn }) {
  const [appId, setAppId] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const saveOp = musicSetupOp('set-credentials')
  const save = useMutation(saveOp)
  const ready = appId.trim() !== '' && privateKey.trim() !== ''

  return (
    <form
      className={s.wizardForm}
      onSubmit={(event) => {
        event.preventDefault()
        if (!ready) return
        // 失败时**输入不清空**(§6.5):错话就地一行,人改一格再按一次就行。
        void saveOp.run({ appId: appId.trim(), privateKey: privateKey.trim() })
      }}
    >
      <p className={s.wizardHint}>{t('music.setup.credentialsHint')}</p>
      <div className={s.wizardBox}>
        <Field label={t('music.setup.appId')}>
          <AppIdInput value={appId} onChange={setAppId} />
        </Field>
        <Field label={t('music.setup.privateKey')}>
          <PrivateKeyInput t={t} value={privateKey} onChange={setPrivateKey} />
        </Field>
      </div>
      {save.error && (
        <p className={s.bad} data-testid="music-credentials-error">
          {save.error}
        </p>
      )}
      <div className={s.wizardFoot}>
        <AsyncButton
          action={saveOp}
          pendingLabel={t('common.working')}
          variant="primary"
          type="submit"
          disabled={!ready}
          data-testid="music-credentials-save"
        >
          {t('music.setup.save')}
        </AsyncButton>
      </div>
    </form>
  )
}

function AppIdInput({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const field = useFieldControlProps()
  return (
    <Input
      {...field}
      value={value}
      onValueChange={onChange}
      autoComplete="off"
      spellCheck={false}
      data-testid="music-app-id"
    />
  )
}

function PrivateKeyInput({ t, value, onChange }: { t: TFn; value: string; onChange: (next: string) => void }) {
  const field = useFieldControlProps()
  return (
    <SecretInput
      {...field}
      value={value}
      onValueChange={onChange}
      autoComplete="off"
      revealLabel={t('music.setup.revealKey')}
      hideLabel={t('music.setup.hideKey')}
      data-testid="music-private-key"
    />
  )
}

/* ── ③ 登录 ─────────────────────────────────────────────────────────────── */

function LoginStep({ t, state }: { t: TFn; state: MusicRuntimeState }) {
  const login = state.login
  const startOp = musicSetupOp('login-start')
  const cancelOp = musicSetupOp('login-cancel')
  const start = useMutation(startOp)
  const cancel = useMutation(cancelOp)
  useLoginPolling(login.status)

  if (login.status === 'waiting' && login.url) {
    return <LoginWaiting t={t} url={login.url} cancelling={cancel.pending} onCancel={() => void cancelOp.run({})} />
  }

  const failed = login.status === 'failed' || login.status === 'quota'
  return (
    <>
      <p className={s.wizardHint}>{t('music.setup.loginHint')}</p>
      {failed && (
        <p className={s.bad} data-testid="music-login-error">
          {login.message ?? t('music.setup.loginFailed')}
        </p>
      )}
      {start.error && !failed && (
        <p className={s.bad} data-testid="music-login-error">
          {start.error}
        </p>
      )}
      <div className={s.wizardFoot}>
        <AsyncButton
          action={startOp}
          pendingLabel={t('music.setup.loginStarting')}
          variant="primary"
          data-testid="music-login-start"
          onClick={() => void startOp.run({})}
        >
          {failed ? t('music.setup.loginRetry') : t('music.setup.loginStart')}
        </AsyncButton>
      </div>
    </>
  )
}

/**
 * 等人扫码那一段的轮询(§6.1 末行:「轮询由壳做」)。
 *
 * 只在 `waiting` 期间跑;成了 / 取消 / 失败都会把状态换掉,这只 effect 跟着清掉
 * 计时器,**卸载也一样**(依赖里那格状态与 cleanup 是同一件事的两半)。
 */
function useLoginPolling(status: MusicRuntimeState['login']['status']): void {
  useEffect(() => {
    if (status !== 'waiting') return undefined
    const check = musicSetupOp('login-check')
    const timer = setInterval(() => {
      void check.run({})
    }, MUSIC_LOGIN_POLL_MS)
    return () => clearInterval(timer)
  }, [status])
}

function LoginWaiting({
  t,
  url,
  cancelling,
  onCancel,
}: {
  t: TFn
  url: string
  cancelling: boolean
  onCancel: () => void
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <div className={s.loginWait}>
      <QrCode value={url} label={t('music.setup.qrLabel')} />
      <div className={s.loginSide}>
        <p className={s.wizardHint}>{t('music.setup.scanHint')}</p>
        {/*
          * 地址的**文字形态**留着,而且可选可复制:读屏用户扫不了码,他要的是这条
          * 地址本身(判词在 `QrCode.tsx`)。`break-all` 归 CSS —— 一条登录地址长得
          * 装不下一行,截断它等于把它毁掉。
          */}
        <p className={s.loginUrl} data-testid="music-login-url">
          {url}
        </p>
        <div className={s.loginKeys}>
          <Button size="sm" variant="primary" data-testid="music-login-open" onClick={() => void openBrowser(url)}>
            {t('music.setup.openInBrowser')}
          </Button>
          <Button
            size="sm"
            data-testid="music-login-copy"
            onClick={() => {
              void copyText(url).then((ok) => {
                announce(t(ok ? 'common.copied' : 'common.copyFailed'))
                setCopied(ok)
                clearTimeout(timer.current)
                timer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
              })
            }}
          >
            {copied ? t('common.copied') : t('music.setup.copyLink')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={cancelling}
            data-testid="music-login-cancel"
            onClick={onCancel}
          >
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </div>
  )
}
