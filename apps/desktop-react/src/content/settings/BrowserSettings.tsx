import { useEffect, useRef, useState } from 'react'
import { Trash2 } from '../../components/icons'
import { AsyncButton } from '../../ui/AsyncButton'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { IconButton } from '../../ui/IconButton'
import { Input } from '../../ui/Input'
import { Select } from '../../ui/Select'
import { Switch } from '../../ui/Switch'
import { Tooltip } from '../../ui/Tooltip'
import { useAsyncPending, useQuery } from '../../data/kernel'
import { COPY_FEEDBACK_MS } from '../../components/motion'
import { copyText } from '../../services/clipboard'
import { announce } from '../../ui/a11y/live-region'
import {
  addBrowserProfile,
  browserSettingsQuery,
  chromeDevtoolsMcpSnippet,
  installChromeDevtoolsMcpMutation,
  removeBrowserProfile,
  renameBrowserProfile,
  saveBrowserProfilesMutation,
  setBrowserCdpEnabledMutation,
  setBrowserSearchEngineMutation,
  setDefaultBrowserProfile,
  type BrowserProfileTableView,
} from '../../data/browser-settings-source'
import { BROWSER_SEARCH_ENGINES } from '../../browser/omnibox'
import { useT } from '../../i18n'
import type { TFn } from '../../i18n'
import shared from '../mocks.module.css'
import s from './BrowserSettings.module.css'

/**
 * 设置页「内置浏览器」那一节(B2′ 起;B3-b 加「身份」与「搜索引擎」两块)。
 *
 * ── 它属于哪个领域 ────────────────────────────────────────────────────────
 * 这一页的分区判据是「**用户想改的是哪件事**」(`SettingsMock.tsx` 文件头)。
 * 这一节的三件事都在同一条线上:**这台内置浏览器怎么用** —— 交不交给 AI 驱动、
 * 以谁的身份上网、地址栏那行话去哪儿搜。
 *
 * ── 为什么 CDP 只有一格开关,没有端口输入框 ──────────────────────────────
 * 「设置极简」判例:**只暴露必填项,技术参数走默认值**。端口是技术参数 ——
 * 它在 99% 的机器上是 9333,而真需要换口的人此刻在改 `settings.json`,不是在
 * 设置页里找输入框。端口仍然**露脸**(复制片段里、「装在 9333」那句里),
 * 只是不给编辑:说出来是诚实,给个框是负担。
 *
 * ── CDP 那一行的话为什么必须那么长 ────────────────────────────────────────
 * 两件后果,一件都不许藏(§9-13):①**重启才生效**;②**本机任何程序都能驱动
 * 这台浏览器**,包括登着账号的页面与 onething 自己的界面。这两句是「会造成
 * 后果的警告」,所以它们**是文案不是数据**,进字典、双语成对。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 「身份」这一块的三张状态表(B3-b;施工前先按它自审整面)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ① **生命周期**:随设置页挂载 → `ensure()` 问一次(与 CDP 那一格**同一条读数**,
 *    所以不多一发往返)→ 卸载时只清那颗复制反馈的表与那格确认框。名册本身不在
 *    这只组件里:它是设置的一部分,产地是后端那份 `settings.browser.profiles`。
 *    **这一节没有第二种宿主形态**(只活在设置页的一节里)。
 *
 * ② **UI 生命状态**
 *
 * | 态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | 还没问到 | `!data` | 「身份」这一块**整个不画**。CDP 那一行画着、禁着 —— 一行禁着的开关说的是「还不知道」,而一张空名册说的是「你一个身份都没有」,后者是假话 |
 * | 只有一格 | `profiles.length === 1` | 一行:名字输入框。**不画删钮**(不是禁灰:名册删到空这件事不存在,所以那一格上没有这个动作)。缺省那一行也不画 —— 只有一格可选的选择器是纯噪音 |
 * | 多格 | `profiles.length > 1` | 每格一行(名字 + 删钮)+ 一行「新 tab 用哪个身份」的选择器 |
 * | 出错 | `error` | 错话与**旧名册并陈**(律②):拉不到不把表抹掉 |
 * | 删确认 | 点了某一行的删 | `ui/Dialog`:说清「登录与数据会消失、它的标签页会被关掉」。**这是这一节唯一允许弹确认的地方**——数据会没 |
 * | 超量 | 名册很长 | 不封顶、不滚自己:它是设置页里的一段,跟着整页滚(与「已授权」那一节同形) |
 *
 * ③ **UI 交互状态**:名字输入框随 `ui/Input`(rest/hover/focus);删钮随
 *    `ui/IconButton` 全套;「新建」随 `ui/Button`;写路 pending 期间整块自禁
 *    (一次写动的是整张表,半张表的乐观态没有意义);确认框随 `ui/Dialog`。
 *
 * ── 名字为什么是「失焦才存」而不是每敲一个字存一次 ────────────────────────
 * 与地址栏草稿同一条:人在打字的时候那一格还不是一个决定。每键一发写路 = 每键
 * 一次整份设置读写,而且中途任何一发失败都会把没打完的半个名字存下来。
 */
export function BrowserSettings() {
  const t = useT()
  const { data, error, phase } = useQuery(browserSettingsQuery)

  useEffect(() => {
    void browserSettingsQuery.ensure()
  }, [])

  /*
   * 开关的忙态。`Switch` 不是 `AsyncButton`(它没有可以换的字),所以律③在这一格
   * 的落法是:乐观翻转让它**当场**动,同时禁掉它挡住连点 —— 一开一关两发打在
   * 同一份设置上,后到的那发会拿着旧底本把前一发写回去。
   */
  const toggling = useAsyncPending(setBrowserCdpEnabledMutation)
  const savingProfiles = useAsyncPending(saveBrowserProfilesMutation)

  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  /** 此刻要确认删掉哪一格身份(null = 没在问)。 */
  const [doomed, setDoomed] = useState<{ id: string; name: string } | null>(null)

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

  /** 名册那张表此刻的样子(四只纯函数进出的都是它)。 */
  const table: BrowserProfileTableView | null = data
    ? { profiles: data.profiles, defaultProfile: data.defaultProfile }
    : null

  const save = (next: BrowserProfileTableView): void => {
    void saveBrowserProfilesMutation.run(next)
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

      {/* ── 搜索引擎(B3-b)。一格 `ui/Select`,四选一 —— 「设置极简」那条判例的
          最小落法:必填项(人真的会换)给一格控件,其余走缺省。 */}
      {table ? (
        <div className={shared.settingRow} data-testid="browser-search-engine-row">
          <div>
            <div className={shared.settingRowLabel}>{t('browser.searchEngineLabel')}</div>
            <div className={shared.settingRowHint}>{t('browser.searchEngineHint')}</div>
          </div>
          <Select
            size="sm"
            label={t('browser.searchEngineLabel')}
            value={data!.searchEngine}
            options={BROWSER_SEARCH_ENGINES.map((engine) => ({
              value: engine.id,
              label: engine.name,
            }))}
            onChange={(next) => void setBrowserSearchEngineMutation.run(next)}
          />
        </div>
      ) : null}

      {/* ── 身份(B3-b)。名册 + 缺省 + 新建。 ───────────────────────────── */}
      {table ? (
        <div className={s.profiles} data-testid="browser-profiles">
          <div className={shared.settingRowLabel}>{t('browser.profilesLabel')}</div>
          <div className={shared.settingRowHint}>{t('browser.profilesHint')}</div>

          {table.profiles.map((profile) => (
            <ProfileRow
              key={profile.id}
              profile={profile}
              /*
                只有一格时**不画**删钮(不是禁灰):名册删到空这件事不存在,
                所以那一格上没有这个动作。判据的产地是 `removeBrowserProfile`
                (它对最后一行恒等),这里只是不画那颗按了没用的钮。
              */
              deletable={table.profiles.length > 1}
              busy={savingProfiles}
              onRename={(name) => save(renameBrowserProfile(table, profile.id, name))}
              onDelete={() => setDoomed({ id: profile.id, name: profileDisplayName(profile, t) })}
            />
          ))}

          {/* 只有一格可选的选择器是纯噪音 —— 所以这一行也按格数出现。 */}
          {table.profiles.length > 1 ? (
            <div className={shared.settingRow} data-testid="browser-default-profile-row">
              <div className={shared.settingRowLabel}>{t('browser.defaultProfileLabel')}</div>
              <Select
                size="sm"
                label={t('browser.defaultProfileLabel')}
                value={table.defaultProfile}
                disabled={savingProfiles}
                options={table.profiles.map((profile) => ({
                  value: profile.id,
                  label: profileDisplayName(profile, t),
                }))}
                onChange={(next) => save(setDefaultBrowserProfile(table, next))}
              />
            </div>
          ) : null}

          <div className={s.actions}>
            <Button
              disabled={savingProfiles}
              onClick={() => save(addBrowserProfile(table, ''))}
              data-testid="browser-profile-add"
            >
              {t('browser.profileAdd')}
            </Button>
          </div>
        </div>
      ) : null}

      {/*
        **这一节唯一允许弹确认的地方**(派工单原话):数据会没。措辞说清三件 ——
        哪一格、什么会消失、它的标签页会被关掉。后果由主进程折
        (`electron/browser/profiles.ts`:先关 tab 再清分区),壳这边只写名册。
      */}
      <Dialog
        open={doomed !== null}
        onClose={() => setDoomed(null)}
        title={t('browser.profileDeleteTitle', { name: doomed?.name ?? '' })}
        footer={
          <>
            <Button onClick={() => setDoomed(null)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (table && doomed) save(removeBrowserProfile(table, doomed.id))
                setDoomed(null)
              }}
              data-testid="browser-profile-delete-confirm"
            >
              {t('browser.profileDeleteConfirm')}
            </Button>
          </>
        }
      >
        {t('browser.profileDeleteBody')}
      </Dialog>
    </>
  )
}

/**
 * **一行身份**:一格可改的名字 + 一颗删钮。
 *
 * 名字是**本地草稿 + 失焦才存**,理由与地址栏那一格逐字相同:人在打字的时候
 * 那一格还不是一个决定。每键一发写路 = 每键一次整份设置读写,而且中途任何
 * 一发失败都会把没打完的半个名字存下来。
 *
 * 草稿的**身份跟着那一行走**(`key` = profile.id):删掉中间一行之后 React
 * 会把后面几行的实例往前挪,不按 id 给 key 的话第 2 行的草稿会落在第 3 行身上。
 *
 * `placeholder` 写的是这一行此刻**显示的名字**(没起过名就是字典里那句「默认」)
 * —— 于是一个空的输入框仍然说得出这一行是谁。
 */
function ProfileRow({
  profile,
  deletable,
  busy,
  onRename,
  onDelete,
}: {
  profile: { id: string; name: string }
  deletable: boolean
  busy: boolean
  onRename: (name: string) => void
  onDelete: () => void
}) {
  const t = useT()
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? profile.name

  return (
    <div className={s.profileRow} data-testid="browser-profile-row" data-profile-id={profile.id}>
      <Input
        size="sm"
        className={s.profileName}
        value={value}
        onValueChange={setDraft}
        placeholder={profileDisplayName(profile, t)}
        aria-label={t('browser.profileName')}
        onBlur={() => {
          setDraft(null)
          // 没改就是恒等 —— 不打一发白写(整份设置读 + 写)。
          if (draft === null || draft === profile.name) return
          onRename(draft)
        }}
      />
      {deletable ? (
        <IconButton
          icon={Trash2}
          size="xs"
          label={t('browser.profileDelete')}
          disabled={busy}
          onClick={onDelete}
          testId="browser-profile-delete"
        />
      ) : null}
    </div>
  )
}

/**
 * 一格身份在屏幕上叫什么。**没起过名的那一行由字典画**(名册里它的 `name`
 * 是空串,不是一句写死的中文)—— 判词在契约 `BrowserProfile.name` 上:
 * 名册是数据,用户改过的名字才进那一格。
 *
 * 起过名但名字是空白(全空格)的也走字典:屏幕上一行看不见的名字比「默认」更糟。
 */
export function profileDisplayName(profile: { id: string; name: string }, t: TFn): string {
  return profile.name.trim() || t('browser.profileDefaultName')
}
