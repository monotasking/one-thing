import { resolveIcon } from '../components/icons'
import s from './mocks.module.css'

const Folder = resolveIcon('FolderTree')

export function FilesMock() {
  return (
    <div className={s.demo}>
      <div className={s.tree}>
        <div className={s.row}>
          <Folder className={s.rowIcon} strokeWidth={1.75} aria-hidden="true" />
          packages
        </div>
        <div className={`${s.row} ${s.indent1}`}>onething-runtime</div>
        <div className={`${s.row} ${s.indent2}`}>model-capability.ts</div>
      </div>
    </div>
  )
}
