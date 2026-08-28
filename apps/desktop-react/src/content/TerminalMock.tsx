import s from './mocks.module.css'

export function TerminalMock() {
  return (
    <div className={s.demo}>
      <pre className={s.term}>
        <span className={s.termDim}>$ npm test</span>
        {'\n'}
        {' ✓ transitions > resolveOpen (5)\n'}
        {' ✓ transitions > clickDockIcon (11)\n'}
        {' ✓ transitions > unpin (5)\n'}
        {'\n Test Files  2 passed (2)\n'}
        {'      Tests  77 passed (77)\n'}
      </pre>
    </div>
  )
}
