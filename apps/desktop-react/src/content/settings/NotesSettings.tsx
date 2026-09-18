import { useEffect, useState } from 'react'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { PathText } from '../../ui/PathText'
import { Radio, RadioGroup } from '../../ui/Radio'
import { Switch } from '../../ui/Switch'
import { Tooltip } from '../../ui/Tooltip'
import { useAsyncPending, useQuery } from '../../data/kernel'
import { useHomeDir } from '../../data/home-dir'
import { notesPort } from '../../data/notes-port'
import {
  notesListQuery,
  notesPhaseOf,
  setDailyFormatMutation,
  setNoteFoldersMutation,
  setNoteSystemEnabledMutation,
  setPrimaryVaultMutation,
  setVaultEnabledMutation,
  setVaultSkillsMutation,
  startNotesSource,
  systemEnabledOf,
  systemStateOf,
} from '../../data/notes-source'
import { useOpenDirDialog } from '../files/open-dir-hub'
import { useT } from '../../i18n'
import type { MessageKey, TFn } from '../../i18n'
import type { NoteSystemState, NoteVaultDto } from '@shared/ipc/notes'
import shared from './Settings.module.css'
import s from './NotesSettings.module.css'

/**
 * 这一页说的是 Obsidian 那个系统,所以它的 id 在这只文件里出现一次 —— **契约层
 * 和取数层里一次都没有**(`settings.notes.systems` 与 `notes.list` 的 `systems`
 * 都是表,键由驱动自述)。加一种笔记系统 = 多一个这样的节,这一节一个字不改。
 */
const OBSIDIAN = 'obsidian'

/** 状态码 → 那一句人话。**一张表,不是一串 if**(同 `SearchSettings` 的 R12 体例)。 */
const STATE_KEY: Record<NoteSystemState, MessageKey> = {
  running: 'notes.stateRunning',
  'not-running': 'notes.stateNotRunning',
  'cli-not-registered': 'notes.stateCliNotRegistered',
  'not-installed': 'notes.stateNotInstalled',
}

/**
 * 设置页「笔记」那一页(P4,正本 `docs/design/notes-obsidian-cli-2026-09.md` §4.6)。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三张状态表(状态先行,09-01 用户令)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ① **生命周期**
 *
 * | 时机 | 做什么 |
 * | --- | --- |
 * | 挂载 | `notesListQuery.ensure()` 一发 + `startNotesSource()`(幂等订 `settings:changed`)。**只读**:后端那一条 `notes.list` 一条 CLI 命令都不发 |
 * | 首载 | 一句「正在读取…」,**不画骨架** —— 一页设置的骨架比一行字更吵;开关全禁(翻一个不知道的值等于拿猜测当底本写设置) |
 * | 重拉 | `settings:changed` / 自身写完的 `settle` 各一发;**旧内容留在屏上**(律②),不清屏不闪 |
 * | 换宿主 | 不存在:这一节只活在设置页的一页里,没有第二种落点形态 |
 * | 翻页 / 卸载 | 组件卸下,query 格留着 = 缓存;订阅挂在模块级、全应用一条,整族退役只有 `resetNotesSourceForTest()` 与 HMR dispose 两口 |
 *
 * ② **UI 生命状态**
 *
 * | 态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | loading | 一份都还没有,也没出错 | 节一只有「正在读取…」;总开关禁着;库表与节二不画 |
 * | ready | 有 `data` | 状态句 + 总开关 + 库表 + 目录表 |
 * | error | 这一发红了且**一份都没有过** | 「读不到笔记库。」+「重试」 |
 * | empty·没装 | `systems.obsidian` 缺席或 `'not-installed'` | 节一**只有**那一句和总开关,库表整块不画(夹紧的宿主答空表,落的也是这一档) |
 * | empty·零库 | 别的三态 ∧ 名册里零个库 | 「Obsidian 里还没有库。」 |
 * | empty·零目录 | `folders` 是空的 | 「还没有添加目录。」;「日记文件名格式」那一行**不画**(它只管上面那些目录,一个都没有时它管不着谁) |
 * | 超量 | 20 个库 / 50 个目录 | 结构行**只截断不换行**(库名一行省略号,路径走 `ui/PathText` 自带的断字点);列表**不粘头**、本节零 `max-height` —— 它是页里的一段,滚动归 `.page` 那一层的那一根条,20 行 / 50 行都只是把页拉长 |
 *
 * ③ **UI 交互状态**:全部走库件(`ui/Switch` / `ui/Radio` / `ui/Button` / `ui/Input`
 *    / `ui/Tooltip`),rest / hover / focus / active 随件走,这一页一行都不自绘。
 *    `disabled` 的产地列成一张表:
 *
 * | 件 | 什么时候禁 |
 * | --- | --- |
 * | 总开关 | 还没问到(`!data`)/ 自己那发写路在飞 |
 * | 行内「启用」 | 上面两条 + 总开关关着 |
 * | 行内「技能来源」/「主库」 | 上面三条 + **这一行的「启用」关着**(关掉的库不该还能当技能来源或主库) |
 * | 目录「移除」/「添加目录…」 | 目录那一条写路在飞 / 正在认一条路径 |
 * | 「日记文件名格式」 | 它自己那发写路在飞 |
 *
 * pending 一律是「**就地更新 + 禁着**」:乐观补丁已经把那一格翻过去了,失败由
 * kernel 回滚并弹一条错(`notesWrite` 的 `onError`)。没有一处「清空→骨架→重灌」。
 *
 * ── 焦点三件 ─────────────────────────────────────────────────────────────
 * 这一节**不新开作用域**:它住在设置页那块面里,`settings` 那一格已经声明过。
 * 所以 `focus/scopes.ts` 零改动、这只文件里一行焦点代码都没有,Esc 归设置页那层。
 */
export function NotesSettings() {
  const t = useT()
  const { data, error } = useQuery(notesListQuery)
  const phase = notesPhaseOf(data, error)

  useEffect(() => {
    void notesListQuery.ensure()
    void startNotesSource()
  }, [])

  if (phase === 'loading') return <div className={shared.sectionNote}>{t('notes.loading')}</div>
  if (phase === 'error') {
    return (
      <div className={s.errorRow}>
        <span className={shared.sectionNote}>{t('notes.loadFailed')}</span>
        <Button onClick={() => void notesListQuery.refetch()}>{t('notes.retry')}</Button>
      </div>
    )
  }

  return (
    <>
      <ObsidianSection t={t} />
      <FoldersSection t={t} />
    </>
  )
}

/* ── 节一:Obsidian ────────────────────────────────────────────────────── */

function ObsidianSection({ t }: { t: TFn }) {
  const data = useQuery(notesListQuery).data
  const busy = useAsyncPending(setNoteSystemEnabledMutation)
  const state = systemStateOf(data, OBSIDIAN)
  // 总开关的值来自**设置**(`systems[id].enabled`),状态句来自**机器的事实**
  // (`systems[id].state`)。两格一起投影在同一行上,判词在契约那一格的注里。
  const enabled = systemEnabledOf(data, OBSIDIAN)
  const vaults = (data?.vaults ?? []).filter((v) => v.system === OBSIDIAN)

  return (
    <div className={shared.section}>
      <h3 className={shared.sectionTitle}>{t('settings.notesObsidian')}</h3>
      <div className={shared.sectionNote} data-testid="notes-obsidian-state">{t(STATE_KEY[state])}</div>

      <div className={shared.settingRow}>
        <div className={shared.settingRowLabel}>{t('notes.useObsidianVaults')}</div>
        <Switch
          checked={enabled}
          disabled={!data || busy}
          onChange={(next) =>
            void setNoteSystemEnabledMutation.run({ systemId: OBSIDIAN, enabled: next })}
          label={t('notes.useObsidianVaults')}
        />
      </div>

      {/*
        **没装 Obsidian 的机器上库表整块不画**:一张永远空的表底下配三列开关,
        说的是「这里本来该有东西」,而那台机器上本来就不该有。那一句状态话已经
        把事情说完了。
      */}
      {state === 'not-installed'
        ? null
        : vaults.length === 0
          ? <div className={shared.sectionNote}>{t('notes.vaultsEmpty')}</div>
          : (
            <RadioGroup
              className={s.vaults}
              value={vaults.find((v) => v.primary)?.id ?? ''}
              onChange={(id) => void setPrimaryVaultMutation.run(id)}
              label={t('notes.vaultPrimary')}
              data-testid="notes-vaults"
            >
              {vaults.map((vault) => (
                <VaultRow key={vault.id} t={t} vault={vault} systemEnabled={enabled} />
              ))}
            </RadioGroup>
            )}
    </div>
  )
}

function VaultRow({ t, vault, systemEnabled }: {
  t: TFn
  vault: NoteVaultDto
  systemEnabled: boolean
}) {
  const home = useHomeDir()
  const togglingEnabled = useAsyncPending(setVaultEnabledMutation)
  const togglingSkills = useAsyncPending(setVaultSkillsMutation)
  const settingPrimary = useAsyncPending(setPrimaryVaultMutation)

  // 关掉的库**降一档色、不隐藏**:看不见的东西开不回来。
  // 「启用」自己那一格不受它影响 —— 那正是把它开回来的那一颗。
  const off = !systemEnabled || !vault.enabled

  return (
    <div className={off ? `${s.vaultRow} ${s.vaultRowOff}` : s.vaultRow} data-testid={`notes-vault-${vault.id}`}>
      <div className={s.vaultIdentity}>
        <div className={s.vaultName}>{vault.name}</div>
        <div className={s.vaultPath}>
          <PathText path={vault.root} home={home} />
          {/* 「没在 Obsidian 里打开」是**这一行的事实**,不是错误:小字跟在路径后面。 */}
          {vault.open ? null : <span className={s.vaultNotOpen}>{t('notes.vaultNotOpen')}</span>}
        </div>
      </div>
      <div className={s.vaultActions}>
        <Switch
          checked={vault.enabled}
          disabled={!systemEnabled || togglingEnabled}
          onChange={(next) => void setVaultEnabledMutation.run({ vaultId: vault.id, enabled: next })}
          label={`${t('notes.vaultEnabled')} · ${vault.name}`}
        />
        <Tooltip content={t('notes.vaultSkillsHint')}>
          <span className={s.vaultAction}>
            <Switch
              checked={vault.skills}
              disabled={off || togglingSkills}
              onChange={(next) => void setVaultSkillsMutation.run({ vaultId: vault.id, skills: next })}
              label={`${t('notes.vaultSkills')} · ${vault.name}`}
            />
          </span>
        </Tooltip>
        <Tooltip content={t('notes.vaultPrimaryHint')}>
          <span className={s.vaultAction}>
            <Radio
              value={vault.id}
              disabled={off || settingPrimary}
              label={`${t('notes.vaultPrimary')} · ${vault.name}`}
            />
          </span>
        </Tooltip>
      </div>
    </div>
  )
}

/* ── 节二:其他笔记目录 ─────────────────────────────────────────────────── */

/**
 * 「添加目录…」那一下**可能被拒的两种理由**。答 `null` = 收下。
 *
 * 判据分成纯函数(是不是已经是一个库)与一发 `stat`(在不在),前者可以逐条单测。
 */
export type FolderRejection = 'notes.folderMissing' | 'notes.folderIsVault'

/** 这条路径已经是名册里的某个库了吗。**归一到无尾斜杠**再比。 */
export function isKnownVault(vaults: readonly NoteVaultDto[], root: string): boolean {
  const normalized = root.replace(/\/+$/, '')
  return vaults.some((vault) => vault.root.replace(/\/+$/, '') === normalized)
}

function FoldersSection({ t }: { t: TFn }) {
  const data = useQuery(notesListQuery).data
  const home = useHomeDir()
  const setOpen = useOpenDirDialog((st) => st.setOpen)
  const savingFolders = useAsyncPending(setNoteFoldersMutation)
  const [rejection, setRejection] = useState<FolderRejection | null>(null)
  const [checking, setChecking] = useState(false)

  const folders = data?.folders ?? []

  /*
   * 挑一个目录走的是**全壳唯一那一面**(`content/files/OpenDirDialog`,它常挂在
   * 外壳上)—— 动作单产地。它今天是一个路径输入框而不是系统对话框,理由整段写在
   * `content/files/open-dir-hub.ts` 上(这台 React 壳注入的是 `shell: null`,
   * 而声明 `configureShellHost` 会顺手翻动 `capabilities.shellTools`,那是一次
   * 要拍板的行为改动)。所以这一单**没有**长出第二扇窗,也没有自己写一个输入行。
   */
  const add = (): void => {
    setRejection(null)
    setOpen(true, (picked) => void accept(picked))
  }

  const accept = async (picked: string): Promise<void> => {
    setChecking(true)
    try {
      const port = await notesPort()
      // `files.stat` 顺手把 `~` 展开,并回**真正 stat 到的绝对路径** —— 存进
      // 设置的就该是那一份,而不是用户敲进去的那一串。
      const stat = await port.stat(picked)
      if (!stat.success || stat.type !== 'directory' || stat.path === undefined) {
        setRejection('notes.folderMissing')
        return
      }
      if (isKnownVault(data?.vaults ?? [], stat.path)) {
        setRejection('notes.folderIsVault')
        return
      }
      if (folders.includes(stat.path)) return // 已经在表里:什么都不做,也不报错。
      await setNoteFoldersMutation.run([...folders, stat.path])
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className={shared.section}>
      <h3 className={shared.sectionTitle}>{t('settings.notesFolders')}</h3>
      <div className={shared.sectionNote}>{t('notes.foldersHint')}</div>

      {folders.length === 0
        ? <div className={shared.sectionNote} data-testid="notes-folders-empty">{t('notes.foldersEmpty')}</div>
        : (
          <div className={s.folders} data-testid="notes-folders">
            {folders.map((folder) => (
              <div key={folder} className={s.folderRow}>
                <span className={s.folderPath}><PathText path={folder} home={home} /></span>
                <Button
                  disabled={savingFolders}
                  onClick={() => void setNoteFoldersMutation.run(folders.filter((f) => f !== folder))}
                >
                  {t('notes.folderRemove')}
                </Button>
              </div>
            ))}
          </div>
          )}

      {/* 拒收的理由**就地一行**,不弹通知:它说的是刚才那一下,不是这台机器出了事。 */}
      {rejection === null
        ? null
        : <div className={s.folderError} data-testid="notes-folder-error">{t(rejection)}</div>}

      <div>
        <Button disabled={savingFolders || checking} onClick={add} data-testid="notes-folder-add">
          {t('notes.folderAdd')}
        </Button>
      </div>

      {/*
        **一个目录都没有时这一行不画**:它只管上面那些目录(Obsidian 的日记格式
        由那边的 daily-notes 插件说了算),一个都没有的时候它管不着任何人 ——
        画一个管不着谁的输入框是请人填一句不会生效的话。
      */}
      {folders.length === 0 ? null : <DailyFormatRow t={t} value={data?.dailyFormat ?? ''} />}
    </div>
  )
}

/**
 * 「日记文件名格式」那一行。
 *
 * **它是一格自持的输入**:边打字边整份写回等于每敲一个字母存一次盘,所以这里
 * 收在本地,**失焦或 ↵ 才提交**(与 `NetworkSettings` 的地址行同一手)。
 * 提交空串 = 交给后端回落到缺省(`toNotesConfig` 的 `|| 'YYYY-MM-DD'`),
 * 壳这一侧不替它编一个缺省值。
 */
function DailyFormatRow({ t, value }: { t: TFn; value: string }) {
  const saving = useAsyncPending(setDailyFormatMutation)
  const [draft, setDraft] = useState(value)
  const [known, setKnown] = useState(value)

  // 外面那份变了(别的客户端改的)就跟过去 —— 但不打断正在打字的人。
  if (value !== known) {
    setKnown(value)
    setDraft(value)
  }

  const commit = (): void => {
    if (draft === value) return
    void setDailyFormatMutation.run(draft)
  }

  return (
    <div className={shared.settingRow}>
      <div>
        <div className={shared.settingRowLabel}>{t('notes.dailyFormat')}</div>
        <div className={shared.settingRowHint}>{t('notes.dailyFormatHint')}</div>
      </div>
      <Input
        className={s.dailyFormatInput}
        value={draft}
        onValueChange={setDraft}
        disabled={saving}
        aria-label={t('notes.dailyFormat')}
        data-testid="notes-daily-format"
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
      />
    </div>
  )
}
