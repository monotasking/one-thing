import { useT } from '../i18n'
import s from './mocks.module.css'

export function BrowserMock() {
  const t = useT()
  return (
    <div className={s.demo}>
      <div className={s.browserBar}>
        <span className={s.addr}>https://docs.anthropic.com</span>
      </div>
      <div className={s.viewport}>{t('browser.pagePlaceholder')}</div>
    </div>
  )
}
