import { useRef, useState } from 'react'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Field } from '../../ui/Field'
import { Input } from '../../ui/Input'
import { Spinner } from '../../ui/Spinner'
import { plural, useT } from '../../i18n'
import { credentialsPort } from '../../data/credentials-port'
import { useCredentialsLoading, useCredentialsLocked, useCredentialsTier } from '../../data/credentials-lock-source'
import { notify } from '../../services/notify'
import { downloadJsonFile } from '../../keymap/profile-file'
import s from './Settings.module.css'

/**
 * 设置 ·「工作区」页的凭证一节(第④步批 0):**导出凭证 / 导入凭证**两颗钮,与一行档位说明。
 *
 * 后端自己持有加密凭证用的主密钥;主密钥丢了(钥匙串条目被删、换电脑)= 凭证全丢,所以口令导出 /
 * 导入是长期功能。口令框、选文件、存文件**都在客户端**:后端只收口令与文件全文,交回的是用口令封好的
 * 密文(`spaces.exportCredentials` / `spaces.importExportedCredentials`)。存文件走与键位组导出同一只
 * `downloadJsonFile`(Blob + `<a download>`,两档宿主都能用);选文件是一枚隐藏的 `<input type="file">`
 * —— 文件选择器必须由一次真实的用户手势触发。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * 生命周期:设置页挂载即挂载,只住在设置页这一种宿主里;对话框是 `ui/Dialog`(模态、Esc 关、焦点归还
 * 由响应链结构性完成)。关掉对话框即丢掉口令(它只在这一次调用里活着)。
 * UI 生命状态:档位未知(还没问到)→ 不画说明;`file` / `none` 各一句说明;`keychain` 不画(那是缺省、
 * 不需要提醒)。锁定时「导出」不可用(锁着读到的是空池,导出一份空文件只会让人以为备份过了),
 * 「导入」照旧可用(钥匙丢了时导入就是恢复的那条路)。
 * UI 交互状态:钮 rest / hover / focus 随 `ui/Button`;对话框里口令为空 → 确认钮 disabled;
 * 提交中 → 确认钮 disabled + aria-busy + 钮内 Spinner;失败 → 口令框 `invalid`(红边),对话框不关;
 * 口令不对(后端答 `WRONG_PASSPHRASE`,按错误码判,不认英文报错串)→ 红边之外框下再一行「口令不对。」。
 * 成功(第④步批 1 补的文案)→ 对话框关掉,现有的轻提示(`notify` success 档,自己飘走)说一句
 * 「凭证已导出。」/「已导入 n 个凭证。」。钥匙还在读 → 档位那一行说「正在读取钥匙串。」(不弹横幅)。
 */
type Mode = { kind: 'export' } | { kind: 'import'; data: string }

export function CredentialsSettings() {
  const t = useT()
  const tier = useCredentialsTier()
  const locked = useCredentialsLocked()
  const loading = useCredentialsLoading()
  const fileRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<Mode | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [wrongPassphrase, setWrongPassphrase] = useState(false)

  function close(): void {
    setMode(null)
    setPassphrase('')
    setFailed(false)
    setWrongPassphrase(false)
    setBusy(false)
  }

  async function onFile(file: File): Promise<void> {
    try {
      setMode({ kind: 'import', data: await file.text() })
      setFailed(false)
    } catch {
      // 读不出来的文件不开对话框。
    }
  }

  async function submit(): Promise<void> {
    if (!mode || !passphrase || busy) return
    setBusy(true)
    setFailed(false)
    setWrongPassphrase(false)
    try {
      const port = await credentialsPort()
      if (mode.kind === 'export') {
        const response = await port.exportCredentials(passphrase)
        if (response.success && response.data && response.fileName && downloadJsonFile(response.fileName, response.data)) {
          close()
          notify({ level: 'success', source: 'credentials', title: t('credentials.exported') })
          return
        }
      } else {
        const response = await port.importCredentials(passphrase, mode.data)
        if (response.success) {
          const n = response.imported ?? 0
          close()
          notify({
            level: 'success',
            source: 'credentials',
            title: t(plural(n, 'credentials.importedOne', 'credentials.importedMany'), { n }),
          })
          return
        }
        if (response.code === 'WRONG_PASSPHRASE') setWrongPassphrase(true)
      }
      setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const title = mode?.kind === 'import' ? t('credentials.import') : t('credentials.export')
  const tierNote = loading
    ? t('credentials.loading')
    : tier === 'file' ? t('credentials.tierFile') : tier === 'none' ? t('credentials.tierNone') : null

  return (
    <>
      <div className={s.settingRow}>
        <div className={s.keyRight}>
          <Button disabled={locked} onClick={() => setMode({ kind: 'export' })} data-testid="credentials-export">
            {t('credentials.export')}
          </Button>
          <Button onClick={() => fileRef.current?.click()} data-testid="credentials-import">
            {t('credentials.import')}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className={s.hiddenFile}
            tabIndex={-1}
            aria-hidden="true"
            data-testid="credentials-import-file"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void onFile(file)
            }}
          />
        </div>
      </div>
      {tierNote ? <div className={s.settingRowNote}>{tierNote}</div> : null}

      <Dialog
        open={mode !== null}
        onClose={close}
        title={title}
        footer={
          <>
            <Button onClick={close} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!passphrase || busy}
              aria-busy={busy || undefined}
              onClick={() => void submit()}
              data-testid="credentials-confirm"
            >
              {/* ui-consume-allow: spinner-placement — 钮内:口令派生与加解密跑着时确认钮自己转,钮外没有第二处说「在忙」 */}
              {busy ? <Spinner size="sm" /> : null}
              {title}
            </Button>
          </>
        }
      >
        <Field
          label={t('credentials.passphraseNote')}
          error={wrongPassphrase ? t('credentials.wrongPassphrase') : undefined}
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={passphrase}
            onValueChange={(value) => {
              setPassphrase(value)
              setFailed(false)
              setWrongPassphrase(false)
            }}
            invalid={failed}
            data-testid="credentials-passphrase"
          />
        </Field>
      </Dialog>
    </>
  )
}
