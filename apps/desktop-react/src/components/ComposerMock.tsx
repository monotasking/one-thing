import { useState } from 'react'
import { useT } from '../i18n'
import { Button } from '../ui/Button'
import s from './ComposerMock.module.css'

export function ComposerMock() {
  const t = useT()
  const [value, setValue] = useState('')
  // rows 随内容行数增长(上限交给 CSS max-height),框因此向上生长而不是把内容推下去。
  const rows = Math.min(4, Math.max(1, value.split('\n').length))

  return (
    <div className={s.wrap}>
      <div className={s.box}>
        <textarea
          className={s.input}
          rows={rows}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t('composer.placeholder')}
        />
        <Button variant="primary">{t('composer.send')}</Button>
      </div>
    </div>
  )
}
