import { useT } from '../../../i18n'
import type { MessageKey } from '../../../i18n'
import { formatBytes } from '../../../format/quantity'
import { registerViewer, disposeRegistrations } from '../registry'
import type { ViewerBodyProps } from '../registry'
import { HonestState } from '../HonestState'

/**
 * **兜底处理器** —— 一切「打不开」的归宿:二进制、超阈值、读失败。
 *
 * 它是**注册表的 fallback**(同块系统的 `source-fallback`):查不到认领者时落到
 * 这里,而不是一片白屏。所以「注册表还不认识这一型」永远只会变成一句人话,
 * 不会变成一次崩溃。
 *
 * 三种情形各说各的,**没有一种回退到别的那一种** —— 「太大了没读」与
 * 「读了也不是文本」与「没有权限」对用户是三种不同的下一步。
 */
const FAILURE_LABELS: Record<'denied' | 'missing' | 'failed', MessageKey> = {
  denied: 'viewer.denied',
  missing: 'viewer.missing',
  failed: 'viewer.failed',
}

function UnsupportedBody({ file, onReveal }: ViewerBodyProps) {
  const t = useT()
  if (file.kind === 'oversize') {
    return (
      <HonestState
        name={file.name}
        title={t('viewer.oversize', { limit: formatBytes(file.limit) })}
        note={formatBytes(file.size)}
        onReveal={onReveal}
      />
    )
  }
  if (file.kind === 'error') {
    return (
      <HonestState
        name={file.name}
        title={t(FAILURE_LABELS[file.failure])}
        note={file.error}
        onReveal={onReveal}
      />
    )
  }
  const size = file.kind === 'binary' ? file.size : undefined
  return (
    <HonestState
      name={file.name}
      title={t('viewer.binary')}
      note={size === undefined ? undefined : formatBytes(size)}
      onReveal={onReveal}
    />
  )
}

registerViewer(
  {
    id: 'unsupported',
    match: (file) => file.kind === 'binary' || file.kind === 'oversize' || file.kind === 'error',
    Body: UnsupportedBody,
  },
  { fallback: true },
)

/*
 * HMR 退役(09-01 立法:模块级副作用必须配 dispose)。这个文件在被 import 时
 * 往注册表里塞东西,而那张表**重复注册即抛** —— 不退役,热更后新模块进来当场
 * 白屏。复用 registry 那一口唯一的拆卸,不写第二套。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => disposeRegistrations({ viewers: ['unsupported'] }))
}
