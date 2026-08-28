import s from './mocks.module.css'

export function DiffMock() {
  return (
    <div className={s.demo}>
      <div className={s.diffHead}>packages/onething-runtime/src/providers/model-capability.ts</div>
      <div className={s.diffBody}>
        <div className={s.diffLine}>{'  export function supportsImageOutput(m: ModelEntry) {'}</div>
        <div className={`${s.diffLine} ${s.diffDel}`}>{'-   return m.modalities?.includes(\'image\')'}</div>
        <div className={`${s.diffLine} ${s.diffAdd}`}>{'+   return readCapability(m, \'imageOutput\')'}</div>
        <div className={`${s.diffLine} ${s.diffAdd}`}>{'+     ?? m.modalities?.includes(\'image\') ?? false'}</div>
        <div className={s.diffLine}>{'  }'}</div>
      </div>
    </div>
  )
}
