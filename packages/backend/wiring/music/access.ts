import {
  DEFAULT_SESSION_OWNER,
  isHistoricalLocalOperator,
  SessionAccessError,
  type SessionAccessContext,
} from '../../session/access.js'

/** The single host player and its persistent DJ state belong to the local operator. */
export function assertMusicOperator(context: SessionAccessContext = DEFAULT_SESSION_OWNER): void {
  if (!isHistoricalLocalOperator(context)) throw new SessionAccessError()
}
