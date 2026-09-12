import { useEffect, useRef, useState } from 'react'
import { AsyncButton } from '../../ui/AsyncButton'
import { Button } from '../../ui/Button'
import { Switch } from '../../ui/Switch'
import { Tooltip } from '../../ui/Tooltip'
import { useAsyncPending, useQuery } from '../../data/kernel'
import { COPY_FEEDBACK_MS } from '../../components/motion'
import { copyText } from '../../services/clipboard'
import { announce } from '../../ui/a11y/live-region'
import {
  browserCdpQuery,
  chromeDevtoolsMcpSnippet,
  installChromeDevtoolsMcpMutation,
  setBrowserCdpEnabledMutation,
} from '../../data/browser-settings-source'
import { useT } from '../../i18n'
import shared from '../mocks.module.css'
import s from './BrowserSettings.module.css'

/**
 * 设置页「内置浏览器」那一节(B2′,方案
 * `apps/desktop-react/docs/terminal-browser-2026-09.md` §2.2-5 / §9-13)。
 *
 * ── 它属于哪个领域 ────────────────────────────────────────────────────────
 * 这一页的分区判据是「**用户想改的是哪件事**」(`SettingsMock.tsx` 文件头)。
 * 这一件是「要不要把内置浏览器交给 AI 与外部工具驱动」—— 一件自成一格的事,
 * 与语言 / 阅读 / Dock / 打开方式 / 已授权 / 快捷键都不是同一件。
 *
 * ── 为什么只有一格开关,没有端口输入框 ────────────────────────────────────
 * 「设置极简」判例:**只暴露必填项,技术参数走默认值**。端口是技术参数 ——
 * 它在 99% 的机器上是 9333,而真需要换口的人此刻在改 `settings.json`,不是在
 * 设置页里找输入框。端口仍然**露脸**(复制片段里、「装在 9333」那句里),
 * 只是不给编辑:说出来是诚实,给个框是负担。
 *
 * ── 行上那句话为什么必须那么长 ────────────────────────────────────────────
 * 两件后果,一件都不许藏(§9-13):①**重启才生效** —— 开关只写设置,
 * `--remote-debugging-port` 得在 app `ready` 之前加(主进程把这一格折成
 * `<store>/run/cdp.json`);②**本机任何程序都能驱动这台浏览器**,包括登着
 * 账号的页面与 onething 自己的界面(CDP 口一开,壳的渲染页也是一个 page 目标,
 * 它内存里有 Bearer token)。这两句是「会造成后果的警告」,所以它们**是文案
 * 不是数据**,进字典、双语成对。
 *
 * ── 三张状态表 ───────────────────────────────────────────────────────────
 * ①生命周期:随设置页挂载 → `ensure()` 问一次(幂等,反复挂载不反复打请求)→
 *   卸载时只清那颗复制反馈的表。这一节**没有第二种宿主形态** —— 它只活在设置
 *   页的一节里,不进浮窗 / 舞台 / 架子,所以没有换宿主那一格。
 * ②UI 生命状态:initial(还没问到:开关在位但禁用,不画骨架 —— 一枚骨架开关
 *   比一枚禁用开关更像在骗人)/ ready / error(错误与旧值**并陈**,律②)/
 *   empty(不存在:这一节永远是那一行开关)/ 超量(不存在:格数是常数 1)。
 * ③UI 交互状态:rest / hover(CSS `:hover`,不进 JS)/ focus(全局 `:focus-visible`)
 *   / pending(开关自禁 + `AsyncButton` 自己说「安装中…」)/ disabled(还没问到、
 *   或者已经装上)/ 复制反馈(钮上就地换字 `COPY_FEEDBACK_MS` + `announce()`,
 *   零 Toast)。
 */
export function BrowserSettings() {
  const t = useT()
  const { data, error, phase } = useQuery(browserCdpQuery)

  useEffect(() => {
    void browserCdpQuery.ensure()
  }, [])

  /*
   * 开关的忙态。`Switch` 不是 `AsyncButton`(它没有可以换的字),所以律③在这一格
   * 的落法是:乐观翻转让它**当场**动,同时禁掉它挡住连点 —— 一开一关两发打在
   * 同一份设置上,后到的那发会拿着旧底本把前一发写回去。
   */
  const toggling = useAsyncPending(setBrowserCdpEnabledMutation)

  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const enabled = data?.enabled === true
  const port = data?.port
  const installed = data?.mcpInstalled === true

  const copySnippet = () => {
    if (port === undefined) return
    void copyText(chromeDevtoolsMcpSnippet(port)).then((ok) => {
      setCopied(ok)
      announce(t(ok ? 'common.copied' : 'common.copyFailed'))
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
    })
  }

  return (
    <>
      <div className={shared.settingRow} data-testid="browser-cdp-row">
        <div>
          <div className={shared.settingRowLabel}>{t('browser.cdpLabel')}</div>
          <div className={shared.settingRowHint}>{t('browser.cdpHint')}</div>
        </div>
        <Switch
          checked={enabled}
          // 还没问到就不许动:此刻屏上那一格是「不知道」,翻它等于拿一个猜测
          // 当底本去写设置。
          disabled={!data || toggling}
          onChange={(next) => void setBrowserCdpEnabledMutation.run(next)}
          label={t('browser.cdpLabel')}
        />
      </div>

      {/* 错误与旧值**并陈**(律②):拉不到不把那一行抹掉。 */}
      {error ? (
        <div className={shared.settingRowNote}>{`${t('browser.loadFailed')} · ${error}`}</div>
      ) : null}

      {/* 首载还没回来时什么都不多画 —— 「关着」与「还没问到」是两件事。 */}
      {enabled && phase !== 'initial' && port !== undefined ? (
        <>
          <div className={s.actions} data-testid="browser-cdp-actions">
            <AsyncButton
              action={installChromeDevtoolsMcpMutation}
              pendingLabel={t('browser.mcpInstalling')}
              // 已经有那一条就不给点:重复写会拿一条新的把用户可能改过的那一条
              // 原样盖掉(判据与写路同一个产地,见 `hasChromeDevtoolsMcp`)。
              disabled={installed}
              onClick={() => void installChromeDevtoolsMcpMutation.run()}
            >
              {t(installed ? 'browser.mcpInstalled' : 'browser.mcpInstall')}
            </AsyncButton>

            <Tooltip content={t('browser.copyConfigTip')}>
              <Button onClick={copySnippet}>
                {t(copied ? 'common.copied' : 'browser.copyConfig')}
              </Button>
            </Tooltip>
          </div>

          {installed ? (
            <div className={s.done}>{t('browser.mcpInstalledNote')}</div>
          ) : null}

          <div className={shared.sectionNote}>{t('browser.cdpPortNote', { port })}</div>
          <div className={shared.sectionNote}>{t('browser.newPageNote')}</div>
        </>
      ) : null}
    </>
  )
}
